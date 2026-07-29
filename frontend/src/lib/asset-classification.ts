// Shared asset identity and classification helpers.
//
// Both the holdings list and the portfolio chart consolidate positions, and
// the concentration panel buckets them. Keeping the logic here means those
// three views can never disagree about what counts as "the same asset".

export interface ClassifiableAsset {
  name: string
  ticker?: string | null
  currency?: string | null
  type?: string | null
  walletName?: string | null
}

// Brazilian Treasury bonds are the same instrument under several names: the
// official label ("Tesouro Prefixado 2027"), the legacy code ("LTN"), and
// broker-specific mixes of the two ("LTN - Tesouro Prefixado 2027",
// "NTN-B Princ - Tesouro IPCA 2029", "LTN jan-27"). Normalizing to
// {kind, maturity year} is what lets the same bond held at three brokers
// collapse into one line.
//
// Returns null when the name isn't a Treasury bond, so callers fall through
// to ordinary name matching.
export function canonicalTesouroName(rawName: string): string | null {
  const n = rawName.trim().toUpperCase().replace(/\s+/g, ' ')

  let year: string | null = null
  const y4 = n.match(/\b(20\d{2})\b/)
  if (y4) {
    year = y4[1]
  } else {
    // Broker short form: "LTN jan-27" -> 2027.
    const y2 = n.match(/\b[A-Z]{3}-(\d{2})\b/)
    if (y2) year = `20${y2[1]}`
  }

  const hasCoupon =
    n.includes('JUROS SEMESTRAIS') || /\bNTN-F\b/.test(n) || /\bNTN-B\b(?!\s*PRINC)/.test(n)

  // Renda+ (NTN-B1) and Educa+ (NTN-B2) are named for the year payouts BEGIN,
  // but brokers often label them with the month the payouts END — "NTN-B1
  // dez-84" is Renda+ 2065, not a 2084 bond. Renda+ pays 240 monthly
  // instalments (20 years) and Educa+ pays 60 (5 years), so the product year
  // is recoverable from the final year.
  if (/\bNTN-B1\b/.test(n) || n.includes('RENDA+') || n.includes('RENDA +')) {
    const y = year ? String(Number(year) - 19) : null
    // A 4-digit year in the name is already the product year; only the
    // end-of-payout short form needs shifting back.
    const explicit = n.match(/\bRENDA\s*\+\s*(20\d{2})\b/)
    const finalYear = explicit ? explicit[1] : y
    return finalYear ? `Tesouro Renda+ ${finalYear}` : 'Tesouro Renda+'
  }
  if (/\bNTN-B2\b/.test(n) || n.includes('EDUCA+') || n.includes('EDUCA +')) {
    const y = year ? String(Number(year) - 4) : null
    const explicit = n.match(/\bEDUCA\s*\+\s*(20\d{2})\b/)
    const finalYear = explicit ? explicit[1] : y
    return finalYear ? `Tesouro Educa+ ${finalYear}` : 'Tesouro Educa+'
  }

  let kind: string
  if (/\bLTN\b/.test(n) || n.includes('TESOURO PREFIXADO')) {
    kind =
      n.includes('JUROS SEMESTRAIS') || /\bNTN-F\b/.test(n)
        ? 'Tesouro Prefixado com Juros Semestrais'
        : 'Tesouro Prefixado'
  } else if (/\bNTN-B\b/.test(n) || n.includes('TESOURO IPCA')) {
    kind = hasCoupon ? 'Tesouro IPCA+ com Juros Semestrais' : 'Tesouro IPCA+'
  } else if (/\bLFT\b/.test(n) || n.includes('TESOURO SELIC')) {
    kind = 'Tesouro Selic'
  } else {
    return null
  }

  return year ? `${kind} ${year}` : kind
}

// Key identifying the same instrument across custodians.
// Ticker first; then the canonical Treasury name; then the raw name.
// Provider-synced fixed income carries no ticker at all, which is exactly the
// case that motivated consolidation, so a ticker-only key would miss it.
export function consolidationKeyOf(a: { ticker?: string | null; name: string }): string {
  const ticker = a.ticker && !a.ticker.startsWith('TD:') ? a.ticker.trim().toUpperCase() : ''
  if (ticker) return `T:${ticker}`
  const td = canonicalTesouroName(a.name)
  if (td) return `TD:${td.toUpperCase()}`
  return `N:${a.name.trim().toUpperCase().replace(/\s+/g, ' ')}`
}

// Display label for a consolidated bucket — prefer ticker, then the canonical
// Treasury name (so the merged row isn't labelled with one broker's wording).
export function consolidatedLabelOf(a: { ticker?: string | null; name: string }): string {
  if (a.ticker && !a.ticker.startsWith('TD:')) return a.ticker
  return canonicalTesouroName(a.name) ?? a.name
}

export type AssetClass =
  | 'fixedIncome' | 'stocksBR' | 'fiis' | 'etfsBR'
  | 'stocksUS' | 'etfsUS' | 'crypto' | 'cash' | 'vehicle' | 'other'

export type AssetRegion = 'brazil' | 'unitedStates' | 'global'

// Tickers ending in 11 are ambiguous in Brazil: both FIIs and ETFs use it.
// There are few BR ETFs and many FIIs, so an explicit ETF list with a FII
// default classifies correctly far more often than the reverse.
const BR_ETFS = new Set([
  'BOVA11', 'SMAL11', 'IVVB11', 'BOVV11', 'SMAC11', 'PIBB11', 'DIVO11',
  'XFIX11', 'HASH11', 'BITH11', 'ACWI11', 'NASD11', 'SPXI11',
])

const US_ETFS = new Set([
  'VOO', 'VTI', 'SPY', 'QQQ', 'IVV', 'BND', 'TLT', 'VNQ', 'SCHD', 'VOOG',
  'VUG', 'VEA', 'VWO', 'IEF', 'AGG', 'GLD', 'IAU', 'ARKK', 'DIA', 'IWM',
])

const FIXED_INCOME = /\b(CDB|RDB|LCI|LCA|LTN|LFT|NTN-?B|NTN-?F|TESOURO|DEBENTURE|DEB[EÊ]NTURE|CRA|CRI|POUPAN|FIRF|FIC\b|RENDA FIXA)/i

/** Best-effort class + region. Heuristic by nature: Securo stores no asset
 *  class, so this reads tickers and names. Deliberately conservative — an
 *  unrecognized asset lands in `other` rather than being forced somewhere. */
export function classifyAsset(a: ClassifiableAsset): { cls: AssetClass; region: AssetRegion } {
  const name = a.name.trim()
  const upper = name.toUpperCase()
  const ticker = (a.ticker ?? '').trim().toUpperCase()
  const currency = (a.currency ?? 'BRL').toUpperCase()
  const isCryptoWallet = (a.walletName ?? '').toUpperCase().includes('BINANCE')

  if (a.type === 'vehicle') return { cls: 'vehicle', region: 'brazil' }
  if (a.type === 'real_estate') return { cls: 'other', region: 'brazil' }

  // Fiat parked at an exchange is cash, not crypto — check before the wallet
  // rule, which would otherwise swallow it.
  if (isCryptoWallet && /^[A-Z]{3}$/.test(upper) && upper !== 'BTC' && upper !== 'ETH') {
    return { cls: 'cash', region: 'global' }
  }
  if (isCryptoWallet || /\(EARN\)$/.test(upper)) {
    // Crypto is treated as international exposure regardless of custody.
    return { cls: 'crypto', region: 'global' }
  }

  if (FIXED_INCOME.test(upper)) return { cls: 'fixedIncome', region: 'brazil' }

  if (currency !== 'BRL') {
    const sym = ticker || upper
    return { cls: US_ETFS.has(sym) ? 'etfsUS' : 'stocksUS', region: 'unitedStates' }
  }

  const m = /^([A-Z]{4})(\d{1,2})$/.exec(ticker || upper)
  if (m) {
    const code = m[1] + m[2]
    if (m[2] === '11') {
      return { cls: BR_ETFS.has(code) ? 'etfsBR' : 'fiis', region: 'brazil' }
    }
    return { cls: 'stocksBR', region: 'brazil' }
  }

  return { cls: 'other', region: 'brazil' }
}
