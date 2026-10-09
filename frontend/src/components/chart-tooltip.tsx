import type { ReactNode } from 'react'

export interface TooltipRow {
  key: string
  label: ReactNode
  value: number
  color?: string
  /** Rendered muted and excluded from the total (e.g. a balance line). */
  extra?: boolean
}

interface ChartTooltipProps {
  title: ReactNode
  rows: TooltipRow[]
  format: (v: number) => string
  totalLabel?: ReactNode
  /** Show each row's share of the total next to its value. */
  shares?: boolean
  footer?: ReactNode
}

/**
 * Tooltip body for recharts: one line per series with its colour, the
 * value right-aligned, an optional share of the total, and the total.
 * Recharts' default lists bare series values without ever summing them.
 */
export function ChartTooltip({ title, rows, format, totalLabel, shares, footer }: ChartTooltipProps) {
  const summed = rows.filter((r) => !r.extra)
  const total = summed.reduce((s, r) => s + r.value, 0)
  return (
    <div className="min-w-56 rounded-xl border bg-popover px-3.5 py-3 text-[12.5px] text-popover-foreground shadow-lg">
      <div className="mb-2 font-semibold">{title}</div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.key} className={r.extra ? 'text-muted-foreground' : undefined}>
            <div className="flex items-center gap-2">
              {r.color && <span className="size-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />}
              <span className="flex-1 truncate">{r.label}</span>
              {shares && !r.extra && total > 0 && (
                <span className="text-muted-foreground tabular-nums">{Math.round((r.value / total) * 100)}%</span>
              )}
              <span className="font-semibold tabular-nums">{format(r.value)}</span>
            </div>
          </li>
        ))}
      </ul>
      {totalLabel && summed.length > 1 && (
        <div className="mt-2 flex items-center justify-between border-t pt-2 font-semibold">
          <span>{totalLabel}</span>
          <span className="tabular-nums">{format(total)}</span>
        </div>
      )}
      {footer && <div className="mt-2 text-muted-foreground">{footer}</div>}
    </div>
  )
}
