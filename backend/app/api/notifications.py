from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_active_user
from app.core.database import get_async_session
from app.models.user import User
from app.notifications import service
from app.notifications.email import email_configured
from app.notifications.prefs import DEFAULTS, get_prefs, recipient

router = APIRouter(prefix="/api/notifications", tags=["notifications"])

Kind = Literal["monthly", "weekly", "bills", "alerts"]


class NotificationPrefs(BaseModel):
    enabled: bool = True
    email: Optional[EmailStr] = None
    monthly_report: bool = True
    weekly_digest: bool = True
    bill_reminders: bool = True
    bill_reminder_days: int = Field(3, ge=1, le=14)
    spend_alerts: bool = True
    large_transaction_threshold: float = Field(1000, ge=0)
    budget_alerts: bool = True
    category_spike_alerts: bool = True
    connection_alerts: bool = True
    send_hour: int = Field(8, ge=0, le=23)


class NotificationSettings(BaseModel):
    preferences: NotificationPrefs
    email_configured: bool
    recipient: str


def _settings(user: User) -> NotificationSettings:
    return NotificationSettings(
        preferences=NotificationPrefs(**get_prefs(user)),
        email_configured=email_configured(),
        recipient=recipient(user),
    )


@router.get("/preferences", response_model=NotificationSettings)
async def get_preferences(user: User = Depends(current_active_user)):
    return _settings(user)


@router.put("/preferences", response_model=NotificationSettings)
async def update_preferences(
    body: NotificationPrefs,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
):
    db_user = await session.get(User, user.id)
    prefs = dict(db_user.preferences or {})
    prefs["notifications"] = {k: v for k, v in body.model_dump().items() if k in DEFAULTS}
    db_user.preferences = prefs  # reassign so the JSON column is flagged dirty
    await session.commit()
    await session.refresh(db_user)
    return _settings(db_user)


@router.post("/test/{kind}")
async def send_test(
    kind: Kind,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
):
    """Send one email of this kind now, marked as a test, ignoring schedules."""
    if not email_configured():
        raise HTTPException(status_code=409, detail="Email is not configured on this server")
    db_user = await session.get(User, user.id)
    sent = await service.send_test(session, db_user, kind)
    if not sent:
        raise HTTPException(status_code=502, detail="The email could not be sent")
    return {"sent": True, "to": recipient(db_user)}


@router.get("/preview/{kind}", response_class=HTMLResponse)
async def preview(
    kind: Kind,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
):
    """The email as it would be sent now, for the in-app preview."""
    db_user = await session.get(User, user.id)
    html = await service.preview(session, db_user, kind)
    if html is None:
        raise HTTPException(status_code=404, detail="Nothing to show")
    return HTMLResponse(html)
