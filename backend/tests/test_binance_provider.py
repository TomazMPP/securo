# backend/tests/test_binance_provider.py
"""Binance provider tests. No network: signed/public reads are stubbed."""
import asyncio
from decimal import Decimal

from app.providers.binance import BinanceProvider, resolve_balance_asset


# Price table shaped like the real one: BTC/ETH/SOL/LDO have pairs, and
# crucially LDBTC does NOT (that is what makes it detectable as a wrapper).
PAIRS = {
    "BTCUSDT": "60000",
    "ETHUSDT": "3000",
    "SOLUSDT": "150",
    "LDOUSDT": "2",
}


def has_pair(pair: str) -> bool:
    return pair in PAIRS


# --- resolve_balance_asset ------------------------------------------------

def test_plain_crypto_resolves_to_itself():
    r = resolve_balance_asset("BTC", has_pair)
    assert (r.symbol, r.pair, r.kind, r.earn_wrapped) == ("BTC", "BTCUSDT", "CRYPTO", False)


def test_ldo_is_lido_not_an_earn_wrapper():
    """LDO starts with LD but has its own pair — must not be unwrapped to O."""
    r = resolve_balance_asset("LDO", has_pair)
    assert (r.symbol, r.kind, r.earn_wrapped) == ("LDO", "CRYPTO", False)


def test_ldbtc_unwraps_to_btc_as_earn():
    r = resolve_balance_asset("LDBTC", has_pair)
    assert (r.symbol, r.pair, r.kind, r.earn_wrapped) == ("BTC", "BTCUSDT", "CRYPTO", True)


def test_ldusdt_unwraps_to_the_quote_stable():
    r = resolve_balance_asset("LDUSDT", has_pair)
    assert (r.symbol, r.kind, r.earn_wrapped) == ("USDT", "STABLE_USD", True)


def test_usdt_is_stable():
    r = resolve_balance_asset("USDT", has_pair)
    assert (r.symbol, r.kind) == ("USDT", "STABLE_USD")


def test_brl_is_fiat():
    r = resolve_balance_asset("BRL", has_pair)
    assert (r.symbol, r.kind) == ("BRL", "FIAT_BRL")


def test_unknown_coin_keeps_symbol_and_has_no_pair():
    r = resolve_balance_asset("XYZNOPAIR", has_pair)
    assert (r.symbol, r.pair, r.kind) == ("XYZNOPAIR", None, "CRYPTO")


# --- get_holdings ---------------------------------------------------------

def _provider(spot, funding, *, funding_raises=False):
    p = BinanceProvider()

    async def fake_signed(credentials, path, params=None, method="GET"):
        if path == "/api/v3/account":
            return {"balances": spot}
        if path == "/sapi/v1/asset/get-funding-asset":
            if funding_raises:
                raise RuntimeError("funding unavailable")
            return funding
        raise AssertionError(f"unexpected signed path {path}")

    async def fake_public(path):
        assert path == "/api/v3/ticker/price"
        return [{"symbol": s, "price": px} for s, px in PAIRS.items()]

    p._signed_request = fake_signed  # type: ignore[assignment]
    p._public_request = fake_public  # type: ignore[assignment]
    return p


def _holdings(spot, funding=None, **kw):
    p = _provider(spot, funding or [], **kw)
    return {h.external_id: h for h in asyncio.run(p.get_holdings({"api_key": "k"}))}


def test_spot_balance_priced_and_summed():
    h = _holdings([{"asset": "BTC", "free": "0.4", "locked": "0.1"}])["SPOT:BTC"]
    assert h.quantity == Decimal("0.5")
    assert h.unit_price == Decimal("60000")
    assert h.current_value == Decimal("30000.0")
    assert h.ticker == "BTC"
    assert h.currency == "USD"


def test_zero_balances_are_dropped():
    h = _holdings([
        {"asset": "BTC", "free": "0", "locked": "0"},
        {"asset": "ETH", "free": "1", "locked": "0"},
    ])
    assert "SPOT:BTC" not in h and "SPOT:ETH" in h


def test_earn_wrapper_becomes_its_own_position():
    h = _holdings([
        {"asset": "BTC", "free": "1", "locked": "0"},
        {"asset": "LDBTC", "free": "2", "locked": "0"},
    ])
    assert set(h) == {"SPOT:BTC", "EARN:BTC"}
    assert h["EARN:BTC"].ticker == "BTC"
    assert h["EARN:BTC"].current_value == Decimal("120000")
    assert "Earn" in h["EARN:BTC"].name


def test_funding_wallet_sums_all_four_buckets():
    h = _holdings(
        [],
        [{"asset": "SOL", "free": "1", "locked": "2", "freeze": "3", "withdrawing": "4"}],
    )["FUNDING:SOL"]
    assert h.quantity == Decimal("10")
    assert h.current_value == Decimal("1500")


def test_funding_failure_does_not_lose_spot():
    h = _holdings([{"asset": "ETH", "free": "2", "locked": "0"}], funding_raises=True)
    assert "SPOT:ETH" in h and h["SPOT:ETH"].current_value == Decimal("6000")


def test_brl_is_valued_natively_at_par():
    h = _holdings([{"asset": "BRL", "free": "500", "locked": "0"}])["SPOT:BRL"]
    assert h.currency == "BRL"
    assert h.unit_price == Decimal("1")
    assert h.current_value == Decimal("500")


def test_unpriceable_coin_reports_quantity_but_no_value():
    """An unknown coin must never be given a fabricated value."""
    h = _holdings([{"asset": "XYZNOPAIR", "free": "7", "locked": "0"}])["SPOT:XYZNOPAIR"]
    assert h.quantity == Decimal("7")
    assert h.current_value == Decimal("0")
    assert h.unit_price is None
    assert h.metadata["priced"] is False


def test_currency_is_always_iso_never_the_ticker():
    """Regression guard for #448: a crypto ticker in `currency` breaks sync."""
    h = _holdings([
        {"asset": "BTC", "free": "1", "locked": "0"},
        {"asset": "XYZNOPAIR", "free": "1", "locked": "0"},
        {"asset": "BRL", "free": "1", "locked": "0"},
    ])
    for holding in h.values():
        assert len(holding.currency) == 3
        assert holding.currency in {"USD", "BRL"}


def test_no_accounts_and_no_transactions_are_returned():
    p = BinanceProvider()
    assert asyncio.run(p.get_accounts({})) == []
    assert asyncio.run(p.get_transactions({}, "whatever")) == []
