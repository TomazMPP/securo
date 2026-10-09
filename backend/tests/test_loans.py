"""Loans pulled from Open Finance: Pluggy mapping, sync lifecycle, API.

Open Finance reports counts and the payment history but not the next
installment, so the mapping derives value and date; these tests pin those
derivations and the upsert/deactivate contract of `_sync_loans`.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.bank_connection import BankConnection
from app.models.loan import Loan
from app.models.user import User
from app.models.workspace import Workspace
from app.providers import register_provider
from app.providers.base import AccountData, BankProvider, ConnectionData, LoanData, TransactionData
from app.providers.pluggy import _add_months, _build_loan_data, _monthly_rate
from app.services.connection_service import _sync_loans


def _raw_loan(**overrides) -> dict:
    raw = {
        "id": "loan-1",
        "contractNumber": "123454471",
        "productName": "CDC Veículo",
        "type": "FINANCIAMENTO_AQUISICAO_BENS_VEICULOS_AUTOMOTORES",
        "kind": "FINANCING",
        "currencyCode": "BRL",
        "contractAmount": 84925,
        "CET": 0.179,
        "contractDate": "2024-10-25",
        "firstInstallmentDueDate": "2024-11-15",
        "dueDate": "2028-10-15",
        "installmentPeriodicity": "MENSAL",
        "amortizationScheduled": "PRICE",
        "interestRates": [{"taxPeriodicity": "AM", "preFixedRate": 0.0129}],
        "warranties": [{"type": "ALIENACAO_FIDUCIARIA", "amount": 92000}],
        "installments": {
            "totalNumberOfInstallments": 48,
            "paidInstallments": 23,
            "dueInstallments": 25,
            "pastDueInstallments": 0,
        },
        "payments": {
            "contractOutstandingBalance": 50673.40,
            "releases": [
                {"paidDate": "2026-08-15", "paidAmount": 2384.17, "isOverParcelPayment": False, "installmentId": "22"},
                {"paidDate": "2026-09-15", "paidAmount": 2384.17, "isOverParcelPayment": False, "installmentId": "23"},
                {"paidDate": "2026-09-20", "paidAmount": 5000, "isOverParcelPayment": True},
            ],
        },
    }
    raw.update(overrides)
    return raw


# ---------------------------------------------------------------------------
# Pluggy mapping
# ---------------------------------------------------------------------------


def test_build_loan_data_maps_contract_fields():
    loan = _build_loan_data(_raw_loan())
    assert loan is not None
    assert loan.external_id == "loan-1"
    assert loan.kind == "FINANCING"
    assert loan.contract_amount == Decimal("84925")
    assert loan.outstanding_balance == Decimal("50673.4")
    assert loan.cet == Decimal("0.179")
    assert loan.monthly_rate == Decimal("0.0129")
    assert (loan.total_installments, loan.paid_installments, loan.remaining_installments) == (48, 23, 25)
    assert loan.final_due_date == date(2028, 10, 15)
    assert loan.raw_data["warranties"][0]["type"] == "ALIENACAO_FIDUCIARIA"


def test_installment_amount_comes_from_latest_regular_payment():
    loan = _build_loan_data(_raw_loan())
    # The 5000 extra payment (over-parcel) is newer but isn't an installment.
    assert loan.installment_amount == Decimal("2384.17")
    assert [p["date"] for p in loan.payments] == ["2026-09-20", "2026-09-15", "2026-08-15"]


def test_installment_amount_falls_back_to_price_formula():
    raw = _raw_loan(payments={"contractOutstandingBalance": 50673.40, "releases": []})
    loan = _build_loan_data(raw)
    assert loan.installment_amount is not None
    assert abs(loan.installment_amount - Decimal("2384.17")) < Decimal("1.00")


def test_next_due_date_advances_first_due_by_paid_count():
    loan = _build_loan_data(_raw_loan())
    assert loan.next_due_date == date(2026, 10, 15)


def test_next_due_date_unknown_for_non_monthly_or_finished_contracts():
    assert _build_loan_data(_raw_loan(installmentPeriodicity="SEM_PERIODICIDADE_REGULAR")).next_due_date is None
    finished = _raw_loan(installments={"totalNumberOfInstallments": 48, "paidInstallments": 48})
    assert _build_loan_data(finished).next_due_date is None


def test_rates_reported_as_percentages_are_normalized():
    loan = _build_loan_data(_raw_loan(CET=17.9, interestRates=[{"taxPeriodicity": "AM", "preFixedRate": 1.29}]))
    assert loan.cet == Decimal("0.179")
    assert loan.monthly_rate == Decimal("0.0129")


def test_annual_rate_is_converted_to_monthly():
    rate = _monthly_rate([{"taxPeriodicity": "AA", "preFixedRate": 0.1665}])
    assert abs(float(rate) - 0.0129) < 0.0002


def test_post_fixed_contract_has_no_monthly_rate():
    assert _monthly_rate([{"taxPeriodicity": "AA", "postFixedRate": 0.02}]) is None


def test_add_months_clamps_to_month_end():
    assert _add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert _add_months(date(2026, 11, 15), 3) == date(2027, 2, 15)


def test_loan_without_id_is_skipped():
    assert _build_loan_data({"productName": "x"}) is None


# ---------------------------------------------------------------------------
# Sync lifecycle
# ---------------------------------------------------------------------------


class _LoanProvider(BankProvider):
    _loans: list[LoanData] = []
    _raise: Optional[Exception] = None

    @property
    def name(self) -> str:
        return "mockloans"

    async def get_oauth_url(self, redirect_uri, state, flow_params=None):  # pragma: no cover
        return "http://mock"

    async def handle_oauth_callback(self, code) -> ConnectionData:  # pragma: no cover
        raise NotImplementedError

    async def get_accounts(self, credentials) -> list[AccountData]:  # pragma: no cover
        return []

    async def get_transactions(self, credentials, account_external_id, since=None, payee_source="auto") -> list[TransactionData]:  # pragma: no cover
        return []

    async def refresh_credentials(self, credentials):  # pragma: no cover
        return credentials

    async def get_loans(self, credentials) -> list[LoanData]:
        if _LoanProvider._raise is not None:
            raise _LoanProvider._raise
        return list(_LoanProvider._loans)


@pytest.fixture(autouse=True)
def _register_loan_provider():
    register_provider("mockloans", _LoanProvider)
    _LoanProvider._loans = []
    _LoanProvider._raise = None
    yield


@pytest_asyncio.fixture
async def loan_connection(session: AsyncSession, test_user: User, test_workspace: Workspace) -> BankConnection:
    conn = BankConnection(
        id=uuid.uuid4(),
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        provider="mockloans",
        external_id="item-loans",
        institution_name="Itaú",
        credentials={"item_id": "item-loans"},
        status="active",
        created_at=datetime.now(timezone.utc),
    )
    session.add(conn)
    await session.commit()
    await session.refresh(conn)
    return conn


async def _loans(session: AsyncSession) -> list[Loan]:
    return list((await session.execute(select(Loan).order_by(Loan.external_id))).scalars())


async def test_sync_creates_and_updates_loans(session, test_user, loan_connection):
    _LoanProvider._loans = [_build_loan_data(_raw_loan())]
    await _sync_loans(session, test_user.id, loan_connection, loan_connection.credentials)
    await session.commit()
    rows = await _loans(session)
    assert len(rows) == 1
    assert rows[0].institution_name == "Itaú"
    assert rows[0].outstanding_balance == Decimal("50673.40")
    assert rows[0].is_active

    updated = _raw_loan()
    updated["payments"]["contractOutstandingBalance"] = 48700.10
    updated["installments"]["paidInstallments"] = 24
    _LoanProvider._loans = [_build_loan_data(updated)]
    await _sync_loans(session, test_user.id, loan_connection, loan_connection.credentials)
    await session.commit()
    rows = await _loans(session)
    assert len(rows) == 1
    await session.refresh(rows[0])
    assert rows[0].outstanding_balance == Decimal("48700.10")
    assert rows[0].paid_installments == 24


async def test_sync_deactivates_loans_no_longer_reported(session, test_user, loan_connection):
    _LoanProvider._loans = [_build_loan_data(_raw_loan()), _build_loan_data(_raw_loan(id="loan-2"))]
    await _sync_loans(session, test_user.id, loan_connection, loan_connection.credentials)
    await session.commit()

    _LoanProvider._loans = [_build_loan_data(_raw_loan())]
    await _sync_loans(session, test_user.id, loan_connection, loan_connection.credentials)
    await session.commit()
    rows = await _loans(session)
    for row in rows:
        await session.refresh(row)
    assert [(r.external_id, r.is_active) for r in rows] == [("loan-1", True), ("loan-2", False)]


async def test_sync_swallows_provider_errors(session, test_user, loan_connection):
    _LoanProvider._raise = RuntimeError("pluggy 500")
    await _sync_loans(session, test_user.id, loan_connection, loan_connection.credentials)
    assert await _loans(session) == []


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


async def test_list_and_get_loans(client: AsyncClient, auth_headers, session, test_user, loan_connection):
    _LoanProvider._loans = [_build_loan_data(_raw_loan())]
    await _sync_loans(session, test_user.id, loan_connection, loan_connection.credentials)
    await session.commit()

    resp = await client.get("/api/loans", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    loan = body[0]
    assert loan["product_name"] == "CDC Veículo"
    assert loan["paid_installments"] == 23
    assert loan["warranties"][0]["type"] == "ALIENACAO_FIDUCIARIA"
    assert len(loan["payments"]) == 3

    one = await client.get(f"/api/loans/{loan['id']}", headers=auth_headers)
    assert one.status_code == 200
    assert one.json()["contract_number"] == "123454471"

    missing = await client.get(f"/api/loans/{uuid.uuid4()}", headers=auth_headers)
    assert missing.status_code == 404


async def test_inactive_loans_hidden_by_default(client: AsyncClient, auth_headers, session, test_user, loan_connection):
    _LoanProvider._loans = [_build_loan_data(_raw_loan())]
    await _sync_loans(session, test_user.id, loan_connection, loan_connection.credentials)
    _LoanProvider._loans = []
    await _sync_loans(session, test_user.id, loan_connection, loan_connection.credentials)
    await session.commit()

    assert (await client.get("/api/loans", headers=auth_headers)).json() == []
    all_loans = (await client.get("/api/loans?include_inactive=true", headers=auth_headers)).json()
    assert len(all_loans) == 1 and all_loans[0]["is_active"] is False
