"""A business workspace starts with business categories, mapped to the DRE."""
import pytest
from sqlalchemy import select

from app.models.category import Category
from app.models.category_group import DRE_SECTIONS, CategoryGroup
from app.models.rule import Rule
from app.models.user import User
from app.services import workspace_service
from app.services.business_categories import BUSINESS_CATEGORIES_I18N, BUSINESS_GROUPS_I18N


async def _seeded(session, workspace_id):
    groups = (await session.execute(
        select(CategoryGroup).where(CategoryGroup.workspace_id == workspace_id)
    )).scalars().all()
    cats = (await session.execute(
        select(Category).where(Category.workspace_id == workspace_id)
    )).scalars().all()
    return {g.id: g for g in groups}, {c.name: c for c in cats}


@pytest.mark.asyncio
async def test_business_workspace_gets_business_categories(session, test_user: User):
    ws = await workspace_service.create_workspace(
        session, name="Meppo", creator=test_user, kind="business", locale="pt-BR",
    )
    await session.commit()
    groups, cats = await _seeded(session, ws.id)

    assert len(groups) == len(BUSINESS_GROUPS_I18N)
    assert len(cats) == len(BUSINESS_CATEGORIES_I18N)
    # None of the household starter set.
    assert "Mercado" not in cats and "Lazer" not in cats

    def section(name):
        return groups[cats[name].group_id].dre_section

    assert section("Receita de serviços") == "revenue"
    assert section("Impostos sobre faturamento") == "deductions"
    assert section("Prestadores e fornecedores") == "costs"
    assert section("Pró-labore") == "operating_expenses"
    assert section("Contabilidade") == "operating_expenses"
    assert section("Tarifas bancárias") == "financial"
    assert section("Distribuição de lucros") == "owners"
    assert section("Transferências") is None
    assert {g.dre_section for g in groups.values()} - {None} <= set(DRE_SECTIONS)

    # Equity and own-account movements stay out of the ordinary reports.
    for name in ("Distribuição de lucros", "Aporte dos sócios", "Transferências", "Investimentos"):
        assert cats[name].treat_as_transfer, name
    assert not cats["Pró-labore"].treat_as_transfer


@pytest.mark.asyncio
async def test_business_categories_fall_back_to_english(session, test_user: User):
    ws = await workspace_service.create_workspace(
        session, name="Acme", creator=test_user, kind="business", locale="de",
    )
    await session.commit()
    _, cats = await _seeded(session, ws.id)
    assert "Service revenue" in cats and "Owner's salary" in cats


@pytest.mark.asyncio
async def test_default_rules_still_resolve_in_business_workspace(session, test_user: User):
    # "Investimentos" keeps the personal default's name, so the universal
    # rule that targets it by key is installed here too.
    ws = await workspace_service.create_workspace(
        session, name="Meppo", creator=test_user, kind="business", locale="pt-BR",
    )
    await session.commit()
    _, cats = await _seeded(session, ws.id)
    rules = (await session.execute(select(Rule).where(Rule.workspace_id == ws.id))).scalars().all()
    targets = {a["value"] for r in rules for a in r.actions if a["op"] == "set_category"}
    assert str(cats["Investimentos"].id) in targets


@pytest.mark.asyncio
async def test_personal_workspace_unchanged(session, test_user: User):
    ws = await workspace_service.create_workspace(
        session, name="Casa", creator=test_user, kind="personal", locale="pt-BR",
    )
    await session.commit()
    groups, cats = await _seeded(session, ws.id)
    assert "Mercado" in cats and "Pró-labore" not in cats
    assert all(g.dre_section is None for g in groups.values())


@pytest.mark.asyncio
async def test_group_dre_section_can_be_set_and_cleared(client, auth_headers, test_workspace):
    headers = {**auth_headers, "X-Workspace-Id": str(test_workspace.id)}
    created = await client.post(
        "/api/category-groups", json={"name": "Receitas", "dre_section": "revenue"}, headers=headers,
    )
    assert created.status_code in (200, 201), created.text
    group = created.json()
    assert group["dre_section"] == "revenue"

    moved = await client.patch(
        f"/api/category-groups/{group['id']}", json={"dre_section": "costs"}, headers=headers,
    )
    assert moved.json()["dre_section"] == "costs"

    renamed = await client.patch(
        f"/api/category-groups/{group['id']}", json={"name": "Vendas"}, headers=headers,
    )
    assert renamed.json()["dre_section"] == "costs"  # untouched when not sent

    cleared = await client.patch(
        f"/api/category-groups/{group['id']}", json={"dre_section": None}, headers=headers,
    )
    assert cleared.json()["dre_section"] is None

    bad = await client.patch(
        f"/api/category-groups/{group['id']}", json={"dre_section": "profit"}, headers=headers,
    )
    assert bad.status_code == 422
