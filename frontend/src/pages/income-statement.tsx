import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { incomeStatement } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/page-header'
import { CategoryIcon } from '@/components/category-icon'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { useAuth } from '@/contexts/auth-context'
import { localDateString } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import type { IncomeStatement, IncomeStatementAmount, IncomeStatementSection } from '@/types'

type RangeKey = 'last6' | 'last12' | 'thisYear' | 'lastYear'
const RANGES: RangeKey[] = ['last6', 'last12', 'thisYear', 'lastYear']

function rangeFor(key: RangeKey): { start: string; end: string } {
  const today = new Date()
  const y = today.getFullYear()
  const m = today.getMonth()
  switch (key) {
    case 'last6':
      return { start: localDateString(new Date(y, m - 5, 1)), end: localDateString(today) }
    case 'last12':
      return { start: localDateString(new Date(y, m - 11, 1)), end: localDateString(today) }
    case 'thisYear':
      return { start: `${y}-01-01`, end: localDateString(today) }
    case 'lastYear':
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` }
  }
}

function formatMoney(value: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function formatMonth(ym: string, locale: string) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(locale, { month: 'short', year: '2-digit' })
}

// The statement, top to bottom: a section adds its signed amount, a
// subtotal restates the running result. `owners` is rendered apart, below.
type Row =
  | { kind: 'section'; key: IncomeStatementSection['key'] }
  | { kind: 'subtotal'; key: keyof IncomeStatement['subtotals'] }

const STATEMENT: Row[] = [
  { kind: 'section', key: 'revenue' },
  { kind: 'section', key: 'deductions' },
  { kind: 'subtotal', key: 'net_revenue' },
  { kind: 'section', key: 'costs' },
  { kind: 'subtotal', key: 'gross_profit' },
  { kind: 'section', key: 'operating_expenses' },
  { kind: 'subtotal', key: 'operating_result' },
  { kind: 'section', key: 'financial' },
  { kind: 'section', key: 'unclassified' },
  { kind: 'subtotal', key: 'net_income' },
]

export default function IncomeStatementPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { mask } = usePrivacyMode()
  const locale = useDisplayLocale()
  const [rangeKey, setRangeKey] = useState<RangeKey>('last6')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const range = rangeFor(rangeKey)

  const { data, isLoading } = useQuery<IncomeStatement>({
    queryKey: ['income-statement', range.start, range.end],
    queryFn: () => incomeStatement.get(range.start, range.end),
  })

  const currency = data?.currency ?? user?.preferences?.currency_display ?? 'BRL'
  const money = (v: number) => mask(formatMoney(v, currency, locale))
  const pct = (v: number | null) =>
    v == null ? '—' : mask(new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(v))
  const section = (key: string) => data?.sections.find((s) => s.key === key)

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const amountCells = (amount: IncomeStatementAmount, className?: string) => (
    <>
      {amount.months.map((v, i) => (
        <td key={i} className={cn('px-3 py-2 text-right tabular-nums whitespace-nowrap', className, v < 0 && 'text-rose-600 dark:text-rose-400')}>
          {v ? money(v) : '—'}
        </td>
      ))}
      <td className={cn('px-3 py-2 text-right tabular-nums whitespace-nowrap font-medium', className, amount.total < 0 && 'text-rose-600 dark:text-rose-400')}>
        {money(amount.total)}
      </td>
    </>
  )

  const sectionRows = (s: IncomeStatementSection) => {
    const open = expanded.has(s.key)
    const canOpen = s.lines.length > 0
    const warn = s.key === 'unclassified'
    return (
      <Fragment key={s.key}>
        <tr className={cn('border-t border-border', warn && 'bg-amber-500/5')}>
          <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-normal">
            <button
              type="button"
              onClick={() => canOpen && toggle(s.key)}
              className={cn('flex items-center gap-1.5 text-left', !canOpen && 'cursor-default')}
              aria-expanded={canOpen ? open : undefined}
            >
              {canOpen ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="w-3.5" />}
              {warn && <AlertTriangle size={14} className="text-amber-500" />}
              <span>{t(`incomeStatement.section.${s.key}`)}</span>
            </button>
          </th>
          {amountCells(s)}
        </tr>
        {open &&
          s.lines.map((line) => (
            <tr key={`${s.key}-${line.category_id ?? 'none'}`} className="text-muted-foreground">
              <th scope="row" className="sticky left-0 z-10 bg-card py-1.5 pl-9 pr-3 text-left font-normal">
                <span className="flex items-center gap-2">
                  <CategoryIcon icon={line.icon} color={line.color} size="xs" />
                  <span className="truncate">{line.name ?? t('incomeStatement.uncategorized')}</span>
                </span>
              </th>
              {amountCells(line, 'py-1.5 text-xs')}
            </tr>
          ))}
      </Fragment>
    )
  }

  const unclassified = section('unclassified')
  const owners = section('owners')
  const revenue = section('revenue')
  const netIncome = data?.subtotals.net_income

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <PageHeader section={t('nav.groupStrategy')} title={t('incomeStatement.title')} />
      <p className="text-sm text-muted-foreground -mt-2 mb-4">{t('incomeStatement.subtitle')}</p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {RANGES.map((key) => (
          <button
            key={key}
            onClick={() => setRangeKey(key)}
            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
              rangeKey === key
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-muted-foreground border-border hover:text-foreground'
            }`}
          >
            {t(`incomeStatement.range.${key}`)}
          </button>
        ))}
      </div>

      {isLoading || !data ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            {[
              { label: t('incomeStatement.section.revenue'), value: money(revenue?.total ?? 0) },
              {
                label: t('incomeStatement.subtotal.net_income'),
                value: money(netIncome?.total ?? 0),
                negative: (netIncome?.total ?? 0) < 0,
              },
              { label: t('incomeStatement.margin'), value: pct(data.margin) },
            ].map((kpi) => (
              <div key={kpi.label} className="rounded-xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">{kpi.label}</p>
                <p className={cn('text-2xl font-semibold tabular-nums mt-1', kpi.negative && 'text-rose-600 dark:text-rose-400')}>
                  {kpi.value}
                </p>
              </div>
            ))}
          </div>

          {unclassified && unclassified.total !== 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 mb-4 text-sm">
              <AlertTriangle size={16} className="text-amber-500 mt-0.5 shrink-0" />
              <p>
                {t('incomeStatement.unclassifiedHint', { amount: money(unclassified.total) })}{' '}
                <Link to="/categories" className="underline underline-offset-2">
                  {t('incomeStatement.unclassifiedLink')}
                </Link>
              </p>
            </div>
          )}

          <div className="rounded-xl border border-border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium min-w-48">
                    <span className="sr-only">{t('incomeStatement.title')}</span>
                  </th>
                  {data.months.map((m) => (
                    <th key={m} scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap capitalize">
                      {formatMonth(m, locale)}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-right font-medium">{t('incomeStatement.total')}</th>
                </tr>
              </thead>
              <tbody>
                {STATEMENT.map((row) => {
                  if (row.kind === 'section') {
                    const s = section(row.key)
                    if (!s || (row.key === 'unclassified' && s.total === 0 && s.lines.length === 0)) return null
                    return sectionRows(s)
                  }
                  const amount = data.subtotals[row.key]
                  const isBottom = row.key === 'net_income'
                  return (
                    <tr key={row.key} className={cn('border-t border-border font-semibold', isBottom ? 'bg-muted/60 border-t-2' : 'bg-muted/30')}>
                      <th scope="row" className={cn('sticky left-0 z-10 px-3 py-2 text-left', isBottom ? 'bg-muted' : 'bg-muted/80')}>
                        = {t(`incomeStatement.subtotal.${row.key}`)}
                      </th>
                      {amountCells(amount)}
                    </tr>
                  )
                })}
                <tr className="text-xs text-muted-foreground">
                  <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-normal">
                    {t('incomeStatement.margin')}
                  </th>
                  {data.margins.map((m, i) => (
                    <td key={i} className="px-3 py-2 text-right tabular-nums">{pct(m)}</td>
                  ))}
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{pct(data.margin)}</td>
                </tr>
                {owners && (owners.total !== 0 || owners.lines.length > 0) && (
                  <>
                    <tr>
                      <td colSpan={data.months.length + 2} className="px-3 pt-5 pb-1 text-xs text-muted-foreground">
                        {t('incomeStatement.ownersCaption')}
                      </td>
                    </tr>
                    {sectionRows(owners)}
                  </>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-3">{t('incomeStatement.footnote')}</p>
        </>
      )}
    </div>
  )
}
