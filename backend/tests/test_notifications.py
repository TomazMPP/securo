"""Email notifications: formatting, scheduling windows, dedupe, templates, API.

Resend is never called: `send_email` is patched to record what would go out.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.core.app_clock import use_resolved_timezone, environment_timezone
from app.models.account import Account
from app.models.notification_log import NotificationLog
from app.models.transaction import Transaction
from app.notifications import content, service, templates
from app.notifications.fmt import money, pct, short_date
from app.notifications.prefs import DEFAULTS, get_prefs, language


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------


def test_money_formats_brl_the_brazilian_way():
    assert money(1234.5, "BRL", "pt") == "R$ 1.234,50"
    assert money(-80, "BRL", "pt") == "−R$ 80,00"
    assert money(15, "BRL", "pt", signed=True) == "+R$ 15,00"
    assert money(1234.5, "USD", "en") == "$1,234.50"


def test_pct_and_dates():
    assert pct(0.774, "pt") == "77%"
    assert pct(-0.125, "pt", digits=1) == "−12,5%"
    assert pct(0.2, "en", signed=True) == "+20%"
    assert short_date(date(2026, 10, 8), "pt") == "qui, 8 out"


# ---------------------------------------------------------------------------
# Preferences & schedule
# ---------------------------------------------------------------------------


class _U:
    def __init__(self, preferences=None, email="me@example.com"):
        self.preferences = preferences
        self.email = email


def test_prefs_merge_defaults_and_ignore_unknown_keys():
    prefs = get_prefs(_U({"notifications": {"weekly_digest": False, "bogus": 1}}))
    assert prefs["weekly_digest"] is False
    assert prefs["monthly_report"] is True
    assert "bogus" not in prefs


def test_language_follows_preference_or_currency():
    assert language(_U({"language": "pt-BR"})) == "pt"
    assert language(_U({"language": "en"})) == "en"
    assert language(_U({"currency_display": "BRL"})) == "pt"
    assert language(_U({})) == "en"


def test_due_kinds_respects_windows():
    prefs = dict(DEFAULTS)
    first_monday_9am = datetime(2026, 6, 1, 9)  # a Monday, day 1
    assert service.due_kinds(prefs, first_monday_9am) == ["monthly", "weekly", "bills", "alerts"]
    assert service.due_kinds(prefs, datetime(2026, 6, 1, 6)) == []  # too early for anything
    assert service.due_kinds(prefs, datetime(2026, 6, 3, 12)) == ["bills", "alerts"]
    assert service.due_kinds({**prefs, "enabled": False}, first_monday_9am) == []
    assert service.due_kinds({**prefs, "spend_alerts": False, "budget_alerts": False,
                              "category_spike_alerts": False, "connection_alerts": False,
                              "bill_reminders": False}, datetime(2026, 6, 3, 12)) == []


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


def _monthly(**kw) -> content.MonthlyReport:
    base = dict(
        month=date(2026, 9, 1), currency="BRL", income=18420.0, expenses=4286.13,
        prev_income=18000.0, prev_expenses=5000.0,
        categories=[content.CategoryLine("Moradia", "#2456E6", 1329.0, -0.1)],
        top_expenses=[content.TxLine(date(2026, 9, 10), "Aluguel <Pix>", "Moradia", 2540.0)],
        over_budget=[("Delivery", 600.0, 400.0)], net_worth=419920.6, net_worth_change=8612.0,
        goals=[("Reserva", 32400.0, 60000.0)], upcoming_total=5666.07, upcoming_count=4, uncategorized=3,
    )
    base.update(kw)
    return content.MonthlyReport(**base)


def test_monthly_template_shows_numbers_and_escapes_text():
    subject, html, text = templates.render_monthly(_monthly(), "pt", "https://app.example")
    assert subject == "Seu mês de setembro: +R$ 14.133,87"
    assert "Resumo de Setembro" in html
    assert "77%" in html  # savings rate
    assert "Aluguel &lt;Pix&gt;" in html  # descriptions are escaped
    assert "Orçamentos estourados" in html
    assert "https://app.example" in html
    assert "R$ 18.420,00" in text


def test_monthly_template_overspent_wording():
    _, html, _ = templates.render_monthly(_monthly(income=1000.0, expenses=1500.0), "pt", "x")
    assert "a mais do que entrou" in html


def test_bills_and_alerts_templates():
    bills = [content.BillLine(date(2026, 10, 15), "Financiamento", 2384.17, "loan", "k1")]
    subject, html, _ = templates.render_bills(bills, date(2026, 10, 18), "BRL", "pt", "x")
    assert subject == "1 conta vence nos próximos dias"
    assert "Parcela do financiamento" in html

    alerts = content.Alerts(currency="BRL", large=[("k", content.TxLine(date(2026, 10, 9), "TV", "Casa", 3999.0))])
    subject, html, _ = templates.render_alerts(alerts, 1000, "pt", "x")
    assert subject == "Alerta do Securo: gasto alto"
    assert "R$ 3.999,00" in html


# ---------------------------------------------------------------------------
# End-to-end with the database
# ---------------------------------------------------------------------------


@pytest.fixture
def outbox(monkeypatch):
    sent: list[tuple[str, str]] = []

    async def fake_send(to, subject, html, text=None):
        sent.append((to, subject))
        return True

    monkeypatch.setattr(service, "send_email", fake_send)
    monkeypatch.setattr(service, "email_configured", lambda: True)
    return sent


async def _large_tx(session, user, workspace, amount=Decimal("2500")):
    acct = Account(id=uuid.uuid4(), user_id=user.id, workspace_id=workspace.id, name="Conta", type="checking",
                   balance=Decimal("0"), currency="BRL")
    session.add(acct)
    session.add(Transaction(
        id=uuid.uuid4(), user_id=user.id, workspace_id=workspace.id, account_id=acct.id,
        description="Notebook", amount=amount, currency="BRL", type="debit",
        date=date.today(), source="manual", status="posted",
        created_at=datetime.now(timezone.utc),
    ))
    await session.commit()


async def test_alerts_are_sent_once(session, test_user, test_workspace, outbox, monkeypatch):
    await _large_tx(session, test_user, test_workspace)
    monkeypatch.setattr(service, "due_kinds", lambda prefs, now: ["alerts"])
    with use_resolved_timezone(environment_timezone()):
        first = await service.run_for_user(session, test_user)
        second = await service.run_for_user(session, test_user)
    assert first == ["alerts"]
    assert second == []
    assert len(outbox) == 1
    logged = (await session.execute(select(NotificationLog.key))).scalars().all()
    assert any(k.startswith("large_tx:") for k in logged)


async def test_alerts_respect_threshold(session, test_user, test_workspace, outbox, monkeypatch):
    await _large_tx(session, test_user, test_workspace, amount=Decimal("50"))
    monkeypatch.setattr(service, "due_kinds", lambda prefs, now: ["alerts"])
    assert await service.run_for_user(session, test_user) == []
    assert outbox == []


async def test_nothing_sent_without_email_config(session, test_user, test_workspace, monkeypatch):
    monkeypatch.setattr(service, "email_configured", lambda: False)
    assert await service.run_for_user(session, test_user) == []


async def test_monthly_report_builds_against_real_services(session, test_user, test_workspace):
    with use_resolved_timezone(environment_timezone()):
        report = await content.build_monthly_report(session, test_workspace.id, test_user.id, date.today().replace(day=1) - timedelta(days=1))
    assert report.currency
    assert report.expenses >= 0


async def test_weekly_digest_builds_against_real_services(session, test_user, test_workspace):
    with use_resolved_timezone(environment_timezone()):
        digest = await content.build_weekly_digest(session, test_workspace.id, test_user.id, date.today())
    assert digest.end - digest.start == timedelta(days=6)
    assert digest.start.weekday() == 0


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


async def test_preferences_roundtrip(client: AsyncClient, auth_headers):
    resp = await client.get("/api/notifications/preferences", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["preferences"]["monthly_report"] is True

    prefs = {**body["preferences"], "weekly_digest": False, "large_transaction_threshold": 500}
    resp = await client.put("/api/notifications/preferences", headers=auth_headers, json=prefs)
    assert resp.status_code == 200
    assert resp.json()["preferences"]["weekly_digest"] is False

    again = (await client.get("/api/notifications/preferences", headers=auth_headers)).json()
    assert again["preferences"]["large_transaction_threshold"] == 500


async def test_preferences_validation(client: AsyncClient, auth_headers):
    resp = await client.put("/api/notifications/preferences", headers=auth_headers,
                            json={**DEFAULTS, "bill_reminder_days": 40})
    assert resp.status_code == 422


async def test_test_email_requires_configuration(client: AsyncClient, auth_headers, monkeypatch):
    from app.api import notifications as api
    monkeypatch.setattr(api, "email_configured", lambda: False)
    resp = await client.post("/api/notifications/test/monthly", headers=auth_headers)
    assert resp.status_code == 409


async def test_preview_returns_html(client: AsyncClient, auth_headers, test_workspace):
    resp = await client.get("/api/notifications/preview/monthly", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "<html" in resp.text
