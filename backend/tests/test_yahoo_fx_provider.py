# backend/tests/test_yahoo_fx_provider.py
"""Yahoo FX provider tests. The yfinance download is stubbed — no network."""
from datetime import date
from decimal import Decimal

import pandas as pd
import pytest

from app.providers.yahoo_fx import YahooFxProvider, _symbol


def _multi_frame(data: dict[str, list[float | None]], index) -> pd.DataFrame:
    """Frame shaped like yfinance's multi-symbol result: MultiIndex columns."""
    cols = pd.MultiIndex.from_product([["Close", "Open"], list(data.keys())])
    frame = pd.DataFrame(index=index, columns=cols, dtype="float64")
    for sym, values in data.items():
        frame[("Close", sym)] = values
        frame[("Open", sym)] = values
    return frame


def test_symbol_format():
    assert _symbol("BRL") == "USDBRL=X"


def test_codes_excludes_usd_and_dedupes(monkeypatch):
    from app.providers import yahoo_fx

    class S:
        supported_currencies = "USD,BRL,EUR,brl, ,GBP"

    monkeypatch.setattr(yahoo_fx, "get_settings", lambda: S())
    assert YahooFxProvider._codes() == ["BRL", "EUR", "GBP"]


def test_last_closes_picks_most_recent_non_null():
    idx = pd.to_datetime(["2026-07-23", "2026-07-24", "2026-07-27"])
    frame = _multi_frame({"USDBRL=X": [5.0, 5.1, 5.25]}, idx)
    out = YahooFxProvider._last_closes(frame, ["USDBRL=X"])
    assert out["USDBRL=X"] == Decimal("5.25")


def test_last_closes_skips_trailing_nan():
    """A stale trailing NaN must not blank out an otherwise valid series."""
    idx = pd.to_datetime(["2026-07-23", "2026-07-24", "2026-07-27"])
    frame = _multi_frame({"USDBRL=X": [5.0, 5.1, None]}, idx)
    out = YahooFxProvider._last_closes(frame, ["USDBRL=X"])
    assert out["USDBRL=X"] == Decimal("5.1")


def test_last_closes_empty_frame():
    assert YahooFxProvider._last_closes(pd.DataFrame(), ["USDBRL=X"]) == {}
    assert YahooFxProvider._last_closes(None, ["USDBRL=X"]) == {}


def test_last_closes_ignores_all_nan_symbol():
    idx = pd.to_datetime(["2026-07-24"])
    frame = _multi_frame({"USDBRL=X": [5.1], "USDXXX=X": [None]}, idx)
    out = YahooFxProvider._last_closes(frame, ["USDBRL=X", "USDXXX=X"])
    assert "USDBRL=X" in out and "USDXXX=X" not in out


@pytest.mark.asyncio
async def test_rates_always_include_usd_as_one(monkeypatch):
    from app.providers import yahoo_fx

    class S:
        supported_currencies = "USD,BRL"

    monkeypatch.setattr(yahoo_fx, "get_settings", lambda: S())
    idx = pd.to_datetime(["2026-07-27"])
    monkeypatch.setattr(
        YahooFxProvider, "_download",
        staticmethod(lambda symbols, start, end: _multi_frame({"USDBRL=X": [5.11]}, idx)),
    )
    rates = await YahooFxProvider().fetch_latest()
    assert rates["USD"] == Decimal("1")
    assert rates["BRL"] == Decimal("5.11")


@pytest.mark.asyncio
async def test_partial_results_do_not_fail(monkeypatch):
    """One unquotable currency must not lose the ones Yahoo did return."""
    from app.providers import yahoo_fx

    class S:
        supported_currencies = "BRL,ZZZ"

    monkeypatch.setattr(yahoo_fx, "get_settings", lambda: S())
    idx = pd.to_datetime(["2026-07-27"])
    monkeypatch.setattr(
        YahooFxProvider, "_download",
        staticmethod(lambda symbols, start, end: _multi_frame({"USDBRL=X": [5.11]}, idx)),
    )
    rates = await YahooFxProvider().fetch_historical(date(2026, 7, 27))
    assert rates["BRL"] == Decimal("5.11")
    assert "ZZZ" not in rates
    assert rates["USD"] == Decimal("1")


@pytest.mark.asyncio
async def test_download_failure_is_raised(monkeypatch):
    from app.providers import yahoo_fx

    class S:
        supported_currencies = "BRL"

    def boom(symbols, start, end):
        raise ConnectionError("yahoo down")

    monkeypatch.setattr(yahoo_fx, "get_settings", lambda: S())
    monkeypatch.setattr(YahooFxProvider, "_download", staticmethod(boom))
    with pytest.raises(RuntimeError, match="Yahoo FX download failed"):
        await YahooFxProvider().fetch_latest()


def test_provider_selection(monkeypatch):
    """Yahoo is the default; OER wins only when an app id is configured."""
    from app.services import fx_rate_service

    class NoKey:
        openexchangerates_app_id = ""

    class WithKey:
        openexchangerates_app_id = "abc123"

    monkeypatch.setattr(fx_rate_service, "get_settings", lambda: NoKey())
    assert fx_rate_service._build_provider().name == "yahoo_fx"

    monkeypatch.setattr(fx_rate_service, "get_settings", lambda: WithKey())
    assert fx_rate_service._build_provider().name == "openexchangerates"
