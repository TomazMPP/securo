import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Check, Info, Landmark } from 'lucide-react'
import { loans as loansApi } from '@/lib/api'
import type { Loan } from '@/types'
import { PageHeader } from '@/components/page-header'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import { projectBalances, simulatePrepayment, type PrepayMode } from '@/lib/loan-math'

const num = (v: string | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function addMonths(iso: string, months: number): Date {
  const d = new Date(`${iso}T12:00:00`)
  d.setMonth(d.getMonth() + months)
  return d
}

function useRelativeTime(locale: string) {
  return (iso: string | null): string => {
    if (!iso) return ''
    const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
    const hours = Math.round(minutes / 60)
    if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')
    return rtf.format(Math.round(hours / 24), 'day')
  }
}

function initials(name: string | null): string {
  return (name ?? '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'
}

export default function LoansPage() {
  const { t } = useTranslation()
  const { data: loans, isLoading } = useQuery({ queryKey: ['loans'], queryFn: () => loansApi.list() })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = loans?.find((l) => l.id === selectedId) ?? loans?.[0] ?? null

  return (
    <div>
      <PageHeader section={t('nav.groupControl')} title={t('loans.title')} />
      {isLoading && (
        <div className="grid gap-5">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-80 rounded-2xl" />
        </div>
      )}
      {!isLoading && (!loans || loans.length === 0) && <LoansEmptyState />}
      {!isLoading && loans && loans.length > 1 && (
        <div role="tablist" aria-label={t('loans.contracts')} className="mb-5 inline-flex flex-wrap gap-1 rounded-xl bg-secondary p-1">
          {loans.map((loan) => (
            <button
              key={loan.id}
              role="tab"
              aria-selected={loan.id === selected?.id}
              onClick={() => setSelectedId(loan.id)}
              className={cn(
                'h-9 rounded-lg px-4 text-sm font-medium text-muted-foreground transition-colors',
                loan.id === selected?.id && 'bg-card font-semibold text-foreground shadow-xs',
              )}
            >
              {loan.product_name ?? t(`loans.kind.${loan.kind ?? 'LOAN'}`, { defaultValue: t('loans.kind.LOAN') })}
            </button>
          ))}
        </div>
      )}
      {selected && <LoanDetail key={selected.id} loan={selected} />}
    </div>
  )
}

function LoansEmptyState() {
  const { t } = useTranslation()
  return (
    <Card className="items-center px-6 py-14 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
        <Landmark size={26} />
      </span>
      <h2 className="mt-5 text-lg font-bold">{t('loans.emptyTitle')}</h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{t('loans.emptyBody')}</p>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{t('loans.emptyMeuPluggy')}</p>
      <Button asChild variant="outline" className="mt-6">
        <Link to="/accounts">{t('loans.emptyAction')}</Link>
      </Button>
    </Card>
  )
}

function LoanDetail({ loan }: { loan: Loan }) {
  const { t } = useTranslation()
  const locale = useDisplayLocale()
  const { mask } = usePrivacyMode()
  const relative = useRelativeTime(locale)
  const money = (v: number | null) => mask(formatCurrency(v, loan.currency, locale))
  const pct = (v: number | null, digits = 1) =>
    v == null ? '—' : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v)
  const date = (iso: string | null, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }) =>
    iso ? new Intl.DateTimeFormat(locale, opts).format(new Date(`${iso}T12:00:00`)) : '—'

  const outstanding = num(loan.outstanding_balance)
  const contract = num(loan.contract_amount)
  const rate = num(loan.monthly_rate)
  const payment = num(loan.installment_amount)
  const total = loan.total_installments
  const paid = loan.paid_installments
  const remaining = loan.remaining_installments ?? (total != null && paid != null ? total - paid : null)
  const paidShare = total && paid != null ? paid / total : null
  const principalShare = outstanding != null && contract ? 1 - outstanding / contract : null
  const kindLabel = t(`loans.kind.${loan.kind ?? 'LOAN'}`, { defaultValue: t('loans.kind.LOAN') })
  const canProject = outstanding != null && rate != null && payment != null && remaining != null && remaining > 0

  const chart = useMemo(() => {
    if (!canProject) return []
    const start = loan.next_due_date ?? new Date().toISOString().slice(0, 10)
    return projectBalances(outstanding, rate, payment, remaining).map((b, k) => ({
      label: new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit' }).format(addMonths(start, k - 1)),
      balance: Math.round(b * 100) / 100,
    }))
  }, [canProject, outstanding, rate, payment, remaining, loan.next_due_date, locale])

  const feesTotal = loan.contracted_fees.reduce((s, f) => s + (Number(f.amount) || 0), 0)
  const warranty = loan.warranties[0]

  return (
    <div className="flex flex-col gap-5">
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-3 border-b px-5 py-4 sm:px-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
            {initials(loan.institution_name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-bold">{[loan.institution_name, loan.product_name].filter(Boolean).join(' · ')}</div>
            <div className="text-[13px] text-muted-foreground tabular-nums">
              {[kindLabel, loan.contract_number && t('loans.contractNo', { number: `•••• ${loan.contract_number.slice(-4)}` }), loan.amortization_system && t('loans.system', { system: loan.amortization_system })]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            <span className="size-1.5 rounded-full bg-emerald-600" />
            {t('loans.syncedVia', { when: relative(loan.last_synced_at) })}
          </span>
        </div>
        <div className="grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
          <Kpi label={t('loans.outstanding')} value={money(outstanding)} big
            note={contract != null ? t('loans.ofContracted', { amount: money(contract) }) : undefined} />
          <div className="px-5 py-5 sm:px-6">
            <div className="text-[13.5px] font-medium text-muted-foreground">{t('loans.installments')}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">
              {paid ?? '—'} <span className="text-[15px] font-medium text-muted-foreground">{t('loans.ofPaid', { total: total ?? '—' })}</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((paidShare ?? 0) * 100)}%` }} />
            </div>
            <div className="mt-1.5 text-[12.5px] text-muted-foreground">
              {t('loans.overdueAndEnd', { count: loan.overdue_installments ?? 0, end: date(loan.final_due_date, { month: 'short', year: 'numeric' }) })}
            </div>
          </div>
          <Kpi
            label={loan.next_due_date ? t('loans.nextOn', { date: date(loan.next_due_date, { day: '2-digit', month: 'short' }) }) : t('loans.next')}
            value={money(payment)}
            note={t('loans.paymentEstimated')}
          />
          <Kpi label={t('loans.cet')} value={loan.cet ? t('loans.perYear', { value: pct(num(loan.cet)) }) : '—'}
            note={rate != null ? t('loans.monthlyRate', { value: pct(rate, 2) }) : undefined} />
        </div>
      </Card>

      {principalShare != null && paidShare != null && (
        <p className="rounded-2xl bg-accent px-5 py-3 text-sm leading-relaxed text-accent-foreground">
          {t('loans.insight', { principal: pct(principalShare, 0), installments: pct(paidShare, 0) })}
        </p>
      )}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card className="gap-0 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[13.5px] font-medium text-muted-foreground">{t('loans.projection')}</h2>
            {canProject && <span className="text-xs text-muted-foreground">{t('loans.projectionHint')}</span>}
          </div>
          {canProject ? (
            <div className="mt-3 h-60">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} minTickGap={24} />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} width={64}
                    tickFormatter={(v: number) => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v)} />
                  <Tooltip formatter={(v) => money(Number(v))} />
                  <Area type="monotone" dataKey="balance" name={t('loans.outstanding')} stroke="var(--primary)" strokeWidth={2.5} fill="var(--accent)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">{t('loans.projectionUnavailable')}</p>
          )}

          <h3 className="mt-6 text-[15px] font-bold">{t('loans.payments')}</h3>
          {loan.payments.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('loans.noPayments')}</p>}
          <ul className="mt-1">
            {loan.payments.slice(0, 12).map((p, idx) => (
              <li key={`${p.date}-${idx}`} className="flex items-center gap-3 border-b py-3 last:border-0">
                <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg',
                  p.over_parcel ? 'bg-accent text-accent-foreground' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300')}>
                  <Check size={16} strokeWidth={2.6} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{p.over_parcel ? t('loans.extraPayment') : t('loans.installmentPaid')}</div>
                  <div className="text-[12.5px] text-muted-foreground">{t('loans.paidOn', { date: date(p.date) })}</div>
                </div>
                <span className="text-sm font-semibold tabular-nums">{money(Number(p.amount))}</span>
              </li>
            ))}
          </ul>
        </Card>

        <div className="flex flex-col gap-5">
          {canProject && <PrepaySimulator loan={loan} balance={outstanding} rate={rate} payment={payment} remaining={remaining} money={money} />}
          <Card className="gap-0 p-5 sm:p-6">
            <h2 className="mb-1 text-base font-bold">{t('loans.details')}</h2>
            <dl>
              <Row label={t('loans.contractAmount')} value={money(contract)} />
              <Row label={t('loans.contractDate')} value={date(loan.contract_date)} />
              <Row label={t('loans.firstInstallment')} value={date(loan.first_installment_date)} />
              <Row label={t('loans.lastInstallment')} value={date(loan.final_due_date)} />
              <Row label={t('loans.rate')} value={rate != null ? t('loans.monthlyRate', { value: pct(rate, 2) }) : '—'} />
              <Row label={t('loans.cet')} value={loan.cet ? t('loans.perYear', { value: pct(num(loan.cet)) }) : '—'} />
              <Row label={t('loans.amortization')} value={loan.amortization_system ?? '—'} />
              {warranty && <Row label={t('loans.warranty')} value={String(warranty.subtype ?? warranty.type ?? '—').replaceAll('_', ' ').toLowerCase()} />}
              {feesTotal > 0 && <Row label={t('loans.fees')} value={money(feesTotal)} />}
            </dl>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Kpi({ label, value, note, big }: { label: string; value: string; note?: string; big?: boolean }) {
  return (
    <div className="px-5 py-5 sm:px-6">
      <div className="text-[13.5px] font-medium text-muted-foreground">{label}</div>
      <div className={cn('mt-1 font-bold tabular-nums tracking-tight', big ? 'text-[32px] leading-tight' : 'text-2xl')}>{value}</div>
      {note && <div className="mt-1 text-[12.5px] text-muted-foreground">{note}</div>}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b py-2.5 text-sm last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function PrepaySimulator({ loan, balance, rate, payment, remaining, money }: {
  loan: Loan
  balance: number
  rate: number
  payment: number
  remaining: number
  money: (v: number | null) => string
}) {
  const { t } = useTranslation()
  const [amount, setAmount] = useState(10000)
  const [mode, setMode] = useState<PrepayMode>('term')
  const result = simulatePrepayment(balance, rate, payment, remaining, amount, mode)

  return (
    <Card className="gap-0 p-5 sm:p-6">
      <h2 className="text-base font-bold">{t('loans.simulate')}</h2>
      <p className="mt-1 mb-4 text-[13.5px] text-muted-foreground">{t('loans.simulateHint')}</p>
      <label htmlFor="prepay-amount" className="text-[13px] font-semibold">{t('loans.prepayAmount')}</label>
      <div className="mt-1.5 mb-3 flex h-12 items-center gap-2 rounded-xl border border-input bg-card px-3.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
        <span className="font-semibold text-muted-foreground">{loan.currency}</span>
        <input
          id="prepay-amount"
          type="number"
          min={0}
          step={500}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value) || 0)}
          className="w-full bg-transparent text-lg font-bold tabular-nums outline-none"
        />
      </div>
      <div role="radiogroup" aria-label={t('loans.prepayMode')} className="grid grid-cols-2 gap-1 rounded-xl bg-secondary p-1">
        {(['term', 'payment'] as const).map((m) => (
          <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
            className={cn('h-9 rounded-lg text-sm font-medium text-muted-foreground', mode === m && 'bg-card font-semibold text-foreground shadow-xs')}>
            {t(m === 'term' ? 'loans.reduceTerm' : 'loans.reducePayment')}
          </button>
        ))}
      </div>
      <div className="mt-4 rounded-xl bg-emerald-50 p-4 dark:bg-emerald-950/60">
        <div className="text-[13px] font-semibold text-emerald-900 dark:text-emerald-200">{t('loans.saving')}</div>
        <div className="mt-0.5 text-3xl font-bold tracking-tight text-emerald-700 tabular-nums dark:text-emerald-300">{money(result.saving)}</div>
        <div className="mt-1.5 text-[13.5px] leading-relaxed text-emerald-900 dark:text-emerald-200">
          {mode === 'term'
            ? result.installmentsCut > 0
              ? t('loans.effectTerm', { count: result.installmentsCut, payment: money(payment) })
              : t('loans.effectTooSmall')
            : t('loans.effectPayment', { from: money(payment), to: money(result.newPayment) })}
        </div>
      </div>
      <p className="mt-3 flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <Info size={14} className="mt-px shrink-0" />
        {t('loans.simulateDisclaimer')}
      </p>
    </Card>
  )
}

