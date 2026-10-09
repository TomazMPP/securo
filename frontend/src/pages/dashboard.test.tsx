import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'

import DashboardPage from '@/pages/dashboard'
import { TooltipProvider } from '@/components/ui/tooltip'
import { renderWithProviders, t } from '@/test/utils'
import type { Account, DashboardSummary, ReportResponse, Transaction } from '@/types'

const api = vi.hoisted(() => ({
  dashboard: {
    summary: vi.fn(),
    spendingByCategory: vi.fn(),
    balanceHistory: vi.fn(),
    projectedTransactions: vi.fn(),
  },
  reports: { incomeExpenses: vi.fn(), netWorth: vi.fn() },
  transactions: { list: vi.fn(), update: vi.fn(), delete: vi.fn(), unlinkTransfer: vi.fn() },
  budgets: { comparison: vi.fn() },
  categories: { list: vi.fn() },
  categoryGroups: { list: vi.fn() },
  accounts: { list: vi.fn() },
  goals: { summary: vi.fn() },
  default: { get: vi.fn() },
}))

vi.mock('@/lib/api', () => api)

vi.mock('@/hooks/use-display-locale', () => ({
  useDisplayLocale: () => 'en-US',
  useDateLocale: () => 'en-US',
}))

vi.mock('@/hooks/use-privacy-mode', () => ({
  usePrivacyMode: () => ({ mask: (value: string) => value, privacyMode: false, MASK: '••••' }),
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { preferences: { currency_display: 'USD' } } }),
}))

vi.mock('@/contexts/collection-filter-context', () => ({
  useCollectionFilter: () => ({ activeAccountIds: null, activeWalletIds: null }),
}))

const modules = vi.hoisted(() => ({ enabled: new Set<string>() }))
vi.mock('@/contexts/workspace-context', () => ({
  useWorkspace: () => ({ hasModule: (id: string) => modules.enabled.has(id), canWrite: true }),
}))

function account(overrides: Partial<Account>): Account {
  return {
    id: 'acc',
    user_id: 'user-1',
    connection_id: null,
    external_id: null,
    name: 'Account',
    display_name: null,
    masked_number: null,
    institution_name: null,
    institution_logo_url: null,
    type: 'checking',
    balance: 0,
    current_balance: 0,
    previous_balance: null,
    balance_primary: null,
    currency: 'USD',
    credit_limit: null,
    available_credit: null,
    statement_close_day: null,
    payment_due_day: null,
    next_close_date: null,
    next_due_date: null,
    minimum_payment: null,
    card_brand: null,
    card_level: null,
    shared_balance_group: null,
    is_closed: false,
    closed_at: null,
    ...overrides,
  }
}

// Two cards on one shared credit line both report the line's full -300.
const accounts = [
  account({ id: 'checking', name: 'Checking', current_balance: 1000 }),
  account({ id: 'card-a', name: 'Card A', type: 'credit_card', current_balance: -300, shared_balance_group: 'line-1', credit_limit: 1000 }),
  account({ id: 'card-b', name: 'Card B', type: 'credit_card', current_balance: -300, shared_balance_group: 'line-1', credit_limit: 1000 }),
  account({ id: 'card-c', name: 'Card C', type: 'credit_card', current_balance: -200 }),
]

const summary: DashboardSummary = {
  total_balance: { USD: 500 },
  total_balance_primary: 500,
  projected_balance: { USD: 500 },
  projected_balance_primary: 500,
  balance_date: '2026-10-09',
  monthly_income: 1000,
  monthly_expenses: 250,
  monthly_income_primary: 1000,
  monthly_expenses_primary: 250,
  accounts_count: accounts.length,
  pending_categorization: 0,
  pending_categorization_amount: 0,
  assets_value: {},
  assets_value_primary: 0,
  primary_currency: 'USD',
  pending_shares_net: 0,
}

/** A daily income/expenses report with the given per-day expenses. */
function dailyReport(month: string, days: number, perDay: Record<number, { expenses?: number; income?: number; delivery?: number }>): ReportResponse {
  const trend = Array.from({ length: days }, (_, i) => {
    const day = i + 1
    const entry = perDay[day] ?? {}
    return {
      date: `${month}-${String(day).padStart(2, '0')}`,
      value: (entry.income ?? 0) - (entry.expenses ?? 0),
      change: null,
      breakdowns: { income: entry.income ?? 0, expenses: entry.expenses ?? 0 },
      composition: entry.delivery
        ? [{ key: 'cat-delivery', label: 'Delivery', value: entry.delivery, color: '#8B5CF6', group: 'expenses' }]
        : [],
    }
  })
  return {
    summary: { primary_value: 0, change_amount: 0, change_percent: null, breakdowns: [] },
    trend,
    meta: { type: 'income_expenses', series_keys: [], currency: 'USD', interval: 'daily' },
    composition: [],
    category_trend: [],
  }
}

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx',
    user_id: 'user-1',
    account_id: 'card-c',
    category_id: null,
    category: null,
    external_id: null,
    description: 'Purchase',
    original_description: null,
    amount: 100,
    currency: 'USD',
    date: '2026-10-05',
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
    is_ignored: false,
    ...overrides,
  } as Transaction
}

function renderDashboard() {
  return renderWithProviders(
    <TooltipProvider delayDuration={0}>
      <DashboardPage />
    </TooltipProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 9, 10, 0, 0))
  modules.enabled = new Set(['transactions', 'accounts', 'reports', 'assets', 'recurring', 'budgets', 'goals'])
  api.dashboard.summary.mockResolvedValue(summary)
  api.dashboard.spendingByCategory.mockResolvedValue([])
  api.dashboard.projectedTransactions.mockResolvedValue([])
  api.reports.incomeExpenses.mockImplementation(
    (_m: number, _i: string, _a: unknown, _p: unknown, _d: unknown, start: string) =>
      Promise.resolve(start.startsWith('2026-10')
        ? dailyReport('2026-10', 9, { 2: { expenses: 150, delivery: 100 }, 8: { expenses: 100, income: 1000 } })
        : dailyReport('2026-09', 30, { 3: { expenses: 300, delivery: 336 }, 9: { expenses: 200, income: 900 }, 20: { expenses: 900 } })),
  )
  api.reports.netWorth.mockResolvedValue({
    summary: { primary_value: 500, change_amount: 0, change_percent: null, breakdowns: [] },
    trend: [
      { date: '2026-09', value: 400, breakdowns: {}, change: null },
      { date: '2026-10', value: 500, breakdowns: {}, change: null },
    ],
    meta: { type: 'net_worth', series_keys: [], currency: 'USD', interval: 'monthly' },
    composition: [],
    category_trend: [],
  })
  api.transactions.list.mockResolvedValue({ items: [], total: 0 })
  api.budgets.comparison.mockResolvedValue([])
  api.categories.list.mockResolvedValue([])
  api.categoryGroups.list.mockResolvedValue([])
  api.accounts.list.mockResolvedValue(accounts)
  api.goals.summary.mockResolvedValue([])
  api.default.get.mockResolvedValue({ data: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Dashboard hero: spent so far', () => {
  it('compares month-to-date spend with the same stretch of last month', async () => {
    renderDashboard()
    const hero = await screen.findByRole('region', { name: t('dashboard.spentToDate') })
    // Oct 1-9: 150 + 100. Sep 1-9: 300 + 200.
    await within(hero).findByText('$250')
    expect(hero).toHaveTextContent(t('dashboard.spentLess', { amount: '$250' }))
    expect(hero).toHaveTextContent(t('dashboard.vsSameDay', { date: 'September 9' }))
    // Delivery: 100 this month vs 336 by Sep 9.
    expect(hero).toHaveTextContent('You spent $236 less on Delivery than in the same period last month.')
  })
})

describe('Dashboard month result', () => {
  it('attaches meaning to the net result', async () => {
    renderDashboard()
    const card = await screen.findByRole('region', { name: t('dashboard.resultTitle') })
    await within(card).findByText('$750')
    // 750 kept of 1000 in.
    expect(card).toHaveTextContent("So far you've kept 75% of what came in")
    // Net 750 vs 400 (900 in, 300 + 200 out) by Sep 9.
    expect(card).toHaveTextContent('+88%')
  })
})

describe('Dashboard net worth and card bills', () => {
  it('splits net worth into assets and debts that reconcile', async () => {
    renderDashboard()
    const card = await screen.findByRole('region', { name: t('dashboard.netWorth') })
    await within(card).findByText('$1,000')
    expect(card).toHaveTextContent(`${t('dashboard.assets')}$1,000`)
    expect(card).toHaveTextContent(`${t('dashboard.debts')}$500`)
    expect(card).toHaveTextContent('+25%')
  })

  it('counts a shared credit line once in the open bills total', async () => {
    renderDashboard()
    const card = await screen.findByRole('region', { name: t('dashboard.openBillsTitle') })
    await within(card).findByText('Card A')
    expect(within(card).getByText('$500')).toBeInTheDocument()
    expect(within(card).getAllByRole('progressbar')[0]).toHaveAttribute('aria-valuenow', '30')
  })

  it('hides account-based cards when the accounts module is off', async () => {
    modules.enabled.delete('accounts')
    renderDashboard()
    await screen.findByRole('region', { name: t('dashboard.netWorth') })
    expect(screen.queryByRole('region', { name: t('dashboard.openBillsTitle') })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: t('dashboard.financingTitle') })).not.toBeInTheDocument()
    expect(api.default.get).not.toHaveBeenCalled()
  })
})

describe('Dashboard financing card', () => {
  it('shows an empty state when Open Finance reports no loans', async () => {
    renderDashboard()
    expect(await screen.findByText(t('dashboard.financingEmpty'))).toBeInTheDocument()
    expect(api.default.get).toHaveBeenCalledWith('/loans')
  })

  it('shows the largest active loan', async () => {
    api.default.get.mockResolvedValue({
      data: [{
        id: 'loan-1',
        institution_name: 'Itaú',
        product_name: 'Car financing',
        kind: 'FINANCIAMENTOS',
        currency: 'USD',
        contract_amount: '100000.00',
        outstanding_balance: '60000.00',
        cet: '0.21',
        monthly_rate: '0.0149',
        total_installments: 48,
        paid_installments: 23,
        remaining_installments: 25,
        overdue_installments: 0,
        installment_amount: '2384.17',
        next_due_date: '2026-10-15',
        final_due_date: '2028-11-15',
        is_active: true,
        last_synced_at: null,
      }],
    })
    renderDashboard()
    const card = await screen.findByRole('region', { name: 'Car financing' })
    expect(card).toHaveTextContent('$60,000.00')
    expect(card).toHaveTextContent(t('dashboard.financingPaidOf', { paid: 23, total: 48 }))
    expect(card).toHaveTextContent('$2,384.17')
  })
})

describe('Dashboard next step', () => {
  it('suggests what to do with installments that are about to end', async () => {
    api.transactions.list.mockImplementation((params: { status?: string }) => Promise.resolve(
      params.status === 'pending'
        ? { items: [], total: 0 }
        : {
            items: [
              tx({ id: 'a', installment_series_id: 's1', installment_number: 6, total_installments: 6, amount: 120 }),
              tx({ id: 'b', installment_series_id: 's2', installment_number: 10, total_installments: 10, amount: 80 }),
              tx({ id: 'c', installment_series_id: 's3', installment_number: 2, total_installments: 12, amount: 999 }),
            ],
            total: 3,
          },
    ))
    renderDashboard()
    const card = await screen.findByRole('region', { name: t('dashboard.nextStepTitle') })
    await within(card).findByText(t('dashboard.stepInstallmentsTitle', { count: 2, month: 'October' }))
    expect(card).toHaveTextContent('From November on, $200.00 a month is freed up.')
  })

  it('shows a neutral state when nothing qualifies', async () => {
    renderDashboard()
    expect(await screen.findByText(t('dashboard.nextStepEmptyTitle'))).toBeInTheDocument()
  })
})
