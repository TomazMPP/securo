import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { CalendarCheck } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { DashboardCard, CardHeading, CardEmpty } from '@/components/dashboard/dashboard-card'
import { formatCurrency } from '@/lib/format'
import { parseIsoDate, type UpcomingItem } from '@/lib/dashboard-insights'

const MAX_ROWS = 5

/** What is coming due in the next weeks, soonest first, with a date badge. */
export function UpcomingBillsCard({
  loading,
  items,
  primaryCurrency,
  accountNames,
  locale,
  uiLocale,
  mask,
  linkTo,
}: {
  loading: boolean
  items: UpcomingItem[]
  primaryCurrency: string
  accountNames: Map<string, string>
  locale: string
  uiLocale: string
  mask: (value: string) => string
  linkTo?: string
}) {
  const { t } = useTranslation()
  const shown = items.slice(0, MAX_ROWS)
  const hidden = items.length - shown.length
  // Only sum what shares the primary currency; a foreign-currency row without
  // a conversion would otherwise be added at face value.
  const total = items.filter((i) => i.currency === primaryCurrency).reduce((s, i) => s + i.amount, 0)
  const lastDate = items.length > 0 ? items[items.length - 1].date : null

  const metaFor = (item: UpcomingItem) => {
    const parts: string[] = []
    if (item.kind === 'card_bill') parts.push(t('dashboard.upcomingCardBill'))
    else if (item.installment) parts.push(t('dashboard.upcomingInstallment', { number: item.installment.number, total: item.installment.total }))
    else if (item.kind === 'recurring') parts.push(t('dashboard.upcomingRecurring'))
    else parts.push(t('dashboard.upcomingScheduled'))
    if (item.kind !== 'card_bill') {
      if (item.categoryName) parts.push(item.categoryName)
      else if (item.accountId && accountNames.get(item.accountId)) parts.push(accountNames.get(item.accountId)!)
    }
    return parts.join(' · ')
  }

  return (
    <DashboardCard labelledBy="dash-upcoming-title">
      <CardHeading id="dash-upcoming-title" title={t('dashboard.upcomingTitle')} to={linkTo} linkLabel={t('dashboard.openRecurring')} />
      {loading ? (
        <div className="mt-3 space-y-3">
          <Skeleton className="h-4 w-40" />
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
        </div>
      ) : items.length === 0 ? (
        <CardEmpty icon={<CalendarCheck className="size-7" />}>{t('dashboard.upcomingEmpty')}</CardEmpty>
      ) : (
        <>
          <p className="mt-1 text-[13.5px]">
            <b className="tabular-nums text-foreground">{mask(formatCurrency(total, primaryCurrency, locale))}</b>{' '}
            <span className="text-muted-foreground">
              {t('dashboard.upcomingUntil', {
                date: parseIsoDate(lastDate!).toLocaleDateString(uiLocale, { day: 'numeric', month: 'long' }),
              })}
            </span>
          </p>
          <ul className="m-0 mt-2.5 list-none p-0">
            {shown.map((item) => {
              const d = parseIsoDate(item.date)
              const mon = d.toLocaleDateString(uiLocale, { month: 'short' }).replace('.', '').toUpperCase()
              return (
                <li key={item.key} className="flex items-center gap-3 border-b border-border/70 py-2.5 last:border-b-0">
                  <div className="w-10 shrink-0 text-center" aria-hidden="true">
                    <div className="text-[11px] font-semibold text-muted-foreground">{mon}</div>
                    <div className="text-[17px] font-bold leading-tight tabular-nums text-foreground">{d.getDate()}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {item.kind === 'card_bill' ? t('dashboard.upcomingCardBillName', { card: item.description }) : item.description}
                    </div>
                    <div className="truncate text-[12.5px] text-muted-foreground">
                      <span className="sr-only">{d.toLocaleDateString(uiLocale)} · </span>
                      {metaFor(item)}
                    </div>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                    {mask(formatCurrency(item.amount, item.currency, locale))}
                  </span>
                </li>
              )
            })}
          </ul>
          {hidden > 0 && linkTo && (
            <Link to={linkTo} className="mt-2 text-xs font-medium text-primary hover:underline">
              {t('dashboard.upcomingMore', { count: hidden })}
            </Link>
          )}
        </>
      )}
    </DashboardCard>
  )
}
