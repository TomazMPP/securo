"""Period x-ray: where the money in one date range actually went.

The reports module answers *how much* over time. This one answers *on what,
with whom, and how much of it repeats* inside a single period — the questions
that only become answerable once transactions are categorized.

Every aggregation here reuses the shared reporting conventions so the numbers
reconcile with the dashboard and reports: `counts_as_user_pnl()` for what
counts, `reporting_date_col()` for which period a transaction lands in, and
`amount_primary` for multi-currency wallets.

Known limitation: group splits are not netted out, so a workspace that uses
shared expenses will see the full transaction amount here while the dashboard
shows only the owner's share.
"""
import uuid
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import String, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.account import Account
from app.models.category import Category
from app.models.category_group import CategoryGroup
from app.models.payee import Payee
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.analysis import (
    AnalysisCategory,
    AnalysisPayee,
    AnalysisSide,
    AnalysisTransaction,
    PeriodAnalysis,
    RecurrenceSplit,
    RecurringItem,
)
from app.services._query_filters import counts_as_user_pnl, reporting_date_col
from app.services.admin_service import get_credit_card_accounting_mode

# How far back to look when deciding whether something repeats, and how many
# distinct months it must appear in. Six months is long enough to catch a
# quarterly charge twice and short enough that a subscription cancelled last
# year stops counting.
LOOKBACK_MONTHS = 6
MIN_MONTHS_FOR_RECURRING = 3

TOP_N = 15


def _amount_expr():
    """Amount in the primary currency, falling back to the raw amount."""
    return func.coalesce(Transaction.amount_primary, Transaction.amount)


def _payee_key_expr():
    """Stable grouping key for "who was this with".

    Only 39% of this workspace's rows carry a `payee_id`, so a ranking keyed
    on it alone would silently drop the majority of spend. The chain falls
    back to the free-text payee and finally to the description, uppercased so
    casing differences from different import sources collapse together.
    """
    return func.coalesce(
        cast(Transaction.payee_id, String),
        func.nullif(func.trim(func.upper(Transaction.payee)), ""),
        func.upper(func.trim(Transaction.description)),
    )


def _payee_label_expr():
    """Human-readable name for a payee key, preferring the curated entity."""
    return func.coalesce(
        Payee.name,
        func.nullif(func.trim(Transaction.payee), ""),
        Transaction.description,
    )


def _month_bucket_expr(report_date):
    """Year-month as a sortable integer, e.g. 202606.

    Built from `extract` rather than `to_char` so the query runs unchanged on
    both Postgres and the SQLite the test suite uses.
    """
    return func.extract("year", report_date) * 100 + func.extract("month", report_date)


def _subtract_months(d: date, months: int) -> date:
    """Shift a date back N months, clamping the day to a valid one."""
    year, month = d.year, d.month - months
    while month <= 0:
        month += 12
        year -= 1
    day = min(d.day, [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
                      31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
    return date(year, month, day)


def _base_filters(workspace_id: uuid.UUID, account_ids: Optional[list[uuid.UUID]]):
    """Filters shared by every query here.

    `opening_balance` rows are seed entries that make an account start at the
    right number; counting them would invent income out of nothing.
    """
    filters = [
        Transaction.workspace_id == workspace_id,
        Account.is_closed.is_(False),
        Transaction.source != "opening_balance",
        counts_as_user_pnl(),
    ]
    if account_ids is not None:
        filters.append(Transaction.account_id.in_(account_ids))
    return filters


async def _categories_for(
    session: AsyncSession, workspace_id, account_ids, report_date,
    start: date, end_exclusive: date, tx_type: str,
) -> list[tuple]:
    result = await session.execute(
        select(
            Category.id,
            Category.name,
            Category.icon,
            Category.color,
            CategoryGroup.name,
            func.sum(_amount_expr()),
            func.count(),
        )
        .select_from(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .outerjoin(Category, Transaction.category_id == Category.id)
        .outerjoin(CategoryGroup, Category.group_id == CategoryGroup.id)
        .where(
            *_base_filters(workspace_id, account_ids),
            Transaction.type == tx_type,
            report_date >= start,
            report_date < end_exclusive,
        )
        .group_by(Category.id, Category.name, Category.icon, Category.color, CategoryGroup.name)
        .order_by(func.sum(_amount_expr()).desc())
    )
    return result.all()


async def _payees_for(
    session: AsyncSession, workspace_id, account_ids, report_date,
    start: date, end_exclusive: date, tx_type: str,
) -> list[tuple]:
    key = _payee_key_expr()
    result = await session.execute(
        select(
            key,
            func.min(_payee_label_expr()),
            func.sum(_amount_expr()),
            func.count(),
        )
        .select_from(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .outerjoin(Payee, Transaction.payee_id == Payee.id)
        .where(
            *_base_filters(workspace_id, account_ids),
            Transaction.type == tx_type,
            report_date >= start,
            report_date < end_exclusive,
        )
        .group_by(key)
        .order_by(func.sum(_amount_expr()).desc())
    )
    return result.all()


async def _recurring_keys(
    session: AsyncSession, workspace_id, account_ids, report_date,
    lookback_start: date, end_exclusive: date, tx_type: str,
) -> dict[str, int]:
    """Payee keys that show up in at least `MIN_MONTHS_FOR_RECURRING` months.

    Recurrence is *detected* rather than read: `recurring_transaction_id` is
    only populated when a user links a charge to a recurring bill by hand, so
    a split based on it reads 100% one-off for most workspaces.
    """
    key = _payee_key_expr()
    month = _month_bucket_expr(report_date)
    result = await session.execute(
        select(key, func.count(func.distinct(month)))
        .select_from(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .where(
            *_base_filters(workspace_id, account_ids),
            Transaction.type == tx_type,
            report_date >= lookback_start,
            report_date < end_exclusive,
        )
        .group_by(key)
        .having(func.count(func.distinct(month)) >= MIN_MONTHS_FOR_RECURRING)
    )
    return {row[0]: int(row[1]) for row in result.all() if row[0]}


async def _largest_for(
    session: AsyncSession, workspace_id, account_ids, report_date,
    start: date, end_exclusive: date, tx_type: str,
) -> list[AnalysisTransaction]:
    result = await session.execute(
        select(
            Transaction.id,
            report_date,
            Transaction.description,
            _payee_label_expr(),
            Category.name,
            _amount_expr(),
        )
        .select_from(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .outerjoin(Category, Transaction.category_id == Category.id)
        .outerjoin(Payee, Transaction.payee_id == Payee.id)
        .where(
            *_base_filters(workspace_id, account_ids),
            Transaction.type == tx_type,
            report_date >= start,
            report_date < end_exclusive,
        )
        .order_by(_amount_expr().desc())
        .limit(TOP_N)
    )
    return [
        AnalysisTransaction(
            id=str(row[0]),
            date=row[1].isoformat(),
            description=row[2] or "",
            payee=row[3],
            category_name=row[4],
            amount=abs(float(row[5] or 0)),
        )
        for row in result.all()
    ]


async def _build_side(
    session: AsyncSession, workspace_id, account_ids, report_date,
    start: date, end_exclusive: date, days: int, tx_type: str,
) -> AnalysisSide:
    cat_rows = await _categories_for(
        session, workspace_id, account_ids, report_date, start, end_exclusive, tx_type
    )
    payee_rows = await _payees_for(
        session, workspace_id, account_ids, report_date, start, end_exclusive, tx_type
    )
    recurring = await _recurring_keys(
        session, workspace_id, account_ids, report_date,
        _subtract_months(start, LOOKBACK_MONTHS), end_exclusive, tx_type,
    )

    total = sum(abs(float(r[5] or 0)) for r in cat_rows)
    count = sum(int(r[6] or 0) for r in cat_rows)

    def share(value: float) -> float:
        return (value / total) if total else 0.0

    categories = [
        AnalysisCategory(
            category_id=str(r[0]) if r[0] else None,
            name=r[1] or "",
            icon=r[2] or "circle-help",
            color=r[3] or "#6B7280",
            group_name=r[4],
            total=abs(float(r[5] or 0)),
            share=share(abs(float(r[5] or 0))),
            count=int(r[6] or 0),
        )
        for r in cat_rows
    ]

    payees: list[AnalysisPayee] = []
    recurring_total, recurring_count = 0.0, 0
    one_off_total, one_off_count = 0.0, 0
    items: list[RecurringItem] = []

    for key, label, amount, n in payee_rows:
        value = abs(float(amount or 0))
        n = int(n or 0)
        is_recurring = key in recurring
        if is_recurring:
            recurring_total += value
            recurring_count += n
            items.append(RecurringItem(
                label=label or "", total=value, count=n, months_seen=recurring[key],
            ))
        else:
            one_off_total += value
            one_off_count += n
        payees.append(AnalysisPayee(
            key=str(key), label=label or "", total=value,
            share=share(value), count=n, recurring=is_recurring,
        ))

    items.sort(key=lambda i: i.total, reverse=True)

    return AnalysisSide(
        total=total,
        count=count,
        daily_average=(total / days) if days else 0.0,
        categories=categories,
        payees=payees[:TOP_N],
        largest=await _largest_for(
            session, workspace_id, account_ids, report_date, start, end_exclusive, tx_type
        ),
        recurrence=RecurrenceSplit(
            recurring_total=recurring_total,
            one_off_total=one_off_total,
            recurring_count=recurring_count,
            one_off_count=one_off_count,
            items=items[:TOP_N],
            lookback_months=LOOKBACK_MONTHS,
            min_months=MIN_MONTHS_FOR_RECURRING,
        ),
    )


async def get_period_analysis(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    start: date,
    end: date,
    account_ids: Optional[list[uuid.UUID]] = None,
) -> PeriodAnalysis:
    """Break one date range down into where money came from and went.

    `end` is inclusive, matching how a user reads "1 to 31 July".
    """
    if end < start:
        start, end = end, start
    end_exclusive = end + timedelta(days=1)
    days = (end_exclusive - start).days

    user = await session.get(User, user_id)
    currency = user.primary_currency if user else get_settings().default_currency
    report_date = reporting_date_col(await get_credit_card_accounting_mode(session))

    expenses = await _build_side(
        session, workspace_id, account_ids, report_date, start, end_exclusive, days, "debit"
    )
    income = await _build_side(
        session, workspace_id, account_ids, report_date, start, end_exclusive, days, "credit"
    )

    net = income.total - expenses.total
    return PeriodAnalysis(
        start=start.isoformat(),
        end=end.isoformat(),
        days=days,
        currency=currency,
        expenses=expenses,
        income=income,
        net=net,
        savings_rate=(net / income.total) if income.total else None,
    )
