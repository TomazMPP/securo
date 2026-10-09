import { Layers, MoreHorizontal, Plus, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export type AccountPageActionsProps = {
  canWrite: boolean
  onAddAccount: () => void
  onConnectBank: () => void
  onOpenCollections: () => void
  testId?: string
}

/**
 * One primary action — connect a bank. Collections and the manual account
 * stay reachable: collections as a secondary button (a menu on phones), the
 * manual account in that menu and in the page's "manual account" card.
 * @example `<AccountPageActions canWrite onAddAccount={openForm} onConnectBank={connect} onOpenCollections={openCollections} />`
 */
export function AccountPageActions(props: AccountPageActionsProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2" data-testid={props.testId}>
      <Button variant="outline" className="hidden gap-1.5 sm:inline-flex" onClick={props.onOpenCollections}>
        <Layers size={16} />
        {t('collections.title')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" className={props.canWrite ? 'size-9 shrink-0' : 'size-9 shrink-0 sm:hidden'} aria-label={t('common.more')}>
            <MoreHorizontal size={18} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="sm:hidden" onSelect={props.onOpenCollections}>
            <Layers size={16} />{t('collections.title')}
          </DropdownMenuItem>
          {props.canWrite && (
            <DropdownMenuItem onSelect={props.onAddAccount}>
              <Wallet size={16} />{t('accounts.addManual')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {props.canWrite && (
        <Button onClick={props.onConnectBank} className="gap-1.5">
          <Plus size={16} />
          {t('accounts.connectBank')}
        </Button>
      )}
    </div>
  )
}
