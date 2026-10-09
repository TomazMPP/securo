import { Trans, useTranslation } from 'react-i18next'
import type { CommitmentItem, CommitmentTotals } from '@/lib/recurring-overview'

/**
 * "Left to pay this cycle": what is still due this month, how far along the
 * month is, and a sentence naming how many charges remain and the biggest.
 */
export function RecurringHeroCard({
  kind,
  items,
  totals,
  monthEnd,
  formatMoney,
  dateLocale,
}: {
  kind: 'debit' | 'credit'
  items: CommitmentItem[]
  totals: CommitmentTotals
  /** `YYYY-MM-DD`, last day of the month shown. */
  monthEnd: string
  formatMoney: (value: number) => string
  dateLocale: string
}) {
  const { t } = useTranslation()
  const pending = items.filter((item) => !item.paid)
  const biggest = pending.reduce<CommitmentItem | null>((max, item) => (!max || item.amount > max.amount ? item : max), null)
  const paidPct = totals.total > 0 ? (totals.paid / totals.total) * 100 : 0
  const endLabel = new Date(`${monthEnd}T00:00:00`).toLocaleDateString(dateLocale, { day: 'numeric', month: 'long' })
  const income = kind === 'credit'

  let sentence: React.ReactNode
  if (totals.total === 0) {
    sentence = t('recurring.heroNothing')
  } else if (!biggest) {
    sentence = t(income ? 'recurring.heroAllReceived' : 'recurring.heroAllPaid')
  } else {
    sentence = (
      <Trans
        i18nKey={income ? 'recurring.heroPendingIncome' : 'recurring.heroPending'}
        count={pending.length}
        values={{
          date: endLabel,
          name: biggest.description,
          day: Number(biggest.date.slice(8, 10)),
        }}
        components={{ b: <b className="font-semibold" /> }}
      />
    )
  }

  return (
    <section className="flex flex-col rounded-[20px] bg-primary p-1" aria-labelledby="recurring-hero-label">
      <div className="rounded-2xl bg-card p-5 sm:p-6">
        <h2 id="recurring-hero-label" className="text-sm font-medium text-muted-foreground">
          {t(income ? 'recurring.heroLabelIncome' : 'recurring.heroLabel')}
        </h2>
        <p className="mt-1.5 text-[32px] font-bold leading-tight tracking-tight tabular-nums text-foreground sm:text-[38px]">
          {formatMoney(totals.remaining)}
        </p>
        <div
          className="mt-4 h-2.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(paidPct)}
          aria-label={t(income ? 'recurring.alreadyReceived' : 'recurring.alreadyPaid', { amount: formatMoney(totals.paid) })}
        >
          <span className="block h-full rounded-full bg-primary" style={{ width: `${paidPct}%` }} />
        </div>
        <div className="mt-1.5 flex flex-wrap justify-between gap-x-4 text-[13px] text-muted-foreground tabular-nums">
          <span>{t(income ? 'recurring.alreadyReceived' : 'recurring.alreadyPaid', { amount: formatMoney(totals.paid) })}</span>
          <span>{t('recurring.ofTotal', { amount: formatMoney(totals.total) })}</span>
        </div>
      </div>
      <p className="m-0 px-5 pb-4 pt-4 text-sm leading-relaxed text-primary-foreground">{sentence}</p>
    </section>
  )
}
