"""Manual loans: Price arithmetic from real payments, matching, principal
mirrors on the loan account, and the API.

The reference case is a real vehicle financing: R$ 77.408,95 in 24
installments of R$ 3.956,54 (≈1,70% a.m.), two regular installments and
two early repayments by boleto — which the bank reported as a balance of
~R$ 58.5k with the 7th installment next.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.account import Account
from app.models.loan import Loan, LoanPayment
from app.models.transaction import Transaction
from app.services import loan_service
from app.services.loan_math import PaymentIn, add_months, build_schedule, implied_rate, price_payment

PRINCIPAL, INSTALLMENT, N = 77408.95, 3956.54, 24
CONTRACT, FIRST_DUE = date(2026, 7, 21), date(2026, 8, 21)
REAL_PAYMENTS = [
    PaymentIn(date(2026, 8, 1), 8102.58, "extra"),
    PaymentIn(date(2026, 8, 21), 3956.54, "installment"),
    PaymentIn(date(2026, 9, 14), 5767.76, "extra"),
    PaymentIn(date(2026, 9, 21), 3956.54, "installment"),
]


# ---------------------------------------------------------------------------
# Math
# ---------------------------------------------------------------------------


def test_implied_rate_recovers_the_contract_rate():
    rate = implied_rate(PRINCIPAL, INSTALLMENT, N)
    assert abs(rate - 0.017) < 0.0005
    assert price_payment(PRINCIPAL, rate, N) == pytest.approx(INSTALLMENT, abs=0.01)


def test_implied_rate_rejects_impossible_terms():
    assert implied_rate(1000, 10, 12) is None  # pays back less than borrowed


def test_schedule_without_payments_follows_the_contract():
    rate = implied_rate(PRINCIPAL, INSTALLMENT, N)
    s = build_schedule(PRINCIPAL, rate, INSTALLMENT, N, CONTRACT, FIRST_DUE, [], date(2026, 7, 22))
    assert s.remaining_installments == N
    assert s.paid_installments == 0
    assert s.next_due == FIRST_DUE
    assert s.payoff_date == add_months(FIRST_DUE, N - 1)
    assert s.total_interest == pytest.approx(s.baseline_interest, rel=0.01)
    assert s.interest_saved < 200


def test_real_contract_matches_what_the_bank_reported():
    rate = implied_rate(PRINCIPAL, INSTALLMENT, N)
    s = build_schedule(PRINCIPAL, rate, INSTALLMENT, N, CONTRACT, FIRST_DUE, REAL_PAYMENTS, date(2026, 10, 9))
    # The bank showed R$ 58.532,39 outstanding and the 7th installment next.
    assert s.balance_today == pytest.approx(58532.39, rel=0.01)
    assert s.paid_installments == 6
    assert s.next_due == date(2026, 10, 21)
    # Early repayments shorten the contract and save interest.
    assert s.months_saved >= 3
    assert s.interest_saved > 4000
    assert s.payoff_date < add_months(FIRST_DUE, N - 1)


def test_payments_cover_interest_before_principal():
    rate = implied_rate(PRINCIPAL, INSTALLMENT, N)
    s = build_schedule(PRINCIPAL, rate, INSTALLMENT, N, CONTRACT, FIRST_DUE, REAL_PAYMENTS, date(2026, 10, 9))
    for p in s.payments:
        assert p.interest + p.principal == pytest.approx(p.amount, abs=0.02)
        assert p.interest >= 0
    assert s.principal_paid + s.balance == pytest.approx(PRINCIPAL, abs=1)


# ---------------------------------------------------------------------------
# Service + API against the database
# ---------------------------------------------------------------------------


@pytest.fixture
async def financing(session, test_user, test_workspace):
    checking = Account(id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id,
                       name="itau", type="checking", balance=Decimal("0"), currency="BRL")
    loan_acct = Account(id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id,
                        name="Financiamento", type="loan", balance=Decimal("0"), currency="BRL")
    session.add_all([checking, loan_acct])
    session.add(Transaction(id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id, account_id=loan_acct.id,
                            description="principal", amount=Decimal(str(PRINCIPAL)), currency="BRL", type="debit",
                            date=CONTRACT, source="opening_balance", status="posted"))
    txs = {}
    for desc, d, amt in [
        ("Pagamento de boleto ITAU-UNIBANCO HOLDING S/A", date(2026, 8, 1), "8102.58"),
        ("Pagamento de financiamento PAGTO FINANC VEIC 01/24", date(2026, 8, 21), "3956.54"),
        ("Pagamento de boleto ITAU-UNIBANCO HOLDING S/A", date(2026, 9, 14), "5767.76"),
        ("Pagamento de financiamento PAGTO FINANC VEIC 02/24", date(2026, 9, 21), "3956.54"),
        ("Supermercado", date(2026, 9, 2), "250.00"),
    ]:
        tx = Transaction(id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id, account_id=checking.id,
                         description=desc, amount=Decimal(amt), currency="BRL", type="debit", date=d,
                         source="sync", status="posted")
        session.add(tx)
        txs[(desc, d)] = tx
    await session.commit()
    return checking, loan_acct, txs


async def _create(client, auth_headers, loan_acct):
    resp = await client.post("/api/loans/manual", headers=auth_headers, json={
        "account_id": str(loan_acct.id), "product_name": "Financiamento Tiggo", "institution_name": "Itaú",
        "contract_amount": PRINCIPAL, "installment_amount": INSTALLMENT, "total_installments": N,
        "contract_date": CONTRACT.isoformat(), "first_installment_date": FIRST_DUE.isoformat(),
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_creating_a_loan_links_unambiguous_installments(client: AsyncClient, auth_headers, financing, session):
    _, loan_acct, _ = financing
    loan = await _create(client, auth_headers, loan_acct)
    assert loan["source"] == "manual"
    assert loan["account_id"] == str(loan_acct.id)
    linked = (await session.execute(select(LoanPayment.kind))).scalars().all()
    assert sorted(linked) == ["installment", "installment"]  # boletos stay suggestions

    sugg = (await client.get(f"/api/loans/{loan['id']}/suggestions", headers=auth_headers)).json()
    kinds = {(s["amount"], s["kind"]) for s in sugg}
    assert (8102.58, "extra") in kinds and (5767.76, "extra") in kinds
    assert all("Supermercado" not in s["description"] for s in sugg)


async def test_linking_extras_updates_balance_and_mirrors_principal(client: AsyncClient, auth_headers, financing, session):
    _, loan_acct, txs = financing
    loan = await _create(client, auth_headers, loan_acct)
    for (desc, d), tx in txs.items():
        if "BOLETO" in desc.upper():
            resp = await client.post(f"/api/loans/{loan['id']}/payments", headers=auth_headers,
                                     json={"transaction_id": str(tx.id), "kind": "extra"})
            assert resp.status_code == 200

    sched = (await client.get(f"/api/loans/{loan['id']}/schedule", headers=auth_headers)).json()
    assert sched["paid_installments"] == 6
    assert len(sched["payments"]) == 4
    assert sched["interest_saved"] > 4000

    # The loan account now carries the debt: opening principal minus mirrors.
    rows = (await session.execute(select(Transaction).where(Transaction.account_id == loan_acct.id))).scalars().all()
    mirrors = [t for t in rows if t.source == "loan_payment"]
    assert len(mirrors) == 4
    assert all(t.type == "credit" and t.exclude_from_pnl for t in mirrors)
    remaining = PRINCIPAL - sum(float(t.amount) for t in mirrors)
    assert remaining == pytest.approx(sched["balance"], abs=1)


async def test_unlinking_removes_the_mirror(client: AsyncClient, auth_headers, financing, session):
    _, loan_acct, txs = financing
    loan = await _create(client, auth_headers, loan_acct)
    first = next(tx for (desc, _), tx in txs.items() if "01/24" in desc)
    resp = await client.delete(f"/api/loans/{loan['id']}/payments/{first.id}", headers=auth_headers)
    assert resp.status_code == 200
    mirrors = (await session.execute(
        select(Transaction).where(Transaction.account_id == loan_acct.id, Transaction.source == "loan_payment")
    )).scalars().all()
    assert len(mirrors) == 1


async def test_only_debits_can_be_payments(client: AsyncClient, auth_headers, financing, session, test_user, test_workspace):
    checking, loan_acct, _ = financing
    loan = await _create(client, auth_headers, loan_acct)
    credit = Transaction(id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id, account_id=checking.id,
                         description="Salário", amount=Decimal("5000"), currency="BRL", type="credit",
                         date=date(2026, 9, 5), source="sync", status="posted")
    session.add(credit)
    await session.commit()
    resp = await client.post(f"/api/loans/{loan['id']}/payments", headers=auth_headers,
                             json={"transaction_id": str(credit.id), "kind": "extra"})
    assert resp.status_code == 422


async def test_deleting_a_manual_loan_removes_its_mirrors(client: AsyncClient, auth_headers, financing, session):
    _, loan_acct, _ = financing
    loan = await _create(client, auth_headers, loan_acct)
    assert (await client.delete(f"/api/loans/{loan['id']}", headers=auth_headers)).status_code == 204
    left = (await session.execute(
        select(Transaction).where(Transaction.account_id == loan_acct.id, Transaction.source == "loan_payment")
    )).scalars().all()
    assert left == []
    assert (await session.execute(select(Loan))).scalars().all() == []


async def test_open_finance_loans_cannot_be_edited(client: AsyncClient, auth_headers, session, test_user, test_workspace):
    loan = Loan(workspace_id=test_workspace.id, user_id=test_user.id, source="pluggy", external_id="x", currency="BRL", is_active=True)
    session.add(loan)
    await session.commit()
    resp = await client.patch(f"/api/loans/{loan.id}", headers=auth_headers, json={"product_name": "x"})
    assert resp.status_code == 409


async def test_schedule_needs_terms(client: AsyncClient, auth_headers, session, test_user, test_workspace):
    loan = Loan(workspace_id=test_workspace.id, user_id=test_user.id, source="pluggy", external_id="y", currency="BRL", is_active=True)
    session.add(loan)
    await session.commit()
    assert (await client.get(f"/api/loans/{loan.id}/schedule", headers=auth_headers)).status_code == 404
    assert loan_service.can_schedule(loan) is False
