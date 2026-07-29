"""FX rates from Yahoo Finance — no API key required.

Open Exchange Rates needs a signed-up app id, so an install without one gets
no rates at all. That is not a loud failure: ``get_rate`` falls back to 1:1 so
screens still render, which silently reports a USD balance as though it were
the primary currency. A self-hosted app shouldn't need a third-party account
just to convert currencies.

Yahoo already backs market prices in this codebase (``market_price.py``) and
quotes FX as ordinary symbols — ``USDBRL=X`` is USD→BRL — so the same
dependency covers rates for free.

Shape matches :class:`FxRateProvider`: both methods return ``{code: rate}``
where ``rate`` is USD→code, since ``fx_rate_service`` cross-rates through USD.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from app.core.config import get_settings
from app.providers.base import FxRateProvider

logger = logging.getLogger(__name__)

# Yahoo skips weekends and holidays. Walk back far enough that a Monday
# lookup still finds Friday's close, and a long holiday doesn't come back
# empty.
_LOOKBACK_DAYS = 10


def _symbol(code: str) -> str:
    return f"USD{code}=X"


class YahooFxProvider(FxRateProvider):
    """USD-based FX rates sourced from Yahoo Finance quotes."""

    @property
    def name(self) -> str:
        return "yahoo_fx"

    @staticmethod
    def _codes() -> list[str]:
        """Supported currencies minus USD, which is the base and always 1."""
        raw = get_settings().supported_currencies or ""
        seen: list[str] = []
        for part in raw.split(","):
            code = part.strip().upper()
            if code and code != "USD" and code not in seen:
                seen.append(code)
        return seen

    @staticmethod
    def _download(symbols: list[str], start: date, end: date):
        """Blocking yfinance call, isolated so it can run in a worker thread."""
        import yfinance as yf

        return yf.download(
            symbols,
            start=start.isoformat(),
            end=end.isoformat(),
            interval="1d",
            progress=False,
            auto_adjust=False,
        )

    @classmethod
    def _last_closes(cls, frame, symbols: list[str]) -> dict[str, Decimal]:
        """Pull the most recent non-null close per symbol.

        yfinance returns a single-level frame for one symbol and a MultiIndex
        for several, so the Close block is normalized before reading.
        """
        if frame is None or getattr(frame, "empty", True):
            return {}

        try:
            close = frame["Close"]
        except (KeyError, TypeError):
            return {}

        out: dict[str, Decimal] = {}
        for symbol in symbols:
            try:
                series = close[symbol] if hasattr(close, "columns") else close
            except (KeyError, IndexError):
                continue
            series = series.dropna()
            if series.empty:
                continue
            try:
                value = Decimal(str(float(series.iloc[-1])))
            except (InvalidOperation, ValueError, TypeError):
                continue
            if value > 0:
                out[symbol] = value
        return out

    async def _rates_asof(self, target: date) -> dict[str, Decimal]:
        codes = self._codes()
        if not codes:
            return {"USD": Decimal("1")}

        symbols = [_symbol(c) for c in codes]
        start = target - timedelta(days=_LOOKBACK_DAYS)
        # yfinance treats `end` as exclusive, so include the target day itself.
        end = target + timedelta(days=1)

        try:
            frame = await asyncio.to_thread(self._download, symbols, start, end)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Yahoo FX download failed: {exc}") from exc

        by_symbol = self._last_closes(frame, symbols)

        # USD is the base: always exactly 1, never fetched.
        rates: dict[str, Decimal] = {"USD": Decimal("1")}
        for code in codes:
            value = by_symbol.get(_symbol(code))
            if value is not None:
                rates[code] = value

        missing = [c for c in codes if c not in rates]
        if missing:
            # Partial results are still useful — every currency Yahoo did
            # return converts correctly, and the rest keep the existing
            # behaviour of falling back.
            logger.warning(
                "Yahoo FX returned no quote for %d currencies as of %s: %s",
                len(missing), target, ",".join(missing),
            )
        return rates

    async def fetch_latest(self) -> dict[str, Decimal]:
        return await self._rates_asof(date.today())

    async def fetch_historical(self, target_date: date) -> dict[str, Decimal]:
        return await self._rates_asof(target_date)
