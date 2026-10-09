import { shiftMonth } from '@/lib/month-utils'
import type { MonthlyTrend, ReportResponse, Transaction } from '@/types'

type AmountFields = Pick<
  Transaction,
  'type' | 'amount' | 'amount_primary' | 'is_ignored' | 'is_shared' | 'viewer_share'
>

/**
 * What a row adds to a day's net, in the primary currency where the row has
 * a stamped conversion. Ignored rows add nothing (they are greyed out in the
 * list for the same reason), and a shared row counts only the viewer's share,
 * which is what its amount cell shows.
 */
export function signedTransactionAmount(tx: AmountFields): number {
  if (tx.is_ignored) return 0
  const native = Math.abs(Number(tx.amount))
  const primary = tx.amount_primary != null ? Math.abs(Number(tx.amount_primary)) : native
  let value = primary
  if (tx.is_shared && tx.viewer_share != null) {
    const share = Math.abs(Number(tx.viewer_share))
    value = native > 0 ? share * (primary / native) : share
  }
  return tx.type === 'credit' ? value : -value
}

export function sumSignedAmounts(items: AmountFields[]): number {
  return items.reduce((total, tx) => total + signedTransactionAmount(tx), 0)
}

export type DayGroup<T> = { date: string; items: T[]; net: number }

/**
 * Consecutive rows sharing a date, in the order given. The list is already
 * sorted by the server, so grouping runs of equal dates keeps that order
 * whether it is newest-first or oldest-first.
 */
export function groupByDay<T extends AmountFields & { date: string }>(items: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  let current: DayGroup<T> | null = null
  for (const tx of items) {
    if (!current || current.date !== tx.date) {
      current = { date: tx.date, items: [], net: 0 }
      groups.push(current)
    }
    current.items.push(tx)
    current.net += signedTransactionAmount(tx)
  }
  return groups
}

/** Rows the bank has not settled yet, apart from everything else. */
export function partitionPending<T extends { status: string | null }>(items: T[]): { pending: T[]; settled: T[] } {
  const pending: T[] = []
  const settled: T[] = []
  for (const tx of items) {
    if (tx.status === 'pending') pending.push(tx)
    else settled.push(tx)
  }
  return { pending, settled }
}

/** Day difference between two `YYYY-MM-DD` strings, ignoring time zones. */
function dayDiff(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)))
  return Math.round((b - a) / 86_400_000)
}

export function relativeDay(date: string, today: string): 'today' | 'yesterday' | null {
  const diff = dayDiff(date, today)
  if (diff === 0) return 'today'
  if (diff === 1) return 'yesterday'
  return null
}

/** "qui., 9 de out." style label, with the year only when it is not this year's. */
export function formatDayDate(date: string, today: string, locale: string): string {
  const d = new Date(`${date}T00:00:00`)
  const sameYear = date.slice(0, 4) === today.slice(0, 4)
  return d.toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

export type MonthStripPoint = {
  /** `YYYY-MM` */
  month: string
  /** Income minus expenses; null while the source has not loaded. */
  net: number | null
  /** Future month: the value is a projection, not booked activity. */
  projected: boolean
}

/**
 * Twelve months around `current`: `past` months ending with the current one,
 * from the dashboard's monthly trend (actuals, plus the current month's
 * pending and future-dated rows), then `future` months from the cash-flow
 * report's monthly forecast (recurring rules, installments, pending rows).
 * A month absent from a loaded source had no activity and reads as zero.
 */
export function buildMonthStrip(
  current: string,
  trend: MonthlyTrend[] | undefined,
  cashFlow: ReportResponse | undefined,
  past = 6,
  future = 6,
): MonthStripPoint[] {
  const trendByMonth = new Map((trend ?? []).map((row) => [row.month, row.income - row.expenses]))
  const flowByMonth = new Map(
    (cashFlow?.trend ?? []).map((point) => [
      point.date,
      (point.breakdowns?.inflow ?? 0) - (point.breakdowns?.outflow ?? 0),
    ]),
  )
  const points: MonthStripPoint[] = []
  for (let offset = -(past - 1); offset <= future; offset++) {
    const month = shiftMonth(current, offset)
    if (offset <= 0) {
      points.push({ month, net: trend ? trendByMonth.get(month) ?? 0 : null, projected: false })
    } else {
      points.push({ month, net: cashFlow ? flowByMonth.get(month) ?? 0 : null, projected: true })
    }
  }
  return points
}

export type CategoryTotal = {
  key: string
  categoryId: string | null
  name: string | null
  icon: string | null
  color: string | null
  total: number
  count: number
}

/**
 * Rows grouped by category and direction, largest first. Ignored rows stay
 * out, matching the list's own totals; transfers keep their category so the
 * movement is still visible.
 */
export function totalsByCategory(
  items: (AmountFields & { category_id: string | null; category: Transaction['category'] })[],
): { expenses: CategoryTotal[]; income: CategoryTotal[] } {
  const buckets = new Map<string, CategoryTotal & { credit: boolean }>()
  for (const tx of items) {
    if (tx.is_ignored) continue
    const credit = tx.type === 'credit'
    const key = `${credit ? 'in' : 'out'}:${tx.category_id ?? 'none'}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        key,
        credit,
        categoryId: tx.category_id,
        name: tx.category?.name ?? null,
        icon: tx.category?.icon ?? null,
        color: tx.category?.color ?? null,
        total: 0,
        count: 0,
      }
      buckets.set(key, bucket)
    }
    bucket.total += Math.abs(signedTransactionAmount(tx))
    bucket.count += 1
  }
  const sorted = [...buckets.values()].sort((a, b) => b.total - a.total)
  const strip = (b: CategoryTotal): CategoryTotal => ({
    key: b.key,
    categoryId: b.categoryId,
    name: b.name,
    icon: b.icon,
    color: b.color,
    total: b.total,
    count: b.count,
  })
  return {
    expenses: sorted.filter((b) => !b.credit).map(strip),
    income: sorted.filter((b) => b.credit).map(strip),
  }
}

/** "Out 26" — short month, two-digit year, no trailing period. */
export function monthStripLabel(month: string, locale: string): string {
  const [y, m] = month.split('-').map(Number)
  const date = new Date(y, m - 1, 2)
  const short = date.toLocaleDateString(locale, { month: 'short' }).replace(/\.$/, '')
  return `${short.charAt(0).toUpperCase()}${short.slice(1)} ${String(y).slice(2)}`
}

/** "+R$ 3,2 mil" — compact, signed, in the user's currency. */
export function formatCompactNet(value: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: 'compact',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
      signDisplay: 'exceptZero',
    }).format(Math.round(value))
  } catch {
    return `${value >= 0 ? '+' : '−'}${Math.abs(Math.round(value))}`
  }
}

/** Tint shared by the pending block's rows, so table and cards match. */
export const PENDING_SECTION_TINT = 'bg-[#FFFBF2] dark:bg-amber-500/[0.06]'
export const PENDING_SECTION_BORDER = 'border-[#F6EBD3] dark:border-amber-500/20'
