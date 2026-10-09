import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { CreditCard } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { AccountIcon } from '@/components/account-icon'
import { DashboardCard, CardHeading, CardEmpty, ProgressBar } from '@/components/dashboard/dashboard-card'
import { getAccountName, sumAccountBalances } from '@/lib/account-utils'
import { formatCurrency } from '@/lib/format'
import { cardOwed, daysUntil, formatWholeCurrency, parseIsoDate } from '@/lib/dashboard-insights'
import type { Account } from '@/types'

const MAX_ROWS = 4

/**
 * Credit cards: the total still owed, then one row per card with how much of
 * its limit is in use and when the statement closes and is due.
 */
export function OpenBillsCard({
  loading,
  cards,
  primaryCurrency,
  locale,
  uiLocale,
  mask,
  linkTo,
}: {
  loading: boolean
  cards: Account[]
  primaryCurrency: string
  locale: string
  uiLocale: string
  mask: (value: string) => string
  linkTo?: string
}) {
  const { t } = useTranslation()

  // A shared credit line is reported in full by every card on it, so the
  // headline counts each line once (same rule as the net-worth total).
  const total = Math.max(0, -sumAccountBalances(cards))
  const rows = [...cards]
    .map((card) => ({ card, owed: cardOwed(card) }))
    .sort((a, b) => b.owed - a.owed)
  const shown = rows.slice(0, MAX_ROWS)
  const hidden = rows.length - shown.length

  const shortDate = (iso: string) =>
    parseIsoDate(iso).toLocaleDateString(uiLocale, { day: 'numeric', month: 'short' }).replace('.', '')

  return (
    <DashboardCard labelledBy="dash-bills-title">
      <CardHeading id="dash-bills-title" title={t('dashboard.openBillsTitle')} to={linkTo} linkLabel={t('dashboard.openCards')} />
      {loading ? (
        <>
          <Skeleton className="mt-2 h-9 w-36" />
          <div className="mt-4 space-y-4">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        </>
      ) : cards.length === 0 ? (
        <CardEmpty
          icon={<CreditCard className="size-7" />}
          action={linkTo && (
            <Link to={linkTo} className="text-sm font-semibold text-primary hover:underline">
              {t('dashboard.openBillsAddCard')}
            </Link>
          )}
        >
          {t('dashboard.openBillsEmpty')}
        </CardEmpty>
      ) : (
        <>
          <div className="mt-1 text-[30px] font-bold leading-tight tracking-[-0.02em] tabular-nums text-foreground">
            {mask(formatWholeCurrency(total, primaryCurrency, locale))}
          </div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {total < 0.01
              ? t('dashboard.openBillsNothingOwed')
              : t('dashboard.openBillsAcross', { count: rows.filter((r) => r.owed >= 0.01).length })}
          </p>
          <div className="my-3.5 h-px bg-border/70" />
          <ul className="m-0 list-none space-y-1 p-0">
            {shown.map(({ card, owed }) => {
              const limit = card.credit_limit != null ? Number(card.credit_limit) : null
              const usage = limit && limit > 0 ? (owed / limit) * 100 : null
              const closeIn = card.next_close_date ? daysUntil(card.next_close_date) : null
              const currency = card.balance_primary != null ? primaryCurrency : card.currency
              const meta: string[] = []
              if (closeIn != null) {
                meta.push(closeIn <= 0 ? t('dashboard.cardClosesToday') : t('dashboard.cardClosesIn', { count: closeIn }))
              }
              if (card.next_due_date) meta.push(t('dashboard.cardDue', { date: shortDate(card.next_due_date) }))
              if (limit) meta.push(t('dashboard.cardLimit', { amount: mask(formatWholeCurrency(limit, card.currency, locale)) }))
              return (
                <li key={card.id}>
                  <Link
                    to={`/accounts/${card.id}`}
                    className="block rounded-lg pt-1.5 pb-2.5 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <AccountIcon account={card} size="md" className="w-7 h-7 rounded-lg" />
                      <span className="flex-1 truncate text-sm font-semibold text-foreground">{getAccountName(card)}</span>
                      <span className="text-sm font-semibold tabular-nums text-foreground">
                        {mask(formatCurrency(owed, currency, locale))}
                      </span>
                    </div>
                    {usage != null && (
                      <ProgressBar
                        value={usage}
                        label={t('dashboard.cardLimitUsed', { pct: Math.round(usage) })}
                        className="mt-2 mb-1 ml-[38px]"
                        barClassName={usage >= 90 ? 'bg-[#B42323] dark:bg-rose-400' : usage >= 70 ? 'bg-[#E08A1E]' : 'bg-primary'}
                      />
                    )}
                    {meta.length > 0 && (
                      <div className="ml-[38px] mt-1 text-xs text-muted-foreground">{meta.join(' · ')}</div>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
          {hidden > 0 && linkTo && (
            <Link to={linkTo} className="mt-1 text-xs font-medium text-primary hover:underline">
              {t('dashboard.moreCards', { count: hidden })}
            </Link>
          )}
        </>
      )}
    </DashboardCard>
  )
}
