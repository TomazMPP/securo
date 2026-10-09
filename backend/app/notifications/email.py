import logging
from typing import Optional

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)

RESEND_URL = "https://api.resend.com/emails"


def email_configured() -> bool:
    settings = get_settings()
    return bool(settings.resend_api_key and settings.email_from)


async def send_email(to: str, subject: str, html: str, text: Optional[str] = None) -> bool:
    """Send one email through Resend. Returns False (and logs) instead of
    raising, so a mail outage never breaks the job that triggered it."""
    settings = get_settings()
    if not email_configured():
        logger.info("Email not configured; skipping %r to %s", subject, to)
        return False
    payload = {"from": settings.email_from, "to": [to], "subject": subject, "html": html}
    if text:
        payload["text"] = text
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                RESEND_URL,
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                json=payload,
            )
    except httpx.HTTPError:
        logger.exception("Resend request failed for %r", subject)
        return False
    if resp.status_code >= 400:
        logger.warning("Resend rejected %r (%s): %s", subject, resp.status_code, resp.text[:300])
        return False
    return True
