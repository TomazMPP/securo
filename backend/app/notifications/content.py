"""Gather the numbers each email shows, reusing the services behind the
dashboard and reports so an email never disagrees with the app."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.bank_connection import BankConnection
from app.models.category import Category
from app.models.credit_card_bill import CreditCardBill
from app.models.loan import Loan
from app.models.transaction import Transaction
from app.services import budget_service, dashboard_service, goal_service, report_service
from app.services._query_filters import counts_as_user_pnl


def month_start(d: date) -> date:
    return d.replace(day=1)


def prev_month(d: date) -> date:
    first = d.replace(day=1)
    return (first - timedelta(days=1)).replace(day=1)


def month_end(d: date) -> date:
    nxt = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return nxt - timedelta(days=1)


@dataclass
class CategoryLine:
    name: str
    color: str
    amount: float
    change: Optional[float] = None  # fraction vs comparison period


@dataclass
class TxLine:
    date: date
    description: str
    category: Optional[str]
    amount: float


@dataclass
class BillLine:
    date: date
    name: str
    amount: float
    kind: str  # recurring | card_bill | loan
    key: str


@dataclass
class MonthlyReport:
    month: date
    currency: str
    income: float
    expenses: float
    prev_income: float
    prev_expenses: float
    categories: list[CategoryLine]
    top_expenses: list[TxLine]
    over_budget: list[tuple[str, float, float]]
    net_worth: Optional[float]
    net_worth_change: Optional[float]
    goals: list[tuple[str, float, float]]
    upcoming_total: float
    upcoming_count: int
    uncategorized: int

    @property
    def net(self) -> float:
        return self.income - self.expenses

    @property
    def savings_rate(self) -> Optional[float]:
        return self.net / self.income if self.income > 0 else None

    @property
    def expenses_change(self) -> Optional[float]:
        return (self.expenses - self.prev_expenses) / self.prev_expenses if self.prev_expenses > 0 else None


@dataclass
class WeeklyDigest:
    start: date
    end: date
    currency: str
    expenses: float
    income: float
    weekly_average: float
    categories: list[CategoryLine]
    top_expenses: list[TxLine]
    upcoming: list[BillLine]

    @property
    def vs_average(self) -> Optional[float]:
        return (self.expenses - self.weekly_average) / self.weekly_average if self.weekly_average > 0 else None


@dataclass
class Alerts:
    currency: str
    large: list[tuple[str, TxLine]] = field(default_factory=list)  # (key, tx)
    budgets: list[tuple[str, str, float, float, float]] = field(default_factory=list)  # key, name, actual, budget, pct
    spikes: list[tuple[str, str, float, float]] = field(default_factory=list)  # key, name, mtd, avg
    connections: list[tuple[str, str, str]] = field(default_factory=list)  # key, institution, status

    def is_empty(self) -> bool:
        return not (self.large or self.budgets or self.spikes or self.connections)


async def _top_expenses(session: AsyncSession, workspace_id: uuid.UUID, start: date, end: date, limit: int = 5) -> list[TxLine]:
    amount = func.abs(func.coalesce(Transaction.amount_primary, Transaction.amount))
    rows = await session.execute(
        select(Transaction.date, Transaction.description, Category.name, amount)
        .outerjoin(Category, Transaction.category_id == Category.id)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.type == "debit",
            Transaction.date >= start,
            Transaction.date <= end,
            Transaction.status == "posted",
            Transaction.source != "opening_balance",
            counts_as_user_pnl(),
        )
        .order_by(amount.desc())
        .limit(limit)
    )
    return [TxLine(d, desc, cat, float(amt)) for d, desc, cat, amt in rows.all()]


async def _spending_by_category(session, workspace_id, user_id, month: date) -> dict[str, tuple[str, str, float]]:
    items = await dashboard_service.get_spending_by_category(session, workspace_id, user_id, month=month)
    return {
        str(i.category_id or "uncategorized"): (i.category_name, i.category_color or "#6B7280", float(i.total or 0))
        for i in items
        if (i.total or 0) > 0
    }


async def upcoming_bills(session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, start: date, end: date) -> list[BillLine]:
    bills: list[BillLine] = []
    projected = await dashboard_service.get_projected_transactions(
        session, workspace_id, user_id, from_date=start, to_date=end
    )
    for p in projected:
        if p.type != "debit":
            continue
        d = date.fromisoformat(p.date)
        bills.append(BillLine(d, p.description, abs(p.amount_primary if p.amount_primary is not None else p.amount), "recurring", f"bill:rec:{p.recurring_id}:{d.isoformat()}"))

    cc = await session.execute(
        select(CreditCardBill.id, CreditCardBill.due_date, CreditCardBill.total_amount, Account.name, Account.display_name)
        .join(Account, CreditCardBill.account_id == Account.id)
        .where(
            CreditCardBill.workspace_id == workspace_id,
            CreditCardBill.due_date >= start,
            CreditCardBill.due_date <= end,
            CreditCardBill.total_amount > 0,
        )
    )
    for bill_id, due, total, name, custom in cc.all():
        bills.append(BillLine(due, custom or name, float(total), "card_bill", f"bill:cc:{bill_id}"))

    loans = await session.execute(
        select(Loan).where(
            Loan.workspace_id == workspace_id,
            Loan.is_active.is_(True),
            Loan.next_due_date >= start,
            Loan.next_due_date <= end,
        )
    )
    for loan in loans.scalars():
        label = loan.product_name or loan.institution_name or "Loan"
        bills.append(BillLine(loan.next_due_date, label, float(loan.installment_amount or 0), "loan", f"bill:loan:{loan.id}:{loan.next_due_date.isoformat()}"))

    return sorted(bills, key=lambda b: (b.date, -b.amount))


async def build_monthly_report(session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, month: date) -> MonthlyReport:
    month = month_start(month)
    before = prev_month(month)
    summary = await dashboard_service.get_summary(session, workspace_id, user_id, month=month)
    prev = await dashboard_service.get_summary(session, workspace_id, user_id, month=before)
    currency = summary.primary_currency

    cur_cats = await _spending_by_category(session, workspace_id, user_id, month)
    prev_cats = await _spending_by_category(session, workspace_id, user_id, before)
    categories = []
    for key, (name, color, amount) in sorted(cur_cats.items(), key=lambda kv: -kv[1][2])[:6]:
        prev_amount = prev_cats.get(key, (None, None, 0.0))[2]
        change = (amount - prev_amount) / prev_amount if prev_amount > 0 else None
        categories.append(CategoryLine(name, color, amount, change))

    over_budget = []
    for b in await budget_service.get_budget_vs_actual(session, workspace_id, user_id, month=month):
        if b.budget_amount and float(b.actual_amount) > float(b.budget_amount):
            over_budget.append((b.category_name, float(b.actual_amount), float(b.budget_amount)))

    net_worth = net_worth_change = None
    try:
        nw = await report_service.get_net_worth_report(session, workspace_id, user_id, months=2, interval="monthly", currency=currency)
        net_worth = nw.summary.primary_value
        net_worth_change = nw.summary.change_amount
    except Exception:  # noqa: BLE001 - a report hiccup must not block the email
        pass

    goals = []
    for g in await goal_service.get_goals(session, workspace_id, user_id):
        target = float(g.target_amount_primary or g.target_amount or 0)
        current = float(g.current_amount_primary or g.current_amount or 0)
        if target > 0 and current < target and g.status == "active":
            goals.append((g.name, current, target))

    this_month = month_start(month_end(month) + timedelta(days=1))
    upcoming = await upcoming_bills(session, workspace_id, user_id, this_month, month_end(this_month))

    return MonthlyReport(
        month=month,
        currency=currency,
        income=summary.monthly_income_primary,
        expenses=summary.monthly_expenses_primary,
        prev_income=prev.monthly_income_primary,
        prev_expenses=prev.monthly_expenses_primary,
        categories=categories,
        top_expenses=await _top_expenses(session, workspace_id, month, month_end(month)),
        over_budget=over_budget,
        net_worth=net_worth,
        net_worth_change=net_worth_change,
        goals=goals[:3],
        upcoming_total=sum(b.amount for b in upcoming),
        upcoming_count=len(upcoming),
        uncategorized=summary.pending_categorization,
    )


async def _pnl_totals(session: AsyncSession, workspace_id: uuid.UUID, start: date, end: date) -> tuple[float, float]:
    """(income, expenses) for a date range, with the same P&L filter the
    dashboard and reports use (no transfers, ignored rows or settlements)."""
    amount = func.abs(func.coalesce(Transaction.amount_primary, Transaction.amount))
    rows = await session.execute(
        select(Transaction.type, func.sum(amount))
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.date >= start,
            Transaction.date <= end,
            Transaction.status == "posted",
            Transaction.source != "opening_balance",
            counts_as_user_pnl(),
        )
        .group_by(Transaction.type)
    )
    totals = {t: float(v or 0) for t, v in rows.all()}
    return totals.get("credit", 0.0), totals.get("debit", 0.0)


async def _expenses_by_category(session: AsyncSession, workspace_id: uuid.UUID, start: date, end: date, limit: int = 4) -> list[CategoryLine]:
    amount = func.abs(func.coalesce(Transaction.amount_primary, Transaction.amount))
    total = func.sum(amount)
    rows = await session.execute(
        select(Category.name, Category.color, total)
        .outerjoin(Category, Transaction.category_id == Category.id)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.type == "debit",
            Transaction.date >= start,
            Transaction.date <= end,
            Transaction.status == "posted",
            Transaction.source != "opening_balance",
            counts_as_user_pnl(),
        )
        .group_by(Category.name, Category.color)
        .order_by(total.desc())
        .limit(limit)
    )
    return [CategoryLine(name or "—", color or "#6B7280", float(v or 0)) for name, color, v in rows.all()]


async def build_weekly_digest(session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, today: date) -> WeeklyDigest:
    """The Monday-to-Sunday week before `today`, against the 8 weeks before it."""
    start = today - timedelta(days=today.weekday() + 7)
    end = start + timedelta(days=6)
    summary = await dashboard_service.get_summary(session, workspace_id, user_id, month=start)
    income, expenses = await _pnl_totals(session, workspace_id, start, end)
    _, history = await _pnl_totals(session, workspace_id, start - timedelta(days=56), start - timedelta(days=1))

    return WeeklyDigest(
        start=start,
        end=end,
        currency=summary.primary_currency,
        expenses=expenses,
        income=income,
        weekly_average=history / 8,
        categories=await _expenses_by_category(session, workspace_id, start, end),
        top_expenses=await _top_expenses(session, workspace_id, start, end, limit=3),
        upcoming=await upcoming_bills(session, workspace_id, user_id, today, today + timedelta(days=6)),
    )


async def build_alerts(session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, prefs: dict, today: date) -> Alerts:
    summary = await dashboard_service.get_summary(session, workspace_id, user_id, month=today)
    alerts = Alerts(currency=summary.primary_currency)

    if prefs.get("spend_alerts") and prefs.get("large_transaction_threshold"):
        threshold = float(prefs["large_transaction_threshold"])
        since = datetime.now(timezone.utc) - timedelta(hours=26)
        amount = func.abs(func.coalesce(Transaction.amount_primary, Transaction.amount))
        rows = await session.execute(
            select(Transaction.id, Transaction.date, Transaction.description, Category.name, amount)
            .outerjoin(Category, Transaction.category_id == Category.id)
            .where(
                Transaction.workspace_id == workspace_id,
                Transaction.type == "debit",
                Transaction.created_at >= since,
                Transaction.source != "opening_balance",
                amount >= threshold,
                counts_as_user_pnl(),
            )
            .order_by(amount.desc())
        )
        for tx_id, d, desc, cat, amt in rows.all():
            alerts.large.append((f"large_tx:{tx_id}", TxLine(d, desc, cat, float(amt))))

    if prefs.get("budget_alerts"):
        for b in await budget_service.get_budget_vs_actual(session, workspace_id, user_id, month=today):
            if not b.budget_amount:
                continue
            actual, budget = float(b.actual_amount), float(b.budget_amount)
            ratio = actual / budget if budget else 0
            level = 100 if ratio >= 1 else 80 if ratio >= 0.8 else None
            if level:
                key = f"budget{level}:{b.category_id}:{today:%Y-%m}"
                alerts.budgets.append((key, b.category_name, actual, budget, ratio))

    if prefs.get("category_spike_alerts") and today.day >= 7:
        current = await _spending_by_category(session, workspace_id, user_id, today)
        history: dict[str, list[float]] = {}
        m = today
        for _ in range(3):
            m = prev_month(m)
            for key, (_, _, amt) in (await _spending_by_category(session, workspace_id, user_id, m)).items():
                history.setdefault(key, []).append(amt)
        for key, (name, _, mtd) in current.items():
            if key == "uncategorized":
                continue
            avg = sum(history.get(key, [])) / 3
            if avg > 0 and mtd > avg * 1.25 and mtd - avg >= 300:
                alerts.spikes.append((f"spike:{key}:{today:%Y-%m}", name, mtd, avg))

    if prefs.get("connection_alerts"):
        conns = await session.execute(
            select(BankConnection.id, BankConnection.display_name, BankConnection.institution_name, BankConnection.status)
            .where(BankConnection.workspace_id == workspace_id, BankConnection.status != "active")
        )
        week = today.isocalendar()
        for conn_id, display, inst, status in conns.all():
            alerts.connections.append((f"conn:{conn_id}:{status}:{week.year}-W{week.week}", display or inst, status))

    return alerts
