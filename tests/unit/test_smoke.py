"""Smoke tests for the harness foundation. No MC, no bot, no LLM."""

import pytest

from tests._lib import Arena, BotClient, Predicates, RconClient, load_config


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
