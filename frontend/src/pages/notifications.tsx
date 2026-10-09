import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, BellRing, CalendarClock, FileBarChart, Mail, Newspaper, Send } from 'lucide-react'
import { notifications as api } from '@/lib/api'
import type { NotificationKind, NotificationPrefs } from '@/types'
import { PageHeader } from '@/components/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const KINDS: { kind: NotificationKind; pref: keyof NotificationPrefs; icon: typeof Mail }[] = [
  { kind: 'monthly', pref: 'monthly_report', icon: FileBarChart },
  { kind: 'weekly', pref: 'weekly_digest', icon: Newspaper },
  { kind: 'bills', pref: 'bill_reminders', icon: CalendarClock },
  { kind: 'alerts', pref: 'spend_alerts', icon: AlertTriangle },
]

export default function NotificationsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['notifications'], queryFn: api.get })
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null)
  const [previewKind, setPreviewKind] = useState<NotificationKind>('monthly')

  useEffect(() => {
    if (data) setPrefs(data.preferences)
  }, [data])

  const save = useMutation({
    mutationFn: api.update,
    onSuccess: (next) => {
      qc.setQueryData(['notifications'], next)
      toast.success(t('notifications.saved'))
    },
    onError: () => toast.error(t('notifications.saveFailed')),
  })
  const test = useMutation({
    mutationFn: api.sendTest,
    onSuccess: (r) => toast.success(t('notifications.testSent', { email: r.to })),
    onError: () => toast.error(t('notifications.testFailed')),
  })
  const preview = useQuery({
    queryKey: ['notifications', 'preview', previewKind],
    queryFn: () => api.preview(previewKind),
    retry: false,
  })

  if (isLoading || !prefs || !data) {
    return (
      <div>
        <PageHeader section={t('nav.groupSetup')} title={t('notifications.title')} />
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    )
  }

  const set = <K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]) => setPrefs({ ...prefs, [key]: value })
  const dirty = JSON.stringify(prefs) !== JSON.stringify(data.preferences)

  return (
    <div>
      <PageHeader
        section={t('nav.groupSetup')}
        title={t('notifications.title')}
        action={
          <Button onClick={() => save.mutate(prefs)} disabled={!dirty || save.isPending}>
            {t('notifications.save')}
          </Button>
        }
      />

      {!data.email_configured && (
        <p className="mb-5 flex gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <AlertTriangle size={18} className="mt-px shrink-0" />
          {t('notifications.notConfigured')}
        </p>
      )}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-5">
          <Card className="gap-0 p-5 sm:p-6">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground"><BellRing size={20} /></span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{t('notifications.master')}</div>
                <div className="truncate text-[13px] text-muted-foreground">{t('notifications.sentTo', { email: data.recipient })}</div>
              </div>
              <Switch checked={prefs.enabled} onCheckedChange={(v) => set('enabled', v)} aria-labelledby="notif-master" />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-[13px] font-medium">
                {t('notifications.email')}
                <input
                  type="email"
                  value={prefs.email ?? ''}
                  placeholder={data.recipient}
                  onChange={(e) => set('email', e.target.value || null)}
                  className="mt-1 h-10 w-full rounded-xl border border-input bg-card px-3 text-sm outline-none focus:border-ring"
                />
              </label>
              <label className="text-[13px] font-medium">
                {t('notifications.sendHour')}
                <select
                  value={prefs.send_hour}
                  onChange={(e) => set('send_hour', Number(e.target.value))}
                  className="mt-1 h-10 w-full rounded-xl border border-input bg-card px-3 text-sm outline-none focus:border-ring"
                >
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
                </select>
              </label>
            </div>
          </Card>

          <Card className={cn('gap-0 p-0', !prefs.enabled && 'opacity-60')}>
            {KINDS.map(({ kind, pref, icon: Icon }) => (
              <div key={kind} className="border-b px-5 py-4 last:border-0 sm:px-6">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground/70"><Icon size={18} /></span>
                  <div className="min-w-0 flex-1">
                    <div id={`notif-${kind}`} className="font-semibold">{t(`notifications.kind.${kind}.title`)}</div>
                    <div className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{t(`notifications.kind.${kind}.description`)}</div>
                  </div>
                  <Switch
                    checked={Boolean(prefs[pref])}
                    disabled={!prefs.enabled}
                    onCheckedChange={(v) => set(pref, v as never)}
                    aria-labelledby={`notif-${kind}`}
                  />
                </div>
                {kind === 'bills' && prefs.bill_reminders && (
                  <label className="mt-3 ml-12 flex items-center gap-2 text-[13px]">
                    {t('notifications.daysBefore')}
                    <input type="number" min={1} max={14} value={prefs.bill_reminder_days}
                      onChange={(e) => set('bill_reminder_days', Math.max(1, Math.min(14, Number(e.target.value) || 1)))}
                      className="h-9 w-16 rounded-lg border border-input bg-card px-2 text-sm tabular-nums" />
                  </label>
                )}
                {kind === 'alerts' && (
                  <div className="mt-3 ml-12 flex flex-col gap-2.5 text-[13px]">
                    {prefs.spend_alerts && (
                      <label className="flex items-center gap-2">
                        {t('notifications.threshold')}
                        <input type="number" min={0} step={100} value={prefs.large_transaction_threshold}
                          onChange={(e) => set('large_transaction_threshold', Math.max(0, Number(e.target.value) || 0))}
                          className="h-9 w-28 rounded-lg border border-input bg-card px-2 text-sm tabular-nums" />
                      </label>
                    )}
                    {(['budget_alerts', 'category_spike_alerts', 'connection_alerts'] as const).map((k) => (
                      <div key={k} className="flex items-center justify-between gap-3">
                        <span id={`notif-${k}`}>{t(`notifications.${k}`)}</span>
                        <Switch checked={prefs[k]} disabled={!prefs.enabled} onCheckedChange={(v) => set(k, v)} aria-labelledby={`notif-${k}`} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </Card>
        </div>

        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <div role="tablist" aria-label={t('notifications.preview')} className="inline-flex flex-wrap gap-1 rounded-xl bg-secondary p-1">
              {KINDS.map(({ kind }) => (
                <button key={kind} role="tab" aria-selected={previewKind === kind} onClick={() => setPreviewKind(kind)}
                  className={cn('h-8 rounded-lg px-3 text-[13px] font-medium text-muted-foreground', previewKind === kind && 'bg-card font-semibold text-foreground shadow-xs')}>
                  {t(`notifications.kind.${kind}.short`)}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="ml-auto" disabled={!data.email_configured || test.isPending}
              onClick={() => test.mutate(previewKind)}>
              <Send size={14} />{t('notifications.sendTest')}
            </Button>
          </div>
          {preview.isLoading && <Skeleton className="m-4 h-[560px] rounded-xl" />}
          {preview.isError && <p className="px-6 py-16 text-center text-sm text-muted-foreground">{t('notifications.previewEmpty')}</p>}
          {preview.data && (
            <iframe title={t('notifications.preview')} srcDoc={preview.data} sandbox="" className="h-[680px] w-full border-0 bg-[#F5F6F8]" />
          )}
        </Card>
      </div>
    </div>
  )
}
