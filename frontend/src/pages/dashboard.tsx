import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import {
  accounts as accountsApi,
  budgets,
  categories as categoriesApi,
  categoryGroups as categoryGroupsApi,
  dashboard,
  goals as goalsApi,
  reports,
  transactions,
} from '@/lib/api'
import { getAccountName } from '@/lib/account-utils'
import { currentMonth, monthLabel, monthLastDay, monthRange, shiftMonth } from '@/lib/month-utils'
import {
  biggestCategoryChange,
  buildCumulativeSeries,
  buildUpcomingItems,
  categoryTotalsUpTo,
  findEndingInstallments,
  isoDate,
  percentChange,
  sumUpToDay,
} from '@/lib/dashboard-insights'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { extractApiError } from '@/lib/api-errors'
import { resolveDateFnsLocale } from '@/lib/date-fns-locale'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { MonthPicker } from '@/components/ui/monthpicker'
import { TransactionDrillDown, type DrillDownFilter } from '@/components/transaction-drill-down'
import { TransactionDialog, type TransactionSavePayload } from '@/components/transaction-dialog'
import { SpendingHeroCard } from '@/components/dashboard/spending-hero-card'
import { SpendingDistributionCard, type DistributionSlice } from '@/components/dashboard/spending-distribution-card'
import { MonthResultCard } from '@/components/dashboard/month-result-card'
import { NetWorthCard } from '@/components/dashboard/net-worth-card'
import { OpenBillsCard } from '@/components/dashboard/open-bills-card'
import { UpcomingBillsCard } from '@/components/dashboard/upcoming-bills-card'
import { FinancingCard } from '@/components/dashboard/financing-card'
import { NextStepCard, type NextStep } from '@/components/dashboard/next-step-card'
import type { ReportResponse, Transaction } from '@/types'

const QuickAddTransaction = lazy(() => import('@/components/quick-add-transaction'))

const MONTH_REGEX = /^\d{4}-\d{2}$/
const MONTH_STRING_LENGTH = 7
/** How far ahead "Próximas contas" looks. */
const UPCOMING_WINDOW_DAYS = 30
/** Categories listed by name in the distribution card; the rest fold into "Others". */
const DISTRIBUTION_TOP = 7

function parseMonthFromParams(params: URLSearchParams): string | null {
  const monthParam = params.get('month')
  if (monthParam && MONTH_REGEX.test(monthParam)) return monthParam
  const fromParam = params.get('from')
  if (fromParam && fromParam.length >= MONTH_STRING_LENGTH) {
    const parsedMonth = fromParam.substring(0, MONTH_STRING_LENGTH)
    if (MONTH_REGEX.test(parsedMonth)) return parsedMonth
  }
  return null
}

/**
 * Daily income/expenses for an explicit date range. The backend refuses an
 * end date past *its* today, which can trail the browser's by a few hours
 * around midnight; one retry a day earlier covers that gap.
 */
async function dailyReport(from: string, to: string, accountIds?: string[]): Promise<ReportResponse> {
  try {
    return await reports.incomeExpenses(1, 'daily', accountIds, undefined, undefined, from, to)
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status !== 422 || to <= from) throw err
    const d = new Date(`${to}T00:00:00`)
    d.setDate(d.getDate() - 1)
    return reports.incomeExpenses(1, 'daily', accountIds, undefined, undefined, from, isoDate(d))
  }
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const { hasModule, canWrite } = useWorkspace()
  const queryClient = useQueryClient()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const displayName = user?.preferences?.display_name || ''
  const locale = useDisplayLocale()
  const uiLocale = i18n.resolvedLanguage ?? i18n.language

  const greeting = (() => {
    const hour = new Date().getHours()
    const key = hour < 12 ? 'greetingMorning' : hour < 18 ? 'greetingAfternoon' : 'greetingEvening'
    const base = t(`dashboard.${key}`)
    return displayName ? `${base}, ${displayName}` : base
  })()

  // ── Selected month, mirrored in the URL (?month=YYYY-MM) ──────────────
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedMonth, setSelectedMonth] = useState<string>(() => parseMonthFromParams(searchParams) ?? currentMonth())
  const prevSearchRef = useRef<string | null>(null)
  useEffect(() => {
    const search = searchParams.toString()
    if (prevSearchRef.current === search) return
    const isInitial = prevSearchRef.current === null
    prevSearchRef.current = search
    const parsed = parseMonthFromParams(searchParams)
    if (parsed) setSelectedMonth(parsed)
    else if (!isInitial) setSelectedMonth(currentMonth())
  }, [searchParams])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set('month', selectedMonth)
    params.delete('from')
    params.delete('to')
    setSearchParams(params, { replace: true })
  }, [selectedMonth, setSearchParams])
  const [monthPickerOpen, setMonthPickerOpen] = useState(false)

  const [drillDown, setDrillDown] = useState<DrillDownFilter | null>(null)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [editingTx, setEditingTx] = useState<Transaction | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // ── Calendar arithmetic ────────────────────────────────────────────────
  const today = new Date()
  const todayIso = isoDate(today)
  const thisMonth = currentMonth()
  const isCurrentMonth = selectedMonth === thisMonth
  const isFutureMonth = selectedMonth > thisMonth
  const { from: monthStart, to: monthEnd } = monthRange(selectedMonth)
  const prevMonth = shiftMonth(selectedMonth, -1)
  const { from: prevStart, to: prevEnd } = monthRange(prevMonth)
  const daysInMonth = monthLastDay(selectedMonth)
  const prevDaysInMonth = monthLastDay(prevMonth)
  // Day of the selected month the comparison runs up to.
  const elapsedDay = isCurrentMonth ? today.getDate() : daysInMonth
  const prevComparableDay = isCurrentMonth ? Math.min(elapsedDay, prevDaysInMonth) : prevDaysInMonth
  const monthLabelStr = monthLabel(selectedMonth, uiLocale)
  const monthName = (ym: string) => {
    const [y, m] = ym.split('-').map(Number)
    return new Date(y, m - 1, 2).toLocaleDateString(uiLocale, { month: 'long' })
  }

  // ── Collection filter (issue #105) ─────────────────────────────────────
  const { activeAccountIds, activeWalletIds } = useCollectionFilter()
  const acctIds = activeAccountIds ?? undefined
  const walletIds = activeWalletIds ?? undefined
  // A wallet-only collection has no account data: account-based cards
  // render empty rather than silently falling back to "all accounts".
  const noAccounts = activeAccountIds !== null && activeAccountIds.length === 0
  const scopedAcctIds = acctIds && acctIds.length > 0 ? acctIds : undefined

  // ── Queries ────────────────────────────────────────────────────────────
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['dashboard', 'summary', selectedMonth, activeAccountIds, activeWalletIds],
    queryFn: () => dashboard.summary(monthStart, undefined, acctIds, walletIds),
  })

  const { data: spending, isLoading: spendingLoading } = useQuery({
    queryKey: ['dashboard', 'spending', selectedMonth, activeAccountIds],
    queryFn: () => dashboard.spendingByCategory(monthStart, acctIds),
    enabled: !noAccounts,
  })

  const currentReportEnd = isCurrentMonth ? todayIso : monthEnd
  const { data: currentReport, isLoading: currentReportLoading } = useQuery({
    queryKey: ['dashboard', 'daily-report', monthStart, currentReportEnd, activeAccountIds],
    queryFn: () => dailyReport(monthStart, currentReportEnd, acctIds),
    enabled: !noAccounts && !isFutureMonth,
  })

  const prevReportEnabled = !noAccounts && prevStart <= todayIso
  const { data: prevReport, isLoading: prevReportLoading } = useQuery({
    queryKey: ['dashboard', 'daily-report', prevStart, prevEnd < todayIso ? prevEnd : todayIso, activeAccountIds],
    queryFn: () => dailyReport(prevStart, prevEnd < todayIso ? prevEnd : todayIso, acctIds),
    enabled: prevReportEnabled,
  })

  const { data: netWorthReport } = useQuery({
    queryKey: ['dashboard', 'net-worth-trend', activeAccountIds, activeWalletIds],
    queryFn: () => reports.netWorth(6, 'monthly', acctIds, walletIds),
  })

  const { data: accountsList, isLoading: accountsLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountsApi.list(),
  })

  const upcomingEnd = (() => {
    const d = new Date(today)
    d.setDate(d.getDate() + UPCOMING_WINDOW_DAYS)
    return isoDate(d)
  })()
  const tomorrowIso = (() => {
    const d = new Date(today)
    d.setDate(d.getDate() + 1)
    return isoDate(d)
  })()

  const { data: upcomingProjected, isLoading: upcomingProjectedLoading } = useQuery({
    queryKey: ['dashboard', 'projected-transactions', 'upcoming', todayIso, upcomingEnd],
    queryFn: () => dashboard.projectedTransactions({ from: todayIso, to: upcomingEnd }),
  })

  const { data: upcomingScheduled, isLoading: upcomingScheduledLoading } = useQuery({
    queryKey: ['transactions', 'upcoming', tomorrowIso, upcomingEnd, activeAccountIds],
    queryFn: () => transactions.list({
      from: tomorrowIso,
      to: upcomingEnd,
      type: 'debit',
      status: 'pending',
      exclude_ignored: true,
      exclude_transfers: true,
      account_ids: scopedAcctIds,
      limit: 100,
    }),
    enabled: !noAccounts,
  })

  // This calendar month's debits: the installment parcels in it tell us
  // which series are about to end ("Próximo passo").
  const { data: thisMonthDebits, isLoading: thisMonthDebitsLoading } = useQuery({
    queryKey: ['transactions', 'installments-ending', thisMonth, activeAccountIds],
    queryFn: () => {
      const { from, to } = monthRange(thisMonth)
      return transactions.list({
        from,
        to,
        type: 'debit',
        exclude_transfers: true,
        exclude_ignored: true,
        account_ids: scopedAcctIds,
        limit: 500,
      })
    },
    enabled: !noAccounts,
  })

  const budgetsOn = hasModule('budgets')
  const { data: budgetComparison } = useQuery({
    queryKey: ['budgets', 'comparison', selectedMonth],
    queryFn: () => budgets.comparison(monthStart),
    enabled: budgetsOn,
  })

  const goalsOn = hasModule('goals')
  const { data: goalsSummary } = useQuery({
    queryKey: ['goals', 'summary'],
    queryFn: () => goalsApi.summary(3),
    enabled: goalsOn,
  })

  // Only needed by the edit dialog opened from a drill-down row.
  const { data: categoriesList } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
    enabled: dialogOpen,
  })
  const { data: categoryGroupsList } = useQuery({
    queryKey: ['categoryGroups'],
    queryFn: categoryGroupsApi.list,
    enabled: dialogOpen,
  })

  const closeDialog = () => {
    setDialogOpen(false)
    setEditingTx(null)
  }
  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: TransactionSavePayload & { id: string }) => transactions.update(id, data),
    onSuccess: () => { invalidateFinancialQueries(queryClient); closeDialog() },
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => transactions.delete(id),
    onSuccess: () => { invalidateFinancialQueries(queryClient); closeDialog() },
  })
  const unlinkTransferMutation = useMutation({
    mutationFn: (pairId: string) => transactions.unlinkTransfer(pairId),
    onSuccess: () => { invalidateFinancialQueries(queryClient); closeDialog() },
  })

  // ── Derived numbers ────────────────────────────────────────────────────
  const primaryCurrency = summary?.primary_currency ?? userCurrency

  // Plain derivations below (no useMemo): they are cheap, and the React
  // Compiler memoizes the component on its own.
  const series = buildCumulativeSeries(
    currentReport,
    prevReportEnabled ? prevReport : undefined,
    daysInMonth,
    prevDaysInMonth,
    elapsedDay,
  )
  const spentSoFar = sumUpToDay(currentReport, elapsedDay, 'expenses')
  const prevSamePeriod = prevReport ? sumUpToDay(prevReport, prevComparableDay, 'expenses') : null
  const hasPreviousData = !!prevReport && (prevReport.trend ?? []).some(
    (p) => Number(p.breakdowns?.expenses ?? 0) > 0 || Number(p.breakdowns?.income ?? 0) > 0,
  )
  const categoryInsight = currentReport && prevReport
    ? biggestCategoryChange(
      categoryTotalsUpTo(currentReport, elapsedDay),
      categoryTotalsUpTo(prevReport, prevComparableDay),
    )
    : null
  const comparisonDate = isCurrentMonth
    ? new Date(Number(prevMonth.slice(0, 4)), Number(prevMonth.slice(5, 7)) - 1, prevComparableDay)
      .toLocaleDateString(uiLocale, { day: 'numeric', month: 'long' })
    : monthName(prevMonth)

  // Distribution: settled spend per category, the same set the hero sums.
  const distribution = useMemo(() => {
    const rows = (spending ?? [])
      .map((s) => ({
        key: s.category_id ?? 'uncategorized',
        categoryId: s.category_id,
        name: s.category_id ? s.category_name : t('transactions.noCategory'),
        icon: s.category_icon,
        color: s.category_color,
        amount: Number(s.total ?? 0),
      }))
      .filter((s) => s.amount > 0.004)
      .sort((a, b) => b.amount - a.amount)
    const top: DistributionSlice[] = rows.slice(0, DISTRIBUTION_TOP)
    const rest = rows.slice(DISTRIBUTION_TOP)
    if (rest.length > 0) {
      top.push({
        key: 'other',
        categoryId: null,
        name: t('dashboard.otherCategories'),
        icon: null,
        color: '#A0A7B4',
        amount: rest.reduce((sum, r) => sum + r.amount, 0),
        isOther: true,
      })
    }
    return { slices: top, total: rows.reduce((sum, r) => sum + r.amount, 0) }
  }, [spending, t])

  // Month result.
  const income = Number(summary?.monthly_income_primary ?? summary?.monthly_income ?? 0)
  const expenses = Number(summary?.monthly_expenses_primary ?? summary?.monthly_expenses ?? 0)
  const projectedIncome = Number(summary?.projected_income_primary ?? summary?.projected_income ?? income)
  const projectedExpenses = Number(summary?.projected_expenses_primary ?? summary?.projected_expenses ?? expenses)
  const resultChange = prevReport && hasPreviousData
    ? percentChange(
      income - expenses,
      sumUpToDay(prevReport, prevComparableDay, 'income') - sumUpToDay(prevReport, prevComparableDay, 'expenses'),
    )
    : null

  // Net worth: the summary's figure, split into what is owned and owed so
  // the two halves always reconcile with the headline.
  const scopedAccounts = useMemo(() => {
    const all = (accountsList ?? []).filter((a) => !a.is_closed)
    return activeAccountIds ? all.filter((a) => activeAccountIds.includes(a.id)) : all
  }, [accountsList, activeAccountIds])
  const totalBalance = summary?.total_balance_primary
    ?? Object.values(summary?.total_balance ?? {}).reduce((a, b) => a + Number(b), 0)
  const assetsValue = summary?.assets_value_primary
    ?? Object.values(summary?.assets_value ?? {}).reduce((a, b) => a + Number(b), 0)
  const ownedInAccounts = scopedAccounts
    .filter((a) => a.type !== 'credit_card')
    .reduce((sum, a) => sum + Math.max(0, Number(a.balance_primary ?? a.current_balance)), 0)
  const ownedTotal = ownedInAccounts + Number(assetsValue)
  const owedTotal = Math.max(0, ownedTotal - totalBalance)
  const netWorthTrend = (netWorthReport?.trend ?? []).map((p) => ({ date: p.date, value: Number(p.value) }))
  const netWorthChange = netWorthTrend.length >= 2
    ? percentChange(netWorthTrend[netWorthTrend.length - 1].value, netWorthTrend[netWorthTrend.length - 2].value)
    : null

  const creditCards = useMemo(() => scopedAccounts.filter((a) => a.type === 'credit_card'), [scopedAccounts])
  const accountNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of accountsList ?? []) map.set(a.id, getAccountName(a))
    return map
  }, [accountsList])

  const upcomingItems = buildUpcomingItems({
    projected: (upcomingProjected ?? []).filter(
      (p) => !activeAccountIds || (p.account_id != null && activeAccountIds.includes(p.account_id)),
    ),
    scheduled: upcomingScheduled?.items ?? [],
    cards: creditCards,
    from: todayIso,
    to: upcomingEnd,
    primaryCurrency,
  })

  // Next step: real, data-backed suggestions only.
  const nextSteps = (() => {
    const steps: NextStep[] = []
    const ending = findEndingInstallments(thisMonthDebits?.items ?? [], thisMonth)
    if (ending && ending.monthlyAmount >= 1) {
      const goal = (goalsSummary ?? []).find((g) => g.percentage < 100) ?? null
      steps.push({ id: 'installments', signature: `${ending.endMonth}:${ending.count}`, data: ending, goal })
    }
    if (budgetsOn) {
      const over = (budgetComparison ?? [])
        .filter((b) => b.budget_amount != null && b.budget_amount > 0 && b.actual_amount > b.budget_amount)
        .sort((a, b) => b.actual_amount / b.budget_amount! - a.actual_amount / a.budget_amount!)[0]
      if (over) {
        steps.push({
          id: 'budget',
          signature: `${selectedMonth}:${over.category_id}`,
          category: over.category_name,
          spent: Number(over.actual_amount),
          budget: Number(over.budget_amount),
        })
      }
    }
    const pending = summary?.pending_categorization ?? 0
    if (pending > 0) {
      steps.push({
        id: 'uncategorized',
        signature: String(pending),
        count: pending,
        amount: Number(summary?.pending_categorization_amount ?? 0),
      })
    }
    return steps
  })()

  const accountsOn = hasModule('accounts')
  const reportsOn = hasModule('reports')

  const monthTitle = monthLabelStr.replace(/^\w/, (c) => c.toUpperCase())

  return (
    <div>
      <PageHeader
        section={monthTitle}
        title={greeting}
        action={
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-11 rounded-xl text-muted-foreground"
                aria-label={t('transactions.monthPrevious')}
                onClick={() => setSelectedMonth(shiftMonth(selectedMonth, -1))}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Popover open={monthPickerOpen} onOpenChange={setMonthPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-11 items-center gap-2 rounded-xl border border-border bg-card px-3.5 text-sm font-semibold text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    {monthTitle}
                    <ChevronDown className="size-4 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-auto p-0">
                  <MonthPicker
                    locale={resolveDateFnsLocale(uiLocale)}
                    selectedMonth={new Date(`${selectedMonth}-01T00:00:00`)}
                    onMonthSelect={(date) => {
                      if (!date) return
                      setSelectedMonth(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`)
                      setMonthPickerOpen(false)
                    }}
                  />
                </PopoverContent>
              </Popover>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 rounded-xl text-muted-foreground"
                aria-label={t('transactions.monthNext')}
                onClick={() => setSelectedMonth(shiftMonth(selectedMonth, 1))}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
            {canWrite && hasModule('transactions') && (
              <Button className="h-11 rounded-xl px-4 text-sm font-semibold" onClick={() => setQuickAddOpen(true)}>
                <Plus className="size-4" strokeWidth={2.4} />
                {t('dashboard.newTransaction')}
              </Button>
            )}
          </div>
        }
      />

      {/* Row 1: the main KPI and where the money went */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SpendingHeroCard
          loading={!isFutureMonth && (currentReportLoading || (prevReportEnabled && prevReportLoading))}
          isFuture={isFutureMonth}
          isCurrentMonth={isCurrentMonth}
          spent={spentSoFar}
          previousSamePeriod={hasPreviousData ? prevSamePeriod : null}
          comparisonDate={comparisonDate}
          currentMonthName={monthName(selectedMonth)}
          previousMonthName={monthName(prevMonth)}
          series={series}
          lastDay={elapsedDay}
          insight={categoryInsight}
          hasPreviousData={hasPreviousData}
          currency={currentReport?.meta?.currency ?? primaryCurrency}
          locale={locale}
          mask={mask}
          onOpen={() => setDrillDown({
            title: t('dashboard.drillDownExpenses', { month: monthLabelStr }),
            type: 'debit',
            from: monthStart,
            to: monthEnd,
          })}
        />
        <SpendingDistributionCard
          loading={!noAccounts && spendingLoading}
          slices={distribution.slices}
          total={distribution.total}
          currency={primaryCurrency}
          locale={locale}
          mask={mask}
          linkTo={reportsOn ? '/analysis' : hasModule('categories') ? '/categories' : undefined}
          onSliceClick={(slice) => setDrillDown({
            title: t('dashboard.drillDownCategory', { category: slice.name, month: monthLabelStr }),
            ...(slice.categoryId ? { category_id: slice.categoryId } : { uncategorized: true }),
            type: 'debit',
            from: monthStart,
            to: monthEnd,
          })}
        />
      </div>

      {/* Row 2: result, net worth, credit cards */}
      <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        <MonthResultCard
          loading={summaryLoading}
          income={income}
          expenses={expenses}
          projectedIncome={projectedIncome}
          projectedExpenses={projectedExpenses}
          changePercent={resultChange}
          isCurrentMonth={isCurrentMonth}
          currency={primaryCurrency}
          locale={locale}
          mask={mask}
          linkTo={reportsOn ? '/reports' : undefined}
          onIncomeClick={() => setDrillDown({
            title: t('dashboard.drillDownIncome', { month: monthLabelStr }),
            type: 'credit',
            from: monthStart,
            to: monthEnd,
          })}
          onExpensesClick={() => setDrillDown({
            title: t('dashboard.drillDownExpenses', { month: monthLabelStr }),
            type: 'debit',
            from: monthStart,
            to: monthEnd,
          })}
        />
        <NetWorthCard
          loading={summaryLoading || accountsLoading}
          netWorth={totalBalance}
          assets={ownedTotal}
          debts={owedTotal}
          trend={netWorthTrend}
          changePercent={netWorthChange}
          currency={primaryCurrency}
          locale={locale}
          mask={mask}
          linkTo={hasModule('assets') ? '/assets' : reportsOn ? '/reports' : undefined}
        />
        {accountsOn && hasModule('cards') && (
          <OpenBillsCard
            loading={accountsLoading}
            cards={creditCards}
            primaryCurrency={primaryCurrency}
            locale={locale}
            uiLocale={uiLocale}
            mask={mask}
            linkTo="/accounts"
          />
        )}
      </div>

      {/* Row 3: what is coming, the financing contract, one next step */}
      <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        <UpcomingBillsCard
          loading={upcomingProjectedLoading || (!noAccounts && upcomingScheduledLoading) || accountsLoading}
          items={upcomingItems}
          primaryCurrency={primaryCurrency}
          accountNames={accountNames}
          locale={locale}
          uiLocale={uiLocale}
          mask={mask}
          linkTo={hasModule('recurring') ? '/recurring' : hasModule('transactions') ? '/transactions' : undefined}
        />
        {accountsOn && hasModule('loans') && <FinancingCard locale={locale} uiLocale={uiLocale} mask={mask} />}
        <NextStepCard
          loading={summaryLoading || (!noAccounts && thisMonthDebitsLoading)}
          steps={nextSteps}
          currency={primaryCurrency}
          locale={locale}
          uiLocale={uiLocale}
          mask={mask}
          onCategorize={() => setDrillDown({ title: t('dashboard.drillDownUncategorized'), uncategorized: true })}
        />
      </div>

      <TransactionDrillDown
        filter={
          drillDown
            ? {
                ...drillDown,
                // Keep drill-downs consistent with the collection-scoped cards
                // they open from.
                account_ids: drillDown.account_ids ?? scopedAcctIds,
              }
            : null
        }
        onClose={() => setDrillDown(null)}
        onTransactionClick={(tx) => { setEditingTx(tx); setDialogOpen(true) }}
      />

      <TransactionDialog
        open={dialogOpen}
        onClose={closeDialog}
        transaction={editingTx}
        categories={categoriesList ?? []}
        categoryGroups={categoryGroupsList ?? []}
        accounts={(accountsList ?? []).map((a) => ({ id: a.id, name: getAccountName(a) }))}
        onSave={(data) => {
          if (editingTx) updateMutation.mutate({ id: editingTx.id, ...data })
        }}
        onDelete={() => {
          if (editingTx) deleteMutation.mutate(editingTx.id)
        }}
        onUnlinkTransfer={(pairId) => unlinkTransferMutation.mutate(pairId)}
        loading={updateMutation.isPending || deleteMutation.isPending || unlinkTransferMutation.isPending}
        error={updateMutation.error ? extractApiError(updateMutation.error) : deleteMutation.error ? extractApiError(deleteMutation.error) : null}
        isSynced={editingTx?.source === 'sync'}
      />

      {quickAddOpen && (
        <Suspense fallback={null}>
          <QuickAddTransaction open={quickAddOpen} onClose={() => setQuickAddOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}
