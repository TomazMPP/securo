import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { categories as categoriesApi, categoryGroups as categoryGroupsApi, recurring as recurringApi, accounts as accountsApi } from '@/lib/api'
import { extractApiError } from '@/lib/api-errors'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { currentMonth, monthLabel, monthRange } from '@/lib/month-utils'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MonthStepper } from '@/components/month-stepper'
import { RecurringForm } from '@/components/recurring/recurring-form'
import { RecurringHeroCard } from '@/components/recurring/recurring-hero-card'
import { RecurringForecastCard } from '@/components/recurring/recurring-forecast-card'
import { RecurringByAccount, RecurringMonthSummary } from '@/components/recurring/recurring-summary-cards'
import { RecurringScheduleCard } from '@/components/recurring/recurring-schedule-card'
import { RecurringRulesCard } from '@/components/recurring/recurring-rules-card'
import { SERIES_VARS_CLASS } from '@/components/recurring/series'
import { useRecurringOverview } from '@/components/recurring/use-recurring-overview'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { useWorkspace } from '@/contexts/workspace-context'
import type { RecurringTransaction } from '@/types'

type Kind = 'debit' | 'credit'

export default function RecurringPage() {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const { canWrite } = useWorkspace()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const queryClient = useQueryClient()

  const [month, setMonth] = useState(currentMonth)
  const [kind, setKind] = useState<Kind>('debit')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<RecurringTransaction | null>(null)
  const [deletingRecurring, setDeletingRecurring] = useState<RecurringTransaction | null>(null)

  const overview = useRecurringOverview(month, kind)

  const { data: recurringList, isLoading: rulesLoading } = useQuery({
    queryKey: ['recurring'],
    queryFn: recurringApi.list,
  })

  const { data: categoriesList } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  })

  const { data: allCategoriesList } = useQuery({
    queryKey: ['categories', 'management'],
    queryFn: categoriesApi.listIncludingHidden,
    enabled: Boolean(editing?.category_id),
  })

  const { data: categoryGroupsList } = useQuery({
    queryKey: ['categoryGroups'],
    queryFn: categoryGroupsApi.list,
  })

  const { data: accountsList } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountsApi.list(),
  })

  const afterRuleChange = () => {
    invalidateFinancialQueries(queryClient)
    queryClient.invalidateQueries({ queryKey: ['recurring'] })
  }

  const closeDialog = () => {
    setDialogOpen(false)
    setEditing(null)
  }

  const createMutation = useMutation({
    mutationFn: (data: Partial<RecurringTransaction>) => recurringApi.create(data),
    onSuccess: () => {
      afterRuleChange()
      setDialogOpen(false)
      toast.success(t('recurring.created'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<RecurringTransaction> & { id: string }) =>
      recurringApi.update(id, data),
    onSuccess: () => {
      afterRuleChange()
      closeDialog()
      toast.success(t('recurring.updated'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const toggleMutation = useMutation({
    mutationFn: (rule: RecurringTransaction) => recurringApi.update(rule.id, { is_active: !rule.is_active }),
    onSuccess: (_data, rule) => {
      afterRuleChange()
      toast.success(t(rule.is_active ? 'recurring.pausedToast' : 'recurring.resumedToast'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => recurringApi.delete(id),
    onSuccess: () => {
      afterRuleChange()
      setDeletingRecurring(null)
      toast.success(t('recurring.deleted'))
    },
    onError: (err: unknown) => {
      toast.error(extractApiError(err, t('common.error')))
    },
  })

  const generateMutation = useMutation({
    mutationFn: () => recurringApi.generate(),
    onSuccess: (data) => {
      afterRuleChange()
      toast.success(t('recurring.generated', { count: data.generated }))
    },
    onError: () => toast.error(t('common.error')),
  })

  const frequencyLabel = (f: string) => {
    const map: Record<string, string> = {
      monthly: t('recurring.monthly'),
      quarterly: t('recurring.quarterly'),
      semiannual: t('recurring.semiannual'),
      weekly: t('recurring.weekly'),
      biweekly: t('recurring.biweekly'),
      yearly: t('recurring.yearly'),
    }
    return map[f] ?? f
  }

  const formatMoney = (value: number) => mask(formatCurrency(value, userCurrency, locale))
  const rules = (recurringList ?? []).filter((r) => r.type === kind)
  const accounts = accountsList ?? []
  const openNew = () => { setEditing(null); setDialogOpen(true) }
  const openRule = (id: string) => {
    const rule = recurringList?.find((r) => r.id === id)
    if (rule) { setEditing(rule); setDialogOpen(true) }
  }
  const monthTitle = monthLabel(month, dateLocale)
  const isLoading = rulesLoading || overview.isLoading
  const nothingAtAll = !isLoading && (recurringList ?? []).length === 0 && overview.items.length === 0

  return (
    <div className={cn('pb-6', SERIES_VARS_CLASS)}>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-[22px] font-bold tracking-tight text-foreground">{t('recurring.pageTitle')}</h1>
        <div role="tablist" aria-label={t('recurring.type')} className="inline-flex gap-1 rounded-xl bg-muted p-1 sm:ml-2">
          {(['debit', 'credit'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                'h-8 rounded-[9px] px-4 text-sm transition-colors',
                kind === k ? 'bg-card font-semibold text-foreground shadow-sm' : 'font-medium text-muted-foreground hover:text-foreground',
              )}
            >
              {t(k === 'debit' ? 'recurring.expenses' : 'recurring.incomes')}
            </button>
          ))}
        </div>
        <div className="hidden flex-1 sm:block" />
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <MonthStepper
            value={month}
            onChange={setMonth}
            locale={dateLocale}
            prevLabel={t('recurring.prevMonth')}
            nextLabel={t('recurring.nextMonth')}
          />
          <div className="flex-1 sm:hidden" />
          {canWrite && (
            <>
              <Button
                variant="outline"
                size="icon"
                className="size-9 shrink-0"
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending}
                title={t('recurring.generatePending')}
                aria-label={t('recurring.generatePending')}
              >
                <RefreshCw size={15} className={generateMutation.isPending ? 'animate-spin' : ''} />
              </Button>
              <Button className="shrink-0 gap-1.5" onClick={openNew}>
                <Plus size={16} />
                <span className="hidden sm:inline">{t('recurring.newRecurring')}</span>
                <span className="sm:hidden">{t('recurring.newShort')}</span>
              </Button>
            </>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      ) : nothingAtAll ? (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-card px-6 py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
            <CalendarClock size={22} />
          </span>
          <h2 className="mt-4 text-base font-bold text-foreground">{t('recurring.emptyTitle')}</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{t('recurring.emptyDescription')}</p>
          {canWrite && (
            <Button className="mt-5 gap-1.5" onClick={openNew}>
              <Plus size={16} />
              {t('recurring.newRecurring')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <RecurringHeroCard
              kind={kind}
              items={overview.items}
              totals={overview.totals}
              monthEnd={monthRange(month).to}
              formatMoney={formatMoney}
              dateLocale={dateLocale}
            />
            <RecurringForecastCard
              forecast={overview.forecast}
              hasLoans={overview.hasLoans}
              relief={kind === 'debit' ? overview.relief : null}
              locale={dateLocale}
              currency={userCurrency}
              formatMoney={formatMoney}
              mask={mask}
            />
          </div>

          <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(300px,1fr)_2fr]">
            <div className="flex flex-col gap-5">
              <RecurringMonthSummary
                title={monthTitle}
                kind={kind}
                totals={overview.totals}
                hasLoans={overview.hasLoans}
                averageIncome={overview.averageIncome}
                formatMoney={formatMoney}
              />
              <RecurringByAccount items={overview.items} accounts={accounts} formatMoney={formatMoney} />
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <RecurringScheduleCard
                kind={kind}
                items={overview.items}
                accounts={accounts}
                today={overview.today}
                month={month}
                dateLocale={dateLocale}
                formatMoney={formatMoney}
                onOpenRule={canWrite ? openRule : undefined}
              />
              <RecurringRulesCard
                rules={rules}
                accounts={accounts}
                categories={categoriesList ?? []}
                canWrite={canWrite}
                dateLocale={dateLocale}
                formatAmount={(rule) => mask(`${rule.type === 'credit' ? '+' : '−'}${formatCurrency(rule.amount, rule.currency, locale)}`)}
                formatPrimary={(rule) =>
                  rule.currency !== userCurrency && rule.amount_primary != null
                    ? mask(formatCurrency(rule.amount_primary, userCurrency, locale))
                    : null
                }
                frequencyLabel={frequencyLabel}
                onEdit={(rule) => { setEditing(rule); setDialogOpen(true) }}
                onToggleActive={(rule) => toggleMutation.mutate(rule)}
                onDelete={setDeletingRecurring}
              />
            </div>
          </div>
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={closeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t('recurring.edit') : t('recurring.add')}</DialogTitle>
          </DialogHeader>
          <RecurringForm
            key={editing?.id ?? `new-${kind}`}
            recurring={editing}
            defaultType={kind}
            categories={categoriesList ?? []}
            categoryGroups={categoryGroupsList ?? []}
            currentCategory={allCategoriesList?.find((category) => category.id === editing?.category_id)}
            accounts={accounts}
            onSave={(data) => {
              if (editing) {
                updateMutation.mutate({ id: editing.id, ...data })
              } else {
                createMutation.mutate(data)
              }
            }}
            onCancel={closeDialog}
            loading={createMutation.isPending || updateMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog
        open={!!deletingRecurring}
        title={t('recurring.confirmDeleteTitle')}
        description={t('recurring.confirmDeleteDescription', { description: deletingRecurring?.description })}
        isPending={deleteMutation.isPending}
        onClose={() => setDeletingRecurring(null)}
        onConfirm={() => deletingRecurring && deleteMutation.mutate(deletingRecurring.id)}
      />
    </div>
  )
}
