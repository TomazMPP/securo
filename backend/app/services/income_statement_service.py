"""Income statement (DRE) for a business workspace.

Revenue - taxes on revenue = net revenue; - cost of services = gross profit;
- operating expenses = operating result; +/- financial result = net income,
with the margin over revenue. Month by month and for the whole range.

Where a transaction lands is decided by its category's group
(`CategoryGroup.dre_section`), so the statement needs no setup in a business
workspace seeded with the business categories, and any group can be moved
to another line from the categories screen.

Cash basis, on the same conventions as the other reports so the numbers
reconcile with them: `reporting_date_col()` picks the month, `amount_primary`
the currency, `counts_as_user_pnl()` what counts. Each row contributes its
signed amount (credit +, debit -), so a refund nets against the expense it
reverses instead of showing up as revenue.

Two deliberate departures:

  - Nothing counted disappears. Uncategorized rows and groups without a
    section form an "unclassified" section that still enters net income, so
    the bottom line always equals what the company actually earned minus
    spent; a large unclassified figure is the cue to categorize.
  - The owners section (withdrawals, contributions) is shown below net
    income and never enters it. Some owner categories are `treat_as_transfer`
    (contributions), which `counts_as_user_pnl()` drops, so this section is
    read with only the ignore/pair/settlement exclusions, whatever the flag.

Closed accounts are included: closing an account doesn't undo the revenue
or expenses it carried in past months.
"""
import uuid
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.category import Category
from app.models.category_group import CategoryGroup
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.income_statement import (
    IncomeStatement,
    IncomeStatementAmount,
    IncomeStatementLine,
    IncomeStatementSection,
    IncomeStatementSubtotals,
)
from app.services._query_filters import counts_as_user_pnl, reporting_date_col
from app.services.admin_service import get_credit_card_accounting_mode
from app.services.analysis_service import _month_bucket_expr

# Statement order. `unclassified` sits just above the bottom line; `owners`
# comes after it and is not part of it.
SECTION_ORDER = (
    "revenue", "deductions", "costs", "operating_expenses", "financial", "unclassified", "owners",
)
MAX_MONTHS = 36


def _month_keys(start: date, end: date) -> list[int]:
    keys, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        keys.append(y * 100 + m)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return keys


def _owners_flow_filter():
    """What counts in the owners section: everything not ignored, paired as a
    transfer, excluded from P/L, or a group settlement."""
    return and_(
        Transaction.transfer_pair_id.is_(None),
        Transaction.is_ignored.is_(False),
        Transaction.exclude_from_pnl.is_(False),
        Transaction.source != "settlement",
        Category.is_ignored.is_(False),
    )


def _round(values: list[Decimal]) -> list[float]:
    return [float(round(v, 2)) for v in values]


async def get_income_statement(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    start: date,
    end: date,
) -> IncomeStatement:
    """`end` is inclusive. Ranges longer than MAX_MONTHS keep the latest months."""
    if end < start:
        start, end = end, start
    month_keys = _month_keys(start, end)
    if len(month_keys) > MAX_MONTHS:
        month_keys = month_keys[-MAX_MONTHS:]
        start = date(month_keys[0] // 100, month_keys[0] % 100, 1)
    index = {k: i for i, k in enumerate(month_keys)}
    n = len(month_keys)

    user = await session.get(User, user_id)
    currency = user.primary_currency if user else get_settings().default_currency
    report_date = reporting_date_col(await get_credit_card_accounting_mode(session))
    month = _month_bucket_expr(report_date)
    amount = func.coalesce(Transaction.amount_primary, Transaction.amount)
    signed = case((Transaction.type == "credit", amount), else_=-amount)
    is_owners = func.coalesce(CategoryGroup.dre_section, "") == "owners"

    rows = (
        await session.execute(
            select(
                month,
                CategoryGroup.dre_section,
                Category.id,
                Category.name,
                Category.icon,
                Category.color,
                CategoryGroup.name,
                func.sum(signed),
            )
            .select_from(Transaction)
            .outerjoin(Category, Transaction.category_id == Category.id)
            .outerjoin(CategoryGroup, Category.group_id == CategoryGroup.id)
            .where(
                Transaction.workspace_id == workspace_id,
                Transaction.source != "opening_balance",
                report_date >= start,
                report_date < end + timedelta(days=1),
                or_(
                    and_(~is_owners, counts_as_user_pnl()),
                    and_(is_owners, _owners_flow_filter()),
                ),
            )
            .group_by(
                month, CategoryGroup.dre_section, Category.id, Category.name,
                Category.icon, Category.color, CategoryGroup.name,
            )
        )
    ).all()

    lines: dict[str, dict[object, dict]] = {key: {} for key in SECTION_ORDER}
    for bucket, section, cat_id, name, icon, color, group_name, total in rows:
        i = index.get(int(bucket))
        if i is None:
            continue
        key = section if section in lines else "unclassified"
        line = lines[key].setdefault(cat_id, {
            "category_id": str(cat_id) if cat_id else None, "name": name, "icon": icon,
            "color": color, "group_name": group_name, "months": [Decimal(0)] * n,
        })
        line["months"][i] += Decimal(str(total or 0))

    sections: list[IncomeStatementSection] = []
    section_months: dict[str, list[Decimal]] = {}
    for key in SECTION_ORDER:
        built = []
        months_total = [Decimal(0)] * n
        for line in lines[key].values():
            line_total = sum(line["months"], Decimal(0))
            if not line_total and not any(line["months"]):
                continue
            months_total = [a + b for a, b in zip(months_total, line["months"])]
            built.append(IncomeStatementLine(
                **{**line, "months": _round(line["months"])}, total=float(round(line_total, 2)),
            ))
        # Biggest first; revenue lines are positive, the rest mostly negative.
        built.sort(key=lambda ln: -abs(ln.total))
        section_months[key] = months_total
        sections.append(IncomeStatementSection(
            key=key, total=float(round(sum(months_total, Decimal(0)), 2)),
            months=_round(months_total), lines=built,
        ))

    def add(*keys_or_series):
        out = [Decimal(0)] * n
        for item in keys_or_series:
            series = section_months[item] if isinstance(item, str) else item
            out = [a + b for a, b in zip(out, series)]
        return out

    def amount_of(series: list[Decimal]) -> IncomeStatementAmount:
        return IncomeStatementAmount(total=float(round(sum(series, Decimal(0)), 2)), months=_round(series))

    net_revenue = add("revenue", "deductions")
    gross_profit = add(net_revenue, "costs")
    operating_result = add(gross_profit, "operating_expenses")
    net_income = add(operating_result, "financial", "unclassified")

    revenue = section_months["revenue"]
    revenue_total = sum(revenue, Decimal(0))

    def margin(income: Decimal, rev: Decimal):
        return float(round(income / rev, 4)) if rev > 0 else None

    return IncomeStatement(
        start=start.isoformat(),
        end=end.isoformat(),
        currency=currency,
        months=[f"{k // 100:04d}-{k % 100:02d}" for k in month_keys],
        sections=sections,
        subtotals=IncomeStatementSubtotals(
            net_revenue=amount_of(net_revenue),
            gross_profit=amount_of(gross_profit),
            operating_result=amount_of(operating_result),
            net_income=amount_of(net_income),
        ),
        margin=margin(sum(net_income, Decimal(0)), revenue_total),
        margins=[margin(ni, rv) for ni, rv in zip(net_income, revenue)],
    )
