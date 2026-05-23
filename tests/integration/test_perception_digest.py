"""Perception-digest MVP: scene fixtures + OpenRouter intent-biased summaries."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from tests._lib.fixture_loader import load_fixture
from tests._lib.openrouter import digest, resolve_openrouter_api_key
from tests._lib.perception_advise import capture_perception_bundle

ROOT = Path(__file__).resolve().parents[2]
D1_FIXTURE = ROOT / "data/perception-digest/fixtures/D1_mixed_scene.yaml"
D2_FIXTURE = ROOT / "data/perception-digest/fixtures/D2_stuck_pit_wood.yaml"


def _write_digest_report(log_dir: Path, slug: str, intent: str, perception_input: dict, result: dict) -> Path:
    out_dir = log_dir / "perception-digest"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{slug}.json"
    report = {
        "slug": slug,
        "intent": intent,
        "perception_input": perception_input,
        "digest": result,
    }
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n[perception-digest] wrote {out_path}")
    return out_path


def _assert_digest_smoke(result: dict) -> None:
    assert result.get("parsed") is not None, (
        f"LLM did not return JSON: {(result.get('raw') or '')[:400]}"
    )
    assert "recommendations" in result["parsed"]


@pytest.fixture
def scene_arena(rcon, arena, config, functional_world):
    """Build D1_mixed_scene on canonical grass (harness reset already ran)."""
    world = config["mc"]["world"]
    fixture = load_fixture(D1_FIXTURE)
    arena.prep(fixture.prep)
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    arena.settle(seconds=3.0)
    yield
    arena.cleanup(fixture.cleanup)


@pytest.mark.integration
@pytest.mark.parametrize(
    "slug,intent",
    [
        ("find_oak_wood", "find oak wood"),
        ("collect_grass_seeds", "collect grass seeds"),
    ],
)
def test_perception_digest_mvp(bot, scene_arena, log_dir, slug, intent):
    if not resolve_openrouter_api_key():
        pytest.skip("OpenRouter API key not set (OPENROUTER_API_KEY or secrets.yaml)")

    bot.ensure_connected(reconnect_timeout=15.0)

    perception_input = capture_perception_bundle(
        bot,
        preserve_status=False,
        include_nearby=False,
        include_map=False,
    )

    result = digest(
        perception_input,
        intent,
        model=os.environ.get("DIGEST_MODEL"),
    )
    _write_digest_report(log_dir, slug, intent, perception_input, result)
    _assert_digest_smoke(result)


@pytest.fixture
def stuck_pit_arena(rcon, arena, config, functional_world):
    """D2: dirt pit at origin; oak east — props on canonical grass."""
    fixture = load_fixture(D2_FIXTURE)
    arena.prep(fixture.prep)
    arena.settle(seconds=2.0)
    yield
    arena.cleanup(fixture.cleanup)


@pytest.mark.integration
def test_perception_digest_stuck_collecting_wood(bot, stuck_pit_arena, log_dir, arena):
    """Failed goto to nearby oak from a pit — can digest infer blocked/stuck?"""
    if not resolve_openrouter_api_key():
        pytest.skip("OpenRouter API key not set (OPENROUTER_API_KEY or secrets.yaml)")

    slug = "blocked_collecting_wood"
    intent = "blocked collecting wood"

    bot.ensure_connected(reconnect_timeout=15.0)

    goto_resp = bot.post(
        "/action/goto",
        {"x": 5, "y": 64, "z": 0},
        timeout=25,
    )
    arena.settle_fast()

    perception_input = capture_perception_bundle(
        bot,
        preserve_status=True,
        include_nearby=True,
        nearby_radius=8,
        include_map=True,
        map_radius=12,
    )
    perception_input["last_goto_attempt"] = goto_resp

    result = digest(
        perception_input,
        intent,
        model=os.environ.get("DIGEST_MODEL"),
    )
    _write_digest_report(log_dir, slug, intent, perception_input, result)
    _assert_digest_smoke(result)

    parsed = result["parsed"]
    text = json.dumps(parsed).lower()
    assert any(
        kw in text
        for kw in ("stuck", "blocked", "pit", "hole", "unreachable", "cannot reach", "can't reach")
    ), f"digest did not mention obstruction: {parsed.get('summary')}"
