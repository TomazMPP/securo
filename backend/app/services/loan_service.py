"""Manual loans: contract terms + real payments → balance, schedule, charts.

A loan described by hand (or one Open Finance hasn't delivered yet) is tied
to the manual `loan` account that carries the debt. Payments are real
transactions (usually debits on a checking account) linked to the loan;
from them `loan_math` rebuilds the balance, and the principal part of each
payment is mirrored as a credit on the loan account so balances and net
worth follow the debt without special-casing loan accounts anywhere else.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import delete, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import app_today
from app.models.account import Account
from app.models.loan import Loan, LoanPayment
from app.models.transaction import Transaction
from app.services.loan_math import PaymentIn, Schedule, build_schedule, implied_rate

MIRROR_SOURCE = "loan_payment"

# Descriptions banks use for financing installments and early repayments.
_INSTALLMENT_PATTERNS = re.compile(r"FINANC|FINANCIAMENTO|PARC(ELA)?\s+(EMPREST|FINANC)|CDC\b", re.I)


@dataclass
class Suggestion:
    transaction_id: uuid.UUID
    date: date
    description: str
    amount: float
    account_name: str
    kind: str
    reason: str


def _plain(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().upper()


def _d(value) -> Optional[float]:
    return float(value) if value is not None else None


async def _payments(session: AsyncSession, loan: Loan) -> list[tuple[LoanPayment, Transaction]]:
    rows = await session.execute(
        select(LoanPayment, Transaction)
        .join(Transaction, LoanPayment.transaction_id == Transaction.id)
        .where(LoanPayment.loan_id == loan.id)
        .order_by(Transaction.date)
    )
    return list(rows.all())


def can_schedule(loan: Loan) -> bool:
    return bool(
        loan.contract_amount and loan.installment_amount and loan.total_installments
        and loan.contract_date and loan.first_installment_date
    )


async def schedule(session: AsyncSession, loan: Loan, today: Optional[date] = None) -> Optional[Schedule]:
    if not can_schedule(loan):
        return None
    pairs = await _payments(session, loan)
    rate = float(loan.monthly_rate) if loan.monthly_rate is not None else (
        implied_rate(float(loan.contract_amount), float(loan.installment_amount), loan.total_installments) or 0.0
    )
    return build_schedule(
        principal=float(loan.contract_amount),
        rate=rate,
        installment=float(loan.installment_amount),
        total_installments=loan.total_installments,
        contract_date=loan.contract_date,
        first_due=loan.first_installment_date,
        payments=[
            PaymentIn(tx.date, abs(float(tx.amount_primary if tx.amount_primary is not None else tx.amount)), lp.kind, str(lp.id))
            for lp, tx in pairs
        ],
        today=today or app_today(),
    )


async def recompute(session: AsyncSession, loan: Loan) -> Optional[Schedule]:
    """Refresh the loan's stored figures and the principal mirrors from its
    payments. Open Finance loans keep the bank's numbers; only manual ones
    are rewritten."""
    sched = await schedule(session, loan)
    if sched is None or loan.source != "manual":
        return sched

    pairs = await _payments(session, loan)
    by_id = {str(lp.id): (lp, tx) for lp, tx in pairs}
    loan.monthly_rate = Decimal(str(round(sched.rate, 6)))
    loan.outstanding_balance = Decimal(str(sched.balance_today))
    loan.paid_installments = sched.paid_installments
    loan.remaining_installments = sched.remaining_installments
    loan.overdue_installments = 0
    loan.next_due_date = sched.next_due
    loan.final_due_date = sched.payoff_date or loan.final_due_date
    loan.payments = [
        {"date": p.date.isoformat(), "amount": str(round(p.amount, 2)), "installment_id": p.ref, "over_parcel": p.kind == "extra"}
        for p in sorted(sched.payments, key=lambda p: p.date, reverse=True)
    ]
    loan.last_synced_at = datetime.now(timezone.utc)

    # Rewrite the principal mirrors (splits shift when a payment is added
    # or removed, since interest accrues between events).
    old_mirrors = [lp.mirror_transaction_id for lp, _ in pairs if lp.mirror_transaction_id]
    for lp, _ in pairs:
        lp.mirror_transaction_id = None
    await session.flush()
    if old_mirrors:
        await session.execute(delete(Transaction).where(Transaction.id.in_(old_mirrors)))

    account = await session.get(Account, loan.account_id) if loan.account_id else None
    for split in sched.payments:
        lp, tx = by_id[split.ref]
        lp.principal = Decimal(str(split.principal))
        lp.interest = Decimal(str(split.interest))
        if account is None or split.principal <= 0:
            continue
        mirror = Transaction(
            id=uuid.uuid4(),
            user_id=account.user_id,
            workspace_id=account.workspace_id,
            account_id=account.id,
            description=f"Amortização — {tx.description}"[:500],
            amount=Decimal(str(split.principal)),
            currency=account.currency,
            type="credit",
            date=split.date,
            source=MIRROR_SOURCE,
            status="posted",
            exclude_from_pnl=True,
            notes="Principal part of a payment matched to this loan. Managed by Securo.",
        )
        session.add(mirror)
        lp.mirror_transaction_id = mirror.id
    await session.flush()
    return sched


async def link_payment(session: AsyncSession, loan: Loan, transaction_id: uuid.UUID, kind: str) -> LoanPayment:
    tx = await session.scalar(
        select(Transaction).where(Transaction.id == transaction_id, Transaction.workspace_id == loan.workspace_id)
    )
    if tx is None or tx.type != "debit":
        raise ValueError("Only debits in this workspace can be loan payments")
    existing = await session.scalar(select(LoanPayment).where(LoanPayment.transaction_id == transaction_id))
    if existing is not None:
        existing.loan_id, existing.kind = loan.id, kind
        payment = existing
    else:
        payment = LoanPayment(loan_id=loan.id, transaction_id=transaction_id, kind=kind)
        session.add(payment)
    await session.flush()
    await recompute(session, loan)
    return payment


async def unlink_payment(session: AsyncSession, loan: Loan, transaction_id: uuid.UUID) -> None:
    payment = await session.scalar(
        select(LoanPayment).where(LoanPayment.loan_id == loan.id, LoanPayment.transaction_id == transaction_id)
    )
    if payment is None:
        return
    if payment.mirror_transaction_id:
        await session.execute(delete(Transaction).where(Transaction.id == payment.mirror_transaction_id))
    await session.delete(payment)
    await session.flush()
    await recompute(session, loan)


async def suggestions(session: AsyncSession, loan: Loan) -> list[Suggestion]:
    """Debits since the contract that look like this loan's payments:
    an installment-sized amount, or a financing/lender description."""
    if not loan.contract_date:
        return []
    linked = set((await session.execute(select(LoanPayment.transaction_id))).scalars())
    installment = float(loan.installment_amount or 0)
    lender = _plain(loan.institution_name.split()[0]) if loan.institution_name else ""
    rows = await session.execute(
        select(Transaction, Account.name, Account.display_name)
        .join(Account, Transaction.account_id == Account.id)
        .where(
            Transaction.workspace_id == loan.workspace_id,
            Transaction.type == "debit",
            Transaction.date >= loan.contract_date,
            Transaction.source.notin_(("opening_balance", MIRROR_SOURCE)),
            Account.id != loan.account_id if loan.account_id else true(),
        )
        .order_by(Transaction.date)
    )
    out: list[Suggestion] = []
    for tx, name, display in rows.all():
        if tx.id in linked:
            continue
        desc = _plain(tx.description or "")
        amount = abs(float(tx.amount_primary if tx.amount_primary is not None else tx.amount))
        installment_sized = installment and abs(amount - installment) <= max(1.0, installment * 0.01)
        financing_words = bool(_INSTALLMENT_PATTERNS.search(desc))
        lender_boleto = bool(lender) and "BOLETO" in desc and lender[:4] in desc
        if financing_words and installment_sized:
            kind, reason = "installment", "financing_installment"
        elif installment_sized and financing_words is False and lender_boleto:
            kind, reason = "installment", "lender_boleto_installment"
        elif lender_boleto or (financing_words and amount > installment):
            kind, reason = "extra", "lender_payment"
        else:
            continue
        out.append(Suggestion(tx.id, tx.date, tx.description, amount, display or name, kind, reason))
    return out


async def auto_link(session: AsyncSession, loan: Loan) -> int:
    """Link only unambiguous installments (financing wording and the exact
    installment amount). Early repayments stay suggestions for the user."""
    count = 0
    for s in await suggestions(session, loan):
        if s.reason == "financing_installment":
            session.add(LoanPayment(loan_id=loan.id, transaction_id=s.transaction_id, kind="installment"))
            count += 1
    if count:
        await session.flush()
        await recompute(session, loan)
    return count
