"""Price-system loan arithmetic from contract terms plus real payments.

The bank's own schedule isn't available for a manually described contract,
so the balance is rebuilt from what happened: interest accrues on the
outstanding principal between events (compounded monthly, pro rata by
days over 30-day months), and each payment first covers the accrued
interest and then reduces principal. An extra payment therefore shortens
the contract — the installment stays the same and the last ones disappear,
which is how Brazilian banks apply "amortização com redução de prazo".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Optional


def add_months(start: date, months: int) -> date:
    year = start.year + (start.month - 1 + months) // 12
    month = (start.month - 1 + months) % 12 + 1
    for day in (start.day, 30, 29, 28):
        try:
            return date(year, month, day)
        except ValueError:
            continue
    return date(year, month, 28)


def price_payment(balance: float, rate: float, n: int) -> float:
    if n <= 0 or balance <= 0:
        return 0.0
    if rate == 0:
        return balance / n
    return balance * rate / (1 - (1 + rate) ** -n)


def implied_rate(principal: float, payment: float, n: int) -> Optional[float]:
    """Monthly rate that makes `n` payments of `payment` amortize `principal`
    (bisection; None when the numbers can't come from a Price contract)."""
    if principal <= 0 or payment <= 0 or n <= 0 or payment * n <= principal:
        return 0.0 if payment * n == principal else None
    lo, hi = 0.0, 1.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if price_payment(principal, mid, n) > payment:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


@dataclass
class PaymentIn:
    date: date
    amount: float
    kind: str  # installment | extra
    ref: Optional[str] = None


@dataclass
class PaymentSplit:
    date: date
    amount: float
    kind: str
    interest: float
    principal: float
    balance_after: float
    ref: Optional[str] = None


@dataclass
class Projected:
    date: date
    payment: float
    interest: float
    principal: float
    balance_after: float


@dataclass
class Schedule:
    principal: float
    rate: float
    installment: float
    total_installments: int
    contract_date: date
    first_due: date
    payments: list[PaymentSplit] = field(default_factory=list)
    projected: list[Projected] = field(default_factory=list)
    balance: float = 0.0  # principal outstanding after the last payment
    balance_today: float = 0.0  # including interest accrued since then
    interest_paid: float = 0.0
    principal_paid: float = 0.0
    baseline_interest: float = 0.0  # the contract as signed, no extra payments
    baseline_end: Optional[date] = None

    @property
    def remaining_installments(self) -> int:
        return len(self.projected)

    @property
    def paid_installments(self) -> int:
        """Installments the contract counts as settled: the original term
        minus what is still ahead (early repayments settle the last ones)."""
        return max(0, self.total_installments - self.remaining_installments)

    @property
    def payoff_date(self) -> Optional[date]:
        return self.projected[-1].date if self.projected else None

    @property
    def projected_interest(self) -> float:
        return sum(p.interest for p in self.projected)

    @property
    def total_interest(self) -> float:
        return self.interest_paid + self.projected_interest

    @property
    def interest_saved(self) -> float:
        return max(0.0, self.baseline_interest - self.total_interest)

    @property
    def months_saved(self) -> int:
        if not self.baseline_end or not self.payoff_date:
            return 0
        return max(0, (self.baseline_end.year - self.payoff_date.year) * 12 + self.baseline_end.month - self.payoff_date.month)

    @property
    def next_due(self) -> Optional[date]:
        return self.projected[0].date if self.projected else None


def _months_between(start: date, end: date) -> float:
    """Whole calendar months from start to end, plus leftover days / 30.
    Due dates a month apart count as exactly one period whatever the
    month's length, so a contract paid on schedule matches the bank's."""
    if end <= start:
        return 0.0
    months = 0
    while add_months(start, months + 1) <= end:
        months += 1
    return months + (end - add_months(start, months)).days / 30.0


def _accrue(balance: float, rate: float, start: date, end: date) -> float:
    return balance * ((1 + rate) ** _months_between(start, end) - 1)


def build_schedule(
    principal: float,
    rate: float,
    installment: float,
    total_installments: int,
    contract_date: date,
    first_due: date,
    payments: list[PaymentIn],
    today: date,
) -> Schedule:
    sched = Schedule(principal, rate, installment, total_installments, contract_date, first_due)

    # The contract as signed, for the "what extra payments saved" comparison.
    sched.baseline_interest = max(0.0, installment * total_installments - principal)
    sched.baseline_end = add_months(first_due, total_installments - 1)

    balance, last = principal, contract_date
    for p in sorted(payments, key=lambda x: (x.date, x.kind != "installment")):
        accrued = _accrue(balance, rate, last, p.date)
        interest = min(p.amount, accrued)
        principal_part = p.amount - interest
        balance = max(0.0, balance + accrued - p.amount)
        last = max(last, p.date)
        sched.interest_paid += interest
        sched.principal_paid += principal_part
        sched.payments.append(PaymentSplit(p.date, p.amount, p.kind, round(interest, 2), round(principal_part, 2), round(balance, 2), p.ref))
    sched.balance = round(balance, 2)
    sched.balance_today = round(balance + (_accrue(balance, rate, last, today) if today > last else 0.0), 2)

    # Project the remaining installments on their due dates. Due dates keep
    # the contract's day of month; the next one is the first due date not
    # yet covered by a regular installment.
    regular = sum(1 for p in payments if p.kind == "installment")
    due = add_months(first_due, regular)
    while due <= last and regular < total_installments:
        regular += 1
        due = add_months(first_due, regular)
    k = 0
    cursor = last
    while balance > 0.01 and k < 600:
        accrued = _accrue(balance, rate, cursor, due)
        payment = min(installment, balance + accrued)
        principal_part = payment - accrued
        balance = max(0.0, balance + accrued - payment)
        sched.projected.append(Projected(due, round(payment, 2), round(accrued, 2), round(principal_part, 2), round(balance, 2)))
        cursor = due
        k += 1
        due = add_months(first_due, regular + k)
    return sched
