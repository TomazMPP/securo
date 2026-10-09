"""Find bills that repeat every month but aren't registered as recurring.

Bank-synced users rarely type their fixed bills in; the history already
shows them (rent, insurance, condo, subscriptions). A payee — or a
normalized description when there's no payee — that was paid in at least
three different months, roughly once a month, at a similar amount and
recently enough to still be active is suggested as a recurring bill.
"""

from __future__ import annotations

import re
import statistics
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import app_today
from app.models.account import Account
from app.models.category import Category
from app.models.payee import Payee
from app.models.recurring_transaction import RecurringTransaction
from app.models.transaction import Transaction
from app.services._query_filters import counts_as_pnl

LOOKBACK_MONTHS = 7
MIN_MONTHS = 3
STILL_ACTIVE_DAYS = 45
MAX_SPREAD = 0.35  # (max - min) / median of the monthly amounts

_NOISE = re.compile(r"(\bCP\s*:\s*\d+-?|\d{4,}|\d{1,2}/\d{1,2}(/\d{2,4})?|PIX ENVIADO|PAGAMENTO DE PIX QR CODE|PAGAMENTO DE BOLETO|PAGAMENTO DE|DEBITO AUTOMATICO|DEBITO|COMPRA)", re.I)


def normalize(description: str) -> str:
    text = _NOISE.sub(" ", (description or "").upper())
    text = re.sub(r"[^A-Z0-9À-Ú ]+", " ", text)
    return re.sub(r"\s{2,}", " ", text).strip()


@dataclass
class RecurringSuggestion:
    key: str
    description: str
    type: str
    amount: float  # median of the monthly amounts
    last_amount: float
    day_of_month: int
    months: int
    last_date: date
    variable: bool
    account_id: uuid.UUID
    account_name: str
    category_id: Optional[uuid.UUID]
    category_name: Optional[str]
    payee_name: Optional[str]
    currency: str


def _month(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


async def suggest(session: AsyncSession, workspace_id: uuid.UUID, today: Optional[date] = None) -> list[RecurringSuggestion]:
    today = today or app_today()
    since = (today.replace(day=1) - timedelta(days=31 * (LOOKBACK_MONTHS - 1))).replace(day=1)
    amount = func.coalesce(Transaction.amount_primary, Transaction.amount)
    rows = await session.execute(
        select(
            Transaction.id, Transaction.date, Transaction.description, Transaction.type, amount,
            Transaction.account_id, Account.name, Account.display_name, Account.type, Account.currency,
            Transaction.category_id, Category.name, Transaction.payee_id, Payee.name,
            Transaction.recurring_transaction_id,
        )
        .join(Account, Transaction.account_id == Account.id)
        .outerjoin(Category, Transaction.category_id == Category.id)
        .outerjoin(Payee, Transaction.payee_id == Payee.id)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.date >= since,
            Transaction.date <= today,
            Transaction.status == "posted",
            Transaction.source.notin_(("opening_balance", "loan_payment", "recurring")),
            Transaction.total_installments.is_(None) | (Transaction.total_installments <= 1),
            counts_as_pnl(),
        )
    )
    groups: dict[str, list] = defaultdict(list)
    for row in rows.all():
        (_id, d, desc, typ, amt, acc_id, acc_name, acc_display, acc_type, cur,
         cat_id, cat_name, payee_id, payee_name, rec_id) = row
        if rec_id is not None:
            continue
        key = f"{typ}:p:{payee_id}" if payee_id else f"{typ}:d:{normalize(desc)}"
        if key.endswith(":d:"):
            continue
        groups[key].append(row)

    # Bills already registered (by description or payee name) aren't suggested again.
    registered: set[str] = set()
    # Latest start of a registered bill per category: a suggestion last paid
    # before it was most likely replaced by it (a move, a new insurer).
    replaced_since: dict[uuid.UUID, date] = {}
    for desc, cat_id, start in (await session.execute(
        select(RecurringTransaction.description, RecurringTransaction.category_id, RecurringTransaction.start_date)
        .where(RecurringTransaction.workspace_id == workspace_id, RecurringTransaction.is_active.is_(True))
    )).all():
        registered.add(normalize(desc))
        if cat_id is not None and (cat_id not in replaced_since or start > replaced_since[cat_id]):
            replaced_since[cat_id] = start

    out: list[RecurringSuggestion] = []
    for key, items in groups.items():
        by_month: dict[str, list] = defaultdict(list)
        for it in items:
            by_month[_month(it[1])].append(it)
        if len(by_month) < MIN_MONTHS:
            continue
        # Roughly once a month: a payee paid many times a month (groceries,
        # rides) is spending, not a bill.
        if sum(len(v) for v in by_month.values()) > len(by_month) * 1.5:
            continue
        last = max(items, key=lambda it: it[1])
        if (today - last[1]).days > STILL_ACTIVE_DAYS:
            continue
        monthly = [sum(float(it[4]) for it in v) for v in by_month.values()]
        median = statistics.median(monthly)
        if median <= 0 or (max(monthly) - min(monthly)) / median > MAX_SPREAD:
            continue
        name = last[13] or last[2]
        if normalize(name) in registered or normalize(last[2]) in registered:
            continue
        # Tax lines that ride along with a subscription (IOF on a foreign
        # charge) follow it; they aren't bills of their own.
        if normalize(last[2]).startswith("IOF"):
            continue
        if last[10] is not None and last[10] in replaced_since and last[1] < replaced_since[last[10]]:
            continue
        day = int(statistics.median(it[1].day for it in items))
        out.append(RecurringSuggestion(
            key=key,
            description=name,
            type=last[3],
            amount=round(median, 2),
            last_amount=round(float(last[4]), 2),
            day_of_month=min(day, 28),
            months=len(by_month),
            last_date=last[1],
            variable=(max(monthly) - min(monthly)) / median > 0.02,
            account_id=last[5],
            account_name=last[7] or last[6],
            category_id=last[10],
            category_name=last[11],
            payee_name=last[13],
            currency=last[9] or "BRL",
        ))
    out.sort(key=lambda s: (s.type != "debit", -s.amount))
    return out
