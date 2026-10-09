"""Everything about credit cards in one place: limits across cards, the open
bill of each, bill history, interest-free installment plans and how much of
the coming months is already committed to them.

Installments arrive as one transaction per installment ("MAGALU 03/10"),
sometimes all of them booked ahead and sometimes only the current one. A
plan is rebuilt from whatever rows exist: one row with its number and bill
month places every installment of the plan on the calendar.
"""

from __future__ import annotations

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import app_today
from app.models.category import Category
from app.models.credit_card_bill import CreditCardBill
from app.models.transaction import Transaction
from app.services import account_service
from app.services._query_filters import counts_as_pnl

_SUFFIX = re.compile(r"\s*\(?\s*(?:PARC(?:ELA)?\s*)?\d{1,2}\s*(?:/|DE)\s*\d{1,2}\s*\)?\s*$", re.I)


def month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def shift_month(key: str, n: int) -> str:
    y, m = int(key[:4]), int(key[5:7])
    total = y * 12 + (m - 1) + n
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def months_between(a: str, b: str) -> int:
    return (int(b[:4]) * 12 + int(b[5:7])) - (int(a[:4]) * 12 + int(a[5:7]))


def clean_description(text: str) -> str:
    return _SUFFIX.sub("", text or "").strip() or (text or "").strip()


@dataclass
class CardInfo:
    id: uuid.UUID
    name: str
    institution: Optional[str]
    logo_url: Optional[str]
    limit: Optional[float]
    used: float
    available: Optional[float]
    close_day: Optional[int]
    due_day: Optional[int]
    next_close: Optional[date]
    next_due: Optional[date]
    shared_group: Optional[str]
    current_bill: float = 0.0
    bill_key: Optional[str] = None  # YYYY-MM of the open (still accumulating) bill's due date
    closed_bill: Optional[float] = None  # closed bill the bank published, still to pay
    closed_due: Optional[date] = None

    @property
    def utilization(self) -> Optional[float]:
        return self.used / self.limit if self.limit else None

    @property
    def best_day(self) -> Optional[int]:
        """Buying the day after the statement closes gives the longest
        interest-free float: the purchase lands on the next bill."""
        if not self.close_day:
            return None
        return self.close_day % 28 + 1 if self.close_day >= 28 else self.close_day + 1


@dataclass
class InstallmentPlan:
    key: str
    card_id: uuid.UUID
    description: str
    category: Optional[str]
    category_color: Optional[str]
    category_icon: Optional[str]
    installment: float
    total: int
    paid: int  # installments on bills already due before the open one
    purchase_date: Optional[date]
    first_month: str
    last_month: str
    months: dict[str, float] = field(default_factory=dict)  # bill month -> amount

    @property
    def remaining(self) -> int:
        return self.total - self.paid

    @property
    def remaining_amount(self) -> float:
        return round(self.installment * self.remaining, 2)

    @property
    def total_amount(self) -> float:
        return round(self.installment * self.total, 2)


@dataclass
class CardsOverview:
    currency: str
    cards: list[CardInfo]
    plans: list[InstallmentPlan]
    commitments: dict[str, dict[str, float]]  # month -> card_id -> installments due
    history: dict[str, dict[str, float]]  # month -> card_id -> bill total
    categories: list[tuple[str, str, str, float]]  # name, color, icon, amount (open bills)

    @property
    def total_limit(self) -> float:
        seen, total = set(), 0.0
        for c in self.cards:
            if c.limit is None:
                continue
            if c.shared_group:
                if c.shared_group in seen:
                    continue
                seen.add(c.shared_group)
            total += c.limit
        return total

    @property
    def total_used(self) -> float:
        seen, total = set(), 0.0
        for c in self.cards:
            if c.shared_group:
                if c.shared_group in seen:
                    continue
                seen.add(c.shared_group)
            total += c.used
        return total

    @property
    def future_installments(self) -> float:
        """Installments on bills after the open one: limit already spoken for."""
        current = min((c.bill_key for c in self.cards if c.bill_key), default=None)
        return round(sum(v for m, by_card in self.commitments.items() if current is None or m > current for v in by_card.values()), 2)


async def overview(session: AsyncSession, workspace_id: uuid.UUID, today: Optional[date] = None) -> CardsOverview:
    today = today or app_today()
    accounts = [a for a in await account_service.get_accounts(session, workspace_id) if a["type"] == "credit_card"]
    cards: dict[uuid.UUID, CardInfo] = {}
    currency = "BRL"
    for a in accounts:
        currency = a.get("currency") or currency
        used = max(0.0, -float(a["current_balance"] or 0))
        cards[a["id"]] = CardInfo(
            id=a["id"],
            name=a.get("display_name") or a["name"],
            institution=a.get("institution_name"),
            logo_url=a.get("institution_logo_url"),
            limit=a.get("credit_limit"),
            used=round(used, 2),
            available=a.get("available_credit"),
            close_day=a.get("statement_close_day"),
            due_day=a.get("payment_due_day"),
            next_close=a.get("next_close_date"),
            next_due=a.get("next_due_date"),
            shared_group=a.get("shared_balance_group"),
            bill_key=month_key(a["next_due_date"]) if a.get("next_due_date") else month_key(today),
        )
    if not cards:
        return CardsOverview(currency, [], [], {}, {}, [])

    card_ids = list(cards)
    amount = func.coalesce(Transaction.amount_primary, Transaction.amount)

    # Bills the bank published (Open Finance). A published bill due today or
    # later is closed and awaiting payment; the open bill is the next one.
    bank_bills: dict[uuid.UUID, dict[str, tuple[date, float]]] = defaultdict(dict)
    for acc_id, due, total in (await session.execute(
        select(CreditCardBill.account_id, CreditCardBill.due_date, CreditCardBill.total_amount)
        .where(CreditCardBill.account_id.in_(card_ids))
    )).all():
        bank_bills[acc_id][month_key(due)] = (due, float(total))
    for card in cards.values():
        published = bank_bills.get(card.id, {}).get(card.bill_key or "")
        if published and published[0] >= today:
            card.closed_due, card.closed_bill = published[0], round(published[1], 2)
            card.bill_key = shift_month(card.bill_key, 1)

    # Bills by month (due-date month), purchases minus refunds; bill payments
    # and transfers are excluded by the P&L filter.
    start_hist = shift_month(month_key(today), -6)
    rows = await session.execute(
        select(Transaction.account_id, Transaction.effective_date, Transaction.type, func.sum(amount))
        .where(
            Transaction.account_id.in_(card_ids),
            Transaction.source != "opening_balance",
            counts_as_pnl(),
        )
        .group_by(Transaction.account_id, Transaction.effective_date, Transaction.type)
    )
    history: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for acc_id, eff, typ, total in rows.all():
        key = month_key(eff)
        signed = float(total or 0) * (1 if typ == "debit" else -1)
        if start_hist <= key <= (cards[acc_id].bill_key or key) and key not in bank_bills.get(acc_id, {}):
            history[key][str(acc_id)] += signed
        card = cards[acc_id]
        if key == card.bill_key:
            card.current_bill += signed
    for c in cards.values():
        c.current_bill = round(max(0.0, c.current_bill), 2)
        for key, (_, total) in bank_bills.get(c.id, {}).items():
            if start_hist <= key <= (c.bill_key or key):
                history[key][str(c.id)] += total

    # Installment plans.
    inst_rows = await session.execute(
        select(Transaction, Category.name, Category.color, Category.icon)
        .outerjoin(Category, Transaction.category_id == Category.id)
        .where(
            Transaction.account_id.in_(card_ids),
            Transaction.total_installments > 1,
            Transaction.type == "debit",
        )
    )
    groups: dict[str, list] = defaultdict(list)
    for tx, cat, color, icon in inst_rows.all():
        if tx.installment_series_id:
            key = f"s:{tx.installment_series_id}"
        else:
            key = f"{tx.account_id}:{clean_description(tx.description).upper()}:{tx.total_installments}:{round(float(tx.amount))}"
        groups[key].append((tx, cat, color, icon))

    # Banks don't always repeat the same purchase date on every installment,
    # so it can't be part of the key. Two purchases of the same thing in the
    # same number of installments show up as repeated installment numbers:
    # split those by purchase date.
    for key in list(groups):
        items = groups[key]
        numbers = [it[0].installment_number for it in items]
        if len(numbers) == len(set(numbers)):
            continue
        del groups[key]
        by_purchase: dict = defaultdict(list)
        for it in items:
            by_purchase[it[0].installment_purchase_date or it[0].date].append(it)
        for purchase, chunk in by_purchase.items():
            groups[f"{key}:{purchase}"] = chunk

    plans: list[InstallmentPlan] = []
    commitments: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for key, items in groups.items():
        items.sort(key=lambda it: (it[0].installment_number or 0))
        tx0, cat, color, icon = items[0]
        total = int(tx0.total_installments)
        value = round(sum(float(it[0].amount) for it in items) / len(items), 2)
        # Anchor the calendar on the row with the latest effective date
        # relative to its number — booked-ahead rows carry their real bill.
        anchor = max(items, key=lambda it: (it[0].effective_date, it[0].installment_number or 0))[0]
        n0 = anchor.installment_number or 1
        anchor_key = month_key(anchor.effective_date)
        first = shift_month(anchor_key, 1 - n0)
        card = cards[tx0.account_id]
        open_key = card.bill_key or month_key(today)
        months = {shift_month(first, i): value for i in range(total)}
        paid = sum(1 for m in months if m < open_key)
        plan = InstallmentPlan(
            key=key, card_id=tx0.account_id, description=clean_description(tx0.description),
            category=cat, category_color=color, category_icon=icon, installment=value, total=total,
            paid=paid, purchase_date=tx0.installment_purchase_date or min(it[0].date for it in items),
            first_month=first, last_month=shift_month(first, total - 1), months=months,
        )
        if plan.remaining <= 0:
            continue
        plans.append(plan)
        for m, v in months.items():
            if m >= open_key:
                commitments[m][str(tx0.account_id)] += v

    plans.sort(key=lambda p: (p.last_month, -p.installment))

    # Spending by category on the open bills.
    cat_rows = await session.execute(
        select(Transaction.account_id, Transaction.effective_date, Category.name, Category.color, Category.icon, func.sum(amount))
        .outerjoin(Category, Transaction.category_id == Category.id)
        .where(
            Transaction.account_id.in_(card_ids),
            Transaction.type == "debit",
            Transaction.source != "opening_balance",
            counts_as_pnl(),
        )
        .group_by(Transaction.account_id, Transaction.effective_date, Category.name, Category.color, Category.icon)
    )
    by_cat: dict[tuple, float] = defaultdict(float)
    for acc_id, eff, name, color, icon, total in cat_rows.all():
        if month_key(eff) == cards[acc_id].bill_key:
            by_cat[(name or "—", color or "#6B7280", icon or "circle-help")] += float(total or 0)
    categories = sorted(((n, c, i, round(v, 2)) for (n, c, i), v in by_cat.items() if v > 0), key=lambda x: -x[3])

    return CardsOverview(
        currency=currency,
        cards=sorted(cards.values(), key=lambda c: -c.used),
        plans=plans,
        commitments={m: {k: round(v, 2) for k, v in d.items()} for m, d in sorted(commitments.items())},
        history={m: {k: round(v, 2) for k, v in d.items()} for m, d in sorted(history.items())},
        categories=categories,
    )

