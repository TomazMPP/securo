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
from decimal import Decimal
from typing import Optional

from sqlalchemy import String, case, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.account import Account
from app.models.bank_connection import BankConnection
from app.models.category import Category
from app.models.category_group import CategoryGroup
from app.models.payee import Payee
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.analysis import (
    AccountMonthPoint,
    AccountsAnalysis,
    AnalysisAccount,
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
from app.services.credit_card_service import compute_available_credit, get_cycle_dates

# How far back to look when deciding whether something repeats, and how many
# distinct months it must appear in. Six months is long enough to catch a
# quarterly charge twice and short enough that a subscription cancelled last
# year stops counting.
LOOKBACK_MONTHS = 6
MIN_MONTHS_FOR_RECURRING = 3

TOP_N = 15

# Per-account breakdown: how many expense categories to list per account
# before rolling the tail into "other", and how many trailing months the
# per-account spend trend covers.
ACCOUNT_TOP_CATEGORIES = 5
TREND_MONTHS = 6


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


def _trend_month_labels(end: date) -> list[tuple[int, str]]:
    """The trailing `TREND_MONTHS` (bucket, label) pairs ending at `end`'s month,
    oldest first. Bucket matches `_month_bucket_expr` (YYYYMM as int)."""
    first = _subtract_months(date(end.year, end.month, 1), TREND_MONTHS - 1)
    out = []
    year, month = first.year, first.month
    for _ in range(TREND_MONTHS):
        out.append((year * 100 + month, f"{year:04d}-{month:02d}"))
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return out


async def get_accounts_analysis(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    start: date,
    end: date,
    account_ids: Optional[list[uuid.UUID]] = None,
) -> AccountsAnalysis:
    """Break one date range down by the account the money moved through.

    Same period conventions as `get_period_analysis` (`end` inclusive, same
    P/L filters), so the totals reconcile with the category/payee view.
    Totals are abs'ed at the (account, category) grain — the same convention
    the category view applies per category — so reconciliation is exact
    whenever signs are consistent within a category (see the inline note).
    On top of the per-account totals this adds what only makes sense at the
    account level: the credit-vs-debit split, and per credit card the limit
    utilization and the next statement close/due dates.

    Credit-card payments are transfer legs, so `counts_as_user_pnl()` keeps
    them from double-counting a purchase once on the card and once on the
    checking account that paid the bill.
    """
    if end < start:
        start, end = end, start
    end_exclusive = end + timedelta(days=1)
    days = (end_exclusive - start).days

    user = await session.get(User, user_id)
    currency = user.primary_currency if user else get_settings().default_currency
    report_date = reporting_date_col(await get_credit_card_accounting_mode(session))

    amount = _amount_expr()
    in_period = [report_date >= start, report_date < end_exclusive]
    account_cols = [
        Account.id, Account.name, Account.display_name, Account.type,
        Account.masked_number, Account.card_brand, Account.currency,
        Account.balance, Account.connection_id, Account.credit_limit,
        Account.statement_close_day, Account.payment_due_day,
        BankConnection.institution_name, BankConnection.logo_url,
    ]

    # Which accounts had qualifying activity in the period, plus their
    # display metadata. Totals are NOT summed here — see the grain note below.
    rows = (
        await session.execute(
            select(*account_cols)
            .select_from(Transaction)
            .join(Account, Transaction.account_id == Account.id)
            .outerjoin(BankConnection, Account.connection_id == BankConnection.id)
            .where(*_base_filters(workspace_id, account_ids), *in_period)
            .group_by(*account_cols)
        )
    ).all()

    # Everything is aggregated at the (account, category, type) grain and
    # abs'ed there — the same convention as `_build_side`, which abs's each
    # category's sum. Deriving the account totals from this grain rather than
    # from an abs-of-sum per account keeps each account card internally
    # consistent when an account holds mixed-sign rows (e.g. a refund stored
    # as a negative debit): the category segments, the "other" bucket and the
    # header total add up, and the grand total reconciles with the category
    # view whenever signs are consistent within a category.
    cat_rows = (
        await session.execute(
            select(
                Transaction.account_id,
                Transaction.type,
                Category.id, Category.name, Category.icon, Category.color,
                func.sum(amount), func.count(),
            )
            .select_from(Transaction)
            .join(Account, Transaction.account_id == Account.id)
            .outerjoin(Category, Transaction.category_id == Category.id)
            .where(*_base_filters(workspace_id, account_ids), *in_period)
            .group_by(
                Transaction.account_id, Transaction.type,
                Category.id, Category.name, Category.icon, Category.color,
            )
        )
    ).all()
    side_totals: dict = {}    # (account_id, tx_type) -> [total, count]
    expense_cats: dict = {}   # account_id -> [(cat_id, name, icon, color, total, count)]
    for acct_id, tx_type, cat_id, cat_name, icon, color, total, n in cat_rows:
        value = abs(float(total or 0))
        bucket = side_totals.setdefault((acct_id, tx_type), [0.0, 0])
        bucket[0] += value
        bucket[1] += int(n or 0)
        if tx_type == "debit":
            expense_cats.setdefault(acct_id, []).append(
                (cat_id, cat_name, icon, color, value, int(n or 0))
            )

    # Spend trend over the trailing months ending at the period end. This
    # window is anchored on `end`, not on the selected range: for a short
    # range it adds context, for a long one it shows the recent tail.
    # Aggregated per (account, month, category) and abs'ed at that grain so a
    # month's bar matches what the account card reports for the same month.
    months = _trend_month_labels(end)
    trend_rows = (
        await session.execute(
            select(
                Transaction.account_id,
                _month_bucket_expr(report_date),
                Transaction.category_id,
                func.sum(amount),
            )
            .select_from(Transaction)
            .join(Account, Transaction.account_id == Account.id)
            .where(
                *_base_filters(workspace_id, account_ids),
                Transaction.type == "debit",
                report_date >= _subtract_months(date(end.year, end.month, 1), TREND_MONTHS - 1),
                report_date < end_exclusive,
            )
            .group_by(
                Transaction.account_id, _month_bucket_expr(report_date), Transaction.category_id
            )
        )
    ).all()
    trend_by_account: dict = {}
    for acct_id, bucket, _cat, total in trend_rows:
        acct_map = trend_by_account.setdefault(acct_id, {})
        key = int(bucket)
        acct_map[key] = acct_map.get(key, 0.0) + abs(float(total or 0))

    # Manual credit cards keep only a creation-time seed in `accounts.balance`;
    # their real balance is the signed transaction sum — same formula as the
    # balance subquery in `account_service.get_accounts`.
    manual_cc_ids = [r[0] for r in rows if r[3] == "credit_card" and r[8] is None]
    manual_cc_balance: dict = {}
    if manual_cc_ids:
        effective_amount = case(
            (Transaction.currency == Account.currency, Transaction.amount),
            else_=func.coalesce(Transaction.amount_primary, Transaction.amount),
        )
        signed = case((Transaction.type == "credit", effective_amount), else_=-effective_amount)
        bal_rows = (
            await session.execute(
                select(Transaction.account_id, func.coalesce(func.sum(signed), 0))
                .select_from(Transaction)
                .join(Account, Transaction.account_id == Account.id)
                .outerjoin(Category, Transaction.category_id == Category.id)
                .where(
                    Transaction.account_id.in_(manual_cc_ids),
                    Transaction.is_ignored.is_(False),
                    or_(Transaction.category_id.is_(None), Category.is_ignored.is_(False)),
                )
                .group_by(Transaction.account_id)
            )
        ).all()
        manual_cc_balance = {row[0]: row[1] for row in bal_rows}

    def _side(acct_id, tx_type) -> tuple[float, int]:
        total, count = side_totals.get((acct_id, tx_type), (0.0, 0))
        return total, count

    total_expenses = sum(_side(r[0], "debit")[0] for r in rows)
    total_income = sum(_side(r[0], "credit")[0] for r in rows)
    card_expenses = sum(_side(r[0], "debit")[0] for r in rows if r[3] == "credit_card")

    accounts: list[AnalysisAccount] = []
    for r in rows:
        (
            acct_id, name, display_name, acct_type, masked, brand, acct_currency,
            balance, connection_id, credit_limit, close_day, due_day, institution, logo,
        ) = r
        expense_total, expense_count = _side(acct_id, "debit")
        income_total, income_count = _side(acct_id, "credit")

        top: list[AnalysisCategory] = []
        listed = 0.0
        acct_cats = sorted(expense_cats.get(acct_id, []), key=lambda c: c[4], reverse=True)
        for cat_id, cat_name, icon, color, value, cat_n in acct_cats[:ACCOUNT_TOP_CATEGORIES]:
            listed += value
            top.append(AnalysisCategory(
                category_id=str(cat_id) if cat_id else None,
                name=cat_name or "",
                icon=icon or "circle-help",
                color=color or "#6B7280",
                total=value,
                share=(value / expense_total) if expense_total else 0.0,
                count=cat_n,
            ))

        acct_trend = trend_by_account.get(acct_id, {})
        monthly = [
            AccountMonthPoint(month=label, total=acct_trend.get(bucket, 0.0))
            for bucket, label in months
        ]

        limit_f = available_f = utilization = None
        next_close = next_due = None
        if acct_type == "credit_card":
            # serialize_account's balance convention: providers report card
            # debt as a POSITIVE balance → negate; manual cards use the
            # signed transaction sum computed above.
            if connection_id is not None:
                resolved_balance = -(balance or Decimal("0"))
            else:
                resolved_balance = Decimal(str(manual_cc_balance.get(acct_id, 0) or 0))
            available = compute_available_credit(credit_limit, resolved_balance)
            if credit_limit:
                limit_f = float(credit_limit)
                if available is not None:
                    available_f = float(available)
                    utilization = float((credit_limit - available) / credit_limit)
            cycle = get_cycle_dates(close_day, due_day)
            if cycle["next_close_date"]:
                next_close = cycle["next_close_date"].isoformat()
            if cycle["next_due_date"]:
                next_due = cycle["next_due_date"].isoformat()

        accounts.append(AnalysisAccount(
            account_id=str(acct_id),
            name=display_name or name,
            type=acct_type,
            masked_number=masked,
            card_brand=brand,
            institution_name=institution,
            institution_logo_url=logo,
            account_currency=acct_currency,
            expense_total=expense_total,
            expense_share=(expense_total / total_expenses) if total_expenses else 0.0,
            expense_count=expense_count,
            income_total=income_total,
            income_count=income_count,
            categories=top,
            other_categories_total=max(0.0, expense_total - listed),
            monthly=monthly,
            credit_limit=limit_f,
            available_credit=available_f,
            utilization=utilization,
            next_close_date=next_close,
            next_due_date=next_due,
        ))

    accounts.sort(key=lambda a: (a.expense_total, a.income_total), reverse=True)

    return AccountsAnalysis(
        start=start.isoformat(),
        end=end.isoformat(),
        days=days,
        currency=currency,
        total_expenses=total_expenses,
        total_income=total_income,
        card_expenses=card_expenses,
        card_expense_share=(card_expenses / total_expenses) if total_expenses else 0.0,
        trend_months=TREND_MONTHS,
        accounts=accounts,
    )
