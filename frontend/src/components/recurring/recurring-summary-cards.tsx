import { useTranslation } from 'react-i18next'
import { AccountIcon } from '@/components/account-icon'
import { getAccountName } from '@/lib/account-utils'
import type { CommitmentItem, CommitmentTotals } from '@/lib/recurring-overview'
import type { Account } from '@/types'
import { SERIES_COLOR } from './series'
import { MeterBar, SectionCard, Swatch } from './recurring-ui'

/** Share of income above which little is left for the unexpected. */
const HIGH_SHARE = 50
const MODERATE_SHARE = 30

export function RecurringMonthSummary({
  title,
  kind,
  totals,
  hasLoans,
  averageIncome,
  formatMoney,
}: {
  title: string
  kind: 'debit' | 'credit'
  totals: CommitmentTotals
  hasLoans: boolean
  averageIncome: number | null
  formatMoney: (value: number) => string
}) {
  const { t } = useTranslation()
  const share = averageIncome && totals.total > 0 ? Math.round((totals.total / averageIncome) * 100) : null
  const shareColor = share == null ? '' : share > HIGH_SHARE ? SERIES_COLOR.installment : share > MODERATE_SHARE ? 'var(--primary)' : '#0B7A41'
  const shareMeaning =
    share == null ? '' : share > HIGH_SHARE ? t('recurring.shareHigh') : share > MODERATE_SHARE ? t('recurring.shareModerate') : t('recurring.shareLow')

  const rows = [
    { kind: 'fixed' as const, label: t('recurring.fixedBills'), value: totals.fixed },
    { kind: 'installment' as const, label: t('recurring.installments'), value: totals.installments },
    ...(hasLoans ? [{ kind: 'financing' as const, label: t('recurring.financing'), value: totals.financing }] : []),
  ]

  return (
    <SectionCard>
      <h2 className="m-0 text-base font-bold text-foreground">{title.charAt(0).toUpperCase() + title.slice(1)}</h2>
      <div className="mt-4 flex flex-col gap-3 text-sm">
        {rows.map((row) => (
          <div key={row.kind} className="flex items-center gap-2.5">
            <Swatch kind={row.kind} />
            <span className="text-foreground">{row.label}</span>
            <span className="ml-auto font-semibold tabular-nums text-foreground">{formatMoney(row.value)}</span>
          </div>
        ))}
      </div>
      <div className="my-4 h-px bg-border" />
      <div className="flex items-center text-[15px] font-bold text-foreground">
        {t(kind === 'credit' ? 'recurring.totalExpected' : 'recurring.totalCommitted')}
        <span className="ml-auto tabular-nums">{formatMoney(totals.total)}</span>
      </div>
      {share != null && averageIncome != null && (
        <div className="mt-3.5 rounded-xl bg-muted/60 p-3.5">
          <div className="flex items-center justify-between text-[13.5px]">
            <span className="text-foreground/80">{t('recurring.ofIncome')}</span>
            <b className="tabular-nums text-foreground">{share}%</b>
          </div>
          <MeterBar value={share} color={shareColor} className="mt-2" />
          <p className="mt-2 text-[12.5px] leading-snug text-muted-foreground">
            {shareMeaning} {t('recurring.incomeBasis', { amount: formatMoney(averageIncome) })}
          </p>
        </div>
      )}
    </SectionCard>
  )
}

/** Commitments of the month split by the account they leave from. */
export function RecurringByAccount({
  items,
  accounts,
  formatMoney,
}: {
  items: CommitmentItem[]
  accounts: Account[]
  formatMoney: (value: number) => string
}) {
  const { t } = useTranslation()
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const sums = new Map<string, number>()
  for (const item of items) {
    if (!item.accountId) continue
    sums.set(item.accountId, (sums.get(item.accountId) ?? 0) + item.amount)
  }
  const rows = [...sums.entries()]
    .map(([id, amount]) => ({ id, amount, account: byId.get(id) }))
    .sort((a, b) => b.amount - a.amount)
  const max = rows[0]?.amount ?? 0

  return (
    <SectionCard>
      <h2 className="m-0 text-base font-bold text-foreground">{t('recurring.byAccount')}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('recurring.byAccountEmpty')}</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3.5">
          {rows.map((row) => (
            <li key={row.id}>
              <div className="flex items-center gap-2.5 text-sm">
                {row.account ? <AccountIcon account={row.account} size="sm" /> : <span className="size-6 rounded-md bg-muted" />}
                <span className="min-w-0 truncate font-medium text-foreground">
                  {row.account ? getAccountName(row.account) : t('recurring.unknownAccount')}
                </span>
                <span className="ml-auto shrink-0 font-semibold tabular-nums text-foreground">{formatMoney(row.amount)}</span>
              </div>
              <MeterBar value={max > 0 ? (row.amount / max) * 100 : 0} color="var(--primary)" className="ml-[34px] mt-2 h-1.5" />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
