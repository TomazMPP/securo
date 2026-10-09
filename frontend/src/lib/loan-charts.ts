// Series for the loan charts, built from the backend schedule: real
// payments (split into interest and principal) up to today, then the
// projected installments to payoff.
import type { LoanSchedule } from '@/types'
import { pricePayment } from './loan-math'

export interface MonthBar {
  key: string // YYYY-MM
  principal: number
  interest: number
  extra: number // early repayment principal in the month (part of `principal`)
  balance: number
  projected: boolean
  interestShare: number // interest / (interest + principal)
}

const monthKey = (iso: string) => iso.slice(0, 7)

function addMonthsKey(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** One bar per month: what was paid (or will be) split into principal and
 *  interest, with the balance left at the end of that month. */
export function monthlyBars(s: LoanSchedule): MonthBar[] {
  const byMonth = new Map<string, MonthBar>()
  const touch = (key: string, projected: boolean) => {
    let bar = byMonth.get(key)
    if (!bar) {
      bar = { key, principal: 0, interest: 0, extra: 0, balance: 0, projected, interestShare: 0 }
      byMonth.set(key, bar)
    }
    return bar
  }
  for (const p of s.payments) {
    const bar = touch(monthKey(p.date), false)
    bar.principal += p.principal
    bar.interest += p.interest
    if (p.kind === 'extra') bar.extra += p.principal
    bar.balance = p.balance_after
  }
  for (const p of s.projected) {
    const bar = touch(monthKey(p.date), true)
    bar.principal += p.principal
    bar.interest += p.interest
    bar.balance = p.balance_after
  }
  const bars = [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key))
  for (const bar of bars) {
    const total = bar.principal + bar.interest
    bar.interestShare = total > 0 ? bar.interest / total : 0
    bar.principal = round(bar.principal)
    bar.interest = round(bar.interest)
    bar.extra = round(bar.extra)
  }
  return bars
}

export interface CompareRow {
  key: string
  original: number | null
  actual: number | null
}

/** Balance month by month under the contract as signed (no early
 *  repayments) against what actually happened and is now projected. */
export function originalVsActual(s: LoanSchedule, firstDue: string, totalInstallments: number): CompareRow[] {
  const start = monthKey(firstDue)
  const rows = new Map<string, CompareRow>()
  let balance = s.principal
  const payment = pricePayment(s.principal, s.rate, totalInstallments)
  for (let k = 0; k < totalInstallments; k++) {
    balance = Math.max(0, balance * (1 + s.rate) - payment)
    const key = addMonthsKey(start, k)
    rows.set(key, { key, original: round(balance), actual: null })
  }
  for (const bar of monthlyBars(s)) {
    const row = rows.get(bar.key) ?? { key: bar.key, original: null, actual: null }
    row.actual = bar.balance
    rows.set(bar.key, row)
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export interface CostSlice {
  key: 'principalPaid' | 'interestPaid' | 'principalLeft' | 'interestLeft'
  value: number
}

export function costBreakdown(s: LoanSchedule): CostSlice[] {
  return [
    { key: 'principalPaid', value: round(s.principal_paid) },
    { key: 'interestPaid', value: round(s.interest_paid) },
    { key: 'principalLeft', value: round(Math.max(0, s.principal - s.principal_paid)) },
    { key: 'interestLeft', value: round(s.projected_interest) },
  ]
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}
