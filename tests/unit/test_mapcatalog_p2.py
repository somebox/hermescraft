import pytest

from mapcatalog.gates import parse_gate_line
from mapcatalog.metrics import GateEvalResult, ProbeMetrics, evaluate_gates
from mapcatalog.models import Arena, OreHitsGate
from mapcatalog.metrics import ProbeMetrics
from mapcatalog.models import Arena
from mapcatalog.placements import parse_placement_value
from mapcatalog.placement_resolve import (
    placement_reject_reasons,
    placement_rng,
    resolve_placements,
)
from mapcatalog.probe import FakeRconClient
from mapcatalog.result import fingerprint_payload, sha256_fingerprint


@pytest.mark.unit
def test_placement_rng_deterministic():
    a = placement_rng("424242", "mine_plains_iron", "spawn")
    b = placement_rng("424242", "mine_plains_iron", "spawn")
    c = placement_rng("424243", "mine_plains_iron", "spawn")
    assert [a.random() for _ in range(3)] == [b.random() for _ in range(3)]
    assert [a.random() for _ in range(3)] != [c.random() for _ in range(3)]


@pytest.mark.unit
def test_fingerprint_includes_full_placements_map():
    base = {
        "spawn": [1, 64, 2],
        "muster": [7, 64, 2],
        "iron_view": [3, 63, 1],
    }
    p1 = fingerprint_payload("id", "1", "1.21.4", {"center": [0, 0], "radius": 64}, base, [])
    p2 = fingerprint_payload(
        "id",
        "1",
        "1.21.4",
        {"center": [0, 0], "radius": 64},
        {**base, "iron_view": [4, 63, 1]},
        [],
    )
    assert sha256_fingerprint(p1) != sha256_fingerprint(p2)


@pytest.mark.unit
def test_placement_reject_reason_format():
    assert placement_reject_reasons(["iron_view unreachable"]) == ["placement iron_view unreachable"]


@pytest.mark.unit
def test_evaluate_gates_skips_pass1_biome_gates():
    from mapcatalog.gates import parse_gate_line
    from mapcatalog.metrics import ColumnSample, ProbeMetrics, evaluate_gates
    from mapcatalog.models import BiomeFractionGate

    biome = parse_gate_line("biome in [plains] >= 50%")
    assert isinstance(biome, BiomeFractionGate)
    flat = parse_gate_line("flat patch >= 1 cells")
    metrics = ProbeMetrics(
        columns=[ColumnSample(x=0, z=0, surface_y=64), ColumnSample(x=16, z=0, surface_y=64)],
    )
    client = FakeRconClient()

    class FailingIfBiomeProbed(FakeRconClient):
        def run(self, cmd: str) -> str:
            if "if biome" in cmd:
                raise AssertionError("Pass 2 must not probe biomes for pass1-only gates")
            return super().run(cmd)

    ev = evaluate_gates(FailingIfBiomeProbed(), "proc-lab", Arena((0, 0), 64), [biome, flat], metrics)
    assert isinstance(ev, GateEvalResult)


@pytest.mark.unit
def test_evaluate_ore_gate_from_metrics():
    gate = parse_gate_line("block iron_ore hits >= 3 in y -32..48 step 8")
    assert isinstance(gate, OreHitsGate)
    metrics = ProbeMetrics(
        ore_hits={"minecraft:iron_ore": [(0, 32, 0), (8, 32, 0)]},
    )
    client = FakeRconClient()
    ev = evaluate_gates(client, "proc-lab", Arena((0, 0), 64), [gate], metrics)
    assert isinstance(ev, GateEvalResult)
    assert not ev.passed
    assert any("iron_ore" in r for r in ev.reasons)


@pytest.mark.unit
def test_near_block_empty_hits_unreachable():
    spec = parse_placement_value(
        "unreachable_target",
        "random_safe near block diamond_ore within 4 blocks attempts 8",
    )
    metrics = ProbeMetrics()
    arena = Arena((0, 0), 64)

    class NoRcon:
        def run(self, cmd: str) -> str:
            raise AssertionError(f"rcon should not run when near targets empty: {cmd}")

    resolved, errors = resolve_placements(
        client=NoRcon(),  # type: ignore[arg-type]
        world="proc-lab",
        arena=arena,
        seed="424242",
        requirements_id="unreachable_smoke_v2",
        specs=[spec],
        metrics=metrics,
    )
    assert resolved == {}
    assert errors == ["unreachable_target unreachable"]
    assert placement_reject_reasons(errors) == ["placement unreachable_target unreachable"]

