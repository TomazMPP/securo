import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Landmark } from 'lucide-react'
import api from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import { DashboardCard, CardHeading, CardEmpty, Pill, ProgressBar } from '@/components/dashboard/dashboard-card'
import { formatCurrency } from '@/lib/format'
import { parseIsoDate } from '@/lib/dashboard-insights'

/**
 * Shape of `GET /api/loans` rows this card reads. Kept local on purpose: the
 * shared `Loan` type and `loans` client land with the loans page, and this
 * card only needs a handful of fields. Decimals arrive as strings.
 */
interface DashboardLoan {
  id: string
  institution_name: string | null
  product_name: string | null
  kind: string | null
  currency: string
  contract_amount: string | null
  outstanding_balance: string | null
  cet: string | null
  monthly_rate: string | null
  total_installments: number | null
  paid_installments: number | null
  remaining_installments: number | null
  overdue_installments: number | null
  installment_amount: string | null
  next_due_date: string | null
  final_due_date: string | null
  is_active: boolean
  last_synced_at: string | null
}

async function fetchLoans(): Promise<DashboardLoan[]> {
  const { data } = await api.get<DashboardLoan[]>('/loans')
  return Array.isArray(data) ? data : []
}

function num(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function relativeTime(iso: string, uiLocale: string): string {
  const diffMs = new Date(iso).getTime() - Date.now()
  const rtf = new Intl.RelativeTimeFormat(uiLocale, { numeric: 'auto' })
  const minutes = Math.round(diffMs / 60_000)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')
  return rtf.format(Math.round(hours / 24), 'day')
}

/**
 * The user's main loan or financing contract, as Open Finance reports it:
 * what is still owed, how far along the installments are, and the next one.
 */
export function FinancingCard({
  locale,
  uiLocale,
  mask,
}: {
  locale: string
  uiLocale: string
  mask: (value: string) => string
}) {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: ['loans'],
    queryFn: fetchLoans,
    staleTime: 5 * 60_000,
    retry: false,
  })

  const active = (data ?? []).filter((l) => l.is_active)
  // The contract that weighs most on the user's finances goes first.
  const sorted = [...active].sort(
    (a, b) => (num(b.outstanding_balance) ?? 0) - (num(a.outstanding_balance) ?? 0),
  )
  const loan = sorted[0]
  const others = sorted.length - 1

  const pct = (value: number) =>
    new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(value)

  return (
    <DashboardCard labelledBy="dash-financing-title" className="flex flex-col">
      <CardHeading
        id="dash-financing-title"
        title={loan?.product_name || t('dashboard.financingTitle')}
        to="/loans"
        linkLabel={t('dashboard.openLoans')}
      />
      {isLoading ? (
        <>
          <Skeleton className="mt-2 h-5 w-48" />
          <Skeleton className="mt-4 h-9 w-44" />
          <Skeleton className="mt-4 h-2.5 w-full" />
          <Skeleton className="mt-4 h-14 w-full" />
        </>
      ) : !loan ? (
        <CardEmpty
          icon={<Landmark className="size-7" />}
          action={
            <Link to="/loans" className="text-sm font-semibold text-primary hover:underline">
              {t('dashboard.financingSeeLoans')}
            </Link>
          }
        >
          {t('dashboard.financingEmpty')}
        </CardEmpty>
      ) : (() => {
        const outstanding = num(loan.outstanding_balance) ?? 0
        const contract = num(loan.contract_amount)
        const total = loan.total_installments
        const paid = loan.paid_installments ?? (total != null && loan.remaining_installments != null ? total - loan.remaining_installments : null)
        const progress = total && paid != null ? (paid / total) * 100 : null
        const repaidShare = contract && contract > 0 ? Math.max(0, Math.min(1, 1 - outstanding / contract)) : null
        const installment = num(loan.installment_amount)
        const monthlyRate = num(loan.monthly_rate)
        const cet = num(loan.cet)
        const overdue = loan.overdue_installments ?? 0
        const institution = loan.institution_name ?? t('dashboard.financingUnknownBank')
        return (
          <>
            <div className="mt-1.5 flex items-center gap-2 text-[13px] text-muted-foreground">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-primary text-[10px] font-bold text-primary-foreground" aria-hidden="true">
                {institution.slice(0, 2).toUpperCase()}
              </span>
              <span className="truncate">
                {loan.last_synced_at
                  ? t('dashboard.financingSourceUpdated', { institution, when: relativeTime(loan.last_synced_at, uiLocale) })
                  : t('dashboard.financingSource', { institution })}
              </span>
            </div>
            <div className="mt-4 flex items-center justify-between gap-2">
              <span className="text-[13.5px] font-medium text-muted-foreground">{t('dashboard.financingOutstanding')}</span>
              {overdue > 0 && <Pill tone="down">{t('dashboard.financingOverdue', { count: overdue })}</Pill>}
            </div>
            <div className="text-[30px] font-bold leading-tight tracking-[-0.02em] tabular-nums text-foreground">
              {mask(formatCurrency(outstanding, loan.currency, locale))}
            </div>
            {progress != null && (
              <>
                <ProgressBar value={progress} className="mt-3.5 h-2.5" label={t('dashboard.financingPaidOf', { paid, total })} />
                <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-[13px] text-muted-foreground">
                  <span>{t('dashboard.financingPaidOf', { paid, total })}</span>
                  {repaidShare != null && <span>{t('dashboard.financingRepaid', { pct: pct(repaidShare) })}</span>}
                </div>
              </>
            )}
            {(installment != null || loan.next_due_date) && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-muted/70 px-3.5 py-3">
                <div className="min-w-0">
                  <div className="text-[12.5px] text-muted-foreground">
                    {loan.next_due_date
                      ? t('dashboard.financingNextOn', {
                          date: parseIsoDate(loan.next_due_date).toLocaleDateString(uiLocale, { day: 'numeric', month: 'short' }).replace('.', ''),
                        })
                      : t('dashboard.financingNext')}
                  </div>
                  {installment != null && (
                    <div className="text-base font-bold tabular-nums text-foreground">
                      {mask(formatCurrency(installment, loan.currency, locale))}
                    </div>
                  )}
                </div>
                {monthlyRate != null ? (
                  <Pill>{t('dashboard.financingRateMonthly', { rate: pct(monthlyRate) })}</Pill>
                ) : cet != null ? (
                  <Pill>{t('dashboard.financingCetYearly', { rate: pct(cet) })}</Pill>
                ) : null}
              </div>
            )}
            {others > 0 && (
              <Link to="/loans" className="mt-3 text-xs font-medium text-primary hover:underline">
                {t('dashboard.financingOthers', { count: others })}
              </Link>
            )}
          </>
        )
      })()}
    </DashboardCard>
  )
}
