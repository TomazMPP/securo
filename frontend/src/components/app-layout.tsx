import { useState, useCallback, useEffect, useMemo, lazy, Suspense } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/contexts/auth-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { useSidebarState } from '@/contexts/sidebar-state-context'
import { CollectionSelector } from '@/components/collection-selector'
import { auth as authApi, admin as adminApi } from '@/lib/api'
import { resolveSupportedLang } from '@/lib/i18n'
import { OnboardingTour } from '@/components/onboarding-tour'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { APP_VERSION } from '@/lib/build-info'
import { ShellLogo } from '@/components/shell-logo'
import { UpdateAvailableBanner } from '@/components/update-available-banner'
import { UpdateAvailableDialog } from '@/components/update-available-dialog'
import { WorkspaceSwitcher } from '@/components/workspace-switcher'
import { navItems, visibleNavItems, type NavItem } from '@/lib/nav-items'
import {
  Menu,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Sun,
  Moon,
  Languages,
  KeyRound,
  Check,
  HardDriveDownload,
  Shield,
  ShieldCheck,
  Fingerprint,
} from 'lucide-react'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { ChangePasswordDialog } from '@/components/change-password-dialog'
import { BackupDialog } from '@/components/backup-dialog'
import { TwoFactorSetup } from '@/components/two-factor-setup'
import { PasskeyManagementDialog } from '@/components/passkey-management-dialog'
import { CommandPalette } from '@/components/command-palette'
import { useCommandPaletteHotkey } from '@/hooks/use-command-palette-hotkey'
import { GlobalChatPanel } from '@/components/global-chat-panel'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { Bot, Plus, Search, Sparkles } from 'lucide-react'
import { setThemeBasedOnSystem } from '@/lib/theme-utils'
import { useLocalAuthEnabled } from '@/hooks/use-local-auth'

const QuickAddTransaction = lazy(() => import('@/components/quick-add-transaction'))

/** Placeholder rows shown while the workspace's module list is in flight. */
function NavSkeleton() {
  return (
    <div className="flex flex-col gap-0.5" aria-hidden>
      {[3, 2, 7].map((count, section) => (
        <div key={section} className={cn('flex flex-col gap-0.5', section > 0 && 'pt-3')}>
          <div className="px-3 pt-1 pb-1">
            <div className="h-2 w-16 rounded bg-sidebar-accent/60 animate-pulse" />
          </div>
          {Array.from({ length: count }).map((_, row) => (
            <div key={row} className="flex items-center gap-3 px-3 py-2">
              <div className="h-4 w-4 rounded bg-sidebar-accent/60 animate-pulse" />
              <div className="h-3 flex-1 max-w-[7rem] rounded bg-sidebar-accent/40 animate-pulse" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function AppLayout() {
  const { t } = useTranslation()
  const { user, logout, updateUser } = useAuth()
  const { theme, setTheme, resolvedTheme } = useTheme()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const { collapsed: desktopSidebarCollapsed, toggleCollapsed: toggleDesktopSidebar } = useSidebarState()
  const { privacyMode, togglePrivacyMode } = usePrivacyMode()
  const [changePasswordOpen, setChangePasswordOpen] = useState(false)
  const [twoFactorOpen, setTwoFactorOpen] = useState(false)
  const [passkeysOpen, setPasskeysOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  useCommandPaletteHotkey(setPaletteOpen)
  const { agentsEnabled } = useFeatureFlags()
  const { hasModule, isLoading: workspaceLoading, canWrite } = useWorkspace()
  // The chat is offered only to members who can write. Sending a message
  // reaches a tool set that persists — `propose_create_transaction` and its
  // siblings — so the backend refuses it for a read-only role. Showing the
  // panel anyway would put a raw `403: {"detail":"Read-only role"}` in front
  // of the user, which is what happened before this guard.
  //
  // This costs a viewer the ability to *ask* questions, which is a real use
  // case. Restoring it means making the agent's tools role-aware so a
  // read-only session only exposes the reading ones; then this becomes
  // `agentsEnabled` again.
  const chatAvailable = agentsEnabled && canWrite
  const localAuthEnabled = useLocalAuthEnabled()

  // ⌘J / Ctrl+J toggles the global slide-over chat from anywhere.
  // Distinct from ⌘K (command palette) so users can have both open.
  // Gated on agentsEnabled so the hotkey is a no-op when the feature is
  // off — keeps ⌘J free for browsers/other tools.
  useEffect(() => {
    adminApi.defaultColors().then(({ light, dark }) => {
      setThemeBasedOnSystem(light, dark, resolvedTheme)
    }).catch(() => {})
    
    if (!chatAvailable) return
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (isMod && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault()
        setChatOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [chatAvailable, resolvedTheme])
  // The "Agents" management page used to live in the sidebar, but it's
  // a configuration surface (KB upload, providers, default selection),
  // not a daily destination. Moved to the user menu (Change password,
  // 2FA, Backups, AI agents).
  const finalNavItems: NavItem[] = useMemo(
    () => visibleNavItems(navItems, hasModule),
    [hasModule],
  )
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform)

  const showTour =
    user &&
    !user.preferences?.onboarding_completed &&
    !localStorage.getItem('onboarding_completed')

  const handleTourComplete = useCallback(async () => {
    localStorage.setItem('onboarding_completed', 'true')
    try {
      const prefs = {
        ...(user?.preferences || {}),
        onboarding_completed: true,
      }
      const updated = await authApi.updateMe({ preferences: prefs })
      updateUser(updated)
    } catch {
      // localStorage fallback is already set
    }
  }, [user, updateUser])

  const userInitial = user?.email?.charAt(0).toUpperCase() ?? '?'
  const resolvedThemeLocal = theme === 'system' ? undefined : theme
  const isDark = resolvedThemeLocal
    ? resolvedThemeLocal === 'dark'
    : typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches
  const toggleTheme = () => setTheme(isDark ? 'light' : 'dark')

  const versionA11yLabel = t('app.versionAriaLabel', { version: APP_VERSION })

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile header */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 bg-sidebar border-b border-sidebar-border px-4 lg:hidden">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="text-sidebar-muted hover:text-sidebar-foreground transition-colors"
          aria-label={t('app.toggleMenu')}
        >
          <Menu size={20} />
        </button>
        <Link
          to="/"
          className="flex items-center gap-2 -mx-1 px-1 py-1 rounded-md hover:bg-sidebar-accent transition-colors"
          aria-label={t('app.name')}
          title={t('nav.dashboard')}
        >
          <ShellLogo size={22} className="text-primary shrink-0" />
          <span className="font-bold text-sidebar-foreground">
            {t('app.name')}
          </span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setPaletteOpen(true)}
            className="text-sidebar-muted hover:text-sidebar-foreground transition-colors p-1"
            title={t('cmdk.triggerAria')}
            aria-label={t('cmdk.triggerAria')}
          >
            <Search size={18} />
          </button>
          <button
            onClick={togglePrivacyMode}
            className="text-sidebar-muted hover:text-sidebar-foreground transition-colors p-1"
            title={privacyMode ? t('privacy.show') : t('privacy.hide')}
          >
            {privacyMode ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
          <button
            onClick={toggleTheme}
            className="text-sidebar-muted hover:text-sidebar-foreground transition-colors p-1"
            title={isDark ? t('settings.themeLight') : t('settings.themeDark')}
            aria-label={
              isDark ? t('settings.themeLight') : t('settings.themeDark')
            }
          >
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          {/* AI chat — opens the global slide-over (also reachable via
              ⌘J). Sits next to the theme toggle so the icon is always
              within thumb reach on mobile too. */}
          {chatAvailable && (
            <button
              onClick={() => setChatOpen(true)}
              className="text-sidebar-muted hover:text-sidebar-foreground transition-colors p-1"
              title={`${t('agents.globalChat.title', 'Chat')} (${isMac ? '⌘J' : 'Ctrl+J'})`}
              aria-label={t('agents.globalChat.openHint', 'Open chat (⌘J)')}
            >
              <Bot size={18} />
            </button>
          )}
          <UserMenu
            userInitial={userInitial}
            logout={logout}
            onChangePassword={() => setChangePasswordOpen(true)}
            onTwoFactor={() => setTwoFactorOpen(true)}
            onPasskeys={() => setPasskeysOpen(true)}
            localAuthEnabled={localAuthEnabled}
            agentsEnabled={agentsEnabled}
            onBackup={() => setBackupOpen(true)}
            dark
            isAdmin={user?.is_superuser}
          />
        </div>
      </header>

      <div className="flex">
        {/* Sidebar overlay for mobile */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        <aside
          data-collapsed={desktopSidebarCollapsed}
          className={cn(
            'group/sidebar fixed inset-y-0 left-0 z-50 w-64 bg-sidebar border-r border-sidebar-border flex flex-col transform transition-[transform,width] duration-300 ease-in-out motion-reduce:transition-none lg:translate-x-0 shrink-0',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full',
            desktopSidebarCollapsed ? 'lg:w-16' : 'lg:w-64',
          )}
        >
          {/* Logo — clickable link to the dashboard. Replaces the
              dedicated 'Painel' nav item so the sidebar stays focused
              on the main destinations. */}
          {/* Collapsed on desktop, the header becomes a column: logo on
              top, then the same privacy / chat / theme buttons stacked,
              so nothing the expanded header offers goes missing in the
              rail. */}
          <div className={cn(
            'flex h-16 min-h-16 items-center justify-between px-5 shrink-0',
            desktopSidebarCollapsed && 'lg:h-auto lg:min-h-0 lg:flex-col lg:justify-center lg:gap-2 lg:px-0 lg:py-3',
          )}>
            <Link
              to="/"
              className="flex items-center gap-2.5 -mx-1 px-1 py-1 rounded-md hover:bg-sidebar-accent transition-colors"
              onClick={() => setSidebarOpen(false)}
              aria-label={t('app.name')}
              title={t('nav.dashboard')}
            >
              <ShellLogo size={24} className="text-primary shrink-0" />
              <span className={cn(
                'font-bold text-lg text-sidebar-foreground tracking-tight',
                desktopSidebarCollapsed && 'lg:hidden',
              )}>
                {t('app.name')}
              </span>
            </Link>
            <div className={cn(
              'flex items-center gap-0.5',
              desktopSidebarCollapsed && 'lg:flex-col lg:gap-1',
            )}>
              <button
                onClick={togglePrivacyMode}
                className={cn(
                  'text-sidebar-muted hover:text-sidebar-foreground transition-colors p-1 rounded-md hover:bg-sidebar-accent',
                  desktopSidebarCollapsed && 'lg:flex lg:h-9 lg:w-9 lg:items-center lg:justify-center lg:p-0 lg:[&>svg]:h-[18px] lg:[&>svg]:w-[18px]',
                )}
                title={privacyMode ? t('privacy.show') : t('privacy.hide')}
                aria-label={privacyMode ? t('privacy.show') : t('privacy.hide')}
              >
                {privacyMode ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              {/* AI chat — same trigger as the mobile bar, ⌘J also
                  works. Lives in the sidebar header so the entry point
                  is visible even on first load (no floating button). */}
              {chatAvailable && (
                <button
                  onClick={() => setChatOpen(true)}
                  className={cn(
                    'text-sidebar-muted hover:text-sidebar-foreground transition-colors p-1 rounded-md hover:bg-sidebar-accent',
                    desktopSidebarCollapsed && 'lg:flex lg:h-9 lg:w-9 lg:items-center lg:justify-center lg:p-0 lg:[&>svg]:h-[18px] lg:[&>svg]:w-[18px]',
                  )}
                  title={`${t('agents.globalChat.title', 'Chat')} (${isMac ? '⌘J' : 'Ctrl+J'})`}
                  aria-label={t('agents.globalChat.openHint', 'Open chat (⌘J)')}
                >
                  <Bot size={16} />
                </button>
              )}
              <button
                onClick={toggleTheme}
                className={cn(
                  'text-sidebar-muted hover:text-sidebar-foreground transition-colors p-1 rounded-md hover:bg-sidebar-accent',
                  desktopSidebarCollapsed && 'lg:flex lg:h-9 lg:w-9 lg:items-center lg:justify-center lg:p-0 lg:[&>svg]:h-[18px] lg:[&>svg]:w-[18px]',
                )}
                title={
                  isDark ? t('settings.themeLight') : t('settings.themeDark')
                }
                aria-label={
                  isDark ? t('settings.themeLight') : t('settings.themeDark')
                }
              >
                {isDark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            </div>
          </div>

          {/* The collapse handle sits on the sidebar's edge, halfway out,
              vertically centred in the viewport: the border is the thing
              that moves, so that is where the control lives. Shown on
              hover and on keyboard focus so it never crowds the header. */}
          <button
            type="button"
            onClick={toggleDesktopSidebar}
            className="hidden lg:flex absolute top-1/2 -right-3 -translate-y-1/2 h-6 w-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/sidebar:opacity-100"
            title={desktopSidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
            aria-label={desktopSidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
            aria-expanded={!desktopSidebarCollapsed}
          >
            {desktopSidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>

          {/* Command palette trigger */}
          <div className={cn('px-3 pt-3', desktopSidebarCollapsed && 'lg:px-2')}>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className={cn(
                'group flex h-11 w-full items-center gap-2.5 rounded-xl border border-sidebar-border bg-card px-3',
                'text-sm text-sidebar-muted transition-colors',
                'hover:text-sidebar-foreground hover:border-input',
                desktopSidebarCollapsed && 'lg:justify-center lg:px-0',
              )}
              aria-label={t('cmdk.triggerAria')}
            >
              <Search size={16} className="shrink-0" />
              <span className={cn('flex-1 text-left', desktopSidebarCollapsed && 'lg:hidden')}>{t('cmdk.triggerLabel')}</span>
              <kbd className={cn('hidden lg:inline-flex h-[17px] items-center rounded border border-sidebar-border bg-sidebar px-1 font-mono text-[9.5px] font-semibold text-sidebar-muted/80', desktopSidebarCollapsed && 'lg:hidden')}>
                {isMac ? '⌘' : 'Ctrl'}&nbsp;K
              </kbd>
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Nav */}
          <nav className={cn('flex flex-col gap-0.5 px-3 pt-1 pb-3', desktopSidebarCollapsed && 'lg:items-center lg:gap-1 lg:px-0 lg:pt-3')} data-tour="sidebar">
            {/* Which modules this workspace shows is resolved server-side,
                so until the workspace list lands there is no honest answer
                — a placeholder beats both an empty sidebar and a guess. */}
            {workspaceLoading && <NavSkeleton />}
            {!workspaceLoading && finalNavItems.map((item, idx) => {
              if (item.type === 'separator') {
                // The first separator sits right below the search bar
                // — without trimming the top padding it leaves a wide
                // gap that makes the section header feel disconnected
                // from the search trigger.
                const isFirstSep = idx === 0
                return (
                  <div key={`sep-${idx}`} className={cn(
                    isFirstSep ? 'pt-3 pb-1.5 px-3' : 'pt-5 pb-1.5 px-3',
                    desktopSidebarCollapsed && 'lg:hidden',
                  )}>
                    <span className="text-[11px] uppercase tracking-[0.06em] font-semibold text-sidebar-muted">
                      {t(item.labelKey)}
                    </span>
                  </div>
                )
              }

              const isActive =
                item.path === '/'
                  ? location.pathname === '/'
                  : location.pathname.startsWith(item.path)
              const Icon = item.icon
              const showQuickAdd = item.key === 'transactions' && canWrite
              const link = (
                <Link
                  key={item.key}
                  to={item.path}
                  data-tour={`nav-${item.key}`}
                  onClick={() => setSidebarOpen(false)}
                  title={t(`nav.${item.key}`)}
                  aria-label={t(`nav.${item.key}`)}
                  className={cn(
                    'flex min-h-11 items-center gap-3 rounded-xl px-3 text-[14.5px] font-medium transition-colors',
                    isActive
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold'
                      : 'text-foreground/75 hover:bg-secondary hover:text-sidebar-foreground',
                    desktopSidebarCollapsed && 'lg:h-10 lg:min-h-10 lg:w-10 lg:justify-center lg:px-0',
                  )}
                >
                  <Icon
                    size={18}
                    className={cn(
                      'shrink-0',
                      isActive ? 'text-sidebar-accent-foreground' : 'text-sidebar-muted',
                      desktopSidebarCollapsed && 'lg:h-5 lg:w-5',
                    )}
                  />
                  <span className={cn(desktopSidebarCollapsed && 'lg:hidden')}>{t(`nav.${item.key}`)}</span>
                </Link>
              )
              if (!showQuickAdd) return link
              return (
                <div key={item.key} className="relative flex items-center">
                  <div className="min-w-0 flex-1">{link}</div>
                  <button
                    type="button"
                    onClick={() => {
                      setSidebarOpen(false)
                      setQuickAddOpen(true)
                    }}
                    title={t('transactions.addManual')}
                    aria-label={t('transactions.addManual')}
                    className={cn(
                      'absolute right-2 flex h-6 w-6 items-center justify-center rounded-md border border-sidebar-border bg-sidebar text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground',
                      desktopSidebarCollapsed && 'lg:hidden',
                    )}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              )
            })}
          </nav>

          </div>

          <div className={cn(desktopSidebarCollapsed && 'lg:hidden')}>
            <UpdateAvailableBanner onOpen={() => setUpdateDialogOpen(true)} />
          </div>

          {/* Merged account + workspace menu — one trigger at the
              bottom of the sidebar shows the active workspace as the
              primary identity, the user email + role as the secondary
              line, and combines workspace switching with all the
              account actions that used to live in a separate dropdown. */}
          <div className={cn('px-3 pt-1', desktopSidebarCollapsed && 'lg:px-2')}>
            <WorkspaceSwitcher
              onChangePassword={() => setChangePasswordOpen(true)}
              onTwoFactor={() => setTwoFactorOpen(true)}
              onPasskeys={() => setPasskeysOpen(true)}
              localAuthEnabled={localAuthEnabled}
              onBackup={() => setBackupOpen(true)}
              onUpdateAvailable={() => setUpdateDialogOpen(true)}
              agentsEnabled={agentsEnabled}
              collapsed={desktopSidebarCollapsed}
            />
          </div>

          <div className={cn('px-3 pb-3 pt-1', desktopSidebarCollapsed && 'lg:hidden')}>
            <div
              className="text-[11px] leading-4 text-sidebar-muted/70 text-center"
              role="note"
            >
              <span className="sr-only">{versionA11yLabel}</span>
              <span aria-hidden="true" className="block break-all line-clamp-2">
                {t('app.versionLabel', { version: APP_VERSION })}
              </span>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className={cn(
          'flex-1 min-h-screen overflow-x-hidden transition-[margin] duration-300 ease-in-out motion-reduce:transition-none',
          desktopSidebarCollapsed ? 'lg:ml-16' : 'lg:ml-64',
        )}>
          <div className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
            {/* Active-collection filter (issue #105): sticky bar above the
                content so the scope is visible right where the data is. */}
            <CollectionSelector variant="header" />
            <Outlet />
          </div>
        </main>
      </div>

      {showTour && <OnboardingTour onComplete={handleTourComplete} />}
      {localAuthEnabled && (
        <ChangePasswordDialog
          open={changePasswordOpen}
          onClose={() => setChangePasswordOpen(false)}
        />
      )}
      <TwoFactorSetup
        open={twoFactorOpen}
        onClose={() => setTwoFactorOpen(false)}
        localAuthEnabled={localAuthEnabled}
      />
      <PasskeyManagementDialog
        open={passkeysOpen}
        onClose={() => setPasskeysOpen(false)}
        localAuthEnabled={localAuthEnabled}
      />
      <BackupDialog open={backupOpen} onClose={() => setBackupOpen(false)} />
      {quickAddOpen && (
        <Suspense fallback={null}>
          <QuickAddTransaction open={quickAddOpen} onClose={() => setQuickAddOpen(false)} />
        </Suspense>
      )}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {/* Slide-over global chat — opened from the sidebar pill or via
          ⌘J. The previous floating bottom-right button was removed
          since the entry point now lives in the sidebar next to ⌘K. */}
      {chatAvailable && <GlobalChatPanel open={chatOpen} onOpenChange={setChatOpen} />}
      <UpdateAvailableDialog
        open={updateDialogOpen}
        onClose={() => setUpdateDialogOpen(false)}
      />
    </div>
  )
}

function UserMenu({
  userInitial,
  logout,
  onChangePassword,
  onTwoFactor,
  onPasskeys,
  localAuthEnabled,
  onBackup,
  dark,
  isAdmin,
  agentsEnabled,
}: {
  userInitial: string
  logout: () => void
  onChangePassword: () => void
  onTwoFactor: () => void
  onPasskeys: () => void
  localAuthEnabled: boolean
  onBackup: () => void
  dark?: boolean
  isAdmin?: boolean
  agentsEnabled?: boolean
}) {
  const { user } = useAuth()
  const { t, i18n } = useTranslation()
  const nav = useNavigate()
  const currentLang = resolveSupportedLang(i18n.resolvedLanguage ?? i18n.language)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-8 w-8 rounded-full p-0" aria-label={t('common.userMenu')}>
          <Avatar className="h-8 w-8">
            <AvatarFallback
              className={
                dark
                  ? 'bg-primary/20 text-primary text-xs font-semibold'
                  : 'bg-primary/10 text-primary text-xs font-semibold'
              }
            >
              {userInitial}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {isAdmin && (
          <>
            <DropdownMenuItem
              onClick={() => nav('/admin')}
              className="flex items-center gap-2"
            >
              <Shield size={14} />
              {t('nav.groupAdmin')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {localAuthEnabled && (
          <DropdownMenuItem
            onClick={onChangePassword}
            className="flex items-center gap-2"
          >
            <KeyRound size={14} />
            {t('auth.changePassword')}
          </DropdownMenuItem>
        )}
        {/* Enrolled factors outlive the switch to OIDC-only. Hiding these
            entries would strand the user with a factor and no way to remove
            it, since the product has no recovery codes. */}
        {(localAuthEnabled || user?.is_2fa_enabled) && (
          <DropdownMenuItem
            onClick={onTwoFactor}
            className="flex items-center gap-2"
          >
            <ShieldCheck size={14} />
            {t(localAuthEnabled ? 'auth.twoFactorTitle' : 'auth.disable2fa')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={onPasskeys}
          className="flex items-center gap-2"
        >
          <Fingerprint size={14} />
          {t('auth.passkeysTitle')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={onBackup}
          className="flex items-center gap-2"
        >
          <HardDriveDownload size={14} />
          {t('backup.button')}
        </DropdownMenuItem>
        {agentsEnabled && (
          <DropdownMenuItem
            onClick={() => nav('/agents')}
            className="flex items-center gap-2"
          >
            <Sparkles size={14} />
            {t('nav.aiAgents')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="flex items-center gap-2">
            <Languages size={14} />
            <span className="flex-1">{t('setup.language')}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {currentLang.split('-')[0]}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="w-40">
              <DropdownMenuLabel className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                {t('setup.language')}
              </DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('ru')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Русский</span>
                {currentLang === 'ru' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('de')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Deutsch</span>
                {currentLang === 'de' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('uk')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Українська</span>
                {currentLang === 'uk' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('pt-BR')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Português (BR)</span>
                {currentLang === 'pt-BR' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('pt-PT')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Português (PT)</span>
                {currentLang === 'pt-PT' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('en')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">English</span>
                {currentLang === 'en' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('es')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Español</span>
                {currentLang === 'es' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('hi')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">हिन्दी</span>
                {currentLang === 'hi' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('pl')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Polski</span>
                {currentLang === 'pl' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('it')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Italiano</span>
                {currentLang === 'it' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('fr')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Français</span>
                {currentLang === 'fr' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('nl')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Nederlands</span>
                {currentLang === 'nl' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('sk')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Slovenčina</span>
                {currentLang === 'sk' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('el')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">Ελληνικά</span>
                {currentLang === 'el' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => i18n.changeLanguage('ja')}
                className="flex items-center gap-2"
              >
                <span className="flex-1">日本語</span>
                {currentLang === 'ja' && (
                  <Check size={13} className="text-primary" />
                )}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={logout}
          className="text-rose-600 focus:text-rose-600"
        >
          {t('auth.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
