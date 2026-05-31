"""Unit tests for agent-test scoreboard entity counting helpers."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("agent_test_mod", ROOT / "scripts" / "agent-test.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_parse_scoreboard_count():
    out = "Unknown scoreboard objective agenttest_ent\n#probe has 2 [agenttest_ent]"
    assert mod._parse_scoreboard_count(out) == 2


def test_parse_scoreboard_count_zero():
    assert mod._parse_scoreboard_count("#probe has 0 [agenttest_ent]") == 0


def test_parse_scoreboard_count_missing():
    assert mod._parse_scoreboard_count("no score here") is None
