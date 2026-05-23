"""Shared pytest fixtures and one-time setup for the HermesCraft test tree.

All session-scoped clients (config, RconClient, BotClient) are constructed
once and reused across the run. The `arena` fixture is per-test and resets
world state on teardown.

Tests targeting different infrastructure should use markers:
    @pytest.mark.unit         no MC, no LLM
    @pytest.mark.functional   live MC + bot at config.bot.default_api_url
    @pytest.mark.integration  live MC + bot + LLM key

Markers are declared in pyproject.toml; --strict-markers forbids typos.
"""

from __future__ import annotations

import os
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

import pytest

from tests._lib import Arena, BotClient, BotTrace, Predicates, RconClient, load_config
from tests._lib.functional_fixtures import (
    bake_prefabs_session,
    lay_ground_substrate_session,
    reset_ground_arena,
)


@pytest.fixture(scope="session")
def config():
    """Loaded config/hermescraft.yaml. Session-scoped — read once."""
    return load_config()


@pytest.fixture(scope="session")
def run_id() -> str:
    """Per-pytest-invocation identifier, used as the test-log subdir name."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")


@pytest.fixture(scope="session")
def log_dir(config, run_id) -> Path:
    """Per-run log directory under config.logging.dir/tests/<run-id>/. Created on first use."""
    d = Path(config["logging"]["dir"]) / "tests" / run_id
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture(scope="session")
def silence_banner(config):
    """If config.test.silence_banner, set LOG_BANNER=0 so bots spawned by tests
    suppress their startup banner. Returns the original value for restoration."""
    original = os.environ.get("LOG_BANNER")
    if config["test"]["silence_banner"]:
        os.environ["LOG_BANNER"] = "0"
    yield original
    if original is None:
        os.environ.pop("LOG_BANNER", None)
    else:
        os.environ["LOG_BANNER"] = original


@pytest.fixture(scope="session")
def rcon(config):
    """RconClient for the entire session. No actual connection at construction —
    rcon-cli is invoked on demand. Tests skipped here will not exercise it."""
    return RconClient(config)


def _resolve_bot_url(config: dict, role: str) -> str:
    """Look up `role` in config.bot.roles, falling back to default_api_url."""
    roles = (config.get("bot") or {}).get("roles") or {}
    if role in roles:
        return roles[role]
    if role == "flint":
        # Flint role is the implicit default — fall back to default_api_url
        # when the roles map omits it. This keeps trivial configs working.
        return config["bot"]["default_api_url"]
    raise KeyError(f"unknown bot role {role!r}; config.bot.roles has {list(roles)}")


@pytest.fixture(scope="session")
def tester_bot(config):
    """Session-scoped Tester bot — the canonical test-only bot at
    config.bot.roles.tester (:3004 by default). Used by all functional
    tests. The dedicated Tester identity keeps test runs isolated from
    the landfolk-scenario bots (Flint, Mason, etc.).

    wait_until_ready is NOT called at construction so unit tests don't
    spin on a missing bot.
    """
    return BotClient(config, base_url=_resolve_bot_url(config, "tester"))


@pytest.fixture(scope="session")
def flint_bot(config):
    """Session-scoped Flint bot — the landfolk-scenario player. Functional
    tests should NOT use this (it interferes with whatever the landfolk
    world is doing with Flint). Kept available for any future test that
    explicitly needs to exercise Flint's identity.
    """
    return BotClient(config, base_url=_resolve_bot_url(config, "flint"))


@pytest.fixture
def bot(tester_bot):
    """Function-scoped bot — always Tester. Tests use this for all
    bot interactions. The `tester_bot` session-scoped fixture is the
    backing client; this wrapper exists so future tests can override
    per-case if needed."""
    return tester_bot


@pytest.fixture(scope="session", autouse=True)
def _functional_session_setup(config, rcon):
    """One-time per-pytest-invocation world setup for functional tests.

    Sets the gamerules + difficulty + time that every functional test
    depends on. Previously each per-test fixture re-applied these
    (12+ duplicate sites). Centralizing avoids per-fixture drift and
    saves ~6 rcon round-trips per test (≈15s across a 150-test suite).

    The functional harness itself is marker-gated; this session-scope
    fixture intentionally is NOT, because pytest evaluates session
    autouse fixtures even when no functional test runs (the cost is
    one rcon batch at startup, negligible).

    `doImmediateRespawn true` is set deliberately: it skips the
    death-screen pause, which lets the rescue-tester sequence catch
    the bot before it can drift into a respawn-outside-landfolk
    cascade between tests. (See the 8 documented XPASS scenarios
    around test_dig_walk_pickup_chain for the underlying problem.)
    """
    world = config["mc"]["world"]
    try:
        rcon.batch([
            f"execute in {world} run difficulty peaceful",
            f"execute in {world} run gamerule doDaylightCycle false",
            f"execute in {world} run gamerule doMobSpawning false",
            f"execute in {world} run gamerule keepInventory true",
            f"execute in {world} run gamerule doImmediateRespawn true",
            f"execute in {world} run time set noon",
            f"execute in {world} run weather clear",
            f"execute in {world} run gamerule commandModificationBlockLimit 524288",
        ])
        lay_ground_substrate_session(rcon, world)
        baked = bake_prefabs_session(Arena(rcon, config))
        print(f"[session] baked prefabs: {', '.join(baked)}")
    except Exception:
        # Unit-only invocations may have no rcon target; the
        # functional harness will re-attempt rcon at test time and
        # fail with a clear error there.
        pass


@pytest.fixture(scope="session", autouse=True)
def _tester_bot_ready_once(tester_bot, _functional_session_setup):
    """Block once per session until Tester answers /health.connected=true."""
    try:
        tester_bot.wait_until_ready(timeout=60)
    except Exception:
        pass


@pytest.fixture(scope="session", autouse=True)
def _final_park(rcon, config, tester_bot):
    yield
    try:
        Arena(rcon, config).move_to_safe(bot=tester_bot)
    except Exception:
        pass


@pytest.fixture
def arena(config, rcon):
    """Per-test world prep/cleanup helper. Use `arena.clean()` to reset state."""
    return Arena(rcon, config)


@pytest.fixture
def predicates():
    """Factory: tests call `predicates(end_state, agent_chat=...)` to construct.
    Returning a factory (not an instance) so tests pick when to snapshot state."""
    def _make(end_state: dict, agent_chat: str = "", mc_verbs: list | None = None, pre_deaths: int = 0):
        return Predicates(
            end_state=end_state,
            agent_chat=agent_chat,
            mc_verbs=mc_verbs,
            pre_deaths=pre_deaths,
        )
    return _make


# ── Functional-test harness (consolidated autouse + hooks) ──────────
# A single autouse fixture for functional-tier tests handles, in order:
#
#   1. Pre-test rescue (creative + safe-tp + wait stationary)
#   2. Announce via rcon `say [test #N] <nodeid>` — this is the visible
#      boundary between "harness done" and "per-test fixture starting"
#      for anyone watching the server live.
#   3. Write a structured `# TEST_START n=<N> nodeid=<full> ts=<iso>
#      bot_pos=<x,y,z>` line to the per-test trace log.
#   4. Start the BotTrace 0.4s poller against the same file (it opens
#      in append mode, so the START header survives).
#   5. yield — per-test fixtures + test body run here.
#   6. Stop the poller.
#   7. Append `# TEST_END n=<N> elapsed=<s> outcome=<pass|fail|error>`.
#   8. Announce via rcon `say [done #N] <elapsed>s <outcome>`.
#   9. move_to_safe — park the bot outside the arena.
#
# Each sub-step is wrapped in its own try/except so a single failure
# (e.g. a transient rcon hiccup during announce) doesn't sabotage the
# others. The exception type+message is appended to the trace footer so
# silent harness degradation is detectable across runs.
#
# Previously these concerns were spread across three places
# (pytest_runtest_call hook + _functional_rescue autouse + bot_trace
# autouse). The new single fixture is the canonical, greppable entry
# point for "what runs around every functional test."

_test_counter = {"n": 0}


def _safe_nodeid(nodeid: str) -> str:
    """Filesystem-safe slug of a pytest nodeid for use as a filename."""
    slug = nodeid.split("tests/", 1)[-1] if "tests/" in nodeid else nodeid
    return (
        slug
        .replace("/", "_")
        .replace("::", "__")
        .replace("[", "_")
        .replace("]", "")
    )


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Stash the per-phase report on the item so the harness teardown
    can read the outcome (call.passed / .failed / .skipped) and write
    it into the trace footer. Standard pytest pattern."""
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"rep_{rep.when}", rep)


def pytest_collection_modifyitems(config, items):
    """Drift detection: any test under tests/functional/ that is
    missing @pytest.mark.functional silently bypasses the harness
    (announce/rescue/trace/park). Warn at collection time so the
    mistake is caught early instead of at first cumulative-state
    cascade failure."""
    import inspect

    for item in items:
        if "tests/functional/" in item.nodeid and not item.get_closest_marker("functional"):
            warnings.warn(
                f"{item.nodeid} lives under tests/functional/ but is missing "
                f"@pytest.mark.functional — the functional harness will NOT "
                f"run for this test. Add the marker.",
                stacklevel=0,
            )
        if not item.get_closest_marker("functional"):
            continue
        try:
            src = inspect.getsource(item.function)
            if "time.sleep" in src:
                warnings.warn(
                    f"{item.nodeid}: uses time.sleep directly; prefer "
                    f"arena.settle_*() or bot.wait_for_condition()",
                    stacklevel=0,
                )
        except (OSError, TypeError):
            pass

    if any(
        item.get_closest_marker("functional") or item.get_closest_marker("integration")
        for item in items
    ):
        try:
            import subprocess

            repo = Path(__file__).resolve().parents[1]
            script = repo / "scripts" / "check-arena-coords.py"
            if script.is_file():
                proc = subprocess.run(
                    [
                        sys.executable,
                        str(script),
                        "tests/functional",
                        "tests/integration",
                    ],
                    capture_output=True,
                    text=True,
                    cwd=str(repo),
                )
                if proc.stdout.strip():
                    warnings.warn(
                        f"check-arena-coords:\n{proc.stdout.strip()[:4000]}",
                        stacklevel=0,
                    )
        except Exception:
            pass


@pytest.fixture
def functional_world(_functional_harness):
    """Depend on this in geometry fixtures so setup runs after harness reset."""
    yield


@pytest.fixture(autouse=True)
def _functional_harness(request, config, rcon, tester_bot, log_dir):
    """Canonical setup/teardown wrapper for functional-tier tests.

    Marker-gated: a no-op for unit tests. Runs for @functional and
    @integration. See the section header above for the full sequence.
    """
    if not (
        request.node.get_closest_marker("functional")
        or request.node.get_closest_marker("integration")
    ):
        yield
        return

    world = config["mc"]["world"]
    _test_counter["n"] += 1
    n = _test_counter["n"]
    short = (
        request.node.nodeid.split("tests/", 1)[-1]
        if "tests/" in request.node.nodeid
        else request.node.nodeid
    )
    safe = _safe_nodeid(request.node.nodeid)
    trace_path = log_dir / "traces" / f"{safe}.trace.log"
    trace_path.parent.mkdir(parents=True, exist_ok=True)

    arena = Arena(rcon, config)
    harness_errors: list[str] = []

    # 0. Reconnect HTTP client if a prior test left the bot mid-disconnect.
    try:
        tester_bot.ensure_connected(reconnect_timeout=12.0)
    except TimeoutError as e:
        harness_errors.append(f"ensure_connected: {e}")

    # 1. Geometry reset, state clean, rescue (canonical ground arena).
    try:
        reset_ground_arena(rcon, world)
        arena.clean()
        arena.rescue_tester(bot=tester_bot, wait=True)
    except Exception as e:  # noqa: BLE001 — record + continue
        harness_errors.append(f"rescue_tester: {type(e).__name__}: {e}")

    # 2. Announce.
    try:
        rcon.run(f'execute in {world} run say [test #{n}] {short}')
    except Exception as e:  # noqa: BLE001
        harness_errors.append(f"announce_start: {type(e).__name__}: {e}")

    # 3. TEST_START marker. Capture the bot's pos via the trace's
    #    own preserve=true status call so we don't perturb runtime state.
    bot_pos = "?"
    try:
        p = tester_bot.position() or {}
        if p:
            bot_pos = f"{p.get('x')},{p.get('y')},{p.get('z')}"
            # Sentinel: post-rescue, the bot should be parked near
            # (0, 65, 0).
            try:
                bx = float(p.get("x") or 0)
                by = float(p.get("y") or 0)
                bz = float(p.get("z") or 0)
                if abs(bx) > 2 or abs(by - 65) > 5 or abs(bz) > 2:
                    msg = (
                        f"bot_not_at_safe_park: pos={bx:.1f},{by:.1f},{bz:.1f} "
                        f"(expected near 0,65,0) — rescue_tester ran but did "
                        f"not place the bot; downstream test failures in this "
                        f"and adjacent tests may be cascade-attributable."
                    )
                    harness_errors.append(msg)
                    warnings.warn(
                        f"[harness] {request.node.nodeid}: {msg}",
                        stacklevel=0,
                    )
            except (TypeError, ValueError):
                pass
    except Exception as e:  # noqa: BLE001
        harness_errors.append(f"start_pos: {type(e).__name__}: {e}")
    ts_start = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    try:
        with open(trace_path, "w") as f:
            f.write(
                f"# TEST_START n={n} nodeid={request.node.nodeid} "
                f"ts={ts_start} bot_pos={bot_pos}\n"
            )
    except Exception as e:  # noqa: BLE001
        harness_errors.append(f"write_start: {type(e).__name__}: {e}")

    # 4. Start trace poller (appends after the header).
    no_trace = request.node.get_closest_marker("no_trace") is not None
    trace_marker = request.node.get_closest_marker("trace")
    interval = 1.0
    if trace_marker:
        if trace_marker.kwargs.get("interval") is not None:
            interval = float(trace_marker.kwargs["interval"])
        elif trace_marker.args:
            interval = float(trace_marker.args[0])

    trace = None
    if not no_trace:
        trace = BotTrace(tester_bot.base, trace_path, interval=interval)
        try:
            trace.start()
        except Exception as e:  # noqa: BLE001
            harness_errors.append(f"trace_start: {type(e).__name__}: {e}")

    t0 = time.time()

    try:
        yield
    finally:
        elapsed = time.time() - t0

        # 6. Stop poller.
        if trace is not None:
            try:
                trace.stop()
            except Exception as e:  # noqa: BLE001
                harness_errors.append(f"trace_stop: {type(e).__name__}: {e}")

        # Resolve test outcome from the makereport-stashed report.
        rep_call = getattr(request.node, "rep_call", None)
        rep_setup = getattr(request.node, "rep_setup", None)
        if rep_call is None and rep_setup is not None and rep_setup.failed:
            outcome = "error"  # failed in setup, body never ran
        elif rep_call is None:
            outcome = "unknown"
        elif rep_call.passed:
            outcome = "pass"
        elif rep_call.skipped:
            outcome = "skip"
        else:
            outcome = "fail"

        # 7. TEST_END marker.
        ts_end = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        try:
            with open(trace_path, "a") as f:
                f.write(
                    f"# TEST_END n={n} ts={ts_end} elapsed={elapsed:.2f}s "
                    f"outcome={outcome}\n"
                )
                for err in harness_errors:
                    f.write(f"# HARNESS_ERR {err}\n")
        except Exception:  # noqa: BLE001 — never let trace write break teardown
            pass

        # 8. Done announcement.
        try:
            rcon.run(f'execute in {world} run say [done #{n}] {elapsed:.1f}s {outcome}')
        except Exception:  # noqa: BLE001
            pass

        # 9. Park: next test's harness rescue_tester parks at 0,65,0.
        # Session end: _final_park runs once.
