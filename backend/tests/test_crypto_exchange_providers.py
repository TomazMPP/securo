# backend/tests/test_crypto_exchange_providers.py
"""Exchange connector tests. Network calls are stubbed — nothing goes out."""
import asyncio
import base64
import hashlib
import hmac
import time
import urllib.parse
from contextlib import contextmanager
from decimal import Decimal

from app.providers.base import SessionExpiredError
from app.providers.binance import BinanceProvider
from app.providers.bybit import BybitProvider
from app.providers.coinbase import CoinbaseProvider, _load_cdp_key, _looks_like_cdp
from app.providers.crypto_exchange import (
    CryptoExchangeProvider,
    WalletBalance,
    resolve_asset,
    to_decimal,
)
from app.providers.kraken import KrakenProvider, _normalize_asset

PRICES = {
    "BTCUSDT": Decimal("60000"),
    "ETHUSDT": Decimal("3000"),
    "SOLUSDT": Decimal("150"),
    "LDOUSDT": Decimal("2"),
    "DOTUSDT": Decimal("5"),
}


def has_pair(p: str) -> bool:
    return p in PRICES


def run(coro):
    # NOT asyncio.run(): that resets the thread's event-loop slot on exit,
    # which kills the session-scoped loop pytest-asyncio (asyncio_mode=auto)
    # shares across every other async test in the run.
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _holdings(provider: CryptoExchangeProvider, balances, fallback=None):
    """Drive get_holdings with a fixed balance set and price table.

    Both oracles are stubbed, so nothing here reaches the network. `fallback`
    stands in for the per-symbol lookup and defaults to knowing nothing.
    """
    async def fake_balances(_creds):
        return balances

    async def fake_prices():
        return PRICES

    async def fake_fallback(symbols):
        return {s: p for s, p in (fallback or {}).items() if s in symbols}

    provider.fetch_balances = fake_balances  # type: ignore[assignment]
    import app.providers.crypto_exchange as ce
    originals = (ce.fetch_price_table, ce.fetch_fallback_prices)
    ce.fetch_price_table = fake_prices  # type: ignore[assignment]
    ce.fetch_fallback_prices = fake_fallback  # type: ignore[assignment]
    try:
        return {h.external_id: h for h in run(provider.get_holdings({}))}
    finally:
        ce.fetch_price_table, ce.fetch_fallback_prices = originals  # type: ignore[assignment]


# --- shared resolution ----------------------------------------------------

def test_to_decimal_tolerates_junk():
    assert to_decimal("1.5") == Decimal("1.5")
    assert to_decimal(None) == Decimal("0")
    assert to_decimal("not-a-number") == Decimal("0")


def test_fiat_is_valued_in_its_own_currency():
    r = resolve_asset("BRL", has_pair)
    assert (r.symbol, r.kind, r.pair) == ("BRL", "FIAT", None)


def test_usd_stablecoins_are_pinned_to_one():
    for sym in ("USDT", "USDC", "FDUSD"):
        assert resolve_asset(sym, has_pair).kind == "STABLE_USD"


def test_unknown_coin_has_no_pair():
    r = resolve_asset("XYZNOPAIR", has_pair)
    assert (r.kind, r.pair) == ("CRYPTO", None)


def test_unpriceable_coin_reports_quantity_without_value():
    class P(CryptoExchangeProvider):
        @property
        def name(self): return "test"
        async def handle_oauth_callback(self, code): ...
        async def refresh_credentials(self, c): return c

    h = _holdings(P(), [WalletBalance("SPOT", "XYZNOPAIR", Decimal("7"))])["SPOT:XYZNOPAIR"]
    assert h.quantity == Decimal("7")
    assert h.current_value == Decimal("0")
    assert h.unit_price is None
    assert h.metadata["priced"] is False


def test_fallback_oracle_prices_coins_absent_from_the_table():
    """HYPE has no Binance pair; the per-symbol oracle still values it."""
    class P(CryptoExchangeProvider):
        @property
        def name(self): return "test"
        async def handle_oauth_callback(self, code): ...
        async def refresh_credentials(self, c): return c

    h = _holdings(
        P(),
        [WalletBalance("SPOT", "HYPE", Decimal("12"))],
        fallback={"HYPE": Decimal("56")},
    )["SPOT:HYPE"]
    assert h.unit_price == Decimal("56")
    assert h.current_value == Decimal("672")
    assert h.metadata["price_source"] == "fallback"


def test_fallback_is_only_consulted_for_unpriced_coins():
    """A coin with a pair must not be re-quoted, even if the fallback knows it."""
    class P(CryptoExchangeProvider):
        @property
        def name(self): return "test"
        async def handle_oauth_callback(self, code): ...
        async def refresh_credentials(self, c): return c

    h = _holdings(
        P(),
        [WalletBalance("SPOT", "BTC", Decimal("1"))],
        fallback={"BTC": Decimal("1")},   # wrong on purpose
    )["SPOT:BTC"]
    assert h.unit_price == Decimal("60000")
    assert h.metadata["price_source"] == "oracle"


def test_halted_pairs_are_dropped_from_the_price_table():
    """A delisted pair keeps its frozen last price on the ticker endpoint
    (XMRUSDT sat at 118.70 long after delisting); it must not price anything."""
    from app.providers.crypto_exchange import price_table_from_rows

    rows = [{"symbol": "BTCUSDT", "price": "82676.01"}, {"symbol": "XMRUSDT", "price": "118.70"}]
    table = price_table_from_rows(rows, {"BTCUSDT"})
    assert table == {"BTCUSDT": Decimal("82676.01")}


def test_price_table_unfiltered_when_trading_list_unavailable():
    from app.providers.crypto_exchange import price_table_from_rows

    rows = [{"symbol": "BTCUSDT", "price": "1"}, {"symbol": "XMRUSDT", "price": "2"}]
    assert set(price_table_from_rows(rows, None)) == {"BTCUSDT", "XMRUSDT"}


def test_fallback_tries_kraken_when_coinbase_has_no_quote():
    """XMR is listed on neither Binance nor Coinbase; Kraken's public ticker
    (keyed by its own pair code) still values it."""
    import httpx
    import app.providers.crypto_exchange as ce

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.coinbase.com":
            return httpx.Response(404, json={"errors": [{"id": "not_found"}]})
        assert request.url.params["pair"] == "XMRUSD"
        return httpx.Response(200, json={"error": [], "result": {"XXMRZUSD": {"c": ["518.05", "0.28"]}}})

    real_client = httpx.AsyncClient
    ce.httpx.AsyncClient = lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)  # type: ignore[assignment]
    try:
        assert run(ce.fetch_fallback_prices({"XMR"})) == {"XMR": Decimal("518.05")}
    finally:
        ce.httpx.AsyncClient = real_client  # type: ignore[assignment]


def test_kraken_ticker_error_reply_is_no_quote():
    from app.providers.crypto_exchange import _kraken_last_trade

    assert _kraken_last_trade({"error": ["EQuery:Unknown asset pair"], "result": {}}) == Decimal("0")


def test_currency_is_always_iso_never_the_ticker():
    """Regression guard for #448: a crypto ticker in `currency` breaks sync."""
    class P(CryptoExchangeProvider):
        @property
        def name(self): return "test"
        async def handle_oauth_callback(self, code): ...
        async def refresh_credentials(self, c): return c

    h = _holdings(P(), [
        WalletBalance("SPOT", "BTC", Decimal("1")),
        WalletBalance("SPOT", "BRL", Decimal("10")),
        WalletBalance("SPOT", "XYZNOPAIR", Decimal("1")),
    ])
    for holding in h.values():
        assert len(holding.currency) == 3
        assert holding.currency in {"USD", "BRL"}


def test_exchanges_return_no_accounts_or_transactions():
    for p in (BinanceProvider(), KrakenProvider(), CoinbaseProvider(), BybitProvider()):
        assert run(p.get_accounts({})) == []
        assert run(p.get_transactions({}, "x")) == []
        assert p.flow_type == "token"


# --- Binance --------------------------------------------------------------

def test_binance_unwraps_earn_wrapper():
    h = _holdings(BinanceProvider(), [
        WalletBalance("SPOT", "BTC", Decimal("1")),
        WalletBalance("SPOT", "LDBTC", Decimal("2")),
    ])
    assert set(h) == {"SPOT:BTC", "EARN:BTC"}
    assert h["EARN:BTC"].current_value == Decimal("120000")
    assert "Earn" in h["EARN:BTC"].name


def test_binance_does_not_mistake_lido_for_a_wrapper():
    """LDO starts with LD but has its own pair — must not become 'O'."""
    h = _holdings(BinanceProvider(), [WalletBalance("SPOT", "LDO", Decimal("5"))])
    assert "SPOT:LDO" in h
    assert h["SPOT:LDO"].current_value == Decimal("10")


def test_binance_unwraps_stablecoin_earn():
    h = _holdings(BinanceProvider(), [WalletBalance("SPOT", "LDUSDT", Decimal("100"))])
    assert "EARN:USDT" in h
    assert h["EARN:USDT"].current_value == Decimal("100")


def test_binance_funding_wallet_labelled():
    h = _holdings(BinanceProvider(), [WalletBalance("FUNDING", "SOL", Decimal("2"))])
    assert "FUNDING:SOL" in h
    assert "Funding" in h["FUNDING:SOL"].name


def test_binance_missing_funding_permission_degrades_to_spot_only():
    p = BinanceProvider()

    async def fake_signed(_creds, path, params=None, method="GET"):
        if "funding" in path:
            raise SessionExpiredError("no permission")
        return {"balances": [{"asset": "BTC", "free": "1", "locked": "0"}]}

    p._signed = fake_signed  # type: ignore[assignment]
    balances = {(b.wallet, b.asset) for b in run(p.fetch_balances({}))}
    assert balances == {("SPOT", "BTC")}


def test_binance_transient_funding_failure_aborts_instead_of_dropping_wallets():
    """Same archive hazard as Bybit: a shrunken list hides holdings for good."""
    p = BinanceProvider()

    async def fake_signed(_creds, path, params=None, method="GET"):
        if "funding" in path:
            raise RuntimeError("rate limited")
        return {"balances": [{"asset": "BTC", "free": "1", "locked": "0"}]}

    p._signed = fake_signed  # type: ignore[assignment]
    try:
        run(p.fetch_balances({}))
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected the transient funding failure to propagate")


# --- Kraken ---------------------------------------------------------------

def test_kraken_legacy_asset_codes():
    assert _normalize_asset("XXBT") == ("BTC", None)
    assert _normalize_asset("XBT") == ("BTC", None)
    assert _normalize_asset("ZUSD") == ("USD", None)
    assert _normalize_asset("XETH") == ("ETH", None)
    assert _normalize_asset("XXDG") == ("DOGE", None)


def test_kraken_staking_suffix_becomes_a_wallet():
    assert _normalize_asset("DOT.S") == ("DOT", "STAKING")
    assert _normalize_asset("ETH.F") == ("ETH", "EARN")
    assert _normalize_asset("ETH2") == ("ETH", "STAKING")
    assert _normalize_asset("ETH2.S") == ("ETH", "STAKING")


def test_kraken_plain_symbol_untouched():
    assert _normalize_asset("SOL") == ("SOL", None)


def test_kraken_staked_and_spot_stay_separate_positions():
    h = _holdings(KrakenProvider(), [
        WalletBalance("SPOT", "DOT", Decimal("10")),
        WalletBalance("SPOT", "DOT.S", Decimal("4")),
    ])
    assert set(h) == {"SPOT:DOT", "STAKING:DOT"}
    assert h["STAKING:DOT"].current_value == Decimal("20")


def test_kraken_staking_variants_merge_into_one_position():
    """DOT.S and DOT.P are both staked DOT; two holdings would collide on
    the same STAKING:DOT external_id downstream."""
    h = _holdings(KrakenProvider(), [
        WalletBalance("SPOT", "DOT.S", Decimal("4")),
        WalletBalance("SPOT", "DOT.P", Decimal("6")),
    ])
    assert set(h) == {"STAKING:DOT"}
    assert h["STAKING:DOT"].quantity == Decimal("10")
    assert h["STAKING:DOT"].current_value == Decimal("50")


def test_kraken_signature_matches_documented_scheme():
    """HMAC-SHA512 over path + SHA256(nonce + body), key base64-decoded."""
    secret = base64.b64encode(b"kraken-test-secret").decode()
    nonce = "1700000000000"
    path = "/0/private/Balance"
    body = urllib.parse.urlencode({"nonce": nonce})
    expected = base64.b64encode(
        hmac.new(
            base64.b64decode(secret),
            path.encode() + hashlib.sha256((nonce + body).encode()).digest(),
            hashlib.sha512,
        ).digest()
    ).decode()
    # Recompute exactly as the provider does.
    sha = hashlib.sha256((nonce + body).encode()).digest()
    got = base64.b64encode(
        hmac.new(base64.b64decode(secret), path.encode() + sha, hashlib.sha512).digest()
    ).decode()
    assert got == expected


def test_kraken_rejects_non_base64_secret():
    p = KrakenProvider()
    creds = {"api_key": "k", "api_secret": "!!!not-base64!!!"}
    try:
        run(p._private(creds, "/0/private/Balance"))
    except Exception as e:
        assert "base64" in str(e).lower()
    else:
        raise AssertionError("expected a failure for a non-base64 secret")


# --- Coinbase -------------------------------------------------------------

def test_coinbase_detects_credential_generation():
    assert _looks_like_cdp({"private_key_enc": "x"}) is True
    assert _looks_like_cdp({"private_key": "x"}) is True
    assert _looks_like_cdp({"api_secret_enc": "x"}) is False


def test_coinbase_sums_available_and_held():
    p = CoinbaseProvider()
    pages = [{
        "accounts": [
            {"currency": "BTC",
             "available_balance": {"value": "0.4"}, "hold": {"value": "0.1"}},
            {"currency": "USDC",
             "available_balance": {"value": "250"}, "hold": {"value": "0"}},
            {"currency": "ETH",
             "available_balance": {"value": "0"}, "hold": {"value": "0"}},
        ],
        "has_next": False,
    }]

    async def fake_get(_creds, _path):
        return pages.pop(0)

    p._get = fake_get  # type: ignore[assignment]
    balances = {b.asset: b.quantity for b in run(p.fetch_balances({}))}
    assert balances["BTC"] == Decimal("0.5")   # available + hold
    assert balances["USDC"] == Decimal("250")
    assert "ETH" not in balances               # zero balances dropped


def test_coinbase_follows_pagination():
    p = CoinbaseProvider()
    pages = [
        {"accounts": [{"currency": "BTC", "available_balance": {"value": "1"}, "hold": {"value": "0"}}],
         "has_next": True, "cursor": "next-page"},
        {"accounts": [{"currency": "SOL", "available_balance": {"value": "3"}, "hold": {"value": "0"}}],
         "has_next": False},
    ]
    calls: list[str] = []

    async def fake_get(_creds, path):
        calls.append(path)
        return pages[len(calls) - 1]

    p._get = fake_get  # type: ignore[assignment]
    balances = {b.asset for b in run(p.fetch_balances({}))}
    assert balances == {"BTC", "SOL"}
    assert len(calls) == 2
    assert "cursor=next-page" in calls[1]


def test_coinbase_rejects_credentials_without_any_secret():
    p = CoinbaseProvider()
    try:
        run(p.handle_oauth_callback('{"api_key": "only-a-name"}'))
    except ValueError as e:
        assert "private_key" in str(e)
    else:
        raise AssertionError("expected a ValueError")


# --- Bybit ------------------------------------------------------------------

def _bybit_router(payloads: dict[str, object], calls: list[str] | None = None):
    """A fetch_balances-shaped _signed stub keyed on path (+earn category)."""
    async def fake_signed(_creds, path, params=None):
        key = path
        if path == "/v5/earn/position":
            key = f"{path}:{(params or {}).get('category')}"
        if calls is not None:
            calls.append(key)
        payload = payloads.get(key)
        if isinstance(payload, Exception):
            raise payload
        return payload or {}
    return fake_signed


def test_bybit_reads_all_three_wallets():
    p = BybitProvider()
    p._signed = _bybit_router({  # type: ignore[assignment]
        "/v5/account/wallet-balance": {
            "list": [{"accountType": "UNIFIED", "coin": [
                {"coin": "BTC", "walletBalance": "0.5", "locked": "0.1"},
                {"coin": "USDT", "walletBalance": "1000"},
            ]}],
        },
        "/v5/asset/transfer/query-account-coins-balance": {
            "accountType": "FUND",
            "balance": [{"coin": "SOL", "walletBalance": "2", "transferBalance": "2"}],
        },
        "/v5/earn/position:FlexibleSaving": {
            "list": [{"coin": "USDT", "amount": "500"}],
        },
        "/v5/earn/position:OnChain": {
            "list": [{"coin": "ETH", "amount": "1.5"}],
        },
    })
    balances = {(b.wallet, b.asset): b.quantity for b in run(p.fetch_balances({}))}
    # walletBalance already contains the locked slice — it must not be re-added.
    assert balances[("SPOT", "BTC")] == Decimal("0.5")
    assert balances[("SPOT", "USDT")] == Decimal("1000")
    assert balances[("FUNDING", "SOL")] == Decimal("2")
    assert balances[("EARN", "USDT")] == Decimal("500")
    assert balances[("STAKING", "ETH")] == Decimal("1.5")


def test_bybit_drops_zero_negative_and_redeemed_positions():
    """Borrowed coins go negative and redeemed savings linger at zero."""
    p = BybitProvider()
    p._signed = _bybit_router({  # type: ignore[assignment]
        "/v5/account/wallet-balance": {
            "list": [{"coin": [
                {"coin": "USDC", "walletBalance": "-25"},
                {"coin": "DUST", "walletBalance": "0"},
                {"coin": "BTC", "walletBalance": "1"},
            ]}],
        },
        "/v5/earn/position:FlexibleSaving": {
            "list": [{"coin": "USDT", "amount": "0"}],
        },
    })
    balances = {(b.wallet, b.asset) for b in run(p.fetch_balances({}))}
    assert balances == {("SPOT", "BTC")}


def test_bybit_sums_multiple_earn_positions_per_coin():
    """Two products in one coin must merge, not collide on EARN:USDT."""
    p = BybitProvider()
    p._signed = _bybit_router({  # type: ignore[assignment]
        "/v5/account/wallet-balance": {"list": []},
        "/v5/earn/position:FlexibleSaving": {
            "list": [
                {"coin": "USDT", "amount": "100", "productId": "1"},
                {"coin": "USDT", "amount": "40", "productId": "2"},
            ],
        },
    })
    balances = run(p.fetch_balances({}))
    earn = [b for b in balances if b.wallet == "EARN"]
    assert len(earn) == 1
    assert earn[0].quantity == Decimal("140")


def test_bybit_missing_permissions_skip_funding_and_earn_only():
    """A key without the Wallet/Earn boxes still syncs the unified wallet."""
    p = BybitProvider()
    p._signed = _bybit_router({  # type: ignore[assignment]
        "/v5/account/wallet-balance": {
            "list": [{"coin": [{"coin": "BTC", "walletBalance": "1"}]}],
        },
        "/v5/asset/transfer/query-account-coins-balance": SessionExpiredError("no perm"),
        "/v5/earn/position:FlexibleSaving": SessionExpiredError("no perm"),
        "/v5/earn/position:OnChain": SessionExpiredError("no perm"),
    })
    balances = {(b.wallet, b.asset): b.quantity for b in run(p.fetch_balances({}))}
    assert balances == {("SPOT", "BTC"): Decimal("1")}


def test_bybit_transient_funding_failure_aborts_instead_of_dropping_wallets():
    """A rate limit must not shrink the balance list — downstream, missing
    external_ids are archived, and same-connection assets never auto-unarchive."""
    p = BybitProvider()
    p._signed = _bybit_router({  # type: ignore[assignment]
        "/v5/account/wallet-balance": {
            "list": [{"coin": [{"coin": "BTC", "walletBalance": "1"}]}],
        },
        "/v5/asset/transfer/query-account-coins-balance": RuntimeError("rate limited"),
    })
    try:
        run(p.fetch_balances({}))
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected the transient funding failure to propagate")


def test_bybit_unified_wallet_failure_propagates():
    """The primary read failing must abort the sync, not read as 'no holdings'."""
    p = BybitProvider()
    p._signed = _bybit_router({  # type: ignore[assignment]
        "/v5/account/wallet-balance": SessionExpiredError("key revoked"),
    })
    try:
        run(p.fetch_balances({}))
    except SessionExpiredError:
        pass
    else:
        raise AssertionError("expected SessionExpiredError to propagate")


class _FakeBybitTransport:
    """Stands in for httpx.AsyncClient; replays canned JSON bodies."""

    def __init__(self, bodies: list[dict]):
        self.bodies = bodies
        self.requests: list[dict] = []

    def __call__(self, **kwargs):
        self.kwargs = kwargs
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url):
        self.requests.append({"url": url, "headers": self.kwargs.get("headers") or {}})

        class R:
            status_code = 200
            text = ""
            def __init__(self, body): self._body = body
            def json(self): return self._body
            def raise_for_status(self): return None

        return R(self.bodies[len(self.requests) - 1])


@contextmanager
def _bybit_transport(bodies: list[dict]):
    """Swap httpx.AsyncClient for a canned transport, restoring on exit.

    Also pins the module's clock-offset cache so no /v5/market/time request
    sneaks in and consumes a canned body.
    """
    import time as _time

    import app.providers.bybit as bybit_mod

    transport = _FakeBybitTransport(bodies)
    original_client = bybit_mod.httpx.AsyncClient
    original_offset = (bybit_mod._clock_offset_ms, bybit_mod._clock_offset_at)
    bybit_mod.httpx.AsyncClient = transport  # type: ignore[assignment]
    bybit_mod._clock_offset_ms, bybit_mod._clock_offset_at = 0, _time.time()
    try:
        yield transport
    finally:
        bybit_mod.httpx.AsyncClient = original_client  # type: ignore[assignment]
        bybit_mod._clock_offset_ms, bybit_mod._clock_offset_at = original_offset


def test_bybit_signature_matches_documented_scheme():
    """HMAC-SHA256 hex over timestamp + key + recvWindow + query, per docs."""
    with _bybit_transport([{"retCode": 0, "result": {}}]) as transport:
        creds = {"api_key": "test-key", "api_secret": "test-secret"}
        run(BybitProvider()._signed(creds, "/v5/account/wallet-balance",
                                    {"accountType": "UNIFIED"}))

    req = transport.requests[0]
    assert req["url"].endswith("/v5/account/wallet-balance?accountType=UNIFIED")
    headers = req["headers"]
    assert headers["X-BAPI-API-KEY"] == "test-key"
    assert headers["X-BAPI-RECV-WINDOW"] == "10000"
    # The timestamp must be epoch *milliseconds* — seconds would sign fine
    # against ourselves but be rejected by Bybit, so pin the scale here.
    assert abs(int(headers["X-BAPI-TIMESTAMP"]) - time.time() * 1000) < 60_000
    expected = hmac.new(
        b"test-secret",
        f"{headers['X-BAPI-TIMESTAMP']}test-key10000accountType=UNIFIED".encode(),
        hashlib.sha256,
    ).hexdigest()
    assert headers["X-BAPI-SIGN"] == expected


def test_bybit_auth_retcode_raises_session_expired():
    """Auth failures arrive as HTTP 200 + retCode and must expire the session."""
    with _bybit_transport([{"retCode": 10003, "retMsg": "API key is invalid."}]):
        try:
            run(BybitProvider()._signed(
                {"api_key": "k", "api_secret": "s"},
                "/v5/account/wallet-balance", {"accountType": "UNIFIED"},
            ))
        except SessionExpiredError as e:
            assert "10003" in str(e)
        else:
            raise AssertionError("expected SessionExpiredError for retCode 10003")


def test_bybit_non_uta_account_gets_a_clear_error():
    with _bybit_transport([{"retCode": 10028, "retMsg": "unified only"}]):
        try:
            run(BybitProvider()._signed(
                {"api_key": "k", "api_secret": "s"},
                "/v5/account/wallet-balance", {"accountType": "UNIFIED"},
            ))
        except RuntimeError as e:
            assert "Unified Trading Account" in str(e)
        else:
            raise AssertionError("expected RuntimeError for retCode 10028")


def test_bybit_resyncs_clock_and_retries_on_timestamp_drift():
    """retCode 10002 earns exactly one retry after re-learning the offset."""
    bodies = [
        {"retCode": 10002, "retMsg": "timestamp outside recv window"},
        # /v5/market/time resync — the ms timestamp sits at the TOP level.
        {"retCode": 0, "retMsg": "OK", "result": {"timeSecond": "12"}, "time": 12_345},
        {"retCode": 0, "result": {"list": []}},
    ]
    with _bybit_transport(bodies) as transport:
        result = run(BybitProvider()._signed(
            {"api_key": "k", "api_secret": "s"},
            "/v5/account/wallet-balance", {"accountType": "UNIFIED"},
        ))
    assert result == {"list": []}
    assert len(transport.requests) == 3
    assert "/v5/market/time" in transport.requests[1]["url"]
    # The retry must actually sign with the re-learned offset: server time is
    # 12345ms, so the new timestamp collapses to ~12345, not wall-clock ms.
    assert int(transport.requests[2]["headers"]["X-BAPI-TIMESTAMP"]) < 1_000_000


def test_bybit_persistent_timestamp_drift_fails_after_one_retry():
    """Two 10002s in a row must fail loudly, not loop against the API."""
    bodies = [
        {"retCode": 10002, "retMsg": "drift"},
        {"retCode": 0, "retMsg": "OK", "result": {}, "time": 12_345},
        {"retCode": 10002, "retMsg": "drift"},
    ]
    with _bybit_transport(bodies) as transport:
        try:
            run(BybitProvider()._signed(
                {"api_key": "k", "api_secret": "s"},
                "/v5/account/wallet-balance", {"accountType": "UNIFIED"},
            ))
        except RuntimeError as e:
            assert "persisted" in str(e)
        else:
            raise AssertionError("expected RuntimeError for persistent drift")
    assert len(transport.requests) == 3   # original + one resync + one retry


def test_bybit_missing_retcode_is_an_error_not_an_empty_result():
    """Envelope-less 200s (gateway junk) must not read as empty balances."""
    with _bybit_transport([{"unexpected": "gateway junk"}]):
        try:
            run(BybitProvider()._signed(
                {"api_key": "k", "api_secret": "s"},
                "/v5/account/wallet-balance", {"accountType": "UNIFIED"},
            ))
        except RuntimeError as e:
            assert "retCode" in str(e)
        else:
            raise AssertionError("expected RuntimeError for a body without retCode")


def test_bybit_accepts_key_colon_secret_paste():
    p = BybitProvider()
    seen: list[str] = []

    async def fake_signed(creds, path, params=None):
        seen.append(path)
        assert creds["api_key"] == "my-key"
        return {}

    p._signed = fake_signed  # type: ignore[assignment]
    conn = run(p.handle_oauth_callback("my-key:my-secret"))
    assert conn.external_id == "bybit:my-key"
    assert conn.institution_name == "Bybit"
    assert conn.accounts == []
    assert "api_secret" not in conn.credentials       # only the encrypted form
    assert conn.credentials.get("api_secret_enc")
    assert seen == ["/v5/account/wallet-balance"]     # fail-fast validation ran


def test_bybit_accepts_json_paste():
    """The JSON shape is the one the dialog documents first — cover it too."""
    p = BybitProvider()

    async def fake_signed(creds, path, params=None):
        return {}

    p._signed = fake_signed  # type: ignore[assignment]
    conn = run(p.handle_oauth_callback('{"api_key": "json-key", "api_secret": "sec"}'))
    assert conn.external_id == "bybit:json-key"
    assert conn.credentials.get("api_secret_enc")


def test_bybit_rejects_unparseable_credentials():
    try:
        run(BybitProvider().handle_oauth_callback("just-a-key-no-secret"))
    except ValueError as e:
        assert "api_key" in str(e)
    else:
        raise AssertionError("expected a ValueError")


# --- Coinbase key material ------------------------------------------------
# Coinbase hands out either an EC key in PEM form or a base64 Ed25519 key,
# and the JWT algorithm has to follow whichever arrived.

def _ed25519_secret() -> tuple[str, object]:
    """A CDP-shaped Ed25519 secret: base64 of seed + public key."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization

    key = Ed25519PrivateKey.generate()
    seed = key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub = key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    return base64.b64encode(seed + pub).decode(), key.public_key()


def _ec_pem() -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


def test_coinbase_ed25519_key_selects_eddsa():
    secret, _ = _ed25519_secret()
    _, algorithm = _load_cdp_key(secret)
    assert algorithm == "EdDSA"


def test_coinbase_pem_key_selects_es256():
    _, algorithm = _load_cdp_key(_ec_pem())
    assert algorithm == "ES256"


def test_coinbase_ed25519_jwt_verifies_and_binds_the_uri():
    import jwt

    secret, public_key = _ed25519_secret()
    p = CoinbaseProvider()
    name = "organizations/org-1/apiKeys/key-1"
    token = p._cdp_jwt({"api_key": name, "private_key": secret}, "GET", "/api/v3/brokerage/accounts")

    # Verifying with the matching public key proves the seed was used correctly.
    claims = jwt.decode(token, public_key, algorithms=["EdDSA"], options={"verify_aud": False})
    assert claims["sub"] == name
    assert claims["iss"] == "cdp"
    assert claims["uri"] == "GET api.coinbase.com/api/v3/brokerage/accounts"
    assert jwt.get_unverified_header(token)["kid"] == name


def test_coinbase_jwt_uri_excludes_the_query_string():
    """Coinbase signs the bare path; including `?limit=…` yields a 401."""
    import jwt

    secret, public_key = _ed25519_secret()
    p = CoinbaseProvider()
    creds = {"api_key": "organizations/o/apiKeys/k", "private_key": secret}

    for path in ("/api/v3/brokerage/accounts?limit=250",
                 "/api/v3/brokerage/accounts?limit=250&cursor=abc"):
        token = p._cdp_jwt(creds, "GET", path)
        claims = jwt.decode(token, public_key, algorithms=["EdDSA"])
        assert claims["uri"] == "GET api.coinbase.com/api/v3/brokerage/accounts"


def test_coinbase_escaped_newlines_in_pem_are_repaired():
    escaped = _ec_pem().replace("\n", "\\n")
    _, algorithm = _load_cdp_key(escaped)
    assert algorithm == "ES256"


def test_coinbase_rejects_unusable_key_material():
    for bad in ("not-a-key-at-all!!", base64.b64encode(b"tooshort").decode()):
        try:
            _load_cdp_key(bad)
        except SessionExpiredError:
            pass
        else:
            raise AssertionError(f"expected a failure for {bad!r}")
