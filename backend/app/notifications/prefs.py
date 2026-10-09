"""Per-user notification preferences, stored under
`user.preferences["notifications"]` so no schema change is needed."""

from typing import Any

from app.models.user import User

DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "email": None,  # None = the account email
    "monthly_report": True,
    "weekly_digest": True,
    "bill_reminders": True,
    "bill_reminder_days": 3,
    "spend_alerts": True,
    "large_transaction_threshold": 1000,
    "budget_alerts": True,
    "category_spike_alerts": True,
    "connection_alerts": True,
    "send_hour": 8,  # local hour from which scheduled emails go out
}


def get_prefs(user: User) -> dict[str, Any]:
    stored = (user.preferences or {}).get("notifications") or {}
    prefs = {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}
    return prefs


def recipient(user: User) -> str:
    return get_prefs(user).get("email") or user.email


def language(user: User) -> str:
    """'pt' for Portuguese speakers, else 'en' (the two languages the
    email templates ship in)."""
    prefs = user.preferences or {}
    lang = str(prefs.get("language") or prefs.get("lang") or "").lower()
    if lang.startswith("pt"):
        return "pt"
    if lang:
        return "en"
    # No explicit language: follow the display currency's locale.
    return "pt" if prefs.get("currency_display") == "BRL" else "en"
