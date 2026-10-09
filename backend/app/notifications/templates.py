"""HTML (and plain-text) bodies for the notification emails.

Email clients ignore <style> blocks and modern layout, so everything is
inline-styled tables. Copy ships in Portuguese and English.
"""

from __future__ import annotations

from datetime import date, timedelta
from html import escape

from app.notifications.content import Alerts, BillLine, MonthlyReport, WeeklyDigest
from app.notifications.fmt import money, month_name, pct, short_date

BLUE = "#2456E6"
INK = "#14161A"
MUTED = "#5F6672"
LINE = "#EEF0F3"
GREEN = "#0B7A41"
RED = "#B42323"
FONT = "'Plus Jakarta Sans', 'Segoe UI', Arial, sans-serif"

T = {
    "pt": {
        "monthly_subject": "Seu mês de {month}: {net}",
        "monthly_title": "Resumo de {month}",
        "income": "Receitas",
        "expenses": "Gastos",
        "result": "Resultado",
        "saved": "Você guardou {rate} do que entrou.",
        "overspent": "Você gastou {amount} a mais do que entrou.",
        "vs_prev": "Gastos {change} em relação a {month}.",
        "top_categories": "Onde foi o dinheiro",
        "top_expenses": "Maiores gastos",
        "over_budget": "Orçamentos estourados",
        "net_worth": "Patrimônio líquido",
        "net_worth_change": "{change} no mês",
        "goals": "Metas",
        "of": "de",
        "upcoming": "Já previsto para {month}: {count} cobranças somando {total}.",
        "uncategorized": "{count} transações sem categoria. Categorizar deixa os relatórios mais precisos.",
        "open_app": "Abrir o Securo",
        "weekly_subject": "Sua semana: {amount} em gastos",
        "weekly_title": "Semana de {start} a {end}",
        "week_spent": "Gasto na semana",
        "vs_avg_below": "{change} abaixo da sua média semanal ({avg}).",
        "vs_avg_above": "{change} acima da sua média semanal ({avg}).",
        "next_7": "Próximos 7 dias",
        "nothing_due": "Nada previsto para os próximos dias.",
        "bills_subject": "{count} contas vencem nos próximos dias",
        "bills_subject_one": "1 conta vence nos próximos dias",
        "bills_title": "Contas a vencer",
        "bills_intro": "Estas contas vencem até {date}:",
        "total": "Total",
        "kind_recurring": "Recorrente",
        "kind_card_bill": "Fatura do cartão",
        "kind_loan": "Parcela do financiamento",
        "alerts_subject": "Alerta do Securo: {what}",
        "alerts_title": "Alertas",
        "large_tx": "Gastos acima de {threshold}",
        "budget_over": "{name}: {pct} do orçamento ({actual} de {budget})",
        "budgets": "Orçamentos",
        "spikes": "Categorias acima do normal",
        "spike_line": "{name}: {mtd} este mês, contra média de {avg}",
        "connections": "Conexões bancárias",
        "conn_line": "{name} precisa ser reconectado ({status}).",
        "what_large": "gasto alto",
        "what_budget": "orçamento",
        "what_spike": "categoria acima do normal",
        "what_conn": "conexão bancária",
        "footer": "Você recebe este email porque ativou as notificações do Securo. Ajuste em Configurações › Notificações.",
        "test_note": "Este é um email de teste.",
    },
    "en": {
        "monthly_subject": "Your {month}: {net}",
        "monthly_title": "{month} in review",
        "income": "Income",
        "expenses": "Spending",
        "result": "Result",
        "saved": "You kept {rate} of what came in.",
        "overspent": "You spent {amount} more than came in.",
        "vs_prev": "Spending {change} compared with {month}.",
        "top_categories": "Where the money went",
        "top_expenses": "Biggest expenses",
        "over_budget": "Budgets exceeded",
        "net_worth": "Net worth",
        "net_worth_change": "{change} this month",
        "goals": "Goals",
        "of": "of",
        "upcoming": "Already scheduled for {month}: {count} charges totalling {total}.",
        "uncategorized": "{count} transactions have no category. Categorizing them sharpens your reports.",
        "open_app": "Open Securo",
        "weekly_subject": "Your week: {amount} spent",
        "weekly_title": "Week of {start} to {end}",
        "week_spent": "Spent this week",
        "vs_avg_below": "{change} below your weekly average ({avg}).",
        "vs_avg_above": "{change} above your weekly average ({avg}).",
        "next_7": "Next 7 days",
        "nothing_due": "Nothing scheduled for the next few days.",
        "bills_subject": "{count} bills due in the next few days",
        "bills_subject_one": "1 bill due in the next few days",
        "bills_title": "Bills due soon",
        "bills_intro": "These are due by {date}:",
        "total": "Total",
        "kind_recurring": "Recurring",
        "kind_card_bill": "Card bill",
        "kind_loan": "Loan installment",
        "alerts_subject": "Securo alert: {what}",
        "alerts_title": "Alerts",
        "large_tx": "Expenses above {threshold}",
        "budget_over": "{name}: {pct} of budget ({actual} of {budget})",
        "budgets": "Budgets",
        "spikes": "Categories above normal",
        "spike_line": "{name}: {mtd} this month vs an average of {avg}",
        "connections": "Bank connections",
        "conn_line": "{name} needs to be reconnected ({status}).",
        "what_large": "large expense",
        "what_budget": "budget",
        "what_spike": "category above normal",
        "what_conn": "bank connection",
        "footer": "You get this email because Securo notifications are on. Change them in Settings › Notifications.",
        "test_note": "This is a test email.",
    },
}


def _layout(title: str, body: str, lang: str, app_url: str, test: bool = False) -> str:
    t = T[lang]
    note = f'<p style="margin:0 0 16px;padding:10px 14px;background:#FFF7E8;border-radius:10px;color:#5A3D08;font-size:13px">{escape(t["test_note"])}</p>' if test else ""
    return f"""<!doctype html>
<html lang="{'pt-BR' if lang == 'pt' else 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)}</title></head>
<body style="margin:0;padding:0;background:#F5F6F8;font-family:{FONT};color:{INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="padding:4px 4px 16px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="width:30px;height:30px;background:{BLUE};border-radius:8px;text-align:center;color:#fff;font-weight:700;font-size:15px">S</td>
    <td style="padding-left:10px;font-size:18px;font-weight:700;letter-spacing:-0.02em">securo</td>
  </tr></table>
</td></tr>
<tr><td style="background:#fff;border:1px solid #E8EAEE;border-radius:18px;padding:26px 24px">
  {note}
  <h1 style="margin:0 0 18px;font-size:21px;font-weight:700;letter-spacing:-0.01em">{escape(title)}</h1>
  {body}
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px"><tr><td style="background:{BLUE};border-radius:12px">
    <a href="{escape(app_url)}" style="display:inline-block;padding:12px 20px;color:#fff;text-decoration:none;font-weight:600;font-size:14px">{escape(t['open_app'])}</a>
  </td></tr></table>
</td></tr>
<tr><td style="padding:16px 8px;font-size:12px;line-height:1.5;color:{MUTED};text-align:center">{escape(t['footer'])}</td></tr>
</table></td></tr></table></body></html>"""


def _section(title: str) -> str:
    return f'<h2 style="margin:24px 0 8px;font-size:13px;font-weight:600;color:{MUTED};text-transform:uppercase;letter-spacing:0.05em">{escape(title)}</h2>'


def _row(left: str, right: str, sub: str = "", right_color: str = INK, dot: str | None = None) -> str:
    dot_html = f'<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:{dot};margin-right:8px"></span>' if dot else ""
    sub_html = f'<div style="font-size:12px;color:{MUTED};margin-top:2px">{sub}</div>' if sub else ""
    return f"""<tr><td style="padding:10px 0;border-bottom:1px solid {LINE};font-size:14px">{dot_html}{left}{sub_html}</td>
<td style="padding:10px 0;border-bottom:1px solid {LINE};font-size:14px;font-weight:600;text-align:right;white-space:nowrap;color:{right_color}">{right}</td></tr>"""


def _table(rows: list[str]) -> str:
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table>'


def _kpis(items: list[tuple[str, str, str]]) -> str:
    cells = "".join(
        f'<td style="padding:12px 14px;background:#F5F6F8;border-radius:12px;width:{100 // len(items)}%"><div style="font-size:12px;color:{MUTED};font-weight:600">{escape(label)}</div>'
        f'<div style="font-size:18px;font-weight:700;color:{color};margin-top:2px">{escape(value)}</div></td>'
        + ('<td style="width:8px"></td>' if i < len(items) - 1 else "")
        for i, (label, value, color) in enumerate(items)
    )
    return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{cells}</tr></table>'


def _p(text: str, color: str = INK) -> str:
    return f'<p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:{color}">{text}</p>'


def render_monthly(r: MonthlyReport, lang: str, app_url: str, test: bool = False) -> tuple[str, str, str]:
    t, cur = T[lang], r.currency
    m = month_name(r.month, lang)
    title = t["monthly_title"].format(month=m.capitalize())
    subject = t["monthly_subject"].format(month=m, net=money(r.net, cur, lang, signed=True))
    body = _kpis([
        (t["income"], money(r.income, cur, lang), GREEN),
        (t["expenses"], money(r.expenses, cur, lang), RED),
        (t["result"], money(r.net, cur, lang, signed=True), GREEN if r.net >= 0 else RED),
    ])
    if r.savings_rate is not None and r.net >= 0:
        body += _p(t["saved"].format(rate=f"<b>{pct(r.savings_rate, lang)}</b>"))
    elif r.net < 0:
        body += _p(t["overspent"].format(amount=f"<b>{money(-r.net, cur, lang)}</b>"))
    if r.expenses_change is not None:
        body += _p(t["vs_prev"].format(change=f"<b>{pct(r.expenses_change, lang, signed=True)}</b>", month=month_name(r.month.replace(day=1) - timedelta(days=1), lang)), MUTED)
    if r.categories:
        body += _section(t["top_categories"]) + _table([
            _row(escape(c.name), money(c.amount, cur, lang), pct(c.change, lang, signed=True) if c.change is not None else "", dot=c.color)
            for c in r.categories
        ])
    if r.top_expenses:
        body += _section(t["top_expenses"]) + _table([
            _row(escape(x.description), money(x.amount, cur, lang), escape(f"{short_date(x.date, lang)}" + (f" · {x.category}" if x.category else "")))
            for x in r.top_expenses
        ])
    if r.over_budget:
        body += _section(t["over_budget"]) + _table([
            _row(escape(name), f"{money(actual, cur, lang)} / {money(budget, cur, lang)}", right_color=RED)
            for name, actual, budget in r.over_budget
        ])
    if r.net_worth is not None:
        change = t["net_worth_change"].format(change=money(r.net_worth_change, cur, lang, signed=True)) if r.net_worth_change is not None else ""
        body += _section(t["net_worth"]) + _table([_row(f"<b>{money(r.net_worth, cur, lang)}</b>", change, right_color=GREEN if (r.net_worth_change or 0) >= 0 else RED)])
    if r.goals:
        body += _section(t["goals"]) + _table([
            _row(escape(name), f"{pct(cur_ / target, lang)}", f"{money(cur_, cur, lang)} {t['of']} {money(target, cur, lang)}")
            for name, cur_, target in r.goals
        ])
    next_month = (r.month.replace(day=28) + timedelta(days=4)).replace(day=1)
    if r.upcoming_count:
        body += _p(t["upcoming"].format(month=month_name(next_month, lang), count=r.upcoming_count, total=f"<b>{money(r.upcoming_total, cur, lang)}</b>"))
    if r.uncategorized:
        body += _p(t["uncategorized"].format(count=r.uncategorized), MUTED)
    text = f"{title}\n{t['income']}: {money(r.income, cur, lang)}\n{t['expenses']}: {money(r.expenses, cur, lang)}\n{t['result']}: {money(r.net, cur, lang, signed=True)}\n{app_url}"
    return subject, _layout(title, body, lang, app_url, test), text


def render_weekly(w: WeeklyDigest, lang: str, app_url: str, test: bool = False) -> tuple[str, str, str]:
    t, cur = T[lang], w.currency
    title = t["weekly_title"].format(start=short_date(w.start, lang), end=short_date(w.end, lang))
    subject = t["weekly_subject"].format(amount=money(w.expenses, cur, lang))
    body = _kpis([(t["week_spent"], money(w.expenses, cur, lang), INK), (t["income"], money(w.income, cur, lang), GREEN)])
    if w.vs_average is not None:
        key = "vs_avg_below" if w.vs_average < 0 else "vs_avg_above"
        body += _p(t[key].format(change=f"<b>{pct(abs(w.vs_average), lang)}</b>", avg=money(w.weekly_average, cur, lang)))
    if w.categories:
        body += _section(t["top_categories"]) + _table([_row(escape(c.name), money(c.amount, cur, lang), dot=c.color) for c in w.categories])
    if w.top_expenses:
        body += _section(t["top_expenses"]) + _table([
            _row(escape(x.description), money(x.amount, cur, lang), escape(short_date(x.date, lang) + (f" · {x.category}" if x.category else "")))
            for x in w.top_expenses
        ])
    body += _section(t["next_7"])
    body += _bills_table(w.upcoming, lang, cur) if w.upcoming else _p(t["nothing_due"], MUTED)
    text = f"{title}\n{t['week_spent']}: {money(w.expenses, cur, lang)}\n{app_url}"
    return subject, _layout(title, body, lang, app_url, test), text


def _bills_table(bills: list[BillLine], lang: str, cur: str) -> str:
    t = T[lang]
    rows = [_row(escape(b.name), money(b.amount, cur, lang), escape(f"{short_date(b.date, lang)} · {t['kind_' + b.kind]}")) for b in bills]
    rows.append(_row(f"<b>{escape(t['total'])}</b>", money(sum(b.amount for b in bills), cur, lang)))
    return _table(rows)


def render_bills(bills: list[BillLine], until: date, currency: str, lang: str, app_url: str, test: bool = False) -> tuple[str, str, str]:
    t = T[lang]
    subject = t["bills_subject_one"] if len(bills) == 1 else t["bills_subject"].format(count=len(bills))
    body = _p(t["bills_intro"].format(date=short_date(until, lang)), MUTED) + _bills_table(bills, lang, currency)
    text = "\n".join(f"{b.date} {b.name} {money(b.amount, currency, lang)}" for b in bills)
    return subject, _layout(t["bills_title"], body, lang, app_url, test), text


def render_alerts(a: Alerts, threshold: float, lang: str, app_url: str, test: bool = False) -> tuple[str, str, str]:
    t, cur = T[lang], a.currency
    what = []
    body = ""
    if a.large:
        what.append(t["what_large"])
        body += _section(t["large_tx"].format(threshold=money(threshold, cur, lang))) + _table([
            _row(escape(x.description), money(x.amount, cur, lang), escape(short_date(x.date, lang) + (f" · {x.category}" if x.category else "")))
            for _, x in a.large
        ])
    if a.budgets:
        what.append(t["what_budget"])
        body += _section(t["budgets"]) + _table([
            _row(t["budget_over"].format(name=escape(name), pct=pct(ratio, lang), actual=money(actual, cur, lang), budget=money(budget, cur, lang)), "", right_color=RED)
            for _, name, actual, budget, ratio in a.budgets
        ])
    if a.spikes:
        what.append(t["what_spike"])
        body += _section(t["spikes"]) + _table([
            _row(t["spike_line"].format(name=escape(name), mtd=money(mtd, cur, lang), avg=money(avg, cur, lang)), "")
            for _, name, mtd, avg in a.spikes
        ])
    if a.connections:
        what.append(t["what_conn"])
        body += _section(t["connections"]) + _table([
            _row(t["conn_line"].format(name=escape(name), status=escape(status)), "") for _, name, status in a.connections
        ])
    subject = t["alerts_subject"].format(what=", ".join(what))
    return subject, _layout(t["alerts_title"], body, lang, app_url, test), subject
