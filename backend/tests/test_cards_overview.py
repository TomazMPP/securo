"""Cards overview: limits across cards, closed vs open bills, installment
plans rebuilt from per-installment rows, and future commitments."""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

import pytest
from httpx import AsyncClient

from app.core.app_clock import environment_timezone, use_resolved_timezone
from app.models.account import Account
from app.models.credit_card_bill import CreditCardBill
from app.models.transaction import Transaction
from app.services import card_service
from app.services.card_service import clean_description, month_key, shift_month

TODAY = date(2026, 10, 9)


def test_clean_description_strips_installment_suffix():
    assert clean_description("MAGALU*MagaluFRANC01/10") == "MAGALU*MagaluFRANC"
    assert clean_description("SEPHORA STORESAO P 03/10") == "SEPHORA STORESAO P"
    assert clean_description("Netflix") == "Netflix"


def test_month_helpers():
    assert shift_month("2026-11", 3) == "2027-02"
    assert shift_month("2026-01", -1) == "2025-12"
    assert month_key(date(2026, 10, 9)) == "2026-10"


def _card(user, ws, name, limit, due_day, close_day=None, group=None):
    return Account(id=uuid.uuid4(), user_id=user.id, workspace_id=ws.id, name=name, type="credit_card",
                   balance=Decimal("0"), currency="BRL", credit_limit=Decimal(str(limit)),
                   payment_due_day=due_day, statement_close_day=close_day, shared_balance_group=group)


def _tx(user, ws, card, desc, amount, d, eff, n=None, total=None, purchase=None, typ="debit"):
    return Transaction(id=uuid.uuid4(), user_id=user.id, workspace_id=ws.id, account_id=card.id, description=desc,
                       amount=Decimal(str(amount)), currency="BRL", type=typ, date=d, effective_date=eff,
                       source="sync", status="posted", installment_number=n, total_installments=total,
                       installment_purchase_date=purchase)


@pytest.fixture
async def cards_data(session, test_user, test_workspace):
    u, ws = test_user, test_workspace
    itau = _card(u, ws, "Itau Uniclass", 37099, due_day=13)
    xp = _card(u, ws, "XP Infinite", 20000, due_day=1, close_day=25)
    session.add_all([itau, xp])
    # A 10x plan booked ahead, with the purchase date drifting by a day
    # across installments (seen on real Itaú data).
    for n in range(1, 11):
        eff = date(2026, 8 + n, 10) if n <= 4 else date(2027, n - 4, 10)
        session.add(_tx(u, ws, itau, f"SEPHORA STORESAO P{n:02d}/10", "164.70", eff, eff, n, 10,
                        date(2026, 8, 26) if n <= 2 else date(2026, 8, 27)))
    # A 3x plan where only the current installment row exists.
    session.add(_tx(u, ws, xp, "INSIDER 02/03", "278.99", date(2026, 10, 2), date(2026, 11, 1), 2, 3, date(2026, 9, 2)))
    # A plain purchase on the open Itaú bill and a closed bill the bank published.
    session.add(_tx(u, ws, itau, "Supermercado", "300.00", date(2026, 10, 7), date(2026, 11, 13)))
    session.add(CreditCardBill(id=uuid.uuid4(), user_id=u.id, workspace_id=ws.id, account_id=itau.id,
                               external_id="b1", due_date=date(2026, 10, 13), total_amount=Decimal("6820.48")))
    await session.commit()
    return itau, xp


async def _overview(session, ws):
    with use_resolved_timezone(environment_timezone()):
        return await card_service.overview(session, ws.id, today=TODAY)


async def test_published_bill_is_closed_and_next_one_is_open(session, test_workspace, cards_data, monkeypatch):
    itau, _ = cards_data
    monkeypatch.setattr(card_service, "app_today", lambda: TODAY)
    o = await _overview(session, test_workspace)
    card = next(c for c in o.cards if c.id == itau.id)
    assert card.closed_bill == 6820.48
    assert card.closed_due == date(2026, 10, 13)
    assert card.bill_key == "2026-11"
    assert card.current_bill == pytest.approx(300 + 164.70)  # Nov installment + the purchase


async def test_installment_plans_are_rebuilt_once(session, test_workspace, cards_data):
    o = await _overview(session, test_workspace)
    sephora = [p for p in o.plans if p.description.startswith("SEPHORA")]
    assert len(sephora) == 1  # drifting purchase date doesn't split the plan
    plan = sephora[0]
    assert plan.total == 10 and plan.installment == 164.70
    assert plan.first_month == "2026-09" and plan.last_month == "2027-06"

    insider = next(p for p in o.plans if p.description.startswith("INSIDER"))
    assert insider.first_month == "2026-10" and insider.last_month == "2026-12"


async def test_commitments_and_totals(session, test_workspace, cards_data):
    o = await _overview(session, test_workspace)
    assert o.total_limit == 37099 + 20000
    nov = o.commitments["2026-11"]
    assert sum(nov.values()) == pytest.approx(164.70 + 278.99)
    assert "2026-10" not in o.commitments or all(v >= 0 for v in o.commitments["2026-10"].values())
    assert o.future_installments > 0


async def test_shared_credit_line_counts_once(session, test_user, test_workspace):
    session.add_all([_card(test_user, test_workspace, "A", 10000, 10, group="g"),
                     _card(test_user, test_workspace, "B", 10000, 10, group="g")])
    await session.commit()
    o = await _overview(session, test_workspace)
    assert o.total_limit == 10000


async def test_api_overview(client: AsyncClient, auth_headers, cards_data):
    resp = await client.get("/api/cards/overview", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_limit"] == 57099
    assert {c["name"] for c in body["cards"]} == {"Itau Uniclass", "XP Infinite"}
    assert any(p["description"].startswith("SEPHORA") for p in body["plans"])
    assert body["commitments"] and body["commitments"][0]["month"] <= body["commitments"][-1]["month"]


async def test_api_without_cards(client: AsyncClient, auth_headers, test_workspace):
    body = (await client.get("/api/cards/overview", headers=auth_headers)).json()
    assert body["cards"] == [] and body["total_limit"] == 0


async def test_open_bill_counts_installments_the_bank_has_not_booked_yet(session, test_workspace, cards_data):
    _, xp = cards_data
    o = await _overview(session, test_workspace)
    card = next(c for c in o.cards if c.id == xp.id)
    # XP booked only installment 2/3 (Nov bill); the open bill is Nov, so
    # nothing is missing there.
    assert card.projected_in_bill == 0
    plan = next(p for p in o.plans if p.description.startswith("INSIDER"))
    assert plan.booked == {"2026-11"}
