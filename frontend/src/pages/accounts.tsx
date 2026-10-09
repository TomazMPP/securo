import { useMemo, useState } from 'react'
import { getAccountLabel, sumAccountBalances } from '@/lib/account-utils'
import { getConnectionName } from '@/lib/connection-utils'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useDisplayLocale, useDateLocale } from '@/hooks/use-display-locale'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { ChevronDown, Wallet } from 'lucide-react'
import { accounts, connections } from '@/lib/api'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import { formatTimeAgo } from '@/lib/relative-time'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import type { Account, BankConnection } from '@/types'
import { AccountIcon, ConnectionLogo } from '@/components/account-icon'
import { AccountPageActions } from '@/components/account-page-actions'
import { AccountDialog } from '@/components/accounts/account-dialog'
import {
  AccountGroupCard,
  AccountRow,
  AccountsFooterCards,
  AccountsSectionNav,
  AttentionBanner,
  type AccountsSection,
  type GroupMenuAction,
} from '@/components/accounts/accounts-ui'
import { BankConnectDialog } from '@/components/bank-connect-dialog'
import { ConnectorSelectDialog, type Provider } from '@/components/connector-select-dialog'
import { OAuthConnectDialog } from '@/components/oauth-connect-dialog'
import { TokenConnectDialog } from '@/components/token-connect-dialog'
import { ConnectionSettingsDialog } from '@/components/connection-settings-dialog'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useAuth } from '@/contexts/auth-context'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'

const isCard = (a: Account) => a.type === 'credit_card'

export default function AccountsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const locale = useDisplayLocale()
  const dateLocale = useDateLocale()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const { activeAccountIds } = useCollectionFilter()
  const { canWrite } = useWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()
  const section: AccountsSection = searchParams.get('section') === 'cards' ? 'cards' : 'accounts'
  const setSection = (next: AccountsSection) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'cards') params.set('section', 'cards')
    else params.delete('section')
    setSearchParams(params, { replace: true })
  }
  // The "Viewing" bar sits directly above this page, so its scope has to reach
  // the lists too — the sidebar was already filtered, this page was not.
  // null = no active collection = every account.
  const inActiveCollection = (a: Account) => !activeAccountIds || activeAccountIds.includes(a.id)
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [connectorSelectOpen, setConnectorSelectOpen] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null)
  const [settingsConnection, setSettingsConnection] = useState<BankConnection | null>(null)
  const [disconnectingConnection, setDisconnectingConnection] = useState<BankConnection | null>(null)
  const [closingAccountId, setClosingAccountId] = useState<string | null>(null)
  const [reconnectConnId, setReconnectConnId] = useState<string | null>(null)
  const [reconnectItemId, setReconnectItemId] = useState<string | null>(null)
  const [tokenReconnectConnection, setTokenReconnectConnection] = useState<BankConnection | null>(null)
  const [showClosed, setShowClosed] = useState(false)

  const { data: accountsList, isLoading: accountsLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accounts.list(),
  })

  const { data: connectionsList, isLoading: connectionsLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: connections.list,
  })

  const { data: providersList } = useQuery({
    queryKey: ['connections', 'providers'],
    queryFn: connections.getProviders,
    staleTime: 1000 * 60 * 10,
  })

  const providersByName = useMemo(() => {
    const map = new Map<string, Provider>()
    for (const p of providersList ?? []) map.set(p.name, p as Provider)
    return map
  }, [providersList])

  const handleReconnectClick = async (conn: BankConnection) => {
    const providerInfo = providersByName.get(conn.provider)
    if (providerInfo?.flow_type === 'oauth') {
      try {
        const url = await connections.getReauthUrl(conn.id)
        window.location.assign(url)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        toast.error(message || t('accounts.connectError'))
      }
      return
    }
    if (providerInfo?.flow_type === 'token') {
      setTokenReconnectConnection(conn)
      return
    }
    // Widget flow (Pluggy): re-open the widget with the existing item_id.
    setReconnectConnId(conn.id)
    setReconnectItemId(conn.external_id)
  }

  const { data: closedAccountsList } = useQuery({
    queryKey: ['accounts', 'closed'],
    queryFn: () => accounts.list(true),
  })
  const closedAccounts = closedAccountsList?.filter((a) => a.is_closed && inActiveCollection(a)) ?? []

  const syncMutation = useMutation({
    mutationFn: (id: string) => connections.sync(id),
    onSuccess: (result) => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['connections'] })
      toast.success(t('accounts.syncDone'))
      const merged = (result as BankConnection & { merged_count?: number })?.merged_count
      if (merged && merged > 0) {
        toast.info(t('accounts.mergedCount', { count: merged }))
      }
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: ['connections'] })
      const detail = axios.isAxiosError(err)
        ? err.response?.data?.detail
        : null
      const message = typeof detail === 'string' ? detail : detail?.message
      toast.error(message || t('accounts.syncError'))
    },
  })

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => connections.delete(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['connections'] })
      queryClient.invalidateQueries({ queryKey: ['assets'] })
      queryClient.invalidateQueries({ queryKey: ['asset-groups'] })
      queryClient.invalidateQueries({ queryKey: ['portfolio-trend'] })
      setDisconnectingConnection(null)
      toast.success(t('accounts.disconnected'))
    },
  })

  const createMutation = useMutation({
    mutationFn: (data: { name: string; type: string; balance?: number; currency?: string }) =>
      accounts.create(data),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      toast.success(t('accounts.created'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<Account> & { id: string }) =>
      accounts.update(id, data),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setDialogOpen(false)
      setEditingAccount(null)
      toast.success(t('accounts.updated'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => accounts.delete(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['import-logs'] })
      setDeletingId(null)
      toast.success(t('accounts.deleted'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const closeMutation = useMutation({
    mutationFn: (id: string) => accounts.close(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      setClosingAccountId(null)
      toast.success(t('accounts.accountClosed'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const reopenMutation = useMutation({
    mutationFn: (id: string) => accounts.reopen(id),
    onSuccess: () => {
      invalidateFinancialQueries(queryClient)
      toast.success(t('accounts.accountReopened'))
    },
    onError: () => toast.error(t('common.error')),
  })

  const isLoading = accountsLoading || connectionsLoading
  const openAccounts = accountsList?.filter(inActiveCollection) ?? []
  const inSection = (a: Account) => (section === 'cards' ? isCard(a) : !isCard(a))
  const manualAccounts = openAccounts.filter((a) => a.connection_id === null && inSection(a))

  // Headline numbers, in the primary currency.
  const cashTotal = sumAccountBalances(openAccounts.filter((a) => !isCard(a)))
  const openBills = sumAccountBalances(openAccounts.filter(isCard))
  const availableCredit = openAccounts
    .filter((a) => isCard(a) && a.available_credit != null && a.currency === userCurrency)
    .reduce((sum, a) => sum + Number(a.available_credit), 0)
  const hasCards = openAccounts.some(isCard)
  const money = (value: number, currency = userCurrency) => mask(formatCurrency(value, currency, locale))

  const brokenConnections = (connectionsList ?? []).filter((c) => c.status !== 'active')

  const openEdit = (acc: Account) => { setEditingAccount(acc); setDialogOpen(true) }
  const openNewManual = () => { setEditingAccount(null); setDialogOpen(true) }

  const accountSecondary = (acc: Account) => {
    if (isCard(acc) && acc.available_credit != null) {
      return `${t('accounts.availableCredit')}: ${money(Number(acc.available_credit), acc.currency)}`
    }
    if (acc.balance_primary != null && acc.currency !== userCurrency) {
      return money(acc.balance_primary)
    }
    return null
  }

  const renderRows = (list: Account[], allowDelete: boolean) =>
    list.map((acc) => (
      <AccountRow
        key={acc.id}
        account={acc}
        balance={money(Number(acc.current_balance), acc.currency)}
        secondary={accountSecondary(acc)}
        canWrite={canWrite}
        onEdit={() => openEdit(acc)}
        onClose={() => setClosingAccountId(acc.id)}
        onDelete={allowDelete ? () => setDeletingId(acc.id) : undefined}
        deletePending={deleteMutation.isPending}
      />
    ))

  const connectionStatus = (conn: BankConnection): { text: string; tone: 'ok' | 'warn' } => {
    if (conn.status === 'expired') return { text: t('accounts.connectionExpired'), tone: 'warn' }
    if (conn.status !== 'active') return { text: t('accounts.connectionError'), tone: 'warn' }
    const provider = providersByName.get(conn.provider)?.display_name ?? conn.provider
    const synced = conn.last_sync_at ? formatTimeAgo(conn.last_sync_at, dateLocale) : ''
    return {
      text: synced ? t('accounts.providerUpdated', { provider, time: synced }) : provider,
      tone: 'ok',
    }
  }

  const connectionMenu = (conn: BankConnection): GroupMenuAction[] => {
    if (!canWrite) return []
    const needsReconnect = conn.status !== 'active'
    const syncPending = syncMutation.isPending && syncMutation.variables === conn.id
    return [
      needsReconnect
        ? { key: 'reconnect', label: t('accounts.reconnect'), icon: 'sync', onSelect: () => handleReconnectClick(conn) }
        : { key: 'sync', label: t('accounts.sync'), icon: 'sync', onSelect: () => syncMutation.mutate(conn.id), disabled: syncPending },
      { key: 'settings', label: t('connections.settings'), icon: 'settings', onSelect: () => setSettingsConnection(conn) },
      {
        key: 'disconnect',
        label: t('accounts.disconnect'),
        icon: 'disconnect',
        onSelect: () => setDisconnectingConnection(conn),
        disabled: disconnectMutation.isPending,
        destructive: true,
      },
    ]
  }

  const connectionGroups = (connectionsList ?? [])
    .map((conn) => {
      const all = openAccounts.filter((a) => a.connection_id === conn.id)
      return { conn, all, shown: all.filter(inSection) }
    })
    // A connection with no accounts at all still shows under "Accounts" so
    // its actions stay reachable; otherwise it shows where it has accounts.
    .filter(({ all, shown }) => shown.length > 0 || (section === 'accounts' && all.length === 0))

  const headline = section === 'cards'
    ? { label: t('accounts.openBills'), value: openBills }
    : { label: t('accounts.balanceInAccounts'), value: cashTotal }

  return (
    <div className="space-y-5 pb-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 text-[22px] font-bold tracking-tight text-foreground">{t('accounts.pageTitle')}</h1>
        <AccountPageActions
          canWrite={canWrite}
          onAddAccount={openNewManual}
          onConnectBank={() => setConnectorSelectOpen(true)}
          onOpenCollections={() => navigate('/collections')}
        />
      </div>

      <AccountsSectionNav section={section} onChange={setSection} />

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-64 rounded-xl" />
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-7 gap-y-4 pt-1">
            <div className="min-w-0">
              <p className="text-sm font-medium text-muted-foreground">{headline.label}</p>
              <p className="mt-1 text-[34px] font-bold leading-tight tracking-tight tabular-nums text-foreground sm:text-[40px]">
                {money(headline.value)}
              </p>
              {section === 'accounts' && hasCards && (
                <p className="mt-1 text-[13.5px] text-muted-foreground">
                  {t('accounts.openBills')}{' '}
                  <b className="font-semibold tabular-nums text-[#B42323] dark:text-rose-400">
                    {money(-openBills)}
                  </b>
                  {' · '}
                  {t('accounts.freeAfterBills')}{' '}
                  <b className="font-semibold tabular-nums text-foreground">{money(cashTotal - openBills)}</b>
                </p>
              )}
              {section === 'cards' && availableCredit > 0 && (
                <p className="mt-1 text-[13.5px] text-muted-foreground">
                  {t('accounts.availableCredit')}{' '}
                  <b className="font-semibold tabular-nums text-foreground">{money(availableCredit)}</b>
                </p>
              )}
            </div>
            {brokenConnections.length > 0 && (
              <div className="flex w-full max-w-xl flex-col gap-2 lg:ml-auto lg:w-auto">
                {brokenConnections.map((conn) => {
                  const name = getConnectionName(conn, t)
                  return (
                    <AttentionBanner
                      key={conn.id}
                      title={t(conn.status === 'expired' ? 'accounts.attentionExpired' : 'accounts.attentionError', { name })}
                      description={t('accounts.attentionHint')}
                      actionLabel={canWrite ? t('accounts.renew') : undefined}
                      onAction={canWrite ? () => handleReconnectClick(conn) : undefined}
                    />
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4">
            {connectionGroups.map(({ conn, shown }) => {
              const status = connectionStatus(conn)
              return (
                <AccountGroupCard
                  key={conn.id}
                  // One bank's favicon would misrepresent a multi-institution
                  // link — fall back to the generic icon.
                  logo={<ConnectionLogo logoUrl={(conn.institutions?.length ?? 0) > 1 ? null : conn.logo_url} />}
                  name={getConnectionName(conn, t)}
                  status={status.text}
                  statusTone={status.tone}
                  total={shown.length > 0 ? money(sumAccountBalances(shown)) : undefined}
                  menu={connectionMenu(conn)}
                  menuLabel={`${t('common.more')}: ${getConnectionName(conn, t)}`}
                  headerAction={
                    canWrite && conn.status !== 'active' ? (
                      <Button variant="outline" size="sm" className="hidden h-8 sm:inline-flex" onClick={() => handleReconnectClick(conn)}>
                        {t('accounts.reconnect')}
                      </Button>
                    ) : undefined
                  }
                >
                  {shown.length > 0 ? (
                    renderRows(shown, false)
                  ) : (
                    <p className="px-5 py-4 text-sm text-muted-foreground">
                      {t(activeAccountIds ? 'accounts.emptyFiltered' : 'accounts.noAccountsFound')}
                    </p>
                  )}
                </AccountGroupCard>
              )
            })}

            {(section === 'accounts' || manualAccounts.length > 0) && (
              <AccountGroupCard
                logo={
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Wallet size={15} />
                  </span>
                }
                name={t('accounts.manualAccounts')}
                total={manualAccounts.length > 0 ? money(sumAccountBalances(manualAccounts)) : undefined}
              >
                {manualAccounts.length > 0 ? (
                  renderRows(manualAccounts, true)
                ) : (
                  <p className="px-5 py-4 text-sm text-muted-foreground">
                    {t(activeAccountIds ? 'accounts.emptyFiltered' : 'accounts.noManualAccounts')}
                  </p>
                )}
              </AccountGroupCard>
            )}

            {section === 'accounts' && (connectionsList ?? []).length === 0 && (
              <div className="rounded-2xl border border-dashed border-border bg-card p-8 text-center">
                <p className="text-sm text-muted-foreground">{t('accounts.noBankConnections')}</p>
                {canWrite && (
                  <Button className="mt-4" onClick={() => setConnectorSelectOpen(true)}>
                    {t('accounts.connectBank')}
                  </Button>
                )}
              </div>
            )}

            {section === 'cards' && connectionGroups.length === 0 && manualAccounts.length === 0 && (
              <div className="rounded-2xl border border-dashed border-border bg-card p-8 text-center">
                <p className="text-sm text-muted-foreground">{t('accounts.noCards')}</p>
              </div>
            )}

            <AccountsFooterCards canWrite={canWrite} onAddManual={openNewManual} />

            {/* Closed Accounts */}
            {closedAccounts.length > 0 && (
              <section className="rounded-2xl border border-border bg-card">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-5 py-3.5 text-left"
                  onClick={() => setShowClosed((v) => !v)}
                  aria-expanded={showClosed}
                >
                  <h2 className="m-0 text-sm font-semibold text-muted-foreground">
                    {t('accounts.closedAccounts')} <span className="font-normal">({closedAccounts.length})</span>
                  </h2>
                  <ChevronDown size={16} className={cn('ml-auto text-muted-foreground transition-transform', showClosed && 'rotate-180')} />
                </button>
                {showClosed && (
                  <div className="border-t border-border/70 opacity-70">
                    {closedAccounts.map((acc) => (
                      <div key={acc.id} className="flex items-center border-b border-border/60 px-5 py-3 last:border-0">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <AccountIcon account={acc} />
                          <p className="truncate text-sm font-medium text-muted-foreground">{getAccountLabel(acc)}</p>
                        </div>
                        {canWrite && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="mr-3 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => reopenMutation.mutate(acc.id)}
                            disabled={reopenMutation.isPending}
                          >
                            {t('accounts.reopen')}
                          </Button>
                        )}
                        <p className="w-28 text-right text-sm font-semibold tabular-nums text-muted-foreground sm:w-32">
                          {money(Number(acc.current_balance), acc.currency)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        </>
      )}

      {/* Confirm delete dialog */}
      <Dialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('accounts.confirmDeleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('accounts.confirmDeleteDesc')}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deletingId && deleteMutation.mutate(deletingId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? t('common.loading') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm disconnect dialog */}
      <Dialog open={!!disconnectingConnection} onOpenChange={() => setDisconnectingConnection(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('accounts.confirmDisconnectTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('accounts.confirmDisconnectDesc', { institution: disconnectingConnection ? getConnectionName(disconnectingConnection, t) : '' })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectingConnection(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnectingConnection && disconnectMutation.mutate(disconnectingConnection.id)}
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending ? t('common.loading') : t('accounts.disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm close dialog */}
      <Dialog open={!!closingAccountId} onOpenChange={() => setClosingAccountId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('accounts.close')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('accounts.confirmClose')}
          </p>
          {accountsList?.find(a => a.id === closingAccountId)?.connection_id && (
            <p className="text-sm text-amber-600 font-medium">
              {t('accounts.confirmCloseBank')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosingAccountId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="default"
              onClick={() => closingAccountId && closeMutation.mutate(closingAccountId)}
              disabled={closeMutation.isPending}
            >
              {closeMutation.isPending ? t('common.loading') : t('accounts.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Connector Select Dialog */}
      <ConnectorSelectDialog
        open={connectorSelectOpen}
        onClose={() => setConnectorSelectOpen(false)}
        onSelect={(provider) => setSelectedProvider(provider)}
      />

      {/* Bank Connect Dialog — widget-based (Pluggy) */}
      <BankConnectDialog
        open={!!selectedProvider && selectedProvider.flow_type === 'widget'}
        onClose={() => setSelectedProvider(null)}
        provider={selectedProvider?.name}
        supportsAssetSync={selectedProvider?.supports_asset_sync ?? false}
      />

      {/* OAuth Connect Dialog — institution-pickers (Enable Banking) */}
      <OAuthConnectDialog
        open={!!selectedProvider && selectedProvider.flow_type === 'oauth'}
        onClose={() => setSelectedProvider(null)}
        provider={selectedProvider?.name ?? ''}
        supportsAssetSync={selectedProvider?.supports_asset_sync ?? false}
      />

      {/* Token Connect Dialog — paste-a-token flow (SimpleFIN) */}
      <TokenConnectDialog
        open={!!selectedProvider && selectedProvider.flow_type === 'token'}
        onClose={() => setSelectedProvider(null)}
        provider={selectedProvider?.name ?? ''}
        supportsAssetSync={selectedProvider?.supports_asset_sync ?? false}
      />

      {/* Reconnect Dialog — widget-based (Pluggy) */}
      <BankConnectDialog
        open={!!reconnectConnId}
        onClose={() => { setReconnectConnId(null); setReconnectItemId(null) }}
        reconnectConnectionId={reconnectConnId ?? undefined}
        updateItemId={reconnectItemId ?? undefined}
      />

      {/* Reconnect Dialog — paste-a-token flow (SimpleFIN) */}
      <TokenConnectDialog
        open={!!tokenReconnectConnection}
        onClose={() => setTokenReconnectConnection(null)}
        provider={tokenReconnectConnection?.provider ?? ''}
        reconnectConnectionId={tokenReconnectConnection?.id}
      />

      {/* Connection Settings Dialog */}
      <ConnectionSettingsDialog
        open={!!settingsConnection}
        onClose={() => setSettingsConnection(null)}
        connection={settingsConnection}
        supportsAssetSync={
          settingsConnection
            ? providersByName.get(settingsConnection.provider)?.supports_asset_sync ?? false
            : false
        }
      />

      {/* Account Dialog */}
      <AccountDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setEditingAccount(null) }}
        account={editingAccount}
        onSave={(data) => {
          if (editingAccount) {
            updateMutation.mutate({ id: editingAccount.id, ...data })
          } else {
            createMutation.mutate(data as { name: string; type: string; balance?: number; balance_date?: string; currency?: string })
          }
        }}
        loading={createMutation.isPending || updateMutation.isPending}
      />
    </div>
  )
}
