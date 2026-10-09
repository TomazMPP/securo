import { useTranslation } from 'react-i18next'
import { CategoryIcon } from '@/components/category-icon'
import { getAccountName } from '@/lib/account-utils'
import { groupBy, type CommitmentItem } from '@/lib/recurring-overview'
import { cn } from '@/lib/utils'
import type { Account } from '@/types'
import { POSITIVE_TEXT, SERIES_COLOR, WARNING_TEXT } from './series'
import { ProgressRing, SectionCard } from './recurring-ui'

function dayHeader(date: string, dateLocale: string): string {
  const label = new Date(`${date}T00:00:00`).toLocaleDateString(dateLocale, { weekday: 'short', day: 'numeric', month: 'short' })
  return label.replace(/\./g, '')
}

function GroupHeader({ children }: { children: React.ReactNode }) {
  return <h3 className="m-0 pb-1.5 pt-4 text-xs font-bold uppercase tracking-wide text-muted-foreground">{children}</h3>
}

function ItemRow({
  item,
  sub,
  right,
  onOpen,
  openLabel,
}: {
  item: CommitmentItem
  sub: string
  right: React.ReactNode
  onOpen?: () => void
  openLabel?: string
}) {
  const body = (
    <>
      <CategoryIcon icon={item.categoryIcon} color={item.categoryColor ?? (item.kind === 'financing' ? SERIES_COLOR.financing : null)} size="lg" />
      <div className="min-w-0 flex-1 text-left">
        <p className="truncate text-[14.5px] font-semibold text-foreground">{item.description}</p>
        {sub && <p className="truncate text-[12.5px] text-muted-foreground">{sub}</p>}
      </div>
      <div className="shrink-0 text-right">{right}</div>
    </>
  )
  return (
    <li className="border-b border-border/60 last:border-0">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel}
          className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/60"
        >
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-3 py-2.5">{body}</div>
      )}
    </li>
  )
}

/**
 * The month's schedule in two columns: fixed bills (paid / to pay) and
 * installments (n/total with a completion ring), each grouped by date — card
 * installments are grouped by the card's bill instead.
 */
export function RecurringScheduleCard({
  kind,
  items,
  accounts,
  today,
  month,
  dateLocale,
  formatMoney,
  onOpenRule,
}: {
  kind: 'debit' | 'credit'
  items: CommitmentItem[]
  accounts: Account[]
  today: string
  month: string
  dateLocale: string
  formatMoney: (value: number) => string
  /** Opens the rule behind a fixed bill; omitted when the viewer cannot edit. */
  onOpenRule?: (recurringId: string) => void
}) {
  const { t } = useTranslation()
  const accountById = new Map(accounts.map((a) => [a.id, a]))
  const accountLabel = (id: string | null) => {
    const account = id ? accountById.get(id) : undefined
    return account ? getAccountName(account) : null
  }
  const fixed = items.filter((i) => i.kind === 'fixed')
  const parcels = items.filter((i) => i.kind !== 'fixed')

  const fixedGroups = groupBy(fixed, (i) => i.date)
  const parcelGroups = groupBy(parcels, (i) => {
    const account = i.accountId ? accountById.get(i.accountId) : undefined
    return account?.type === 'credit_card' ? `card:${account.id}` : `date:${i.date}`
  })

  const parcelHeader = (key: string, first: CommitmentItem) => {
    if (!key.startsWith('card:')) return dayHeader(first.date, dateLocale)
    const account = accountById.get(key.slice(5))!
    const name = getAccountName(account)
    if (account.next_due_date?.startsWith(month)) {
      const due = new Date(`${account.next_due_date}T00:00:00`).toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' }).replace(/\./g, '')
      return t('recurring.cardBillDue', { name, date: due })
    }
    return t('recurring.cardBill', { name })
  }

  const statusOf = (item: CommitmentItem) => {
    if (item.paid) return { label: t(kind === 'credit' ? 'recurring.statusReceived' : 'recurring.statusPaid'), cls: POSITIVE_TEXT }
    if (item.date < today) return { label: t('recurring.statusOverdue'), cls: WARNING_TEXT }
    return { label: t(kind === 'credit' ? 'recurring.statusToReceive' : 'recurring.statusToPay'), cls: 'text-muted-foreground' }
  }

  return (
    <SectionCard className="grid grid-cols-1 gap-7 lg:grid-cols-2">
      <div className="min-w-0">
        <h2 className="m-0 text-base font-bold text-foreground">
          {t('recurring.fixedBills')} <span className="font-medium text-muted-foreground">({fixed.length})</span>
        </h2>
        {fixedGroups.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t('recurring.fixedEmpty')}</p>
        ) : (
          fixedGroups.map((group) => (
            <div key={group.key}>
              <GroupHeader>{dayHeader(group.key, dateLocale)}</GroupHeader>
              <ul className="m-0 list-none p-0">
                {group.items.map((item) => {
                  const status = statusOf(item)
                  const sub = [item.categoryName, accountLabel(item.accountId)].filter(Boolean).join(' · ')
                  return (
                    <ItemRow
                      key={item.key}
                      item={item}
                      sub={sub}
                      onOpen={onOpenRule && item.recurringId ? () => onOpenRule(item.recurringId!) : undefined}
                      openLabel={`${t('common.edit')}: ${item.description}`}
                      right={
                        <>
                          <p className="text-[14.5px] font-semibold tabular-nums text-foreground">{formatMoney(item.amount)}</p>
                          <p className={cn('text-xs font-semibold', status.cls)}>{status.label}</p>
                        </>
                      }
                    />
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      <div className="min-w-0">
        <h2 className="m-0 text-base font-bold text-foreground">
          {t('recurring.installments')} <span className="font-medium text-muted-foreground">({parcels.length})</span>
        </h2>
        {parcelGroups.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t('recurring.installmentsEmpty')}</p>
        ) : (
          parcelGroups.map((group) => (
            <div key={group.key}>
              <GroupHeader>{parcelHeader(group.key, group.items[0])}</GroupHeader>
              <ul className="m-0 list-none p-0">
                {group.items.map((item) => {
                  const hasFraction = item.installmentNumber != null && item.totalInstallments != null
                  const complete = hasFraction && item.installmentNumber === item.totalInstallments
                  const sub = item.kind === 'financing'
                    ? [t('recurring.financing'), item.categoryName].filter(Boolean).join(' · ')
                    : item.categoryName ?? ''
                  return (
                    <ItemRow
                      key={item.key}
                      item={item}
                      sub={sub}
                      right={
                        <>
                          <p className="text-[14.5px] font-semibold tabular-nums text-foreground">{formatMoney(item.amount)}</p>
                          {hasFraction && (
                            <div
                              className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground"
                              title={t('recurring.installmentOf', { n: item.installmentNumber, total: item.totalInstallments })}
                            >
                              <span className="tabular-nums">{item.installmentNumber}/{item.totalInstallments}</span>
                              <ProgressRing
                                value={item.installmentNumber!}
                                total={item.totalInstallments!}
                                color={complete ? '#0F8A4B' : SERIES_COLOR[item.kind]}
                              />
                            </div>
                          )}
                        </>
                      }
                    />
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </SectionCard>
  )
}
