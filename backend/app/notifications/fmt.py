"""Small formatting helpers for the email templates (no Babel dependency)."""

from datetime import date

_SYMBOLS = {"BRL": "R$", "USD": "$", "EUR": "€", "GBP": "£"}

MONTHS = {
    "pt": ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
           "agosto", "setembro", "outubro", "novembro", "dezembro"],
    "en": ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"],
}
WEEKDAYS = {
    "pt": ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"],
    "en": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
}


def money(value: float | None, currency: str, lang: str, signed: bool = False) -> str:
    if value is None:
        return "—"
    sign = "−" if value < 0 else ("+" if signed and value > 0 else "")
    body = f"{abs(value):,.2f}"
    if lang == "pt":
        body = body.replace(",", "§").replace(".", ",").replace("§", ".")
    symbol = _SYMBOLS.get(currency, currency + " ")
    return f"{sign}{symbol} {body}" if lang == "pt" or len(symbol) > 1 else f"{sign}{symbol}{body}"


def pct(value: float | None, lang: str, digits: int = 0, signed: bool = False) -> str:
    if value is None:
        return "—"
    sign = "+" if signed and value > 0 else ("−" if value < 0 else "")
    body = f"{abs(value) * 100:.{digits}f}"
    if lang == "pt":
        body = body.replace(".", ",")
    return f"{sign}{body}%"


def month_name(d: date, lang: str) -> str:
    return MONTHS[lang][d.month - 1]


def short_date(d: date, lang: str) -> str:
    if lang == "pt":
        return f"{WEEKDAYS[lang][d.weekday()]}, {d.day} {MONTHS[lang][d.month - 1][:3]}"
    return f"{WEEKDAYS[lang][d.weekday()]}, {MONTHS[lang][d.month - 1][:3]} {d.day}"
