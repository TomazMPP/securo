import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.models.user import User
from app.notifications.email import email_configured
from app.notifications.service import run_for_user
from app.worker import celery_app

logger = logging.getLogger(__name__)


async def _run_all() -> dict:
    if not email_configured():
        return {"skipped": "email not configured"}
    engine = create_async_engine(get_settings().database_url)
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    sent: dict[str, list[str]] = {}
    try:
        async with session_maker() as session:
            user_ids = list((await session.execute(select(User.id).where(User.is_active.is_(True)))).scalars())
        for user_id in user_ids:
            try:
                async with session_maker() as session:
                    user = await session.get(User, user_id)
                    kinds = await run_for_user(session, user)
                    if kinds:
                        sent[str(user_id)] = kinds
            except Exception:  # noqa: BLE001
                logger.exception("Notification run failed for user %s", user_id)
    finally:
        await engine.dispose()
    return sent


@celery_app.task(name="app.tasks.notification_tasks.send_due_notifications")
def send_due_notifications() -> dict:
    """Hourly: send monthly reports, weekly digests, bill reminders and
    spending alerts that are due (each at most once, see notification_log)."""
    result = asyncio.run(_run_all())
    if result:
        logger.info("Notifications sent: %s", result)
    return result
