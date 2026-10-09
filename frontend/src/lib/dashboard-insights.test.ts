import { describe, expect, it } from 'vitest'
import {
  biggestCategoryChange,
  buildCumulativeSeries,
  buildUpcomingItems,
  categoryTotalsUpTo,
  daysUntil,
  findEndingInstallments,
  formatWholeCurrency,
  percentChange,
  sumUpToDay,
} from './dashboard-insights'
import type { Account, ProjectedTransaction, ReportResponse, Transaction } from '@/types'

function report(month: string, perDay: Record<number, { expenses?: number; income?: number; cats?: Record<string, number> }>, days = 30): ReportResponse {
  return {
    summary: { primary_value: 0, change_amount: 0, change_percent: null, breakdowns: [] },
    trend: Array.from({ length: days }, (_, i) => {
      const e = perDay[i + 1] ?? {}
      return {
        date: `${month}-${String(i + 1).padStart(2, '0')}`,
        value: 0,
        change: null,
        breakdowns: { income: e.income ?? 0, expenses: e.expenses ?? 0 },
        composition: Object.entries(e.cats ?? {}).map(([key, value]) => ({
          key, label: key.toUpperCase(), value, color: '#000', group: 'expenses',
        })),
      }
    }),
    meta: { type: 'income_expenses', series_keys: [], currency: 'USD', interval: 'daily' },
    composition: [],
    category_trend: [],
  }
}

describe('cumulative spend', () => {
  it('accumulates the current month up to the last day and the previous month in full', () => {
    const cur = report('2026-10', { 1: { expenses: 10 }, 3: { expenses: 5 } }, 3)
    const prev = report('2026-09', { 1: { expenses: 7 }, 30: { expenses: 3 } })
    const series = buildCumulativeSeries(cur, prev, 31, 30, 3)
    expect(series).toHaveLength(31)
    expect(series[0]).toEqual({ day: 1, current: 10, previous: 7 })
    expect(series[2]).toEqual({ day: 3, current: 15, previous: 7 })
    expect(series[3].current).toBeNull()
    expect(series[29].previous).toBe(10)
    expect(series[30].previous).toBeNull()
  })

  it('sums a series up to a given day', () => {
    const r = report('2026-09', { 2: { expenses: 4, income: 9 }, 10: { expenses: 6 } })
    expect(sumUpToDay(r, 9)).toBe(4)
    expect(sumUpToDay(r, 10)).toBe(10)
    expect(sumUpToDay(r, 30, 'income')).toBe(9)
  })
})

describe('category change', () => {
  it('picks the largest move and ignores noise', () => {
    const cur = categoryTotalsUpTo(report('2026-10', { 1: { cats: { food: 100, fun: 50 } } }), 9)
    const prev = categoryTotalsUpTo(report('2026-09', { 2: { cats: { food: 336, fun: 50.5 } }, 20: { cats: { food: 999 } } }), 9)
    expect(biggestCategoryChange(cur, prev)).toEqual({ key: 'food', label: 'FOOD', delta: -236 })
  })

  it('returns null when nothing moved', () => {
    const same = categoryTotalsUpTo(report('2026-10', { 1: { cats: { food: 10 } } }), 9)
    expect(biggestCategoryChange(same, same)).toBeNull()
  })
})

function tx(o: Partial<Transaction>): Transaction {
  return {
    id: 'x', type: 'debit', amount: 10, amount_primary: null, currency: 'USD', date: '2026-10-05',
    account_id: 'a', description: 'd', installment_number: null, total_installments: null,
    installment_series_id: null, installment_purchase_date: null, is_ignored: false,
    transfer_pair_id: null, category: null, recurring_transaction_id: null, ...o,
  } as Transaction
}

describe('installments ending', () => {
  it('returns the soonest ending month with the freed amount', () => {
    const result = findEndingInstallments([
      tx({ installment_series_id: 'a', installment_number: 11, total_installments: 12, amount: 50 }),
      tx({ installment_series_id: 'b', installment_number: 4, total_installments: 5, amount: 25.5 }),
      tx({ installment_series_id: 'c', installment_number: 1, total_installments: 10, amount: 999 }),
      tx({ installment_series_id: 'd', installment_number: 3, total_installments: 5, amount: 1 }),
    ], '2026-10')
    expect(result).toEqual({ endMonth: '2026-11', freedFrom: '2026-12', count: 2, monthlyAmount: 75.5 })
  })

  it('returns null without installments near their end', () => {
    expect(findEndingInstallments([tx({ installment_number: 1, total_installments: 12 })], '2026-10')).toBeNull()
    expect(findEndingInstallments([tx({})], '2026-10')).toBeNull()
  })
})

describe('upcoming items', () => {
  const card = { id: 'card', name: 'Visa', display_name: null, type: 'credit_card', is_closed: false, next_due_date: '2026-10-20', current_balance: -400, balance_primary: null, currency: 'USD', shared_balance_group: null } as Account
  it('merges projections, scheduled rows and card bills by date', () => {
    const projected = [
      { recurring_id: 'r1', date: '2026-10-12', type: 'debit', amount: 100, amount_primary: null, currency: 'USD', description: 'Rent', account_id: 'chk', category_name: 'Home' },
      { recurring_id: 'r2', date: '2026-10-13', type: 'credit', amount: 999, amount_primary: null, currency: 'USD', description: 'Salary', account_id: 'chk', category_name: null },
    ] as ProjectedTransaction[]
    const scheduled = [
      tx({ id: 's1', date: '2026-10-15', amount: 30, account_id: 'chk', description: 'Internet' }),
      tx({ id: 's2', date: '2026-10-16', amount: 50, account_id: 'card', description: 'Card parcel' }),
    ]
    const items = buildUpcomingItems({ projected, scheduled, cards: [card], from: '2026-10-09', to: '2026-11-08', primaryCurrency: 'USD' })
    expect(items.map((i) => [i.description, i.amount, i.kind])).toEqual([
      ['Rent', 100, 'recurring'],
      ['Internet', 30, 'scheduled'],
      ['Visa', 400, 'card_bill'],
    ])
  })
})

describe('small helpers', () => {
  it('computes percent change and day distances', () => {
    expect(percentChange(110, 100)).toBeCloseTo(10)
    expect(percentChange(10, 0)).toBeNull()
    expect(percentChange(-50, -100)).toBeCloseTo(50)
    expect(daysUntil('2026-10-12', new Date(2026, 9, 9, 23, 0))).toBe(3)
  })

  it('formats whole currency without cents', () => {
    expect(formatWholeCurrency(4286.4, 'USD', 'en-US')).toBe('$4,286')
    expect(formatWholeCurrency(-0.3, 'USD', 'en-US')).toBe('$0')
  })
})
