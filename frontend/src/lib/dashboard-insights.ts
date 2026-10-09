/**
 * Pure data helpers behind the dashboard ("Visão geral") cards.
 *
 * Everything here derives a number or a sentence's ingredients from data the
 * existing endpoints already return, so the cards stay thin and the rules
 * that decide what a card says can be tested without rendering anything.
 */
import type {
  Account,
  ProjectedTransaction,
  ReportResponse,
  Transaction,
} from '@/types'
import { shiftMonth } from '@/lib/month-utils'

/** `YYYY-MM-DD` for a local date, without going through UTC. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Parse a `YYYY-MM-DD` string as a local-midnight Date. */
export function parseIsoDate(value: string): Date {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Whole days from `from` to `value` (negative when `value` is in the past). */
export function daysUntil(value: string, from: Date = new Date()): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  return Math.round((parseIsoDate(value).getTime() - start.getTime()) / 86_400_000)
}

function dayOfLabel(label: string): number {
  return Number(label.slice(8, 10))
}

/**
 * Daily expenses of a `reports/income-expenses` response requested with
 * `interval=daily`, keyed by day of month.
 */
export function dailyExpenses(report: ReportResponse | undefined): Map<number, number> {
  const out = new Map<number, number>()
  for (const point of report?.trend ?? []) {
    const day = dayOfLabel(point.date)
    if (!Number.isFinite(day)) continue
    out.set(day, (out.get(day) ?? 0) + Number(point.breakdowns?.expenses ?? 0))
  }
  return out
}

/** Sum of a daily report's `breakdowns[key]` for days 1..`uptoDay`. */
export function sumUpToDay(
  report: ReportResponse | undefined,
  uptoDay: number,
  key: 'income' | 'expenses' = 'expenses',
): number {
  let total = 0
  for (const point of report?.trend ?? []) {
    if (dayOfLabel(point.date) <= uptoDay) total += Number(point.breakdowns?.[key] ?? 0)
  }
  return total
}

export interface CumulativePoint {
  day: number
  current: number | null
  previous: number | null
}

/**
 * Month-to-date cumulative spend for the selected month (up to `lastDay`)
 * against the previous month's whole curve. The x axis spans the longer
 * of the two months so the dashed line is never cut short.
 */
export function buildCumulativeSeries(
  current: ReportResponse | undefined,
  previous: ReportResponse | undefined,
  daysInMonth: number,
  prevDaysInMonth: number,
  lastDay: number,
): CumulativePoint[] {
  const cur = dailyExpenses(current)
  const prev = dailyExpenses(previous)
  const span = Math.max(daysInMonth, prevDaysInMonth)
  const points: CumulativePoint[] = []
  let curSum = 0
  let prevSum = 0
  for (let day = 1; day <= span; day++) {
    curSum += cur.get(day) ?? 0
    prevSum += prev.get(day) ?? 0
    points.push({
      day,
      current: current && day <= lastDay ? round2(curSum) : null,
      previous: previous && day <= prevDaysInMonth ? round2(prevSum) : null,
    })
  }
  return points
}

export interface CategoryTotal {
  key: string
  label: string
  color: string
  value: number
}

/**
 * Expense totals per category for days 1..`uptoDay`, read from the per-day
 * composition the income/expenses report attaches to each trend point.
 */
export function categoryTotalsUpTo(
  report: ReportResponse | undefined,
  uptoDay: number,
): Map<string, CategoryTotal> {
  const out = new Map<string, CategoryTotal>()
  for (const point of report?.trend ?? []) {
    if (dayOfLabel(point.date) > uptoDay) continue
    for (const item of point.composition ?? []) {
      if (item.group !== 'expenses') continue
      const existing = out.get(item.key)
      if (existing) existing.value += item.value
      else out.set(item.key, { key: item.key, label: item.label, color: item.color, value: item.value })
    }
  }
  return out
}

export interface CategoryChange {
  key: string
  label: string
  /** Current minus previous; negative means less was spent. */
  delta: number
}

/**
 * The category whose spend moved the most between the two periods. Ignores
 * changes below `minDelta` so a few cents of noise never becomes an insight.
 */
export function biggestCategoryChange(
  current: Map<string, CategoryTotal>,
  previous: Map<string, CategoryTotal>,
  minDelta = 1,
): CategoryChange | null {
  const keys = new Set([...current.keys(), ...previous.keys()])
  let best: CategoryChange | null = null
  for (const key of keys) {
    const cur = current.get(key)
    const prev = previous.get(key)
    const delta = (cur?.value ?? 0) - (prev?.value ?? 0)
    if (Math.abs(delta) < minDelta) continue
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { key, label: cur?.label ?? prev?.label ?? key, delta: round2(delta) }
    }
  }
  return best
}

export interface EndingInstallments {
  /** Month (`YYYY-MM`) of the last installment. */
  endMonth: string
  /** First month without those installments. */
  freedFrom: string
  count: number
  monthlyAmount: number
}

/**
 * Installment series whose last parcel falls soonest, read from one month's
 * transactions (`month`). A row tells us its own number and the series
 * length, so the end month is `month + (total - number)`. Only series ending
 * within `horizon` months qualify, and only the earliest such month is
 * returned, so the card can say "N installments end in <month>".
 */
export function findEndingInstallments(
  txs: readonly Transaction[],
  month: string,
  horizon = 2,
): EndingInstallments | null {
  const series = new Map<string, { remaining: number; amount: number }>()
  for (const tx of txs) {
    if (tx.type !== 'debit') continue
    const total = tx.total_installments
    const number = tx.installment_number
    if (!total || !number || total < 2 || number > total) continue
    const key = tx.installment_series_id
      ?? `${tx.account_id}|${tx.description}|${total}|${tx.installment_purchase_date ?? ''}`
    const amount = Math.abs(Number(tx.amount_primary ?? tx.amount))
    const remaining = total - number
    if (!series.has(key)) series.set(key, { remaining, amount })
  }
  let best: number | null = null
  for (const { remaining } of series.values()) {
    if (remaining <= horizon && (best === null || remaining < best)) best = remaining
  }
  if (best === null) return null
  let count = 0
  let monthlyAmount = 0
  for (const s of series.values()) {
    if (s.remaining !== best) continue
    count += 1
    monthlyAmount += s.amount
  }
  const endMonth = shiftMonth(month, best)
  return { endMonth, freedFrom: shiftMonth(endMonth, 1), count, monthlyAmount: round2(monthlyAmount) }
}

export type UpcomingKind = 'recurring' | 'scheduled' | 'card_bill'

export interface UpcomingItem {
  key: string
  date: string
  description: string
  amount: number
  currency: string
  kind: UpcomingKind
  categoryName: string | null
  accountId: string | null
  installment: { number: number; total: number } | null
}

/**
 * Bills coming due between `from` and `to` (inclusive, `YYYY-MM-DD`):
 * recurring projections, future-dated pending rows that are not card
 * purchases (those reach the user through the card bill), and the open
 * balance of each credit card whose due date lands in the window.
 */
export function buildUpcomingItems(params: {
  projected: readonly ProjectedTransaction[]
  scheduled: readonly Transaction[]
  cards: readonly Account[]
  from: string
  to: string
  primaryCurrency: string
}): UpcomingItem[] {
  const { projected, scheduled, cards, from, to, primaryCurrency } = params
  const cardIds = new Set(cards.map((c) => c.id))
  const items: UpcomingItem[] = []
  const inWindow = (d: string | null | undefined) => !!d && d >= from && d <= to

  for (const p of projected) {
    if (p.type !== 'debit' || !inWindow(p.date)) continue
    items.push({
      key: `proj-${p.recurring_id}-${p.date}`,
      date: p.date,
      description: p.description,
      amount: Math.abs(p.amount_primary ?? p.amount),
      currency: p.amount_primary != null ? primaryCurrency : p.currency,
      kind: 'recurring',
      categoryName: p.category_name,
      accountId: p.account_id,
      installment: null,
    })
  }

  for (const tx of scheduled) {
    if (tx.type !== 'debit' || !inWindow(tx.date)) continue
    if (tx.account_id && cardIds.has(tx.account_id)) continue
    if (tx.is_ignored || tx.transfer_pair_id) continue
    items.push({
      key: `tx-${tx.id}`,
      date: tx.date,
      description: tx.description,
      amount: Math.abs(Number(tx.amount_primary ?? tx.amount)),
      currency: tx.amount_primary != null ? primaryCurrency : tx.currency,
      kind: tx.recurring_transaction_id ? 'recurring' : 'scheduled',
      categoryName: tx.category?.name ?? null,
      accountId: tx.account_id,
      installment: tx.installment_number && tx.total_installments
        ? { number: tx.installment_number, total: tx.total_installments }
        : null,
    })
  }

  const seenGroups = new Set<string>()
  for (const card of cards) {
    if (card.is_closed || !inWindow(card.next_due_date)) continue
    if (card.shared_balance_group) {
      if (seenGroups.has(card.shared_balance_group)) continue
      seenGroups.add(card.shared_balance_group)
    }
    const owed = cardOwed(card)
    if (owed < 0.01) continue
    items.push({
      key: `card-${card.id}`,
      date: card.next_due_date!,
      description: card.display_name ?? card.name,
      amount: owed,
      currency: card.balance_primary != null ? primaryCurrency : card.currency,
      kind: 'card_bill',
      categoryName: null,
      accountId: card.id,
      installment: null,
    })
  }

  items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
  return items
}

/** What a credit card currently owes, as a positive number (0 when in credit). */
export function cardOwed(card: Pick<Account, 'balance_primary' | 'current_balance'>): number {
  return Math.max(0, -Number(card.balance_primary ?? card.current_balance ?? 0))
}

/** Percent change from `previous` to `current`, or null when undefined. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || Math.abs(previous) < 0.01) return null
  return ((current - previous) / Math.abs(previous)) * 100
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Currency without cents, for headline numbers ("R$ 4.286"). Falls back to
 * a plain format if the currency code is not one Intl knows.
 */
export function formatWholeCurrency(value: number, currency: string, locale: string): string {
  const rounded = Math.round(value)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(rounded === 0 ? 0 : rounded)
  } catch {
    return `${currency} ${rounded}`
  }
}

/** Signed percentage for pills ("+8.4%" / "-3%"), one decimal under 10%. */
export function formatSignedPercent(value: number, locale: string): string {
  const abs = Math.abs(value)
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: abs < 10 ? 1 : 0,
    signDisplay: 'exceptZero',
  }).format(value / 100)
}

/** Unsigned whole percentage ("77%"). */
export function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value / 100)
}
