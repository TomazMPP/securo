import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Sparkles, X } from 'lucide-react'
import { recurring as recurringApi } from '@/lib/api'
import type { RecurringSuggestion } from '@/types'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

const DISMISSED_KEY = 'securo.recurring.dismissedSuggestions'

function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

interface Props {
  canWrite: boolean
  formatMoney: (value: number, currency?: string) => string
  onCreated: () => void
}

/**
 * Bills found in the history that repeat every month but aren't registered:
 * one click turns each into a recurring bill that waits for the real charge
 * (no placeholder transaction), so it shows up in the schedule and forecast.
 */
export function RecurringSuggestionsCard({ canWrite, formatMoney, onCreated }: Props) {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState<string[]>(readDismissed)
  const { data } = useQuery({ queryKey: ['recurring', 'suggestions'], queryFn: recurringApi.suggestions })
  const create = useMutation({
    mutationFn: (s: RecurringSuggestion) =>
      recurringApi.create({
        description: s.payee_name ?? s.description,
        amount: s.amount,
        currency: s.currency,
        type: s.type,
        frequency: 'monthly',
        day_of_month: s.day_of_month,
        start_date: s.last_date,
        account_id: s.account_id,
        category_id: s.category_id,
        auto_generate: false,
        // The last payment already happened: start from the next one.
        skip_first: true,
      } as never),
    onSuccess: (_, s) => {
      toast.success(t('recurring.suggestionAdded', { name: s.payee_name ?? s.description }))
      onCreated()
    },
    onError: () => toast.error(t('common.error')),
  })

  const dismiss = (key: string) => {
    const next = [...dismissed, key]
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      // private mode: dismissal lasts for this visit only
    }
  }

  const visible = (data ?? []).filter((s) => !dismissed.includes(s.key))
  if (visible.length === 0) return null

  return (
    <Card className="mb-5 gap-0 border-primary/30 p-0">
      <div className="flex items-start gap-3 px-5 pt-5 pb-3 sm:px-6">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground"><Sparkles size={18} /></span>
        <div>
          <h2 className="text-base font-bold">{t('recurring.suggestionsTitle', { count: visible.length })}</h2>
          <p className="text-[13.5px] text-muted-foreground">{t('recurring.suggestionsBody')}</p>
        </div>
      </div>
      <ul>
        {visible.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center gap-3 border-t px-5 py-3 sm:px-6">
            <div className="min-w-[12rem] flex-1">
              <div className="truncate text-sm font-semibold">{s.payee_name ?? s.description}</div>
              <div className="text-[12.5px] text-muted-foreground">
                {t('recurring.suggestionMeta', { day: s.day_of_month, months: s.months, account: s.account_name })}
                {s.category_name ? ` · ${s.category_name}` : ''}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-semibold tabular-nums">{s.variable ? '≈ ' : ''}{formatMoney(s.amount, s.currency)}</div>
              {s.variable && <div className="text-[11.5px] text-muted-foreground">{t('recurring.suggestionVariable')}</div>}
            </div>
            {canWrite && (
              <div className="flex gap-1.5">
                <Button size="sm" onClick={() => create.mutate(s)} disabled={create.isPending}><Check size={14} />{t('recurring.suggestionAdd')}</Button>
                <Button size="sm" variant="ghost" aria-label={t('recurring.suggestionDismiss')} onClick={() => dismiss(s.key)}><X size={14} /></Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}
