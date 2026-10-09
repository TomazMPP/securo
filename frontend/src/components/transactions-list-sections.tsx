import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock } from 'lucide-react'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Category } from '@/types'

const POSITIVE = 'text-[#0B7A41] dark:text-emerald-400'
const NEGATIVE = 'text-[#B42323] dark:text-rose-400'

/** Signed money: "+R$ 12,40", "−R$ 486,73", or plain zero. */
function signedMoney(value: number, currency: string, locale: string): string {
  const sign = value > 0.004 ? '+' : value < -0.004 ? '−' : ''
  return `${sign}${formatCurrency(Math.abs(value), currency, locale)}`
}

function netTone(value: number): string {
  if (value > 0.004) return POSITIVE
  if (value < -0.004) return NEGATIVE
  return 'text-muted-foreground'
}

type MoneyProps = {
  currency: string
  locale: string
  mask: (value: string) => string
}

/** Uppercase day label on the left, that day's net on the right. */
export function TransactionDayHeader({
  label,
  net,
  currency,
  locale,
  mask,
  className,
}: MoneyProps & { label: string; net: number; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-3 px-4 pb-2 pt-4 text-xs font-bold uppercase tracking-[0.04em] text-muted-foreground md:px-5',
        className,
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className={cn('shrink-0 font-semibold normal-case tracking-normal tabular-nums', netTone(net))}>
        {mask(signedMoney(net, currency, locale))}
      </span>
    </div>
  )
}

/** Warm header over rows the bank has not settled yet. */
export function PendingSectionHeader({
  count,
  net,
  currency,
  locale,
  mask,
}: MoneyProps & { count: number; net: number }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 pb-2 pt-4 text-xs font-bold uppercase tracking-[0.04em] text-[#8A5A0B] dark:text-amber-300 md:px-5">
      <span className="inline-flex items-center gap-1.5">
        <Clock size={13} aria-hidden="true" />
        {t('transactions.pendingSection.title', { count })}
      </span>
      <span className="font-medium normal-case tracking-normal tabular-nums">
        {t('transactions.pendingSection.included', { amount: mask(formatCurrency(Math.abs(net), currency, locale)) })}
      </span>
    </div>
  )
}

/** Category name in a pill tinted with the category's own colour. */
export function CategoryPill({ category, emptyLabel }: { category: Pick<Category, 'name' | 'color'> | null | undefined; emptyLabel: string }) {
  if (!category) {
    return (
      <span className="inline-flex max-w-full items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium italic text-muted-foreground">
        <span className="truncate">{emptyLabel}</span>
      </span>
    )
  }
  const color = category.color || '#6B7280'
  return (
    <span
      className="inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
        color: `color-mix(in srgb, ${color} 72%, var(--foreground))`,
      }}
    >
      <span className="truncate">{category.name}</span>
    </span>
  )
}

/** "128 transactions · Income R$ … · Expenses R$ …" for the active filters. */
export function TransactionsSummaryLine({
  count,
  income,
  expense,
  net,
  excluded,
  currency,
  locale,
  mask,
  extra,
}: MoneyProps & {
  count: number
  income: number
  expense: number
  net: number
  excluded: number
  extra?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px] text-muted-foreground">
      <span>
        <b className="font-bold tabular-nums text-foreground">{count}</b>{' '}
        {t('transactions.summaryCountNoun', { count })}
      </span>
      <span className="sm:ml-auto">
        {t('transactions.summaryInflows')}{' '}
        <b className={cn('font-bold tabular-nums', POSITIVE)}>{mask(formatCurrency(income, currency, locale))}</b>
      </span>
      <span>
        {t('transactions.summaryOutflows')}{' '}
        <b className={cn('font-bold tabular-nums', NEGATIVE)}>{mask(formatCurrency(expense, currency, locale))}</b>
      </span>
      <span>
        {t('transactions.summaryNet')}{' '}
        <b className={cn('font-bold tabular-nums', netTone(net))}>{mask(signedMoney(net, currency, locale))}</b>
      </span>
      {excluded > 0 && (
        <span title={t('transactions.summaryExcludedHint')}>
          {t('transactions.summaryExcluded')}{' '}
          <b className="font-semibold tabular-nums text-muted-foreground">{mask(formatCurrency(excluded, currency, locale))}</b>
        </span>
      )}
      {extra}
    </div>
  )
}
