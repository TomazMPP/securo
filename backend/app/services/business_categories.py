"""Starter categories for a business workspace.

A personal workspace starts with groceries, leisure and personal care; none of
that describes a company's money. A business workspace starts instead with
the lines an owner reads in an income statement: revenue, taxes on revenue,
cost of services, people, operating expenses, financial result, and the
owners' own movements.

Each group carries its `dre_section`, so the income statement works from the
first transaction without any setup, and a category the user adds later
lands on the right line by joining a group.

Two choices worth knowing:

  - Owner withdrawals are one category, not pró-labore vs profit
    distribution: owners usually take both in the same lumpy transfers, so a
    per-transaction split is guesswork. They count as outflows in the
    ordinary reports (cash really left the company) and sit below the bottom
    line of the income statement. Owner contributions are `treat_as_transfer`:
    equity coming in is not income.
  - "Transferências" and "Investimentos" keep the exact names (and the
    transfer flag) of the personal defaults, so the default rules and rule
    packs that target them by name resolve here too.

Names fall back to English for languages without a translation.
"""
import uuid
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category import Category
from app.models.category_group import CategoryGroup

BUSINESS_GROUPS_I18N: dict[str, dict] = {
    "revenue":    {"en": "Revenue",            "pt-BR": "Receitas",              "pt-PT": "Receitas",              "es": "Ingresos",               "icon": "trending-up", "color": "#16A34A", "position": 0, "dre_section": "revenue"},
    "deductions": {"en": "Taxes on revenue",   "pt-BR": "Impostos sobre vendas", "pt-PT": "Impostos sobre vendas", "es": "Impuestos sobre ventas", "icon": "file-text",   "color": "#78716C", "position": 1, "dre_section": "deductions"},
    "costs":      {"en": "Cost of services",   "pt-BR": "Custos dos serviços",   "pt-PT": "Custos dos serviços",   "es": "Costos de servicios",    "icon": "truck",       "color": "#F97316", "position": 2, "dre_section": "costs"},
    "people":     {"en": "People",             "pt-BR": "Pessoal",               "pt-PT": "Pessoal",               "es": "Personal",               "icon": "users",       "color": "#EC4899", "position": 3, "dre_section": "operating_expenses"},
    "operating":  {"en": "Operating expenses", "pt-BR": "Despesas operacionais", "pt-PT": "Despesas operacionais", "es": "Gastos operativos",      "icon": "building-2",  "color": "#8B5CF6", "position": 4, "dre_section": "operating_expenses"},
    "financial":  {"en": "Financial result",   "pt-BR": "Resultado financeiro",  "pt-PT": "Resultado financeiro",  "es": "Resultado financiero",   "icon": "percent",     "color": "#0EA5E9", "position": 5, "dre_section": "financial"},
    "owners":     {"en": "Owners",             "pt-BR": "Sócios",                "pt-PT": "Sócios",                "es": "Socios",                 "icon": "piggy-bank",  "color": "#64748B", "position": 6, "dre_section": "owners"},
    "other":      {"en": "Other",              "pt-BR": "Outros",                "pt-PT": "Outros",                "es": "Otros",                  "icon": "circle-help", "color": "#6B7280", "position": 7, "dre_section": None},
}

# Internal key -> its group, localized names, icon, color, transfer flag.
BUSINESS_CATEGORIES_I18N: dict[str, dict] = {
    # Revenue
    "service_revenue":      {"group": "revenue",    "en": "Service revenue",          "pt-BR": "Receita de serviços",       "pt-PT": "Receita de serviços",        "es": "Ingresos por servicios",   "icon": "handshake",        "color": "#16A34A"},
    "product_sales":        {"group": "revenue",    "en": "Product sales",            "pt-BR": "Venda de produtos",         "pt-PT": "Venda de produtos",          "es": "Venta de productos",       "icon": "package",          "color": "#22C55E"},
    "other_income":         {"group": "revenue",    "en": "Other income",             "pt-BR": "Outras receitas",           "pt-PT": "Outras receitas",            "es": "Otros ingresos",           "icon": "wallet",           "color": "#4ADE80"},
    # Taxes on revenue (DAS / Simples Nacional, ISS, PIS/COFINS...)
    "revenue_taxes":        {"group": "deductions", "en": "Taxes on sales",           "pt-BR": "Impostos sobre faturamento", "pt-PT": "Impostos sobre faturação", "es": "Impuestos sobre ventas",   "icon": "file-text",        "color": "#78716C"},
    # Cost of services
    "contractors":          {"group": "costs",      "en": "Contractors & suppliers",  "pt-BR": "Prestadores e fornecedores", "pt-PT": "Prestadores e fornecedores", "es": "Contratistas y proveedores", "icon": "briefcase",   "color": "#F97316"},
    "direct_costs":         {"group": "costs",      "en": "Direct costs",             "pt-BR": "Custos diretos",            "pt-PT": "Custos diretos",             "es": "Costos directos",          "icon": "truck",            "color": "#FB923C"},
    # People
    "pro_labore":           {"group": "people",     "en": "Owner's salary",           "pt-BR": "Pró-labore",                "pt-PT": "Remuneração dos sócios",     "es": "Sueldo de los socios",     "icon": "banknote",         "color": "#EC4899"},
    "payroll":              {"group": "people",     "en": "Payroll & payroll taxes",  "pt-BR": "Salários e encargos",       "pt-PT": "Salários e encargos",        "es": "Nómina y cargas sociales", "icon": "users",            "color": "#F472B6"},
    "benefits":             {"group": "people",     "en": "Benefits",                 "pt-BR": "Benefícios",                "pt-PT": "Benefícios",                 "es": "Beneficios",               "icon": "heartbeat",        "color": "#DB2777"},
    # Operating expenses
    "accounting":           {"group": "operating",  "en": "Accounting",               "pt-BR": "Contabilidade",             "pt-PT": "Contabilidade",              "es": "Contabilidad",             "icon": "receipt",          "color": "#8B5CF6"},
    "software":             {"group": "operating",  "en": "Software & subscriptions", "pt-BR": "Software e assinaturas",    "pt-PT": "Software e subscrições",     "es": "Software y suscripciones", "icon": "cloud",            "color": "#6366F1"},
    "marketing":            {"group": "operating",  "en": "Marketing",                "pt-BR": "Marketing",                 "pt-PT": "Marketing",                  "es": "Marketing",                "icon": "sparkles",         "color": "#A855F7"},
    "office":               {"group": "operating",  "en": "Rent & office",            "pt-BR": "Aluguel e escritório",      "pt-PT": "Renda e escritório",         "es": "Alquiler y oficina",       "icon": "building-2",       "color": "#7C3AED"},
    "utilities":            {"group": "operating",  "en": "Utilities & internet",     "pt-BR": "Água, luz e internet",      "pt-PT": "Água, luz e internet",       "es": "Servicios e internet",     "icon": "lightbulb",        "color": "#C084FC"},
    "travel":               {"group": "operating",  "en": "Travel",                   "pt-BR": "Viagens e deslocamentos",   "pt-PT": "Viagens e deslocações",      "es": "Viajes",                   "icon": "plane",            "color": "#3B82F6"},
    "fees_licenses":        {"group": "operating",  "en": "Fees & licenses",          "pt-BR": "Taxas e licenças",          "pt-PT": "Taxas e licenças",           "es": "Tasas y licencias",        "icon": "landmark",         "color": "#9333EA"},
    "other_expenses":       {"group": "operating",  "en": "Other expenses",           "pt-BR": "Outras despesas",           "pt-PT": "Outras despesas",            "es": "Otros gastos",             "icon": "receipt",          "color": "#A78BFA"},
    # Financial result
    "bank_fees":            {"group": "financial",  "en": "Bank fees",                "pt-BR": "Tarifas bancárias",         "pt-PT": "Comissões bancárias",        "es": "Comisiones bancarias",     "icon": "percent",          "color": "#0EA5E9"},
    "interest_iof":         {"group": "financial",  "en": "Interest & IOF",           "pt-BR": "Juros e IOF",               "pt-PT": "Juros e impostos",           "es": "Intereses e impuestos",    "icon": "trending-down",    "color": "#0284C7"},
    "financial_income":     {"group": "financial",  "en": "Interest income",          "pt-BR": "Rendimentos financeiros",   "pt-PT": "Rendimentos financeiros",    "es": "Rendimientos financieros", "icon": "coins",            "color": "#38BDF8"},
    # Owners: equity movements, below the bottom line
    "owner_withdrawals":    {"group": "owners",     "en": "Owner withdrawals",        "pt-BR": "Retiradas dos sócios",      "pt-PT": "Levantamentos dos sócios",   "es": "Retiros de los socios",    "icon": "hand-coins",       "color": "#64748B"},
    "capital_contribution": {"group": "owners",     "en": "Owner contribution",       "pt-BR": "Aporte dos sócios",         "pt-PT": "Entrada dos sócios",         "es": "Aporte de los socios",     "icon": "piggy-bank",       "color": "#94A3B8", "treat_as_transfer": True},
    # Other (outside the statement)
    "transfers":            {"group": "other",      "en": "Transfers",                "pt-BR": "Transferências",            "pt-PT": "Transferências",             "es": "Transferencias",           "icon": "arrow-left-right", "color": "#64748B", "treat_as_transfer": True},
    "investments":          {"group": "other",      "en": "Investments",              "pt-BR": "Investimentos",             "pt-PT": "Investimentos",              "es": "Inversiones",              "icon": "trending-up",      "color": "#0EA5E9", "treat_as_transfer": True},
    "other":                {"group": "other",      "en": "Other",                    "pt-BR": "Outros",                    "pt-PT": "Outros",                     "es": "Otros",                    "icon": "circle-help",      "color": "#6B7280"},
}


def _name(entry: dict, lang: str) -> str:
    return str(entry.get(lang) or entry["en"])


async def create_business_categories(
    session: AsyncSession,
    user_id: uuid.UUID,
    lang: str,
    workspace_id: Optional[uuid.UUID],
) -> list[Category]:
    """Seed the business groups and categories. Commits, like the personal seed."""
    groups: dict[str, CategoryGroup] = {}
    for key, data in BUSINESS_GROUPS_I18N.items():
        group = CategoryGroup(
            user_id=user_id,
            workspace_id=workspace_id,
            name=_name(data, lang),
            icon=data["icon"],
            color=data["color"],
            position=data["position"],
            dre_section=data["dre_section"],
            is_system=True,
        )
        session.add(group)
        groups[key] = group
    await session.flush()

    categories = []
    for data in BUSINESS_CATEGORIES_I18N.values():
        category = Category(
            user_id=user_id,
            workspace_id=workspace_id,
            name=_name(data, lang),
            icon=data["icon"],
            color=data["color"],
            is_system=True,
            group_id=groups[data["group"]].id,
            treat_as_transfer=data.get("treat_as_transfer", False),
        )
        session.add(category)
        categories.append(category)
    await session.commit()
    return categories
