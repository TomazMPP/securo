"""Decide which emails are due for a user and send them once.

`run_for_user` is called hourly by Celery. Each email kind has a local-time
window and a dedupe key recorded in `notification_log`, so re-runs are
no-ops and a failed send is retried on the next run.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta
from typing import Literal, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import get_workspace_timezone, use_resolved_timezone
from app.core.config import get_settings
from app.models.notification_log import NotificationLog
from app.models.user import User
from app.models.workspace import WorkspaceMember
from app.notifications import content, templates
from app.notifications.email import email_configured, send_email
from app.notifications.prefs import get_prefs, language, recipient

logger = logging.getLogger(__name__)

Kind = Literal["monthly", "weekly", "bills", "alerts"]


async def _sent_keys(session: AsyncSession, user_id: uuid.UUID, keys: list[str]) -> set[str]:
    if not keys:
        return set()
    rows = await session.execute(
        select(NotificationLog.key).where(NotificationLog.user_id == user_id, NotificationLog.key.in_(keys))
    )
    return set(rows.scalars())


async def _record(session: AsyncSession, user_id: uuid.UUID, kind: str, keys: list[str]) -> None:
    for key in keys:
        session.add(NotificationLog(user_id=user_id, kind=kind, key=key))
    await session.commit()


async def _primary_workspace(session: AsyncSession, user_id: uuid.UUID) -> Optional[uuid.UUID]:
    return await session.scalar(
        select(WorkspaceMember.workspace_id)
        .where(WorkspaceMember.user_id == user_id, WorkspaceMember.role.in_(("owner", "manager")))
        .order_by(WorkspaceMember.joined_at)
        .limit(1)
    )


async def render(
    session: AsyncSession, user: User, workspace_id: uuid.UUID, kind: Kind, today: date, test: bool = False
) -> Optional[tuple[str, str, str, list[str]]]:
    """Build one email. Returns (subject, html, text, dedupe keys), or None
    when there's nothing worth sending (no bills due, no alerts)."""
    prefs = get_prefs(user)
    lang = language(user)
    app_url = get_settings().frontend_url
    if kind == "monthly":
        month = content.prev_month(today)
        report = await content.build_monthly_report(session, workspace_id, user.id, month)
        subject, html, text = templates.render_monthly(report, lang, app_url, test)
        return subject, html, text, [f"monthly:{month:%Y-%m}"]
    if kind == "weekly":
        digest = await content.build_weekly_digest(session, workspace_id, user.id, today)
        iso = digest.start.isocalendar()
        subject, html, text = templates.render_weekly(digest, lang, app_url, test)
        return subject, html, text, [f"weekly:{iso.year}-W{iso.week:02d}"]
    if kind == "bills":
        days = max(1, min(int(prefs.get("bill_reminder_days") or 3), 14))
        until = today + timedelta(days=days)
        bills = await content.upcoming_bills(session, workspace_id, user.id, today, until)
        if not bills and not test:
            return None
        summary_currency = (await content.dashboard_service.get_summary(session, workspace_id, user.id, month=today)).primary_currency
        subject, html, text = templates.render_bills(bills, until, summary_currency, lang, app_url, test)
        return subject, html, text, [b.key for b in bills]
    alerts = await content.build_alerts(session, workspace_id, user.id, prefs, today)
    if not test:
        sent = await _sent_keys(session, user.id, [k for k, *_ in alerts.large + alerts.budgets + alerts.spikes + alerts.connections])
        alerts.large = [a for a in alerts.large if a[0] not in sent]
        alerts.budgets = [a for a in alerts.budgets if a[0] not in sent]
        alerts.spikes = [a for a in alerts.spikes if a[0] not in sent]
        alerts.connections = [a for a in alerts.connections if a[0] not in sent]
    if alerts.is_empty():
        return None
    subject, html, text = templates.render_alerts(alerts, float(prefs.get("large_transaction_threshold") or 0), lang, app_url, test)
    keys = [a[0] for a in alerts.large + alerts.budgets + alerts.spikes + alerts.connections]
    return subject, html, text, keys


def due_kinds(prefs: dict, now_local: datetime) -> list[Kind]:
    """Which kinds may go out at this local time. Dedupe keys stop repeats
    within the window, so the hourly job can safely offer them every hour."""
    if not prefs.get("enabled"):
        return []
    hour = now_local.hour
    send_hour = int(prefs.get("send_hour") or 8)
    kinds: list[Kind] = []
    if hour >= send_hour:
        if prefs.get("monthly_report") and now_local.day == 1:
            kinds.append("monthly")
        if prefs.get("weekly_digest") and now_local.weekday() == 0:
            kinds.append("weekly")
        if prefs.get("bill_reminders"):
            kinds.append("bills")
    # Alerts are time-sensitive but shouldn't wake anyone up.
    if 7 <= hour < 23 and any(prefs.get(k) for k in ("spend_alerts", "budget_alerts", "category_spike_alerts", "connection_alerts")):
        kinds.append("alerts")
    return kinds


async def run_for_user(session: AsyncSession, user: User) -> list[str]:
    """Send whatever is due for one user now. Returns the kinds sent."""
    if not email_configured():
        return []
    prefs = get_prefs(user)
    workspace_id = await _primary_workspace(session, user.id)
    if workspace_id is None:
        return []
    tz = await get_workspace_timezone(session, workspace_id)
    now_local = datetime.now(tz)
    sent_kinds: list[str] = []
    with use_resolved_timezone(tz):
        for kind in due_kinds(prefs, now_local):
            try:
                built = await render(session, user, workspace_id, kind, now_local.date())
            except Exception:  # noqa: BLE001 - one broken email must not block the rest
                logger.exception("Building %s email failed for user %s", kind, user.id)
                await session.rollback()
                continue
            if built is None:
                continue
            subject, html, text, keys = built
            fresh = [k for k in keys if k not in await _sent_keys(session, user.id, keys)]
            if not fresh:
                continue
            if await send_email(recipient(user), subject, html, text):
                await _record(session, user.id, kind, fresh)
                sent_kinds.append(kind)
    return sent_kinds


async def send_test(session: AsyncSession, user: User, kind: Kind) -> bool:
    workspace_id = await _primary_workspace(session, user.id)
    if workspace_id is None:
        return False
    tz = await get_workspace_timezone(session, workspace_id)
    with use_resolved_timezone(tz):
        built = await render(session, user, workspace_id, kind, datetime.now(tz).date(), test=True)
    if built is None:
        return False
    subject, html, text, _ = built
    return await send_email(recipient(user), subject, html, text)


async def preview(session: AsyncSession, user: User, kind: Kind) -> Optional[str]:
    workspace_id = await _primary_workspace(session, user.id)
    if workspace_id is None:
        return None
    tz = await get_workspace_timezone(session, workspace_id)
    with use_resolved_timezone(tz):
        built = await render(session, user, workspace_id, kind, datetime.now(tz).date(), test=True)
    return built[1] if built else None
