import { describe, expect, it } from 'vitest'
import { pricePayment, projectBalances, simulatePrepayment } from './loan-math'

// A 25-installment remainder of a vehicle financing at 1.29% a.m.
const BALANCE = 50673.4
const RATE = 0.0129
const N = 25
const PAYMENT = 2384.17

describe('pricePayment', () => {
  it('matches the contract installment', () => {
    expect(pricePayment(BALANCE, RATE, N)).toBeCloseTo(PAYMENT, 0)
  })

  it('splits evenly without interest and is zero when nothing is owed', () => {
    expect(pricePayment(1200, 0, 12)).toBe(100)
    expect(pricePayment(0, RATE, 12)).toBe(0)
  })
})

describe('projectBalances', () => {
  it('reaches zero after the remaining installments', () => {
    const balances = projectBalances(BALANCE, RATE, PAYMENT, N)
    expect(balances[0]).toBe(BALANCE)
    expect(balances.length).toBe(N + 1)
    expect(balances[balances.length - 1]).toBeLessThan(5)
  })
})

describe('simulatePrepayment', () => {
  it('shortens the term and saves interest', () => {
    const r = simulatePrepayment(BALANCE, RATE, PAYMENT, N, 10000, 'term')
    expect(r.installmentsCut).toBeGreaterThanOrEqual(4)
    expect(r.saving).toBeGreaterThan(1000)
    expect(r.newPayment).toBe(PAYMENT)
  })

  it('lowers the installment over the same term', () => {
    const r = simulatePrepayment(BALANCE, RATE, PAYMENT, N, 10000, 'payment')
    expect(r.newPayment).toBeLessThan(PAYMENT)
    expect(r.newPayment).toBeCloseTo(pricePayment(BALANCE - 10000, RATE, N), 6)
    expect(r.saving).toBeGreaterThan(0)
  })

  it('saves more interest by shortening the term than by lowering the installment', () => {
    const term = simulatePrepayment(BALANCE, RATE, PAYMENT, N, 10000, 'term')
    const pay = simulatePrepayment(BALANCE, RATE, PAYMENT, N, 10000, 'payment')
    expect(term.saving).toBeGreaterThan(pay.saving)
  })

  it('caps the prepayment at the balance', () => {
    const r = simulatePrepayment(BALANCE, RATE, PAYMENT, N, 1e9, 'term')
    expect(r.installmentsCut).toBe(N)
    expect(r.saving).toBeCloseTo(PAYMENT * N - BALANCE, 2)
  })

  it('does nothing for a zero amount', () => {
    const r = simulatePrepayment(BALANCE, RATE, PAYMENT, N, 0, 'term')
    expect(r.installmentsCut).toBe(0)
    expect(r.saving).toBeLessThan(1)
  })
})
