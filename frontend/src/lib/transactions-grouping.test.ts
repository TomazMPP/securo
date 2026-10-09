import { describe, expect, it } from 'vitest'
import {
  buildMonthStrip,
  groupByDay,
  partitionPending,
  relativeDay,
  signedTransactionAmount,
  totalsByCategory,
} from '@/lib/transactions-grouping'
import type { ReportResponse, Transaction } from '@/types'

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    date: '2026-10-09',
    type: 'debit',
    amount: 10,
    amount_primary: null,
    is_ignored: false,
    is_shared: false,
    viewer_share: null,
    status: 'posted',
    category_id: null,
    category: null,
    ...overrides,
  } as Transaction
}

describe('signedTransactionAmount', () => {
  it('signs credits positive and debits negative, preferring the primary amount', () => {
    expect(signedTransactionAmount(tx({ type: 'credit', amount: 100 }))).toBe(100)
    expect(signedTransactionAmount(tx({ type: 'debit', amount: 40, amount_primary: 200 }))).toBe(-200)
  })

  it('leaves ignored rows out of the net', () => {
    expect(signedTransactionAmount(tx({ amount: 50, is_ignored: true }))).toBe(0)
  })

  it('counts only the viewer share of a shared row, converted like the row', () => {
    expect(
      signedTransactionAmount(tx({ amount: 100, amount_primary: 500, is_shared: true, viewer_share: 25 })),
    ).toBe(-125)
  })
})

describe('groupByDay', () => {
  it('groups consecutive dates in the given order with each day net', () => {
    const groups = groupByDay([
      tx({ date: '2026-10-09', amount: 30 }),
      tx({ date: '2026-10-09', type: 'credit', amount: 10 }),
      tx({ date: '2026-10-06', type: 'credit', amount: 1000 }),
    ])
    expect(groups.map((g) => [g.date, g.items.length, g.net])).toEqual([
      ['2026-10-09', 2, -20],
      ['2026-10-06', 1, 1000],
    ])
  })
})

describe('partitionPending', () => {
  it('splits rows the bank has not settled from the rest, keeping order', () => {
    const a = tx({ id: 'a', status: 'pending' })
    const b = tx({ id: 'b' })
    const c = tx({ id: 'c', status: 'pending' })
    const { pending, settled } = partitionPending([a, b, c])
    expect(pending.map((t) => t.id)).toEqual(['a', 'c'])
    expect(settled.map((t) => t.id)).toEqual(['b'])
  })
})

describe('relativeDay', () => {
  it('names today and yesterday, across a month boundary too', () => {
    expect(relativeDay('2026-10-09', '2026-10-09')).toBe('today')
    expect(relativeDay('2026-09-30', '2026-10-01')).toBe('yesterday')
    expect(relativeDay('2026-10-06', '2026-10-09')).toBeNull()
  })
})

describe('buildMonthStrip', () => {
  const cashFlow = {
    trend: [
      { date: '2026-10', value: 0, breakdowns: { inflow: 999, outflow: 1 }, change: null },
      { date: '2026-11', value: 0, breakdowns: { inflow: 5000, outflow: 2600 }, change: null },
      { date: '2027-01', value: 0, breakdowns: { inflow: 100, outflow: 300 }, change: null },
    ],
  } as unknown as ReportResponse

  it('takes six booked months from the trend and six projected from the cash flow', () => {
    const points = buildMonthStrip(
      '2026-10',
      [
        { month: '2026-08', income: 1000, expenses: 2400 },
        { month: '2026-10', income: 18420, expenses: 4286 },
      ],
      cashFlow,
    )
    expect(points).toHaveLength(12)
    expect(points[0]).toEqual({ month: '2026-05', net: 0, projected: false })
    expect(points[3]).toEqual({ month: '2026-08', net: -1400, projected: false })
    // The current month is booked activity, never the cash-flow forecast.
    expect(points[5]).toEqual({ month: '2026-10', net: 14134, projected: false })
    expect(points[6]).toEqual({ month: '2026-11', net: 2400, projected: true })
    expect(points[7]).toEqual({ month: '2026-12', net: 0, projected: true })
    expect(points[8]).toEqual({ month: '2027-01', net: -200, projected: true })
    expect(points[11].month).toBe('2027-04')
  })

  it('leaves values unknown while a source is loading', () => {
    const points = buildMonthStrip('2026-10', undefined, undefined)
    expect(points.every((p) => p.net === null)).toBe(true)
  })
})

describe('totalsByCategory', () => {
  it('sums each side per category, largest first, without ignored rows', () => {
    const food = { id: 'food', name: 'Food', icon: 'utensils', color: '#0E6F5C' }
    const { expenses, income } = totalsByCategory([
      tx({ category_id: 'food', category: food as Transaction['category'], amount: 30 }),
      tx({ category_id: 'food', category: food as Transaction['category'], amount: 20 }),
      tx({ category_id: null, amount: 80 }),
      tx({ category_id: null, amount: 500, is_ignored: true }),
      tx({ category_id: 'food', category: food as Transaction['category'], type: 'credit', amount: 5 }),
    ])
    expect(expenses.map((r) => [r.categoryId, r.total, r.count])).toEqual([
      [null, 80, 1],
      ['food', 50, 2],
    ])
    expect(income.map((r) => [r.categoryId, r.total])).toEqual([['food', 5]])
  })
})
