import { describe, expect, it } from 'vitest'
import { classifyAsset } from './asset-classification'

// Exchange-synced assets carry source = provider name; wallet names are
// user-renamable and must not be load-bearing (the original bug: only a
// wallet literally named "Binance" counted as crypto, so Coinbase/Kraken/
// Bybit holdings landed in stocksUS via the currency branch).
describe('classifyAsset — exchange holdings', () => {
  it.each(['binance', 'coinbase', 'kraken', 'bybit'])(
    'classifies BTC from %s as crypto regardless of wallet name',
    (source) => {
      const r = classifyAsset({ name: 'BTC', ticker: 'BTC', currency: 'USD', source })
      expect(r).toEqual({ cls: 'crypto', region: 'global' })
    },
  )

  it('does not mistake three-letter coins for cash', () => {
    for (const sym of ['SOL', 'DOT', 'ADA', 'XRP', 'BNB']) {
      const r = classifyAsset({ name: sym, ticker: sym, currency: 'USD', source: 'kraken' })
      expect(r.cls).toBe('crypto')
    }
  })

  it('classifies exchange fiat as cash, not crypto', () => {
    expect(
      classifyAsset({ name: 'BRL (Funding)', ticker: 'BRL', currency: 'BRL', source: 'binance' }).cls,
    ).toBe('cash')
    expect(
      classifyAsset({ name: 'USD', ticker: 'USD', currency: 'USD', source: 'coinbase' }).cls,
    ).toBe('cash')
  })

  it('treats stablecoins as crypto', () => {
    expect(
      classifyAsset({ name: 'USDT (Earn)', ticker: 'USDT', currency: 'USD', source: 'bybit' }).cls,
    ).toBe('crypto')
  })

  it('still honors the wallet-name hint for manual crypto entries', () => {
    const r = classifyAsset({
      name: 'ETH', ticker: 'ETH', currency: 'USD', source: 'manual', walletName: 'My Crypto',
    })
    expect(r.cls).toBe('crypto')
  })
})

describe('classifyAsset — non-exchange assets are unaffected', () => {
  it('keeps BR tickers in their classes', () => {
    expect(classifyAsset({ name: 'PETR4', ticker: 'PETR4', currency: 'BRL' }).cls).toBe('stocksBR')
    expect(classifyAsset({ name: 'HGLG11', ticker: 'HGLG11', currency: 'BRL' }).cls).toBe('fiis')
    expect(classifyAsset({ name: 'BOVA11', ticker: 'BOVA11', currency: 'BRL' }).cls).toBe('etfsBR')
  })

  it('keeps US holdings in US classes', () => {
    expect(classifyAsset({ name: 'VOO', ticker: 'VOO', currency: 'USD' })).toEqual({
      cls: 'etfsUS', region: 'unitedStates',
    })
    expect(classifyAsset({ name: 'AAPL', ticker: 'AAPL', currency: 'USD' }).cls).toBe('stocksUS')
  })

  it('keeps fixed income and non-financial types', () => {
    expect(classifyAsset({ name: 'Tesouro Prefixado 2027', currency: 'BRL' }).cls).toBe('fixedIncome')
    expect(classifyAsset({ name: 'Meu Carro', type: 'vehicle', currency: 'BRL' }).cls).toBe('vehicle')
  })
})
