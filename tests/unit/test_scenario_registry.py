import pytest

from mapcatalog.lint import lint_requirements
from mapcatalog.scenario_registry import load_registry, variant_by_id


@pytest.mark.unit
def test_scenario_registry_loads():
    reg = load_registry()
    assert reg.version >= 2
    ids = {v.id for v in reg.variants}
    assert "smoke" in ids
    assert "mining.plains_iron" in ids
    assert "fishing.river_shore" in ids
    assert variant_by_id(reg, "scenario_homestead_smoke") is not None


@pytest.mark.unit
def test_smoke_requirements_seed_candidates():
    from pathlib import Path

    from mapcatalog.load import load_requirements

    root = Path(__file__).resolve().parents[2]
    req = load_requirements(root / "requirements/scenario_homestead_smoke.yaml")
    assert req.find.seed_candidates[:3] == ["800", "2024", "271828"]
    from mapcatalog.models import BiomeFractionGate, FlatPatchGate, HeightJitterGate

    assert not any(isinstance(g, BiomeFractionGate) for g in req.gates)
    kinds = {type(g) for g in req.gates}
    assert FlatPatchGate in kinds and HeightJitterGate in kinds


@pytest.mark.unit
def test_scenario_variant_setting_alias():
    reg = load_registry()
    smoke = variant_by_id(reg, "smoke")
    assert smoke is not None
    assert smoke.setting == "smoke"
    assert smoke.topic == "smoke"


@pytest.mark.unit
def test_all_registry_requirements_lint():
    reg = load_registry()
    failures = []
    for v in reg.variants:
        report = lint_requirements(v.requirements_path)
        if not report.ok:
            failures.append(f"{v.id}: {report.errors}")
    assert not failures, "\n".join(failures)
