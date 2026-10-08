from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_active_user
from app.core.config import get_settings
from app.core.database import get_async_session
from app.models.fx_rate import FxRate
from app.models.user import User
from app.services.fx_rate_service import sync_rates

router = APIRouter(prefix="/api/fx-rates", tags=["fx-rates"])


@router.post("/refresh")
async def refresh_rates(
    session: AsyncSession = Depends(get_async_session),
    user: User = Depends(current_active_user),
):
    """Trigger immediate FX rate sync."""
    count = await sync_rates(session, date.today())
    return {"synced": True, "rates_count": count, "date": date.today().isoformat()}


@router.get("/latest")
async def latest_rates(
    session: AsyncSession = Depends(get_async_session),
    user: User = Depends(current_active_user),
):
    """Latest stored USD-based rate per quote currency.

    Powers the client-side FX display view: any cross-rate is
    ``rates[to] / rates[from]``, so one small table lets the frontend
    re-express every amount in a chosen currency without a round trip
    per conversion. Per-quote latest (rather than one global latest date)
    because on-demand syncs don't land on the same day for every currency.
    """
    rows = (
        await session.execute(
            select(
                FxRate.quote_currency,
                FxRate.rate,
                FxRate.date,
            )
            .where(FxRate.base_currency == "USD")
            .order_by(FxRate.quote_currency, FxRate.date.desc())
        )
    ).all()

    rates: dict[str, float] = {}
    dates: list[date] = []
    for quote, rate, rate_date in rows:
        if quote in rates:  # rows are newest-first per quote
            continue
        rates[quote] = float(rate)
        dates.append(rate_date)
    # The base is always quotable against itself.
    rates.setdefault("USD", 1.0)

    return {
        "base": "USD",
        "date": max(dates).isoformat() if dates else None,
        "rates": rates,
    }


@router.get("/status")
async def rates_status(
    session: AsyncSession = Depends(get_async_session),
    user: User = Depends(current_active_user),
):
    """Return last sync date and total stored rates."""
    last_date = await session.scalar(
        select(func.max(FxRate.date))
    )
    total = await session.scalar(
        select(func.count()).select_from(FxRate)
    ) or 0

    settings = get_settings()
    return {
        "last_sync_date": last_date.isoformat() if last_date else None,
        "total_rates": total,
        "fx_sync_mode": settings.fx_sync_mode,
    }
