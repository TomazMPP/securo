import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Area, AreaChart, Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, Pie, PieChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Check, Info, Landmark, Pencil, Plus, Sparkles, X } from 'lucide-react'
import { accounts as accountsApi, loans as loansApi } from '@/lib/api'
import type { Account, Loan, LoanSchedule, ManualLoanInput } from '@/types'
import { PageHeader } from '@/components/page-header'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { formatCurrency } from '@/lib/format'
import { sumAccountBalances } from '@/lib/account-utils'
import { cn } from '@/lib/utils'
import { simulatePrepayment, type PrepayMode } from '@/lib/loan-math'
import { costBreakdown, monthlyBars, originalVsActual } from '@/lib/loan-charts'

const PRINCIPAL = '#18A058'
const INTEREST = '#E5484D'
const BALANCE = 'var(--primary)'
const MUTED = '#A0A7B4'

const num = (v: string | number | null | undefined): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function useFormatters(currency: string) {
  const locale = useDisplayLocale()
  const { mask } = usePrivacyMode()
  return useMemo(() => {
    const money = (v: number | null) => mask(formatCurrency(v, currency, locale))
    const compact = (v: number) => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v)
    const pct = (v: number | null, digits = 1) =>
      v == null ? '—' : new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)
    const date = (iso: string | null, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }) =>
      iso ? new Intl.DateTimeFormat(locale, opts).format(new Date(`${iso.length === 7 ? `${iso}-01` : iso}T12:00:00`)) : '—'
    const month = (key: string) => date(key, { month: 'short', year: '2-digit' })
    const relative = (iso: string | null) => {
      if (!iso) return ''
      const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
      if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
      const hours = Math.round(minutes / 60)
      if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')
      return rtf.format(Math.round(hours / 24), 'day')
    }
    return { money, compact, pct, date, month, relative }
  }, [currency, locale, mask])
}

export default function LoansPage() {
  const { t } = useTranslation()
  const { data: loans, isLoading } = useQuery({ queryKey: ['loans'], queryFn: () => loansApi.list() })
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi.list() })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState<Account | 'blank' | null>(null)
  const selected = loans?.find((l) => l.id === selectedId) ?? loans?.[0] ?? null

  // Manual loan accounts that don't have a contract yet can become one.
  const orphanLoanAccounts = (accounts ?? []).filter(
    (a) => a.type === 'loan' && !a.is_closed && !(loans ?? []).some((l) => l.account_id === a.id),
  )

  return (
    <div>
      <PageHeader
        section={t('nav.groupControl')}
        title={t('loans.title')}
        action={<Button variant="outline" onClick={() => setCreating('blank')}><Plus size={16} />{t('loans.addManual')}</Button>}
      />
      {isLoading && <div className="grid gap-5"><Skeleton className="h-40 rounded-2xl" /><Skeleton className="h-96 rounded-2xl" /></div>}

      {!isLoading && orphanLoanAccounts.map((acc) => (
        <Card key={acc.id} className="mb-5 flex-row items-center gap-4 border-primary/30 bg-accent/40 p-5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Sparkles size={20} /></span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{t('loans.convertTitle', { name: acc.display_name || acc.name })}</div>
            <div className="text-[13.5px] text-muted-foreground">{t('loans.convertBody')}</div>
          </div>
          <Button onClick={() => setCreating(acc)}>{t('loans.convertAction')}</Button>
        </Card>
      ))}

      {!isLoading && loans && loans.length > 0 && <DebtSummary loans={loans} accounts={accounts ?? []} />}
      {!isLoading && (!loans || loans.length === 0) && orphanLoanAccounts.length === 0 && <LoansEmptyState />}

      {!isLoading && loans && loans.length > 1 && (
        <div role="tablist" aria-label={t('loans.contracts')} className="mb-5 inline-flex flex-wrap gap-1 rounded-xl bg-secondary p-1">
          {loans.map((loan) => (
            <button key={loan.id} role="tab" aria-selected={loan.id === selected?.id} onClick={() => setSelectedId(loan.id)}
              className={cn('h-9 rounded-lg px-4 text-sm font-medium text-muted-foreground', loan.id === selected?.id && 'bg-card font-semibold text-foreground shadow-xs')}>
              {loan.product_name ?? t(`loans.kind.${loan.kind ?? 'LOAN'}`, { defaultValue: t('loans.kind.LOAN') })}
            </button>
          ))}
        </div>
      )}
      {selected && <LoanDetail key={selected.id} loan={selected} />}
      {creating && <ManualLoanDialog account={creating === 'blank' ? null : creating} onClose={() => setCreating(null)} />}
    </div>
  )
}

function DebtSummary({ loans, accounts }: { loans: Loan[]; accounts: Account[] }) {
  const { t } = useTranslation()
  const f = useFormatters(loans[0]?.currency ?? 'BRL')
  const loanDebt = loans.reduce((s, l) => s + (num(l.outstanding_balance) ?? 0), 0)
  const cardDebt = Math.max(0, -sumAccountBalances(accounts.filter((a) => a.type === 'credit_card' && !a.is_closed)))
  const monthlyInterest = loans.reduce((s, l) => s + (num(l.outstanding_balance) ?? 0) * (num(l.monthly_rate) ?? 0), 0)
  const debtFree = loans.map((l) => l.final_due_date).filter(Boolean).sort().at(-1) ?? null

  return (
    <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <section className="flex flex-col rounded-[20px] bg-primary p-1">
        <div className="rounded-[17px] bg-card p-5 sm:p-6">
          <div className="text-[13.5px] font-medium text-muted-foreground">{t('loans.totalDebt')}</div>
          <div className="mt-1 text-[34px] font-bold tracking-tight tabular-nums">{f.money(loanDebt + cardDebt)}</div>
          <dl className="mt-4 flex flex-col gap-2.5 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">{t('loans.title')}</dt><dd className="font-semibold tabular-nums">{f.money(loanDebt)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">{t('loans.openCardBills')}</dt><dd className="font-semibold tabular-nums">{f.money(cardDebt)}</dd></div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('loans.interestPerMonth')}<div className="text-xs">{t('loans.interestPerMonthHint')}</div></dt>
              <dd className="font-semibold text-[#B42323] tabular-nums dark:text-red-400">≈ {f.money(monthlyInterest)}</dd>
            </div>
          </dl>
        </div>
        {debtFree && (
          <p className="px-5 py-3.5 text-sm leading-relaxed text-primary-foreground">
            {t('loans.debtFree', { date: f.date(debtFree, { month: 'long', year: 'numeric' }) })}
          </p>
        )}
      </section>
      <Card className="gap-0 p-5 sm:p-6">
        <h2 className="text-[13.5px] font-medium text-muted-foreground">{t('loans.debtComposition')}</h2>
        <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-secondary">
          {loanDebt + cardDebt > 0 && (
            <>
              <span style={{ width: `${(loanDebt / (loanDebt + cardDebt)) * 100}%`, background: 'var(--primary)' }} />
              <span style={{ width: `${(cardDebt / (loanDebt + cardDebt)) * 100}%`, background: '#E08A1E' }} />
            </>
          )}
        </div>
        <ul className="mt-4 flex flex-col">
          {loans.map((l) => (
            <li key={l.id} className="flex items-center gap-3 border-b py-2.5 text-sm last:border-0">
              <span className="size-2.5 rounded-sm bg-primary" />
              <span className="flex-1 font-medium">{l.product_name ?? l.institution_name}</span>
              <span className="text-xs text-muted-foreground">{l.monthly_rate ? t('loans.monthlyRate', { value: f.pct(num(l.monthly_rate), 2) }) : ''}</span>
              <span className="w-28 text-right font-semibold tabular-nums">{f.money(num(l.outstanding_balance))}</span>
            </li>
          ))}
          <li className="flex items-center gap-3 py-2.5 text-sm">
            <span className="size-2.5 rounded-sm bg-[#E08A1E]" />
            <span className="flex-1 font-medium">{t('loans.openCardBills')}</span>
            <Link to="/accounts?section=cards" className="text-xs">{t('loans.seeCards')}</Link>
            <span className="w-28 text-right font-semibold tabular-nums">{f.money(cardDebt)}</span>
          </li>
        </ul>
      </Card>
    </div>
  )
}

function LoansEmptyState() {
  const { t } = useTranslation()
  return (
    <Card className="items-center px-6 py-14 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><Landmark size={26} /></span>
      <h2 className="mt-5 text-lg font-bold">{t('loans.emptyTitle')}</h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{t('loans.emptyBody')}</p>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{t('loans.emptyMeuPluggy')}</p>
      <Button asChild variant="outline" className="mt-6"><Link to="/accounts">{t('loans.emptyAction')}</Link></Button>
    </Card>
  )
}

function LoanDetail({ loan }: { loan: Loan }) {
  const { t } = useTranslation()
  const f = useFormatters(loan.currency)
  const [editing, setEditing] = useState(false)
  const { data: schedule } = useQuery({
    queryKey: ['loans', loan.id, 'schedule', loan.outstanding_balance, loan.payments.length],
    queryFn: () => loansApi.schedule(loan.id),
    retry: false,
  })

  const outstanding = num(loan.outstanding_balance)
  const contract = num(loan.contract_amount)
  const rate = num(loan.monthly_rate)
  const payment = num(loan.installment_amount)
  const total = loan.total_installments
  const paid = loan.paid_installments
  const paidShare = total && paid != null ? paid / total : null
  const principalShare = outstanding != null && contract ? 1 - outstanding / contract : null
  const kindLabel = t(`loans.kind.${loan.kind ?? 'LOAN'}`, { defaultValue: t('loans.kind.LOAN') })
  const isManual = loan.source === 'manual'

  return (
    <div className="flex flex-col gap-5">
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-3 border-b px-5 py-4 sm:px-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
            {(loan.institution_name ?? '?').slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-bold">{[loan.institution_name, loan.product_name].filter(Boolean).join(' · ')}</div>
            <div className="text-[13px] text-muted-foreground tabular-nums">
              {[kindLabel, loan.contract_number && t('loans.contractNo', { number: `•••• ${loan.contract_number.slice(-4)}` }), loan.amortization_system && t('loans.system', { system: loan.amortization_system })].filter(Boolean).join(' · ')}
            </div>
          </div>
          {isManual ? (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground">{t('loans.manualBadge')}</span>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}><Pencil size={14} />{t('loans.editTerms')}</Button>
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              <span className="size-1.5 rounded-full bg-emerald-600" />{t('loans.syncedVia', { when: f.relative(loan.last_synced_at) })}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
          <Kpi label={t('loans.outstanding')} value={f.money(outstanding)} big note={contract != null ? t('loans.ofContracted', { amount: f.money(contract) }) : undefined} />
          <div className="px-5 py-5 sm:px-6">
            <div className="text-[13.5px] font-medium text-muted-foreground">{t('loans.installments')}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{paid ?? '—'} <span className="text-[15px] font-medium text-muted-foreground">{t('loans.ofPaid', { total: total ?? '—' })}</span></div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((paidShare ?? 0) * 100)}%` }} /></div>
            <div className="mt-1.5 text-[12.5px] text-muted-foreground">{t('loans.overdueAndEnd', { count: loan.overdue_installments ?? 0, end: f.date(loan.final_due_date, { month: 'short', year: 'numeric' }) })}</div>
          </div>
          <Kpi label={loan.next_due_date ? t('loans.nextOn', { date: f.date(loan.next_due_date, { day: '2-digit', month: 'short' }) }) : t('loans.next')} value={f.money(payment)} note={isManual ? t('loans.paymentContract') : t('loans.paymentEstimated')} />
          <Kpi label={t('loans.rate')} value={rate != null ? t('loans.monthlyRate', { value: f.pct(rate, 2) }) : '—'}
            note={loan.cet ? t('loans.cetValue', { value: f.pct(num(loan.cet)) }) : rate != null ? t('loans.perYear', { value: f.pct(Math.pow(1 + rate, 12) - 1) }) : undefined} />
        </div>
      </Card>

      {schedule && schedule.interest_saved > 1 && (
        <p className="flex gap-3 rounded-2xl bg-emerald-50 px-5 py-3.5 text-sm leading-relaxed text-emerald-950 dark:bg-emerald-950/50 dark:text-emerald-100">
          <Sparkles size={18} className="mt-0.5 shrink-0" />
          <span>{t('loans.savedInsight', { saved: f.money(schedule.interest_saved), count: schedule.months_saved, payoff: f.date(schedule.payoff_date, { month: 'long', year: 'numeric' }), original: f.date(schedule.baseline_end, { month: 'long', year: 'numeric' }) })}</span>
        </p>
      )}
      {!schedule && principalShare != null && paidShare != null && (
        <p className="rounded-2xl bg-accent px-5 py-3 text-sm leading-relaxed text-accent-foreground">{t('loans.insight', { principal: f.pct(principalShare, 0), installments: f.pct(paidShare, 0) })}</p>
      )}

      {schedule && <ScheduleCharts loan={loan} schedule={schedule} />}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          {isManual && <SuggestionsCard loan={loan} />}
          <PaymentsCard loan={loan} schedule={schedule ?? null} />
        </div>
        <div className="flex flex-col gap-5">
          {outstanding != null && rate != null && payment != null && (schedule?.remaining_installments ?? loan.remaining_installments ?? 0) > 0 && (
            <PrepaySimulator loan={loan} balance={outstanding} rate={rate} payment={payment} remaining={schedule?.remaining_installments ?? loan.remaining_installments ?? 0} money={f.money} />
          )}
          <Card className="gap-0 p-5 sm:p-6">
            <h2 className="mb-1 text-base font-bold">{t('loans.details')}</h2>
            <dl>
              <Row label={t('loans.contractAmount')} value={f.money(contract)} />
              <Row label={t('loans.contractDate')} value={f.date(loan.contract_date)} />
              <Row label={t('loans.firstInstallment')} value={f.date(loan.first_installment_date)} />
              <Row label={t('loans.lastInstallment')} value={f.date(loan.final_due_date)} />
              {schedule && <Row label={t('loans.totalInterest')} value={f.money(schedule.total_interest)} />}
              {schedule && <Row label={t('loans.totalCost')} value={f.money(schedule.principal + schedule.total_interest)} />}
              <Row label={t('loans.amortization')} value={loan.amortization_system ?? '—'} />
              {loan.warranties[0] && <Row label={t('loans.warranty')} value={String(loan.warranties[0].subtype ?? loan.warranties[0].type ?? '—').replaceAll('_', ' ').toLowerCase()} />}
            </dl>
          </Card>
        </div>
      </div>
      {editing && <ManualLoanDialog loan={loan} account={null} onClose={() => setEditing(false)} />}
    </div>
  )
}

function ScheduleCharts({ loan, schedule }: { loan: Loan; schedule: LoanSchedule }) {
  const { t } = useTranslation()
  const f = useFormatters(loan.currency)
  const bars = useMemo(() => monthlyBars(schedule), [schedule])
  const compare = useMemo(() => loan.first_installment_date && loan.total_installments ? originalVsActual(schedule, loan.first_installment_date, loan.total_installments) : [], [schedule, loan])
  const slices = useMemo(() => costBreakdown(schedule), [schedule])
  const todayKey = new Date().toISOString().slice(0, 7)
  const sliceColors: Record<string, string> = { principalPaid: PRINCIPAL, interestPaid: INTEREST, principalLeft: '#B7E4C7', interestLeft: '#F6B7B9' }
  const tooltipMoney = (v: unknown) => f.money(Number(v))

  return (
    <>
      <Card className="gap-0 p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[13.5px] font-medium text-muted-foreground">{t('loans.evolution')}</h2>
          <span className="text-xs text-muted-foreground">{t('loans.evolutionHint')}</span>
        </div>
        <div className="mt-3 h-80">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={bars} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="key" tickFormatter={f.month} tickLine={false} axisLine={false} fontSize={12} minTickGap={16} />
              <YAxis yAxisId="pay" tickLine={false} axisLine={false} fontSize={12} width={56} tickFormatter={f.compact} />
              <YAxis yAxisId="bal" orientation="right" tickLine={false} axisLine={false} fontSize={12} width={56} tickFormatter={f.compact} />
              <Tooltip formatter={tooltipMoney} labelFormatter={(k) => f.month(String(k))} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine yAxisId="pay" x={todayKey} stroke={MUTED} strokeDasharray="4 4" label={{ value: t('loans.today'), fontSize: 11, fill: MUTED, position: 'top' }} />
              <Bar yAxisId="pay" dataKey="principal" name={t('loans.principal')} stackId="p" fill={PRINCIPAL} radius={[0, 0, 0, 0]}>
                {bars.map((b) => <Cell key={b.key} fillOpacity={b.projected ? 0.45 : 1} />)}
              </Bar>
              <Bar yAxisId="pay" dataKey="interest" name={t('loans.interest')} stackId="p" fill={INTEREST} radius={[4, 4, 0, 0]}>
                {bars.map((b) => <Cell key={b.key} fillOpacity={b.projected ? 0.45 : 1} />)}
              </Bar>
              <Line yAxisId="bal" dataKey="balance" name={t('loans.outstanding')} stroke={BALANCE} strokeWidth={2.5} dot={false} type="monotone" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="gap-0 p-5 sm:p-6">
          <h2 className="text-[13.5px] font-medium text-muted-foreground">{t('loans.whereMoneyGoes')}</h2>
          <div className="relative mt-2 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={slices} dataKey="value" nameKey="key" innerRadius="62%" outerRadius="92%" stroke="none" paddingAngle={1.5}>
                  {slices.map((s) => <Cell key={s.key} fill={sliceColors[s.key]} />)}
                </Pie>
                <Tooltip formatter={tooltipMoney} labelFormatter={() => ''} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xs text-muted-foreground">{t('loans.totalCost')}</span>
              <span className="text-base font-bold tabular-nums">{f.money(schedule.principal + schedule.total_interest)}</span>
            </div>
          </div>
          <ul className="mt-3 flex flex-col gap-1.5 text-[13px]">
            {slices.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span className="size-2.5 rounded-sm" style={{ background: sliceColors[s.key] }} />
                <span className="flex-1 text-muted-foreground">{t(`loans.slice.${s.key}`)}</span>
                <span className="font-semibold tabular-nums">{f.money(s.value)}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="gap-0 p-5 sm:p-6">
          <h2 className="text-[13.5px] font-medium text-muted-foreground">{t('loans.originalVsActual')}</h2>
          <div className="mt-3 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={compare} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis dataKey="key" tickFormatter={f.month} tickLine={false} axisLine={false} fontSize={11} minTickGap={28} />
                <YAxis hide />
                <Tooltip formatter={tooltipMoney} labelFormatter={(k) => f.month(String(k))} />
                <Line dataKey="original" name={t('loans.original')} stroke={MUTED} strokeDasharray="5 5" strokeWidth={2} dot={false} connectNulls />
                <Line dataKey="actual" name={t('loans.actual')} stroke={BALANCE} strokeWidth={2.5} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
            <div className="rounded-xl bg-secondary p-3"><dt className="text-muted-foreground">{t('loans.original')}</dt><dd className="font-semibold">{f.date(schedule.baseline_end, { month: 'short', year: 'numeric' })}</dd><dd className="tabular-nums text-muted-foreground">{t('loans.interestAmount', { amount: f.money(schedule.baseline_interest) })}</dd></div>
            <div className="rounded-xl bg-accent p-3"><dt className="text-accent-foreground">{t('loans.actual')}</dt><dd className="font-semibold">{f.date(schedule.payoff_date, { month: 'short', year: 'numeric' })}</dd><dd className="tabular-nums text-accent-foreground">{t('loans.interestAmount', { amount: f.money(schedule.total_interest) })}</dd></div>
          </dl>
        </Card>

        <Card className="gap-0 p-5 sm:p-6">
          <h2 className="text-[13.5px] font-medium text-muted-foreground">{t('loans.interestShare')}</h2>
          <div className="mt-3 h-44">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={bars} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis dataKey="key" tickFormatter={f.month} tickLine={false} axisLine={false} fontSize={11} minTickGap={28} />
                <YAxis hide domain={[0, 1]} />
                <Tooltip formatter={(v) => f.pct(Number(v), 0)} labelFormatter={(k) => f.month(String(k))} />
                <Area dataKey="interestShare" name={t('loans.interest')} stroke={INTEREST} fill={INTEREST} fillOpacity={0.15} strokeWidth={2} type="monotone" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
            {t('loans.interestShareHint', { now: f.pct(bars.find((b) => b.projected)?.interestShare ?? null, 0), last: f.pct(bars.at(-1)?.interestShare ?? null, 0) })}
          </p>
        </Card>
      </div>
    </>
  )
}

function SuggestionsCard({ loan }: { loan: Loan }) {
  const { t } = useTranslation()
  const f = useFormatters(loan.currency)
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['loans', loan.id, 'suggestions', loan.payments.length], queryFn: () => loansApi.suggestions(loan.id) })
  const [dismissed, setDismissed] = useState<string[]>([])
  const link = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'installment' | 'extra' }) => loansApi.linkPayment(loan.id, id, kind),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['loans'] }); qc.invalidateQueries({ queryKey: ['accounts'] }); toast.success(t('loans.linked')) },
    onError: () => toast.error(t('loans.linkFailed')),
  })
  const visible = (data ?? []).filter((s) => !dismissed.includes(s.transaction_id))
  if (visible.length === 0) return null
  return (
    <Card className="gap-0 border-primary/30 p-5 sm:p-6">
      <h2 className="text-base font-bold">{t('loans.suggestionsTitle', { count: visible.length })}</h2>
      <p className="mt-1 text-[13.5px] text-muted-foreground">{t('loans.suggestionsBody')}</p>
      <ul className="mt-3">
        {visible.map((s) => (
          <li key={s.transaction_id} className="flex flex-wrap items-center gap-3 border-b py-3 last:border-0">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{s.description}</div>
              <div className="text-[12.5px] text-muted-foreground">{f.date(s.date)} · {s.account_name} · {t(s.kind === 'extra' ? 'loans.asExtra' : 'loans.asInstallment')}</div>
            </div>
            <span className="text-sm font-semibold tabular-nums">{f.money(s.amount)}</span>
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => link.mutate({ id: s.transaction_id, kind: s.kind })} disabled={link.isPending}><Check size={14} />{t('loans.confirm')}</Button>
              <Button size="sm" variant="ghost" aria-label={t('loans.dismiss')} onClick={() => setDismissed([...dismissed, s.transaction_id])}><X size={14} /></Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function PaymentsCard({ loan, schedule }: { loan: Loan; schedule: LoanSchedule | null }) {
  const { t } = useTranslation()
  const f = useFormatters(loan.currency)
  const qc = useQueryClient()
  const unlink = useMutation({
    mutationFn: (txId: string) => loansApi.unlinkPayment(loan.id, txId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['loans'] }); qc.invalidateQueries({ queryKey: ['accounts'] }) },
  })
  const rows = schedule
    ? [...schedule.payments].reverse()
    : loan.payments.map((p) => ({ date: p.date, amount: Number(p.amount), kind: p.over_parcel ? 'extra' : 'installment', interest: null, principal: null, transaction_id: null, description: null }))

  return (
    <Card className="gap-0 p-5 sm:p-6">
      <h2 className="text-base font-bold">{t('loans.payments')}</h2>
      {rows.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t('loans.noPayments')}</p>}
      <ul className="mt-1">
        {rows.map((p, idx) => {
          const share = p.interest != null && p.amount ? (p.interest as number) / p.amount : null
          return (
            <li key={`${p.date}-${idx}`} className="border-b py-3 last:border-0">
              <div className="flex items-center gap-3">
                <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', p.kind === 'extra' ? 'bg-accent text-accent-foreground' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300')}>
                  {p.kind === 'extra' ? <Sparkles size={15} /> : <Check size={16} strokeWidth={2.6} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{p.kind === 'extra' ? t('loans.extraPayment') : t('loans.installmentPaid')}</div>
                  <div className="truncate text-[12.5px] text-muted-foreground">{f.date(p.date)}{p.description ? ` · ${p.description}` : ''}</div>
                </div>
                <span className="text-sm font-semibold tabular-nums">{f.money(p.amount)}</span>
                {loan.source === 'manual' && p.transaction_id && (
                  <Button size="icon-sm" variant="ghost" aria-label={t('loans.unlink')} onClick={() => unlink.mutate(p.transaction_id as string)}><X size={14} /></Button>
                )}
              </div>
              {share != null && (
                <div className="mt-2 ml-11">
                  <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary">
                    <span style={{ width: `${(1 - share) * 100}%`, background: PRINCIPAL }} />
                    <span style={{ width: `${share * 100}%`, background: INTEREST }} />
                  </div>
                  <div className="mt-1 flex justify-between text-[11.5px] text-muted-foreground tabular-nums">
                    <span>{t('loans.principal')} {f.money(p.principal as number)}</span>
                    <span>{t('loans.interest')} {f.money(p.interest as number)}</span>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
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
  loan: Loan; balance: number; rate: number; payment: number; remaining: number; money: (v: number | null) => string
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
        <input id="prepay-amount" type="number" min={0} step={500} value={amount} onChange={(e) => setAmount(Number(e.target.value) || 0)} className="w-full bg-transparent text-lg font-bold tabular-nums outline-none" />
      </div>
      <div role="radiogroup" aria-label={t('loans.prepayMode')} className="grid grid-cols-2 gap-1 rounded-xl bg-secondary p-1">
        {(['term', 'payment'] as const).map((m) => (
          <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn('h-9 rounded-lg text-sm font-medium text-muted-foreground', mode === m && 'bg-card font-semibold text-foreground shadow-xs')}>
            {t(m === 'term' ? 'loans.reduceTerm' : 'loans.reducePayment')}
          </button>
        ))}
      </div>
      <div className="mt-4 rounded-xl bg-emerald-50 p-4 dark:bg-emerald-950/60">
        <div className="text-[13px] font-semibold text-emerald-900 dark:text-emerald-200">{t('loans.saving')}</div>
        <div className="mt-0.5 text-3xl font-bold tracking-tight text-emerald-700 tabular-nums dark:text-emerald-300">{money(result.saving)}</div>
        <div className="mt-1.5 text-[13.5px] leading-relaxed text-emerald-900 dark:text-emerald-200">
          {mode === 'term'
            ? result.installmentsCut > 0 ? t('loans.effectTerm', { count: result.installmentsCut, payment: money(payment) }) : t('loans.effectTooSmall')
            : t('loans.effectPayment', { from: money(payment), to: money(result.newPayment) })}
        </div>
      </div>
      <p className="mt-3 flex gap-1.5 text-xs leading-relaxed text-muted-foreground"><Info size={14} className="mt-px shrink-0" />{t('loans.simulateDisclaimer')}</p>
    </Card>
  )
}

function ManualLoanDialog({ account, loan, onClose }: { account: Account | null; loan?: Loan; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [form, setForm] = useState<ManualLoanInput>(() => ({
    account_id: loan?.account_id ?? account?.id ?? null,
    product_name: loan?.product_name ?? account?.display_name ?? account?.name ?? '',
    institution_name: loan?.institution_name ?? '',
    contract_amount: num(loan?.contract_amount) ?? Math.abs(Number(account?.current_balance ?? 0)),
    installment_amount: num(loan?.installment_amount) ?? 0,
    total_installments: loan?.total_installments ?? 12,
    contract_date: loan?.contract_date ?? new Date().toISOString().slice(0, 10),
    first_installment_date: loan?.first_installment_date ?? new Date().toISOString().slice(0, 10),
    monthly_rate: num(loan?.monthly_rate),
  }))
  const save = useMutation({
    mutationFn: () => (loan ? loansApi.update(loan.id, form) : loansApi.createManual(form)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loans'] })
      qc.invalidateQueries({ queryKey: ['accounts'] })
      toast.success(t('loans.savedContract'))
      onClose()
    },
    onError: () => toast.error(t('loans.saveContractFailed')),
  })
  const set = <K extends keyof ManualLoanInput>(k: K, v: ManualLoanInput[K]) => setForm({ ...form, [k]: v })
  const field = 'mt-1 h-10 w-full rounded-xl border border-input bg-card px-3 text-sm outline-none focus:border-ring'
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{loan ? t('loans.editTerms') : t('loans.addManual')}</DialogTitle></DialogHeader>
        <form className="grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          <label className="col-span-2 text-[13px] font-medium">{t('loans.form.name')}<input required className={field} value={form.product_name} onChange={(e) => set('product_name', e.target.value)} /></label>
          <label className="col-span-2 text-[13px] font-medium">{t('loans.form.institution')}<input className={field} value={form.institution_name ?? ''} onChange={(e) => set('institution_name', e.target.value)} /></label>
          <label className="text-[13px] font-medium">{t('loans.contractAmount')}<input required type="number" step="0.01" min="0" className={field} value={form.contract_amount} onChange={(e) => set('contract_amount', Number(e.target.value))} /></label>
          <label className="text-[13px] font-medium">{t('loans.form.installment')}<input required type="number" step="0.01" min="0" className={field} value={form.installment_amount} onChange={(e) => set('installment_amount', Number(e.target.value))} /></label>
          <label className="text-[13px] font-medium">{t('loans.form.count')}<input required type="number" min="1" className={field} value={form.total_installments} onChange={(e) => set('total_installments', Number(e.target.value))} /></label>
          <label className="text-[13px] font-medium">{t('loans.form.rate')}<input type="number" step="0.01" min="0" className={field} placeholder={t('loans.form.ratePlaceholder')} value={form.monthly_rate != null ? +(form.monthly_rate * 100).toFixed(4) : ''} onChange={(e) => set('monthly_rate', e.target.value === '' ? null : Number(e.target.value) / 100)} /></label>
          <label className="text-[13px] font-medium">{t('loans.contractDate')}<input required type="date" className={field} value={form.contract_date} onChange={(e) => set('contract_date', e.target.value)} /></label>
          <label className="text-[13px] font-medium">{t('loans.firstInstallment')}<input required type="date" className={field} value={form.first_installment_date} onChange={(e) => set('first_installment_date', e.target.value)} /></label>
          <p className="col-span-2 text-xs leading-relaxed text-muted-foreground">{t('loans.form.hint')}</p>
          <DialogFooter className="col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={save.isPending}>{t('loans.form.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
