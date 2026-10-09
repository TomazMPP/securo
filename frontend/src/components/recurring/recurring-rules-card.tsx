import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Info, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { CategoryIcon } from '@/components/category-icon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getAccountName } from '@/lib/account-utils'
import { cn } from '@/lib/utils'
import type { Account, Category, RecurringTransaction } from '@/types'
import { SectionCard } from './recurring-ui'

/**
 * Every rule of the selected type, including paused ones and those with no
 * occurrence in the month on screen — where edit, pause/resume and delete live.
 */
export function RecurringRulesCard({
  rules,
  accounts,
  categories,
  canWrite,
  dateLocale,
  formatAmount,
  formatPrimary,
  frequencyLabel,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  rules: RecurringTransaction[]
  accounts: Account[]
  categories: Category[]
  canWrite: boolean
  dateLocale: string
  formatAmount: (rule: RecurringTransaction) => string
  /** Converted amount for rules in another currency, or null. */
  formatPrimary: (rule: RecurringTransaction) => string | null
  frequencyLabel: (frequency: string) => string
  onEdit: (rule: RecurringTransaction) => void
  onToggleActive: (rule: RecurringTransaction) => void
  onDelete: (rule: RecurringTransaction) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const accountById = new Map(accounts.map((a) => [a.id, a]))
  const categoryById = new Map(categories.map((c) => [c.id, c]))
  const sorted = [...rules].sort(
    (a, b) => Number(b.is_active) - Number(a.is_active) || a.next_occurrence.localeCompare(b.next_occurrence),
  )

  return (
    <SectionCard>
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <h2 className="m-0 text-base font-bold text-foreground">
          {t('recurring.allRules')} <span className="font-medium text-muted-foreground">({rules.length})</span>
        </h2>
        <ChevronDown size={16} className={cn('ml-auto text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        rules.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t('recurring.empty')}</p>
        ) : (
          <ul className="mt-2 list-none p-0">
            {sorted.map((rule) => {
              const category = rule.category_id ? categoryById.get(rule.category_id) : undefined
              const account = rule.account_id ? accountById.get(rule.account_id) : undefined
              const next = new Date(`${rule.next_occurrence}T00:00:00`).toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' })
              const primary = formatPrimary(rule)
              const sub = [
                frequencyLabel(rule.frequency),
                rule.is_active ? t('recurring.nextOn', { date: next }) : null,
                account ? getAccountName(account) : null,
              ].filter(Boolean).join(' · ')
              return (
                <li key={rule.id} className={cn('flex items-center gap-3 border-b border-border/60 py-2.5 last:border-0', !rule.is_active && 'opacity-70')}>
                  <CategoryIcon icon={category?.icon} color={category?.color} size="lg" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-[14.5px] font-semibold text-foreground">
                      <span className="truncate">{rule.description}</span>
                      {!rule.is_active && (
                        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                          {t('recurring.paused')}
                        </span>
                      )}
                    </p>
                    <p className="truncate text-[12.5px] text-muted-foreground">{sub}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={cn('text-[14.5px] font-semibold tabular-nums', rule.type === 'credit' ? 'text-[#0B7A41] dark:text-emerald-400' : 'text-foreground')}>
                      {formatAmount(rule)}
                    </p>
                    {primary && (
                      <p className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground tabular-nums">
                        {primary}
                        <span title={t('recurring.fxEstimate', { rate: rule.fx_rate_used?.toFixed(4) ?? '–' })}>
                          <Info size={11} className="opacity-60" />
                        </span>
                      </p>
                    )}
                  </div>
                  {canWrite && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={`${t('recurring.actions')}: ${rule.description}`}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onEdit(rule)}>
                          <Pencil size={14} />
                          {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onToggleActive(rule)}>
                          {rule.is_active ? <Pause size={14} /> : <Play size={14} />}
                          {rule.is_active ? t('recurring.pause') : t('recurring.resume')}
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(rule)}>
                          <Trash2 size={14} />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              )
            })}
          </ul>
        )
      )}
    </SectionCard>
  )
}
