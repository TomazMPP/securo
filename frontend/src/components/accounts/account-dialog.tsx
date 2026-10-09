import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { currencies } from '@/lib/api'
import { localDateString } from '@/lib/date-utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { DatePickerInput } from '@/components/ui/date-picker-input'
import { useAuth } from '@/contexts/auth-context'
import type { Account } from '@/types'

// Account types offered in the create/edit dialog. Shared between the manual
// type selector and the connected-account override selector so the list stays
// in one place.
const ACCOUNT_TYPE_OPTIONS = [
  { value: 'checking', labelKey: 'accounts.typeChecking' },
  { value: 'savings', labelKey: 'accounts.typeSavings' },
  { value: 'credit_card', labelKey: 'accounts.typeCreditCard' },
  { value: 'investment', labelKey: 'accounts.typeInvestment' },
  { value: 'wallet', labelKey: 'accounts.typeWallet' },
  { value: 'loan', labelKey: 'accounts.typeLoan' },
] as const

export function AccountDialog({
  open,
  onClose,
  account,
  onSave,
  loading,
}: {
  open: boolean
  onClose: () => void
  account: Account | null
  onSave: (data: {
    name?: string
    display_name?: string | null
    type?: string
    balance?: number
    balance_date?: string
    currency?: string
    credit_limit?: number | null
    statement_close_day?: number | null
    payment_due_day?: number | null
  }) => void
  loading: boolean
}) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const { data: supportedCurrencies } = useQuery({
    queryKey: ['currencies'],
    queryFn: currencies.list,
    staleTime: Infinity,
  })
  const [name, setName] = useState(account?.name ?? '')
  const [displayName, setDisplayName] = useState(account?.display_name ?? '')
  const [type, setType] = useState(account?.type ?? 'checking')
  const [balance, setBalance] = useState(account?.balance?.toString() ?? '0')
  const [currency, setCurrency] = useState(account?.currency ?? userCurrency)
  const [balanceDate, setBalanceDate] = useState(localDateString)
  const [creditLimit, setCreditLimit] = useState(account?.credit_limit?.toString() ?? '')
  const [statementCloseDay, setStatementCloseDay] = useState(account?.statement_close_day?.toString() ?? '')
  const [paymentDueDay, setPaymentDueDay] = useState(account?.payment_due_day?.toString() ?? '')

  const [formSource, setFormSource] = useState<{ account: typeof account } | null>(null)
  if (!formSource || formSource.account !== account) {
    setFormSource({ account })
    setName(account?.name ?? '')
    setDisplayName(account?.display_name ?? '')
    setType(account?.type ?? 'checking')
    setBalance(account?.balance?.toString() ?? '0')
    setCurrency(account?.currency ?? userCurrency)
    setBalanceDate(localDateString())
    setCreditLimit(account?.credit_limit?.toString() ?? '')
    setStatementCloseDay(account?.statement_close_day?.toString() ?? '')
    setPaymentDueDay(account?.payment_due_day?.toString() ?? '')
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {account ? t('accounts.editAccount') : t('accounts.addManual')}
          </DialogTitle>
        </DialogHeader>
        <form
          key={account?.id ?? 'new'}
          onSubmit={(e) => {
            e.preventDefault()
            const isCC = type === 'credit_card'
            const parseDay = (v: string) => {
              const n = parseInt(v, 10)
              return Number.isFinite(n) && n >= 1 && n <= 31 ? n : null
            }
            const isConnected = !!account?.connection_id
            onSave({
              ...(!isConnected && { name, balance: parseFloat(balance), balance_date: balanceDate, currency }),
              type,
              display_name: displayName.trim() || null,
              ...(isCC && {
                credit_limit: creditLimit !== '' ? parseFloat(creditLimit) : null,
                statement_close_day: parseDay(statementCloseDay),
                payment_due_day: parseDay(paymentDueDay),
              }),
            })
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label>{t('accounts.accountName')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required disabled={!!account?.connection_id} />
          </div>
          {account?.connection_id && (
            <div className="space-y-2">
              <Label>{t('accounts.displayName')}</Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={name}
              />
              <p className="text-xs text-muted-foreground">{t('accounts.displayNameHint')}</p>
            </div>
          )}
          {account?.connection_id && (
            <div className="space-y-2">
              <Label>{t('accounts.accountType')}</Label>
              <select
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                {ACCOUNT_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t('accounts.typeOverrideHint')}</p>
            </div>
          )}
          {!account?.connection_id && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('accounts.accountType')}</Label>
                  <select
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                  >
                    {ACCOUNT_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>{t('accounts.currency')}</Label>
                  <select
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                  >
                    {(supportedCurrencies ?? [{ code: userCurrency, symbol: userCurrency, name: userCurrency, flag: '' }]).map((c) => (
                      <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>
                    {type === 'credit_card'
                      ? t('accounts.balanceCreditCard')
                      : t('accounts.balance')}
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    min={type === 'credit_card' ? '0' : undefined}
                    value={balance}
                    onChange={(e) => setBalance(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('accounts.balanceDate')}</Label>
                  <DatePickerInput
                    value={balanceDate}
                    onChange={setBalanceDate}
                    className="w-full justify-start"
                  />
                </div>
              </div>
              {type === 'credit_card' && (
                <p className="text-xs text-muted-foreground -mt-2">
                  {t('accounts.balanceCreditCardHint')}
                </p>
              )}
            </>
          )}
          {type === 'credit_card' && (
            <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
              <div className="space-y-2">
                <Label>{t('accounts.creditLimit')}</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={creditLimit}
                  onChange={(e) => setCreditLimit(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('accounts.statementCloseDay')}</Label>
                  <Input
                    type="number"
                    min="1"
                    max="31"
                    value={statementCloseDay}
                    onChange={(e) => setStatementCloseDay(e.target.value)}
                    placeholder={t('accounts.dayOfMonthHint')}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('accounts.paymentDueDay')}</Label>
                  <Input
                    type="number"
                    min="1"
                    max="31"
                    value={paymentDueDay}
                    onChange={(e) => setPaymentDueDay(e.target.value)}
                    placeholder={t('accounts.dayOfMonthHint')}
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? t('common.loading') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
