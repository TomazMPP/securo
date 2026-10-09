import { describe, expect, it } from 'vitest'
import type { ProjectedTransaction, Transaction } from '@/types'
import {
  averageMonthlyIncome,
  buildForecast,
  buildMonthItems,
  findInstallmentRelief,
  groupBy,
  normalizeLoans,
  totalsOf,
} from './recurring-overview'

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: 'tx',
    user_id: 'u',
    account_id: 'acc',
    category_id: null,
    category: null,
    external_id: null,
    description: 'Tx',
    original_description: null,
    amount: 100,
    currency: 'BRL',
    date: '2026-10-10',
    type: 'debit',
    source: 'manual',
    status: 'posted',
    payee: null,
    payee_id: null,
    payee_name: null,
    notes: null,
    transfer_pair_id: null,
    amount_primary: null,
    fx_rate_used: null,
    fx_fallback: false,
    installment_number: null,
    total_installments: null,
    installment_total_amount: null,
    installment_purchase_date: null,
    installment_series_id: null,
    bill_id: null,
    effective_bill_date: null,
    splits: [],
    ...over,
  } as Transaction
}

function proj(over: Partial<ProjectedTransaction>): ProjectedTransaction {
  return {
    recurring_id: 'r1',
    account_id: 'acc',
    description: 'Rent',
    amount: 2000,
    amount_primary: null,
    currency: 'BRL',
    type: 'debit',
    date: '2026-10-20',
    category_id: null,
    category_name: null,
    category_icon: null,
    category_color: null,
    ...over,
  }
}

const base = { today: '2026-10-09', kind: 'debit' as const, loans: [] }

describe('buildMonthItems', () => {
  it('classifies paid recurring, projected recurring and installments', () => {
    const items = buildMonthItems({
      ...base,
      month: '2026-10',
      transactions: [
        tx({ id: 'a', recurring_transaction_id: 'r0', amount: 50, date: '2026-10-05' }),
        tx({ id: 'b', installment_number: 3, total_installments: 10, amount: 65, date: '2026-10-12' }),
        tx({ id: 'c', amount: 999 }), // plain spending is not a commitment
        tx({ id: 'd', recurring_transaction_id: 'r0', date: '2026-11-05' }), // other month
      ],
      projections: [proj({})],
    })
    expect(items.map((i) => [i.key, i.kind, i.paid])).toEqual([
      ['tx-a', 'fixed', true],
      ['tx-b', 'installment', false],
      ['proj-r1-2026-10-20', 'fixed', false],
    ])
    expect(totalsOf(items)).toMatchObject({ fixed: 2050, installments: 65, total: 2115, paid: 50, remaining: 2065 })
  })

  it('filters by kind and prefers the primary-currency amount', () => {
    const items = buildMonthItems({
      ...base,
      month: '2026-10',
      transactions: [],
      projections: [proj({ amount_primary: 10 }), proj({ recurring_id: 'r2', type: 'credit' })],
    })
    expect(items).toHaveLength(1)
    expect(items[0].amount).toBe(10)
  })

  it('projects active loans forward until their final due date', () => {
    const loans = normalizeLoans([
      { id: 'l1', name: 'Car', installment_amount: '2384.17', final_due_date: '2026-12-15', installments_paid: 23, total_installments: 48 },
      { id: 'l2', name: 'Done', installment_amount: 10, final_due_date: '2027-01-01', status: 'closed' },
    ])
    expect(loans.map((l) => l.id)).toEqual(['l1'])
    const oct = buildMonthItems({ ...base, month: '2026-10', transactions: [], projections: [], loans })
    expect(oct).toHaveLength(1)
    expect(oct[0]).toMatchObject({ kind: 'financing', date: '2026-10-15', amount: 2384.17, paid: false, installmentNumber: 24 })
    expect(buildMonthItems({ ...base, month: '2027-01', transactions: [], projections: [], loans })).toHaveLength(0)
    expect(buildMonthItems({ ...base, month: '2026-09', transactions: [], projections: [], loans })).toHaveLength(0)
  })
})

describe('forecast helpers', () => {
  const transactions = [
    tx({ id: '1', installment_number: 9, total_installments: 10, amount: 100, date: '2026-10-12' }),
    tx({ id: '2', installment_number: 10, total_installments: 10, amount: 100, date: '2026-11-12' }),
    tx({ id: '3', installment_number: 2, total_installments: 6, amount: 40, date: '2026-11-03' }),
  ]

  it('sums each month of the window', () => {
    const forecast = buildForecast({ ...base, month: '2026-10', count: 3, transactions, projections: [] })
    expect(forecast.map((m) => [m.month, m.installments])).toEqual([
      ['2026-10', 100],
      ['2026-11', 140],
      ['2026-12', 0],
    ])
  })

  it('finds the month installments end and how much is freed', () => {
    expect(findInstallmentRelief({ ...base, month: '2026-10', transactions, projections: [] })).toEqual({
      month: '2026-12',
      count: 1,
      amount: 100,
    })
    expect(findInstallmentRelief({ ...base, month: '2026-10', transactions: [], projections: [] })).toBeNull()
  })
})

describe('averageMonthlyIncome', () => {
  it('averages the last complete months with income', () => {
    const trend = [
      { month: '2026-06', income: 1000, expenses: 0 },
      { month: '2026-07', income: 0, expenses: 0 },
      { month: '2026-08', income: 2000, expenses: 0 },
      { month: '2026-09', income: 3000, expenses: 0 },
      { month: '2026-10', income: 50, expenses: 0 },
    ]
    expect(averageMonthlyIncome(trend, '2026-10')).toBe(2000)
    expect(averageMonthlyIncome([], '2026-10')).toBeNull()
  })
})

describe('groupBy', () => {
  it('keeps first-seen order', () => {
    expect(groupBy([1, 2, 3, 4], (n) => (n % 2 ? 'odd' : 'even')).map((g) => [g.key, g.items])).toEqual([
      ['odd', [1, 3]],
      ['even', [2, 4]],
    ])
  })
})
