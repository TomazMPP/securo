import type { MonthlyTrend, ProjectedTransaction, Transaction } from '@/types'
import { monthLastDay, shiftMonth } from '@/lib/month-utils'

/**
 * Pure helpers behind the Recurring page. They fold three sources into one
 * list of "commitments" per month:
 *
 * - fixed bills: recurring rules — the occurrences already booked as a
 *   transaction (linked through `recurring_transaction_id`, so paid) plus the
 *   projections the server still expects (to pay);
 * - installments: transactions carrying `installment_number/total_installments`
 *   (card purchases split in parcels, already booked into future months);
 * - financing: active loans, one `installment_amount` a month until their
 *   `final_due_date`.
 *
 * Amounts are positive and in the primary currency when the source carries a
 * converted value; otherwise the native amount is used.
 */

export type CommitmentKind = 'fixed' | 'installment' | 'financing'

export interface CommitmentItem {
  key: string
  kind: CommitmentKind
  /** `YYYY-MM-DD` */
  date: string
  description: string
  amount: number
  paid: boolean
  accountId: string | null
  categoryName: string | null
  categoryIcon: string | null
  categoryColor: string | null
  recurringId: string | null
  installmentNumber: number | null
  totalInstallments: number | null
}

/**
 * The slice of a loan this page needs. The loans API is owned elsewhere, so
 * every field beyond the two the projection depends on is optional.
 */
export interface LoanLike {
  id: string
  name?: string | null
  contract_name?: string | null
  institution_name?: string | null
  installment_amount?: number | string | null
  installment_amount_primary?: number | string | null
  final_due_date?: string | null
  next_due_date?: string | null
  status?: string | null
  is_active?: boolean | null
  installments_paid?: number | null
  paid_installments?: number | null
  total_installments?: number | null
  installments_total?: number | null
}

const INACTIVE_LOAN_STATUSES = new Set(['closed', 'paid', 'paid_off', 'inactive', 'finished', 'settled', 'cancelled', 'canceled'])

/** Accepts `[...]` or `{ items: [...] }`; anything else yields no loans. */
export function normalizeLoans(payload: unknown): LoanLike[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)
      ? (payload as { items: unknown[] }).items
      : []
  return list.filter((loan): loan is LoanLike => {
    if (!loan || typeof loan !== 'object') return false
    const l = loan as LoanLike
    if (l.is_active === false) return false
    if (l.status && INACTIVE_LOAN_STATUSES.has(String(l.status).toLowerCase())) return false
    return Number(l.installment_amount_primary ?? l.installment_amount) > 0 && !!l.final_due_date
  })
}

export function loanName(loan: LoanLike): string {
  return loan.name || loan.contract_name || loan.institution_name || ''
}

function amountOf(primary: number | null | undefined, native: number): number {
  return Math.abs(Number(primary ?? native) || 0)
}

function isInstallment(tx: Transaction): boolean {
  return tx.installment_number != null && tx.total_installments != null && tx.total_installments > 1
}

function dayInMonth(month: string, day: number): string {
  const clamped = Math.min(Math.max(day, 1), monthLastDay(month))
  return `${month}-${String(clamped).padStart(2, '0')}`
}

export interface BuildItemsInput {
  /** `YYYY-MM` */
  month: string
  /** `YYYY-MM-DD` */
  today: string
  kind: 'debit' | 'credit'
  transactions: Transaction[]
  projections: ProjectedTransaction[]
  loans: LoanLike[]
}

/** Every commitment due in `month`, sorted by date. */
export function buildMonthItems({ month, today, kind, transactions, projections, loans }: BuildItemsInput): CommitmentItem[] {
  const items: CommitmentItem[] = []

  for (const tx of transactions) {
    if (tx.type !== kind || !tx.date.startsWith(month) || tx.source === 'opening_balance') continue
    if (isInstallment(tx)) {
      items.push({
        key: `tx-${tx.id}`,
        kind: 'installment',
        date: tx.date,
        description: tx.description,
        amount: amountOf(tx.amount_primary, tx.amount),
        paid: tx.date <= today,
        accountId: tx.account_id,
        categoryName: tx.category?.name ?? null,
        categoryIcon: tx.category?.icon ?? null,
        categoryColor: tx.category?.color ?? null,
        recurringId: null,
        installmentNumber: tx.installment_number,
        totalInstallments: tx.total_installments,
      })
    } else if (tx.recurring_transaction_id) {
      items.push({
        key: `tx-${tx.id}`,
        kind: 'fixed',
        date: tx.date,
        description: tx.description,
        amount: amountOf(tx.amount_primary, tx.amount),
        paid: true,
        accountId: tx.account_id,
        categoryName: tx.category?.name ?? null,
        categoryIcon: tx.category?.icon ?? null,
        categoryColor: tx.category?.color ?? null,
        recurringId: tx.recurring_transaction_id,
        installmentNumber: null,
        totalInstallments: null,
      })
    }
  }

  for (const p of projections) {
    if (p.type !== kind || !p.date.startsWith(month)) continue
    items.push({
      key: `proj-${p.recurring_id}-${p.date}`,
      kind: 'fixed',
      date: p.date,
      description: p.description,
      amount: amountOf(p.amount_primary, p.amount),
      paid: false,
      accountId: p.account_id,
      categoryName: p.category_name,
      categoryIcon: p.category_icon,
      categoryColor: p.category_color,
      recurringId: p.recurring_id,
      installmentNumber: null,
      totalInstallments: null,
    })
  }

  // Loans only project forward: without a start date, a past month cannot
  // tell whether the contract already existed.
  if (kind === 'debit' && month >= today.slice(0, 7)) {
    for (const loan of loans) {
      const finalDue = loan.final_due_date!
      if (finalDue.slice(0, 7) < month) continue
      const date = dayInMonth(month, Number(finalDue.slice(8, 10)) || 1)
      const total = loan.total_installments ?? loan.installments_total ?? null
      const paidCount = loan.installments_paid ?? loan.paid_installments ?? null
      const monthsAhead = monthDiff(today.slice(0, 7), month)
      // The installment number falling in this month, when the loan says how
      // many are paid: next unpaid one this month, then one more per month.
      const thisMonthPaid = date < today
      const number = total != null && paidCount != null
        ? Math.min(total, paidCount + monthsAhead + (thisMonthPaid ? 0 : 1))
        : null
      items.push({
        key: `loan-${loan.id}-${month}`,
        kind: 'financing',
        date,
        description: loanName(loan),
        amount: Math.abs(Number(loan.installment_amount_primary ?? loan.installment_amount) || 0),
        paid: thisMonthPaid,
        accountId: null,
        categoryName: loan.institution_name ?? null,
        categoryIcon: 'landmark',
        categoryColor: null,
        recurringId: null,
        installmentNumber: number,
        totalInstallments: number != null ? total : null,
      })
    }
  }

  return items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount)
}

export function monthDiff(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm)
}

export interface CommitmentTotals {
  fixed: number
  installments: number
  financing: number
  total: number
  paid: number
  remaining: number
}

export function totalsOf(items: CommitmentItem[]): CommitmentTotals {
  const totals: CommitmentTotals = { fixed: 0, installments: 0, financing: 0, total: 0, paid: 0, remaining: 0 }
  for (const item of items) {
    if (item.kind === 'fixed') totals.fixed += item.amount
    else if (item.kind === 'installment') totals.installments += item.amount
    else totals.financing += item.amount
    totals.total += item.amount
    if (item.paid) totals.paid += item.amount
    else totals.remaining += item.amount
  }
  return totals
}

export interface ForecastMonth extends CommitmentTotals {
  month: string
}

/** `count` consecutive months starting at `month`, each with its totals. */
export function buildForecast(input: Omit<BuildItemsInput, 'month'> & { month: string; count?: number }): ForecastMonth[] {
  const count = input.count ?? 6
  return Array.from({ length: count }, (_, i) => {
    const month = shiftMonth(input.month, i)
    return { month, ...totalsOf(buildMonthItems({ ...input, month })) }
  })
}

/**
 * The first month in the window where installment plans stop: the plans whose
 * last parcel falls in the previous month. `amount` is the monthly sum freed.
 * Null when no plan ends inside the window.
 */
export function findInstallmentRelief(
  input: Omit<BuildItemsInput, 'month'> & { month: string; count?: number },
): { month: string; count: number; amount: number } | null {
  const count = input.count ?? 6
  for (let i = 0; i < count - 1; i += 1) {
    const month = shiftMonth(input.month, i)
    const ending = buildMonthItems({ ...input, month }).filter(
      (item) => item.kind === 'installment' && item.installmentNumber != null && item.installmentNumber === item.totalInstallments,
    )
    if (ending.length > 0) {
      return {
        month: shiftMonth(month, 1),
        count: ending.length,
        amount: ending.reduce((sum, item) => sum + item.amount, 0),
      }
    }
  }
  return null
}

/**
 * Average monthly income over the last `window` complete months before
 * `month` that had any income. Null when there is none to go on.
 */
export function averageMonthlyIncome(trend: MonthlyTrend[], month: string, window = 3): number | null {
  const complete = trend
    .filter((row) => row.month < month && Number(row.income) > 0)
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, window)
  if (complete.length === 0) return null
  return complete.reduce((sum, row) => sum + Number(row.income), 0) / complete.length
}

export interface DateGroup<T> {
  key: string
  items: T[]
}

/** Groups consecutive items by a key, keeping the incoming order. */
export function groupBy<T>(items: T[], keyOf: (item: T) => string): DateGroup<T>[] {
  const groups: DateGroup<T>[] = []
  const index = new Map<string, DateGroup<T>>()
  for (const item of items) {
    const key = keyOf(item)
    let group = index.get(key)
    if (!group) {
      group = { key, items: [] }
      index.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}
