import { CalendarDays, List, PieChart } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type TransactionsViewMode = 'list' | 'category' | 'calendar'

export type TransactionsViewSwitcherProps = {
  value: TransactionsViewMode
  onChange: (value: TransactionsViewMode) => void
  listLabel: string
  calendarLabel: string
  /** Adds the "by category" option between list and calendar when given. */
  categoryLabel?: string
  /** Accessible name for the group. */
  ariaLabel?: string
  className?: string
}

function Segment({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-medium transition-colors sm:flex-none sm:px-3.5',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30',
        active
          ? 'bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(20,22,26,0.08)] dark:bg-secondary'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * Segmented view switch, shared by the transactions page and the dashboard's
 * transactions section so both read as the same control.
 * @example `<TransactionsViewSwitcher value={view} onChange={setView} listLabel="List" calendarLabel="Calendar" />`
 */
export function TransactionsViewSwitcher({
  value,
  onChange,
  listLabel,
  calendarLabel,
  categoryLabel,
  ariaLabel,
  className,
}: TransactionsViewSwitcherProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn('inline-flex gap-1 rounded-xl bg-muted p-1', className)}
    >
      <Segment active={value === 'list'} onClick={() => onChange('list')} icon={<List size={14} />} label={listLabel} />
      {categoryLabel && (
        <Segment
          active={value === 'category'}
          onClick={() => onChange('category')}
          icon={<PieChart size={14} />}
          label={categoryLabel}
        />
      )}
      <Segment
        active={value === 'calendar'}
        onClick={() => onChange('calendar')}
        icon={<CalendarDays size={14} />}
        label={calendarLabel}
      />
    </div>
  )
}
