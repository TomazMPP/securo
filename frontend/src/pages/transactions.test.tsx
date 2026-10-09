import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import TransactionsPage from '@/pages/transactions'
import { renderWithProviders, t } from '@/test/utils'
import type { Transaction } from '@/types'

const mobile = vi.hoisted(() => ({ value: false }))

const api = vi.hoisted(() => ({
  transactions: {
    list: vi.fn(),
    calendar: vi.fn(),
    get: vi.fn(),
  },
  dashboard: { monthlyTrend: vi.fn() },
  reports: { cashFlow: vi.fn() },
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  const empty = () => Promise.resolve([])
  return {
    ...actual,
    transactions: { ...actual.transactions, ...api.transactions },
    dashboard: { ...actual.dashboard, ...api.dashboard },
    reports: { ...actual.reports, ...api.reports },
    categories: { ...actual.categories, list: empty, listIncludingHidden: empty },
    categoryGroups: { ...actual.categoryGroups, list: empty },
    accounts: {
      ...actual.accounts,
      list: () => Promise.resolve([{ id: 'acc-1', name: 'Inter', type: 'checking', currency: 'USD' }]),
    },
    recurring: { ...actual.recurring, list: empty },
    payees: { ...actual.payees, list: empty },
    groups: { ...actual.groups, list: empty },
    reconciliation: { ...actual.reconciliation, suggestions: empty },
    admin: { ...actual.admin, accountingMode: () => Promise.resolve({ mode: 'cash' }) },
  }
})

vi.mock('@/hooks/use-display-locale', () => ({
  useDisplayLocale: () => 'en-US',
  useDateLocale: () => 'en-US',
}))
vi.mock('@/hooks/use-timezone', () => ({
  useEffectiveTimezone: () => undefined,
  useTimezones: () => ({ data: undefined }),
}))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.value }))
vi.mock('@/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => ({ mask: (value: string) => value, privacyMode: false }),
}))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { preferences: { currency_display: 'USD' } } }),
}))
vi.mock('@/contexts/workspace-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/workspace-context')>()),
  useWorkspace: () => ({ canWrite: true, hasModule: () => false }),
}))
vi.mock('@/contexts/collection-filter-context', () => ({
  useCollectionFilter: () => ({ activeAccountIds: null, activeWalletIds: null }),
}))

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    account_id: 'acc-1',
    category_id: null,
    category: null,
    description: 'Row',
    amount: 10,
    amount_primary: null,
    currency: 'USD',
    date: '2026-10-09',
    type: 'debit',
    source: 'manual',
    status: 'posted',
    notes: null,
    payee: null,
    payee_id: null,
    payee_name: null,
    is_ignored: false,
    is_shared: false,
    viewer_share: null,
    transfer_pair_id: null,
    recurring_transaction_id: null,
    installment_number: null,
    total_installments: null,
    attachment_count: 0,
    ...overrides,
  } as Transaction
}

const ITEMS = [
  tx({ id: 'p1', description: 'Gas station', status: 'pending', amount: 312.4 }),
  tx({ id: 't1', description: 'Supermarket', amount: 342.18 }),
  tx({
    id: 't2',
    description: 'Headphones',
    amount: 65,
    installment_number: 3,
    total_installments: 10,
    category_id: 'shop',
    category: { id: 'shop', name: 'Shopping', icon: 'shopping-bag', color: '#A3264F' } as Transaction['category'],
  }),
  tx({ id: 'y1', description: 'Pharmacy', date: '2026-10-08', amount: 97.05 }),
  tx({ id: 's1', description: 'Salary', date: '2026-10-06', type: 'credit', amount: 18420 }),
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 9, 12))
  vi.clearAllMocks()
  localStorage.clear()
  mobile.value = false
  window.history.replaceState(null, '', '/transactions')
  api.transactions.list.mockResolvedValue({
    items: ITEMS,
    total: ITEMS.length,
    page: 1,
    limit: 20,
    summary: { income: 18420, expense: 816.63, net: 17603.37, excluded: 0, currency: 'USD' },
  })
  api.dashboard.monthlyTrend.mockResolvedValue([{ month: '2026-10', income: 18420, expenses: 816.63 }])
  api.reports.cashFlow.mockResolvedValue({
    summary: { primary_value: 0, change_amount: 0, change_percent: null, breakdowns: [] },
    trend: [],
    meta: { type: 'cash_flow', series_keys: [], currency: 'USD', interval: 'monthly' },
    composition: [],
    category_trend: [],
  })
})

afterEach(() => vi.useRealTimers())

describe('Transactions page — statement layout', () => {
  it('puts pending rows on top and groups the rest by day with each day net', async () => {
    renderWithProviders(<TransactionsPage />, { route: '/transactions' })

    expect(await screen.findByText('Supermarket')).toBeInTheDocument()

    const pendingHeader = screen.getByText(t('transactions.pendingSection.title', { count: 1 }))
    expect(pendingHeader).toBeInTheDocument()
    expect(screen.getByText(t('transactions.pendingSection.included', { amount: '$312.40' }))).toBeInTheDocument()

    const rows = screen.getAllByRole('row').map((row) => row.textContent ?? '')
    const index = (text: string) => rows.findIndex((r) => r.includes(text))
    expect(index('Gas station')).toBeLessThan(index(t('transactions.dayToday')))
    expect(index(t('transactions.dayToday'))).toBeLessThan(index('Supermarket'))
    expect(index(t('transactions.dayYesterday'))).toBeLessThan(index('Pharmacy'))

    const todayRow = screen.getAllByRole('row').find((r) => r.textContent?.includes(t('transactions.dayToday')))!
    expect(todayRow).toHaveTextContent('−$407.18')
    const salaryDay = screen.getAllByRole('row')[index('Salary') - 1]
    expect(salaryDay).toHaveTextContent('+$18,420.00')
  })

  it('shows the account and installment position under the description', async () => {
    renderWithProviders(<TransactionsPage />, { route: '/transactions' })
    const row = (await screen.findByText('Headphones')).closest('tr')!
    expect(row).toHaveTextContent(t('transactions.installmentPosition', { current: 3, total: 10 }))
    expect(within(row).getByText('Shopping')).toBeInTheDocument()
  })

  it('summarises the filtered rows in the filter bar', async () => {
    renderWithProviders(<TransactionsPage />, { route: '/transactions' })
    await screen.findByText('Supermarket')
    expect(screen.getByText(t('transactions.summaryInflows')).parentElement).toHaveTextContent('$18,420.00')
    expect(screen.getByText(t('transactions.summaryOutflows')).parentElement).toHaveTextContent('$816.63')
  })

  it('keeps shift-click ranges in on-screen order across the pending block', async () => {
    renderWithProviders(<TransactionsPage />, { route: '/transactions' })
    await screen.findByText('Supermarket')
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: 'Gas station' }))
    await user.keyboard('{Shift>}')
    await user.click(screen.getByRole('checkbox', { name: 'Supermarket' }))
    await user.keyboard('{/Shift}')
    expect(screen.getByRole('checkbox', { name: 'Gas station' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Supermarket' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Headphones' })).not.toBeChecked()
  })

  it('sets the month range from the strip', async () => {
    renderWithProviders(<TransactionsPage />, { route: '/transactions' })
    await screen.findByText('Supermarket')
    await userEvent.click(screen.getByRole('button', { name: /Aug 26/ }))
    await waitFor(() =>
      expect(api.transactions.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: '2026-08-01', to: '2026-08-31' }),
      ),
    )
    expect(screen.getByRole('button', { name: /Aug 26/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('groups mobile cards the same way', async () => {
    mobile.value = true
    renderWithProviders(<TransactionsPage />, { route: '/transactions' })
    await screen.findByText('Supermarket')
    expect(screen.getByText(t('transactions.pendingSection.title', { count: 1 }))).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`^${t('transactions.dayToday')} · `))).toBeInTheDocument()
  })
})
