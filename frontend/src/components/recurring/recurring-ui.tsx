import { cn } from '@/lib/utils'
import type { CommitmentKind } from '@/lib/recurring-overview'
import { SERIES_COLOR } from './series'

export function Swatch({ kind, className }: { kind: CommitmentKind; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2.5 shrink-0 rounded-[3px]', className)}
      style={{ background: SERIES_COLOR[kind] }}
    />
  )
}

export function MeterBar({ value, color, className }: { value: number; color: string; className?: string }) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-muted', className)}>
      <span className="block h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

/** Small completion ring for an installment plan: `n` of `total` paid. */
export function ProgressRing({ value, total, color }: { value: number; total: number; color: string }) {
  const c = 2 * Math.PI * 6
  const done = total > 0 ? Math.min(1, value / total) : 0
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--muted)" strokeWidth="2.5" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeDasharray={`${(c * done).toFixed(1)} ${c.toFixed(1)}`}
        transform="rotate(-90 8 8)"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function SectionCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return <section className={cn('rounded-2xl border border-border bg-card p-5 sm:p-6', className)}>{children}</section>
}
