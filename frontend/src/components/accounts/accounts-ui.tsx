import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Landmark, MoreVertical, Plus, RefreshCw, Settings, TriangleAlert, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AccountIcon } from '@/components/account-icon'
import { AccountRowActions } from '@/components/account-row-actions'
import { formatAccountMask, getAccountName } from '@/lib/account-utils'
import { getAccountTypeConfig } from '@/lib/account-type-config'
import { cn } from '@/lib/utils'
import type { Account } from '@/types'

export type AccountsSection = 'accounts' | 'cards'

const SEG_ITEM = 'inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-[9px] px-3.5 text-sm transition-colors sm:px-4'
const SEG_ON = 'bg-card font-semibold text-foreground shadow-sm'
const SEG_OFF = 'font-medium text-muted-foreground hover:text-foreground'

/** Contas / Cartões / Empréstimos e financiamentos. The last is its own page. */
export function AccountsSectionNav({
  section,
  onChange,
}: {
  section: AccountsSection
  onChange: (section: AccountsSection) => void
}) {
  const { t } = useTranslation()
  return (
    <nav aria-label={t('accounts.sectionsLabel')} className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="inline-flex gap-1 rounded-xl bg-muted p-1">
        {(['accounts', 'cards'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-current={section === s ? 'page' : undefined}
            onClick={() => onChange(s)}
            className={cn(SEG_ITEM, section === s ? SEG_ON : SEG_OFF)}
          >
            {t(s === 'accounts' ? 'accounts.sectionAccounts' : 'accounts.sectionCards')}
          </button>
        ))}
        <Link to="/loans" className={cn(SEG_ITEM, SEG_OFF)}>
          {t('accounts.sectionLoans')}
          <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-bold tracking-wide text-primary-foreground">
            {t('accounts.newBadge')}
          </span>
        </Link>
      </div>
    </nav>
  )
}

/** A connection that stopped syncing, with the action that fixes it. */
export function AttentionBanner({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-[#F3DDB0] bg-[#FFF7E8] px-4 py-3 dark:border-amber-500/30 dark:bg-amber-500/10"
    >
      <TriangleAlert size={20} className="shrink-0 text-[#8A5A0B] dark:text-amber-300" aria-hidden />
      <p className="m-0 min-w-0 flex-[1_1_220px] text-[13.5px] leading-snug text-[#5A3D08] dark:text-amber-100">
        <b className="font-semibold">{title}</b> {description}
      </p>
      {actionLabel && onAction && (
        <Button
          variant="outline"
          className="h-9 border-[#E8CF9C] bg-card font-semibold dark:border-amber-500/40"
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      )}
    </div>
  )
}

export interface GroupMenuAction {
  key: string
  label: string
  icon: 'sync' | 'settings' | 'disconnect'
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
}

const MENU_ICONS = { sync: RefreshCw, settings: Settings, disconnect: Unlink }

/** One institution (or the manual accounts) with its accounts as rows. */
export function AccountGroupCard({
  logo,
  name,
  status,
  statusTone,
  total,
  menu,
  menuLabel,
  headerAction,
  children,
}: {
  logo: React.ReactNode
  name: string
  status?: string
  statusTone?: 'ok' | 'warn' | 'none'
  total?: string
  menu?: GroupMenuAction[]
  menuLabel?: string
  headerAction?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-4 py-3.5 sm:px-5">
        {logo}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
          <h2 className="m-0 truncate text-[15px] font-bold text-foreground">{name}</h2>
          {status && (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
              {statusTone !== 'none' && (
                <span
                  aria-hidden
                  className={cn('size-2 shrink-0 rounded-full', statusTone === 'warn' ? 'bg-[#E08A1E]' : 'bg-[#0F8A4B]')}
                />
              )}
              <span className={cn('truncate', statusTone === 'warn' && 'font-medium text-[#8A5A0B] dark:text-amber-300')}>{status}</span>
            </span>
          )}
        </div>
        {headerAction}
        {total && <span className="hidden text-sm font-semibold tabular-nums text-foreground/80 sm:inline">{total}</span>}
        {menu && menu.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="-mr-2 rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={menuLabel}
              >
                <MoreVertical size={18} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {menu.map((action) => {
                const Icon = MENU_ICONS[action.icon]
                return (
                  <Fragment key={action.key}>
                    {action.destructive && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      variant={action.destructive ? 'destructive' : 'default'}
                      disabled={action.disabled}
                      onSelect={action.onSelect}
                    >
                      <Icon size={14} />
                      {action.label}
                    </DropdownMenuItem>
                  </Fragment>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {children}
    </section>
  )
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const due = new Date(dateStr + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

/** One account: name, type · masked number · due, balance and row actions. */
export function AccountRow({
  account,
  balance,
  secondary,
  canWrite,
  onEdit,
  onClose,
  onDelete,
  deletePending,
}: {
  account: Account
  balance: string
  secondary?: string | null
  canWrite: boolean
  onEdit: () => void
  onClose: () => void
  onDelete?: () => void
  deletePending: boolean
}) {
  const { t } = useTranslation()
  const cfg = getAccountTypeConfig(account.type)
  const bal = Number(account.current_balance)
  const isCC = account.type === 'credit_card'
  const dueIn = isCC ? daysUntil(account.next_due_date) : null
  const dueText =
    dueIn == null ? null
      : dueIn < 0 ? t('accounts.overdue')
      : dueIn === 0 ? t('accounts.dueToday')
      : t('accounts.dueIn', { count: dueIn })
  const dueClass = dueIn != null && dueIn <= 3 ? 'text-[#8A5A0B] dark:text-amber-300' : ''
  const accountMask = formatAccountMask(account)
  const negative = isCC ? bal > 0 : bal < 0

  return (
    <div className="flex items-center border-b border-border/60 px-4 py-3 transition-colors last:border-0 hover:bg-muted/40 sm:px-5">
      <Link to={`/accounts/${account.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <AccountIcon account={account} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-semibold text-foreground">{getAccountName(account)}</p>
          <p className="truncate text-[12.5px] text-muted-foreground">
            {t(cfg.label)}
            {accountMask && <> · <span className="tabular-nums">{accountMask}</span></>}
            {account.shared_balance_group && <> · {t('accounts.sharedCreditBalance')}</>}
            {dueText && <> · <span className={dueClass}>{dueText}</span></>}
          </p>
        </div>
        <div className="shrink-0 pl-2 text-right">
          <p className={cn('text-[15px] font-bold tabular-nums sm:text-base', negative ? 'text-[#B42323] dark:text-rose-400' : 'text-foreground')}>
            {balance}
          </p>
          {secondary && <p className="text-[12px] text-muted-foreground tabular-nums">{secondary}</p>}
        </div>
      </Link>
      {canWrite && (
        <AccountRowActions
          accountName={getAccountName(account)}
          onEdit={onEdit}
          onClose={onClose}
          onDelete={onDelete}
          deletePending={deletePending}
        />
      )}
    </div>
  )
}

/** Link to the loans page and the dashed "add a manual account" card. */
export function AccountsFooterCards({ canWrite, onAddManual }: { canWrite: boolean; onAddManual: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Link
        to="/loans"
        className="flex items-center gap-4 rounded-2xl border border-border bg-card p-5 text-inherit no-underline transition-colors hover:bg-muted/40"
      >
        <span className="flex size-12 shrink-0 items-center justify-center rounded-[14px] bg-accent text-accent-foreground">
          <Landmark size={22} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-bold text-foreground">{t('accounts.loansCardTitle')}</span>
          <span className="mt-0.5 block text-[13.5px] leading-snug text-muted-foreground">{t('accounts.loansCardDescription')}</span>
        </span>
        <ChevronRight size={18} className="shrink-0 text-muted-foreground" />
      </Link>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-dashed border-border bg-card/60 p-5">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-[14px] bg-muted text-muted-foreground">
            <Plus size={22} />
          </span>
          <span className="min-w-0 flex-[1_1_160px]">
            <span className="block text-[15px] font-bold text-foreground">{t('accounts.manualCardTitle')}</span>
            <span className="mt-0.5 block text-[13.5px] leading-snug text-muted-foreground">{t('accounts.manualCardDescription')}</span>
          </span>
          <Button variant="outline" className="h-10 font-semibold" onClick={onAddManual}>
            {t('accounts.add')}
          </Button>
        </div>
      )}
    </div>
  )
}
