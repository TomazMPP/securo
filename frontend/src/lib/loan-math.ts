// Price-system (French amortization) helpers for the Loans page. Open
// Finance reports the outstanding balance, the remaining installment count
// and the contract's fixed monthly rate; everything below is derived from
// those three numbers, so it is an estimate the bank's own figures win over.

/** Installment that amortizes `balance` in `n` payments at monthly rate `i`. */
export function pricePayment(balance: number, i: number, n: number): number {
  if (n <= 0 || balance <= 0) return 0
  if (i === 0) return balance / n
  return (balance * i) / (1 - Math.pow(1 + i, -n))
}

/** Balance left after each of the next `n` payments of `payment` (index 0 = today). */
export function projectBalances(balance: number, i: number, payment: number, n: number): number[] {
  const out = [balance]
  let b = balance
  for (let k = 0; k < n && b > 0.005; k++) {
    b = b * (1 + i) - payment
    out.push(Math.max(0, b))
  }
  return out
}

export type PrepayMode = 'term' | 'payment'

export interface PrepayResult {
  /** Interest saved versus keeping the contract as is. */
  saving: number
  /** 'term': installments removed from the end of the contract. */
  installmentsCut: number
  /** 'payment': the new installment over the same remaining term. */
  newPayment: number
}

/**
 * Effect of paying `amount` off the balance today, either keeping the
 * installment and shortening the term, or keeping the term and lowering
 * the installment.
 */
export function simulatePrepayment(
  balance: number,
  i: number,
  payment: number,
  remaining: number,
  amount: number,
  mode: PrepayMode,
): PrepayResult {
  const prepay = Math.max(0, Math.min(amount, balance))
  const before = payment * remaining
  const left = balance - prepay
  if (left <= 0.005) {
    return { saving: Math.max(0, before - prepay), installmentsCut: remaining, newPayment: 0 }
  }
  if (mode === 'term') {
    const n = i === 0 ? left / payment : -Math.log(1 - (left * i) / payment) / Math.log(1 + i)
    const saving = before - (prepay + payment * n)
    return { saving: Math.max(0, saving), installmentsCut: Math.max(0, remaining - Math.ceil(n)), newPayment: payment }
  }
  const newPayment = pricePayment(left, i, remaining)
  return { saving: Math.max(0, before - (prepay + newPayment * remaining)), installmentsCut: 0, newPayment }
}
