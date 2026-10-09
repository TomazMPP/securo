import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TransactionsMonthStrip } from '@/components/transactions-month-strip'
import { renderWithProviders } from '@/test/utils'

const api = vi.hoisted(() => ({
  dashboard: { monthlyTrend: vi.fn() },
  reports: { cashFlow: vi.fn() },
}))

vi.mock('@/lib/api', () => ({ dashboard: api.dashboard, reports: api.reports }))

vi.mock('@/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => ({ mask: (value: string) => value, privacyMode: false }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  api.dashboard.monthlyTrend.mockResolvedValue([
    { month: '2026-08', income: 1000, expenses: 2400 },
    { month: '2026-10', income: 18000, expenses: 4000 },
  ])
  api.reports.cashFlow.mockResolvedValue({
    summary: { primary_value: 0, change_amount: 0, change_percent: null, breakdowns: [] },
    trend: [{ date: '2026-11', value: 0, breakdowns: { inflow: 3000, outflow: 600 }, change: null }],
    meta: { type: 'cash_flow', series_keys: [], currency: 'USD', interval: 'monthly' },
    composition: [],
    category_trend: [],
  })
})

function renderStrip(props: Partial<Parameters<typeof TransactionsMonthStrip>[0]> = {}) {
  const onSelectMonth = vi.fn()
  renderWithProviders(
    <TransactionsMonthStrip
      currentMonth="2026-10"
      selectedMonth="2026-10"
      onSelectMonth={onSelectMonth}
      accountIds={[]}
      currency="USD"
      locale="en-US"
      labelLocale="en-US"
      {...props}
    />,
  )
  return { onSelectMonth }
}

describe('TransactionsMonthStrip', () => {
  it('fetches the booked trend and the monthly forecast once each, scoped to the accounts', async () => {
    renderStrip({ accountIds: ['acc-1'] })
    await waitFor(() => expect(api.reports.cashFlow).toHaveBeenCalled())
    expect(api.dashboard.monthlyTrend).toHaveBeenCalledWith(6, ['acc-1'])
    // One month past the strip so its last month is a full forecast.
    expect(api.reports.cashFlow).toHaveBeenCalledWith(7, 'monthly', false, ['acc-1'])
  })

  it('shows twelve months, marks the selected one, and signs each net', async () => {
    renderStrip()
    const buttons = await screen.findAllByRole('button')
    expect(buttons).toHaveLength(12)
    const october = screen.getByRole('button', { name: /Oct 26/ })
    expect(october).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(october).toHaveTextContent('+$14K'))
    expect(screen.getByRole('button', { name: /Aug 26/ })).toHaveTextContent('-$1.4K')
    expect(screen.getByRole('button', { name: /Nov 26/ })).toHaveTextContent('+$2.4K')
  })

  it('selects a month when clicked', async () => {
    const { onSelectMonth } = renderStrip()
    await userEvent.click(await screen.findByRole('button', { name: /Dec 26/ }))
    expect(onSelectMonth).toHaveBeenCalledWith('2026-12')
  })

  it('fetches nothing for a wallet-only collection', () => {
    renderStrip({ disabled: true })
    expect(api.dashboard.monthlyTrend).not.toHaveBeenCalled()
    expect(api.reports.cashFlow).not.toHaveBeenCalled()
  })
})
