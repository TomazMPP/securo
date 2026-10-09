import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** White dashboard card: the shadcn Card with the dashboard's padding. */
export function DashboardCard({
  className,
  children,
  labelledBy,
}: {
  className?: string
  children: ReactNode
  labelledBy?: string
}) {
  return (
    <Card className={cn('p-5 sm:p-[22px] min-w-0', className)} aria-labelledby={labelledBy} role="region">
      {children}
    </Card>
  )
}

/**
 * Small muted card title with the corner "open" arrow that leads to the page
 * the card summarises. `to` is optional so a card can stay link-less when its
 * destination module is off.
 */
export function CardHeading({
  id,
  title,
  to,
  linkLabel,
  aside,
}: {
  id?: string
  title: string
  to?: string
  linkLabel?: string
  aside?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-2 min-h-8">
      <h2 id={id} className="m-0 text-[13.5px] font-medium text-muted-foreground tracking-normal">{title}</h2>
      <div className="flex items-center gap-1">
        {aside}
        {to && (
          <Link
            to={to}
            aria-label={linkLabel ?? title}
            title={linkLabel ?? title}
            className="inline-flex size-8 items-center justify-center rounded-[9px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <ArrowUpRight className="size-4" />
          </Link>
        )}
      </div>
    </div>
  )
}

export type PillTone = 'up' | 'down' | 'neutral'

const PILL_TONES: Record<PillTone, string> = {
  up: 'bg-[#E5F5EC] text-[#0B7A41] dark:bg-emerald-500/15 dark:text-emerald-300',
  down: 'bg-[#FDECEC] text-[#B42323] dark:bg-rose-500/15 dark:text-rose-300',
  neutral: 'bg-muted text-[#4A515C] dark:text-muted-foreground',
}

/** Rounded status pill: green for good news, red for bad, grey for neutral. */
export function Pill({
  tone = 'neutral',
  className,
  title,
  children,
}: {
  tone?: PillTone
  className?: string
  title?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-xs font-semibold tabular-nums whitespace-nowrap',
        PILL_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Thin horizontal progress bar. `value` is 0..100. */
export function ProgressBar({
  value,
  className,
  barClassName,
  label,
}: {
  value: number
  className?: string
  barClassName?: string
  label?: string
}) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label}
      className={cn('h-2 rounded-full bg-muted overflow-hidden', className)}
    >
      <span className={cn('block h-full rounded-full bg-primary', barClassName)} style={{ width: `${clamped}%` }} />
    </div>
  )
}

/** Compact empty state used inside a card. */
export function CardEmpty({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
      {icon && <div className="text-muted-foreground/70">{icon}</div>}
      <p className="text-sm text-muted-foreground max-w-[260px]">{children}</p>
      {action}
    </div>
  )
}
