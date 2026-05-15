"""Smoke tests for the harness foundation. No MC, no bot, no LLM."""

from unittest.mock import MagicMock

import pytest

from tests._lib import Arena, BotClient, Predicates, RconClient, extract_error, load_config


@pytest.mark.unit
def test_config_loads(config):
    """config/hermescraft.yaml parses and has the expected top-level shape."""
    assert "mc" in config
    assert "rcon" in config
    assert "bot" in config
    assert "logging" in config
    assert config["mc"]["host"]


@pytest.mark.unit
def test_rcon_client_constructs(rcon, config):
    """RconClient reads SSH host + container from config, doesn't hardcode."""
    assert rcon.ssh_host == config["rcon"]["ssh_host"]
    assert rcon.container == config["rcon"]["docker_container"]
    assert rcon.world == config["mc"]["world"]
    argv = rcon._argv()
    assert "ssh" in argv
    assert config["rcon"]["docker_container"] in argv


@pytest.mark.unit
def test_bot_client_base_url(bot, config):
    """BotClient base URL comes from config.bot.default_api_url."""
    assert bot.base == config["bot"]["default_api_url"].rstrip("/")


@pytest.mark.unit
def test_arena_uses_world_from_config(arena, config):
    """Arena resolves world name and bot name from config."""
    assert arena.world == config["mc"]["world"]
    assert arena.bot_name  # default 'Flint' or override


@pytest.mark.unit
def test_predicates_evaluate_passes_and_fails(predicates):
    """Predicates factory builds an evaluator with the expected vocabulary."""
    p = predicates(
        end_state={
            "position": {"x": 0.5, "y": 65, "z": 6.2},
            "health": 18,
            "inventory_summary": {"cobblestone": 5},
        },
        agent_chat="I gathered cobblestone successfully",
    )
    results = p.evaluate({
        "bot_at": {"x": 0, "y": 65, "z": 6, "range": 1.5},
        "bot_hp_at_least": 15,
        "bot_inventory": {"cobblestone": ">=3"},
        "agent_chat_contains": ["cobblestone"],
        "agent_chat_does_not_contain": ["error"],
    })
    assert all(r.passed for r in results), [r for r in results if not r.passed]

    # Now a failing case — hp too low
    p2 = predicates(end_state={"health": 5})
    res = p2.evaluate({"bot_hp_at_least": 15})
    assert len(res) == 1 and not res[0].passed and "hp=5" in res[0].detail


@pytest.mark.unit
def test_extract_error_handles_dict_string_and_missing():
    """extract_error normalizes the three shapes the bot returns."""
    code, msg, obs = extract_error({
        "ok": False,
        "error": {"code": "NAV_BLOCKED", "message": "blocked", "observed_state": {"closest_standable": {"x": 0}}},
    })
    assert code == "NAV_BLOCKED"
    assert msg == "blocked"
    assert obs == {"closest_standable": {"x": 0}}

    code, msg, obs = extract_error({"ok": False, "error": "something went wrong"})
    assert code == ""
    assert msg == "something went wrong"
    assert obs == {}

    code, msg, obs = extract_error({"ok": True, "data": {"x": 1}})
    assert (code, msg, obs) == ("", "", {})


@pytest.mark.unit
def test_bot_inventory_flattens_to_count_map(config):
    """BotClient.inventory() turns the /status item list into {name: count}."""
    b = BotClient(config)
    b.get = MagicMock(return_value={
        "ok": True,
        "data": {
            "inventory": [
                {"name": "cobblestone", "count": 5, "slot": 0},
                {"name": "stone_pickaxe", "count": 1, "slot": 1},
                {"name": "cobblestone", "count": 3, "slot": 2},  # duplicate name → summed
                {"name": None, "count": 0},                       # malformed → skipped
            ],
        },
    })
    inv = b.inventory()
    assert inv == {"cobblestone": 8, "stone_pickaxe": 1}


@pytest.mark.unit
def test_bot_position_handles_missing_data(config):
    """BotClient.position() returns {} when /status has no position."""
    b = BotClient(config)
    b.get = MagicMock(return_value={"ok": True, "data": {}})
    assert b.position() == {}

    b.get = MagicMock(return_value={"ok": True, "data": {"position": {"x": 1.5, "y": 64, "z": 2.5}}})
    assert b.position() == {"x": 1.5, "y": 64, "z": 2.5}


@pytest.mark.unit
def test_bot_wait_for_condition_returns_true_on_success(config):
    """wait_for_condition stops as soon as predicate returns truthy."""
    b = BotClient(config)
    calls = {"n": 0}
    def pred():
        calls["n"] += 1
        return calls["n"] >= 2
    assert b.wait_for_condition(pred, timeout=1.0, interval=0.05) is True
    assert calls["n"] >= 2


@pytest.mark.unit
def test_bot_wait_for_condition_returns_false_on_timeout(config):
    """wait_for_condition returns False (does not raise) on deadline."""
    b = BotClient(config)
    assert b.wait_for_condition(lambda: False, timeout=0.2, interval=0.05) is False


@pytest.mark.unit
def test_bot_wait_for_condition_swallows_predicate_errors(config):
    """A throwing predicate is treated as not-yet-true; loop continues."""
    b = BotClient(config)
    calls = {"n": 0}
    def pred():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("transient")
        return True
    assert b.wait_for_condition(pred, timeout=1.0, interval=0.05) is True


@pytest.mark.unit
def test_rcon_block_is_parses_test_passed_and_failed(config):
    """block_is returns True/False on the documented Paper output and
    raises on anything else (better noisy than silently flipping)."""
    r = RconClient(config)
    r.run = MagicMock(return_value="Test passed")
    assert r.block_is(0, 65, 0, "cobblestone") is True

    r.run = MagicMock(return_value="Test failed")
    assert r.block_is(0, 65, 0, "cobblestone") is False

    r.run = MagicMock(return_value="")
    with pytest.raises(RuntimeError):
        r.block_is(0, 65, 0, "cobblestone")


@pytest.mark.unit
def test_rcon_block_is_normalizes_kind_prefix(config):
    """Callers may pass 'cobblestone' or 'minecraft:cobblestone' — both work."""
    r = RconClient(config)
    captured = {}
    def capture(cmd):
        captured["cmd"] = cmd
        return "Test passed"
    r.run = capture
    r.block_is(1, 2, 3, "cobblestone")
    assert "minecraft:cobblestone" in captured["cmd"]
    r.block_is(1, 2, 3, "minecraft:oak_door[half=lower]")
    assert "minecraft:oak_door[half=lower]" in captured["cmd"]
    assert "minecraft:minecraft:" not in captured["cmd"]  # no double-prefix


@pytest.mark.unit
def test_bot_fixture_picks_role_from_tester_marker(config, request):
    """The conftest `bot` fixture uses config.bot.roles[role] keyed on the
    @pytest.mark.tester marker. This unit test exercises the resolver helper
    directly to avoid the marker-application complexity."""
    from tests.conftest import _resolve_bot_url
    assert _resolve_bot_url(config, "flint") == config["bot"]["roles"]["flint"]
    assert _resolve_bot_url(config, "tester") == config["bot"]["roles"]["tester"]
    # Fallback path: when roles map is absent, flint resolves to default_api_url.
    bare = {"bot": {"default_api_url": "http://example:9999"}}
    assert _resolve_bot_url(bare, "flint") == "http://example:9999"
    with pytest.raises(KeyError):
        _resolve_bot_url(bare, "tester")


@pytest.mark.unit
def test_load_config_applies_overrides(tmp_path):
    """$overrides.<profile> deep-merges onto base when HERMESCRAFT_PROFILE matches."""
    cfg = tmp_path / "hermescraft.yaml"
    cfg.write_text("""
mc: {host: localhost, port: 25565}
logging: {banner: true, dir: /tmp/x}
$overrides:
  ci:
    mc: {host: 10.0.0.5}
    logging: {banner: false}
""")
    out = load_config(path=cfg, profile="ci")
    assert out["mc"]["host"] == "10.0.0.5"
    assert out["mc"]["port"] == 25565  # base preserved
    assert out["logging"]["banner"] is False
    assert out["logging"]["dir"] == "/tmp/x"  # base preserved
