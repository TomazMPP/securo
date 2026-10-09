import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { currencies as currenciesApi } from '@/lib/api'
import { getAccountName, sortAccountsByDisplayName } from '@/lib/account-utils'
import { localDateString } from '@/lib/date-utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DialogFooter } from '@/components/ui/dialog'
import { CategorySelect } from '@/components/category-select'
import { DatePickerInput } from '@/components/ui/date-picker-input'
import { useAuth } from '@/contexts/auth-context'
import type { Category, CategoryGroup, RecurringTransaction } from '@/types'

export function RecurringForm({
  recurring,
  categories,
  categoryGroups,
  currentCategory,
  accounts,
  onSave,
  onCancel,
  loading,
  defaultType = 'debit',
}: {
  recurring: RecurringTransaction | null
  categories: Category[]
  categoryGroups: CategoryGroup[]
  currentCategory?: Category
  accounts: { id: string; name: string; display_name?: string | null }[]
  onSave: (data: Partial<RecurringTransaction>) => void
  onCancel: () => void
  loading: boolean
  /** Type preselected when creating a new rule. */
  defaultType?: 'debit' | 'credit'
}) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const userCurrency = user?.preferences?.currency_display ?? 'USD'
  const sortedAccounts = useMemo(() => sortAccountsByDisplayName(accounts), [accounts])
  const { data: supportedCurrencies } = useQuery({
    queryKey: ['currencies'],
    queryFn: currenciesApi.list,
    staleTime: Infinity,
  })
  const [description, setDescription] = useState(recurring?.description ?? '')
  const [amount, setAmount] = useState(recurring?.amount?.toString() ?? '')
  const [currency, setCurrency] = useState(recurring?.currency ?? userCurrency)
  const [type, setType] = useState<'debit' | 'credit'>(recurring?.type ?? defaultType)
  const [frequency, setFrequency] = useState(recurring?.frequency ?? 'monthly')
  const [weekendAdjustment, setWeekendAdjustment] = useState<RecurringTransaction['weekend_adjustment']>(
    recurring?.weekend_adjustment ?? 'none'
  )
  const [dayOfMonth, setDayOfMonth] = useState(recurring?.day_of_month?.toString() ?? '')
  const [startDate, setStartDate] = useState(recurring?.start_date ?? localDateString())
  const [endDate, setEndDate] = useState(recurring?.end_date ?? '')
  const [categoryId, setCategoryId] = useState(recurring?.category_id ?? '')
  const [accountId, setAccountId] = useState(recurring?.account_id ?? sortedAccounts[0]?.id ?? '')
  const [isActive, setIsActive] = useState(recurring?.is_active ?? true)
  const [autoGenerate, setAutoGenerate] = useState(recurring?.auto_generate ?? true)

  const selectClass = 'w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary'

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave({
          description,
          amount: parseFloat(amount),
          currency,
          type,
          frequency,
          weekend_adjustment: weekendAdjustment,
          day_of_month: dayOfMonth ? parseInt(dayOfMonth) : null,
          start_date: startDate,
          end_date: endDate || null,
          category_id: categoryId || null,
          account_id: accountId || null,
          is_active: isActive,
          auto_generate: autoGenerate,
        } as Partial<RecurringTransaction>)
      }}
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label>{t('recurring.description')}</Label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} required />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>{t('recurring.amount')}</Label>
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label>{t('recurring.currency')}</Label>
          <select className={selectClass} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {(supportedCurrencies ?? [{ code: userCurrency, symbol: userCurrency, name: userCurrency, flag: '' }]).map((c) => (
              <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label>{t('recurring.type')}</Label>
          <select className={selectClass} value={type} onChange={(e) => setType(e.target.value as 'debit' | 'credit')}>
            <option value="debit">{t('recurring.expense')}</option>
            <option value="credit">{t('recurring.income')}</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t('recurring.frequency')}</Label>
          <select className={selectClass} value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringTransaction['frequency'])}>
            <option value="monthly">{t('recurring.monthly')}</option>
            <option value="quarterly">{t('recurring.quarterly')}</option>
            <option value="semiannual">{t('recurring.semiannual')}</option>
            <option value="weekly">{t('recurring.weekly')}</option>
            <option value="biweekly">{t('recurring.biweekly')}</option>
            <option value="yearly">{t('recurring.yearly')}</option>
          </select>
        </div>
        {(frequency === 'monthly' || frequency === 'quarterly' || frequency === 'semiannual') && (
          <div className="space-y-2">
            <Label>{t('recurring.dayOfMonth')}</Label>
            <Input type="number" min="1" max="31" value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} />
          </div>
        )}
      </div>
      <div className="space-y-2">
        <Label>{t('recurring.weekendAdjustment')}</Label>
        <select
          className={selectClass}
          value={weekendAdjustment}
          onChange={(e) => setWeekendAdjustment(e.target.value as RecurringTransaction['weekend_adjustment'])}
        >
          <option value="none">{t('recurring.weekendAdjustmentNone')}</option>
          <option value="previous_friday">{t('recurring.weekendAdjustmentPreviousFriday')}</option>
          <option value="next_monday">{t('recurring.weekendAdjustmentNextMonday')}</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t('recurring.startDate')}</Label>
          <DatePickerInput value={startDate} onChange={setStartDate} className="w-full justify-start" />
        </div>
        <div className="space-y-2">
          <Label>{t('recurring.endDate')}</Label>
          <DatePickerInput value={endDate} onChange={setEndDate} placeholder={t('recurring.endDate')} className="w-full justify-start" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t('recurring.category')}</Label>
          <CategorySelect
            value={categoryId}
            onChange={setCategoryId}
            categories={categories}
            groups={categoryGroups}
            currentCategory={currentCategory}
            allowNone={true}
            className={selectClass}
          />
        </div>
        <div className="space-y-2">
          <Label>{t('recurring.account')}</Label>
          <select
            className={selectClass}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
          >
            {!accountId && <option value="" disabled>{t('recurring.noAccount')}</option>}
            {sortedAccounts.map((acc) => (
              <option key={acc.id} value={acc.id}>{getAccountName(acc)}</option>
            ))}
          </select>
        </div>
      </div>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={autoGenerate}
          onChange={(e) => setAutoGenerate(e.target.checked)}
          className="h-4 w-4 mt-0.5 rounded border-border"
        />
        <span className="text-sm text-foreground">
          {t('recurring.autoGenerate')}
          <span className="block text-xs text-muted-foreground">{t('recurring.autoGenerateHelp')}</span>
        </span>
      </label>
      {recurring && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          <span className="text-sm text-foreground">{t('recurring.active')}</span>
        </label>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" disabled={loading}>
          {loading ? t('common.loading') : t('common.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}
