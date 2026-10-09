"""Suggesting recurring bills from history."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

import pytest
from httpx import AsyncClient

from app.models.account import Account
from app.models.category import Category
from app.models.recurring_transaction import RecurringTransaction
from app.models.transaction import Transaction
from app.services import recurring_detection
from app.services.recurring_detection import normalize

TODAY = date(2026, 10, 9)


def test_normalize_drops_bank_noise():
    assert normalize("PIX ENVIADO - Cp :19540550-THIAGO OLIVEIRA CONSULTOR") == "THIAGO OLIVEIRA CONSULTOR"
    assert normalize("Pagamento de Pix QR Code ESTACIO RIBEIRAO PRETO") == "ESTACIO RIBEIRAO PRETO"
    assert normalize("DEBITO ICATU SEGUROS - 91596208") == "ICATU SEGUROS"


@pytest.fixture
async def history(session, test_user, test_workspace):
    acct = Account(id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id, name="itau",
                   type="checking", balance=Decimal("0"), currency="BRL")
    rent = Category(id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id, name="Rent", icon="key", color="#000000")
    session.add_all([acct, rent])

    def tx(desc, amount, d, cat=None):
        session.add(Transaction(id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id, account_id=acct.id,
                                description=desc, amount=Decimal(amount), currency="BRL", type="debit", date=d,
                                source="sync", status="posted", category_id=cat))

    for m in (6, 7, 8, 9):
        tx("Pagamento de Pix QR Code BTT TELECOMUNICACOES", "139.00", date(2026, m, 3))
        tx("PIX ENVIADO - Cp :1954-THIAGO OLIVEIRA IMOVEIS", "2809.00", date(2026, m, 16), rent.id)
        tx("IOF INTERNACIONAL - TWITCH", "1.01", date(2026, m, 23))
        for day in (2, 9, 16, 23):  # weekly groceries: spending, not a bill
            tx("SUPERMERCADO BH", "250.00", date(2026, m, day))
    tx("PIX ENVIADO - Cp :1111-ACADEMIA", "120.00", date(2026, 3, 5))  # stopped long ago
    tx("PIX ENVIADO - Cp :1111-ACADEMIA", "120.00", date(2026, 4, 5))
    tx("PIX ENVIADO - Cp :1111-ACADEMIA", "120.00", date(2026, 5, 5))
    await session.commit()
    return acct, rent


async def test_monthly_bills_are_suggested(session, test_workspace, history):
    found = {s.description: s for s in await recurring_detection.suggest(session, test_workspace.id, today=TODAY)}
    internet = next(s for name, s in found.items() if "BTT" in name)
    assert internet.amount == 139.0 and internet.day_of_month == 3 and internet.months == 4
    assert not internet.variable
    assert not any("SUPERMERCADO" in n for n in found)  # many times a month
    assert not any("ACADEMIA" in n for n in found)  # no longer active
    assert not any(n.startswith("IOF") for n in found)


async def test_bills_replaced_by_a_newer_registered_one_are_not_suggested(session, test_user, test_workspace, history):
    acct, rent = history
    before = await recurring_detection.suggest(session, test_workspace.id, today=TODAY)
    assert any("THIAGO" in s.description for s in before)
    session.add(RecurringTransaction(id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id,
                                     account_id=acct.id, category_id=rent.id, description="Aluguel novo",
                                     amount=Decimal("2600"), currency="BRL", type="debit", frequency="monthly",
                                     day_of_month=6, start_date=date(2026, 10, 6), next_occurrence=date(2026, 11, 6),
                                     auto_generate=False))
    await session.commit()
    after = await recurring_detection.suggest(session, test_workspace.id, today=TODAY)
    assert not any("THIAGO" in s.description for s in after)


async def test_suggestions_endpoint(client: AsyncClient, auth_headers, history):
    resp = await client.get("/api/recurring-transactions/suggestions", headers=auth_headers)
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
