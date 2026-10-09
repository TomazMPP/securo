import { describe, expect, it } from 'vitest'
import type { LoanSchedule } from '@/types'
import { costBreakdown, monthlyBars, originalVsActual } from './loan-charts'

const schedule: LoanSchedule = {
  rate: 0.017, installment: 3956.54, principal: 77408.95, balance: 58047.09, balance_today: 58638.4,
  interest_paid: 2421.56, principal_paid: 19361.86, projected_interest: 9460.86, total_interest: 11882.42,
  baseline_interest: 17548.01, interest_saved: 5665.59, months_saved: 4, paid_installments: 6,
  remaining_installments: 2, next_due: '2026-10-21', payoff_date: '2026-11-21', baseline_end: '2028-07-21',
  payments: [
    { date: '2026-08-01', amount: 8102.58, kind: 'extra', interest: 480.93, principal: 7621.65, balance_after: 69787.3, payment_id: 'a', transaction_id: 't1', description: 'boleto' },
    { date: '2026-08-21', amount: 3956.54, kind: 'installment', interest: 790.33, principal: 3166.21, balance_after: 66621.1, payment_id: 'b', transaction_id: 't2', description: '01/24' },
  ],
  projected: [
    { date: '2026-10-21', payment: 3956.54, interest: 986.8, principal: 2969.74, balance_after: 55077.35 },
    { date: '2026-11-21', payment: 3956.54, interest: 936.31, principal: 3020.23, balance_after: 52057.12 },
  ],
}

describe('monthlyBars', () => {
  it('groups payments by month and keeps the month-end balance', () => {
    const bars = monthlyBars(schedule)
    expect(bars.map((b) => b.key)).toEqual(['2026-08', '2026-10', '2026-11'])
    const aug = bars[0]
    expect(aug.principal).toBeCloseTo(7621.65 + 3166.21, 2)
    expect(aug.interest).toBeCloseTo(480.93 + 790.33, 2)
    expect(aug.extra).toBeCloseTo(7621.65, 2)
    expect(aug.balance).toBe(66621.1)
    expect(aug.projected).toBe(false)
    expect(bars[1].projected).toBe(true)
  })

  it('reports the share of each month that went to interest', () => {
    const oct = monthlyBars(schedule)[1]
    expect(oct.interestShare).toBeCloseTo(986.8 / 3956.54, 4)
  })
})

describe('originalVsActual', () => {
  it('lays the signed contract next to the actual balance', () => {
    const rows = originalVsActual(schedule, '2026-08-21', 24)
    expect(rows[0].key).toBe('2026-08')
    expect(rows[0].actual).toBe(66621.1)
    expect(rows[0].original).toBeGreaterThan(rows[0].actual!)
    const last = rows.find((r) => r.key === '2028-07')
    expect(last?.original).toBeLessThan(5)
  })
})

describe('costBreakdown', () => {
  it('splits the contract into paid and remaining principal and interest', () => {
    const slices = Object.fromEntries(costBreakdown(schedule).map((s) => [s.key, s.value]))
    expect(slices.principalPaid + slices.principalLeft).toBeCloseTo(77408.95, 1)
    expect(slices.interestPaid).toBe(2421.56)
    expect(slices.interestLeft).toBe(9460.86)
  })
})
