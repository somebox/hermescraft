"""Arena — canonical blank-slate world setup for functional tests.

Every existing scripts/test-*.py has a near-identical preamble: kill all
non-player entities, set difficulty peaceful, set time to noon, freeze the
daylight cycle, clear the test bot's inventory, give it saturation. Some
tests also fill a bounding box with air. This class makes that one call.

Harness post-condition (autouse _functional_harness in tests/conftest.py):

After the autouse _functional_harness fixture has run (which happens
before any per-test fixture), the Tester bot is guaranteed to be:
  - In world config.mc.world (mvtp'd via Multiverse-Core)
  - Survival gamemode, full HP, saturation 600s
  - Standing on the canonical grass cap at (0, 65, 0)
  - Below the grass: dirt y=60..63, stone y=50..59 (session substrate)
  - Stationary (wait_until_stationary returned)
  - With lastMoveFailed / recentEscapes / recentStuckCells cleared
  - Inventory cleared (no leftover items from prior tests)
  - No non-player entities in the world (mobs and dropped items killed)

Per-test fixtures MUST NOT:
  - call arena.rescue_tester() (harness did it)
  - call arena.clean() (harness step 1b does kill @e + clear Tester)
  - call tester_bot.wait_until_ready (session fixture does it once)
  - call mvtp Tester / tp Tester 0 65 0 (harness already parked)

Per-test fixtures MAY:
  - call arena.reset_workspace(bbox=..., floor=...) to lay a fresh
    arena floor (geometry only, does not touch bot state)
  - call arena.place_player(bot, x, y, z, expected_floor_y=...)
    to position the bot on that floor
  - issue give/effect commands for test-specific inventory/effects

TP Y coordinate is the bot's feet position and must equal floor_top_y + 1
when using expected_floor_y. There is no "drop margin."
"""

from __future__ import annotations

import time
from typing import Iterable

from .rcon import RconClient

PREFAB_VAULT_ORIGIN = (200, 48, 200)
PREFAB_SLOT_STRIDE = 64
_PREFAB_REGISTRY: dict[str, tuple[int, int, int, int, int, int]] = {}
_PREFAB_SLOTS: dict[str, int] = {}


class Arena:
    """Test-world setup/teardown helper. Pass an RconClient and the config dict."""

    def __init__(self, rcon: RconClient, config: dict, bot_name: str = "Tester"):
        self.rcon = rcon
        self.config = config
        self.world = config["mc"]["world"]
        self.bot_name = bot_name
        self._settle_seconds = config["test"]["settle_seconds"]

    def clean(self, bbox: tuple[int, int, int, int, int, int] | None = None) -> str:
        """Reset world state to a known-clean baseline.

        Args:
            bbox: Optional (x1,y1,z1,x2,y2,z2) — fill this box with air. Useful
                  when the test world has accumulated test-block detritus.

        Returns:
            Combined rcon stdout from the batched commands.
        """
        # difficulty / gamerules / time / weather are now set once at
        # session scope (see tests/conftest.py::_functional_session_setup).
        # arena.clean() handles only per-test world reset: entity kill,
        # inventory clear, fresh saturation effect.
        cmds = [
            f"execute in {self.world} run difficulty peaceful",
            f"execute in {self.world} run time set noon",
            f"execute in {self.world} run kill @e[type=!player]",
            f"clear {self.bot_name}",
            f"effect clear {self.bot_name}",
            f"effect give {self.bot_name} minecraft:saturation 600 1",
        ]
        if bbox is not None:
            x1, y1, z1, x2, y2, z2 = bbox
            cmds.append(f"execute in {self.world} run fill {x1} {y1} {z1} {x2} {y2} {z2} air")
        return self.rcon.batch(cmds)

    def prep(self, commands: Iterable[str]) -> str:
        """Run a fixture-style list of rcon commands (the `prep:` block in
        a YAML fixture). Batched."""
        return self.rcon.batch(commands)

    def cleanup(self, commands: Iterable[str]) -> str:
        """Run a fixture-style cleanup list. Batched."""
        return self.rcon.batch(commands)

    def settle(self, seconds: float | None = None) -> None:
        """Sleep `seconds` (default config.test.settle_seconds). Lets the bot's
        perception catch up with world state before assertions."""
        time.sleep(seconds if seconds is not None else self._settle_seconds)

    def settle_fast(self) -> None:
        """0.3s: after a small (<8) setblock batch on already-loaded chunks."""
        time.sleep(0.3)

    def settle_default(self) -> None:
        """1.0s: after fills or moderate batches."""
        time.sleep(1.0)

    def settle_water(self) -> None:
        """2.0s: after water/lava placement."""
        time.sleep(2.0)

    def settle_heavy(self) -> None:
        """2.5s: after multi-region rebuilds + forceload changes."""
        time.sleep(2.5)

    def wait_until_stationary(
        self,
        bot,
        *,
        timeout_s: float = 6.0,
        stable_for_s: float = 0.6,
        tolerance: float = 0.15,
    ) -> dict:
        """Poll /health until the bot's (x,y,z) holds steady within `tolerance`
        for `stable_for_s`. The bot just got tp'd and Tester often arrives
        airborne (test world has voids below y=64 in places); without this
        wait, the per-test arena fixture finishes BEFORE the bot lands and
        the test body runs against a falling/dying bot — exactly the symptom
        re44 spotted as recurring across the functional suite.

        Returns the last /health snapshot. Raises on timeout so the failure
        is loud and points at the right thing instead of cascading into a
        generic "test body failed" error.
        """
        deadline = time.time() + timeout_s
        last_pos = None
        stable_since = None
        last_health = None
        while time.time() < deadline:
            last_health = bot.get("/health", timeout=2.0)
            pos = last_health.get("position") or {}
            if last_pos is not None:
                dx = abs((pos.get("x") or 0) - (last_pos.get("x") or 0))
                dy = abs((pos.get("y") or 0) - (last_pos.get("y") or 0))
                dz = abs((pos.get("z") or 0) - (last_pos.get("z") or 0))
                if max(dx, dy, dz) <= tolerance:
                    if stable_since is None:
                        stable_since = time.time()
                    elif time.time() - stable_since >= stable_for_s:
                        return last_health
                else:
                    stable_since = None
            last_pos = pos
            time.sleep(0.15)
        raise AssertionError(
            f"wait_until_stationary: {self.bot_name} never settled within {timeout_s}s "
            f"(last pos={last_pos}, tolerance={tolerance})"
        )

    def rescue_tester(
        self,
        *,
        safe_xyz: tuple[float, float, float] = (0.0, 65.0, 0.0),
        bot: "BotClient | None" = None,
        wait: bool = True,
    ) -> None:
        """Force the Tester bot into a clean, alive, invulnerable state.

        Use at the TOP of every fixture so it doesn't matter how the previous
        test (or an external command) left the bot. Sequence:

          1. POST /action/stop — clear any in-flight pathfinder goal from
             a prior test (e.g. one that timed out mid-walk)
          2. difficulty peaceful — auto-regen + no mob aggro
          3. gamemode creative   — immediate full HP, invulnerable, no fall dmg
          4. setblock floor at safe_xyz — guarantee a landing surface so a
             gravity-affected TP into landfolk-test's voids doesn't drop
             Tester into the abyss while the test fixture is still building
             walls/pillars upstairs
          5. tp to safe coords + small floor
          6. wait_until_stationary (when `wait=True`) — block until Tester
             reports an unchanged position for 0.6s. Without this, fixtures
             have raced setblock-vs-gravity for years; tests sporadically
             see the bot mid-air at start.

        Pass `bot` if you have a BotClient handy — without it the
        /action/stop and wait steps are skipped.
        """
        if bot is not None:
            try:
                bot.post("/action/stop", {}, timeout=3.0)
            except Exception:
                pass
        sx, sy, sz = safe_xyz
        floor_y = int(sy) - 1
        ix, iz = int(sx), int(sz)
        needs_heavy = False
        if bot is not None:
            try:
                s = bot.status_lean()
                hp = s.get("health") or 0
                pos = s.get("position") or {}
                dx = abs((pos.get("x") or 0) - sx)
                dz = abs((pos.get("z") or 0) - sz)
                if hp < 19 or dx > 5 or dz > 5:
                    needs_heavy = True
            except Exception:
                needs_heavy = True
        else:
            needs_heavy = True

        cmds = [
            f"mvtp {self.bot_name} {self.world}",
            f"execute in {self.world} run difficulty peaceful",
        ]
        if needs_heavy:
            cmds.extend([
                f"gamemode creative {self.bot_name}",
                f"execute in {self.world} run fill {ix - 1} {floor_y} {iz - 1} {ix + 1} {floor_y} {iz + 1} minecraft:stone",
                f"execute in {self.world} run fill {ix - 1} {int(sy)} {iz - 1} {ix + 1} {int(sy) + 2} {iz + 1} minecraft:air",
                f"execute in {self.world} run tp {self.bot_name} {sx} {sy} {sz} 0 0",
                f"gamemode survival {self.bot_name}",
                f"effect give {self.bot_name} minecraft:saturation 600 1",
                f"effect give {self.bot_name} minecraft:instant_health 1 10",
            ])
        else:
            cmds.extend([
                f"execute in {self.world} run tp {self.bot_name} {sx} {sy} {sz} 0 0",
                f"effect give {self.bot_name} minecraft:saturation 600 1",
            ])
        self.rcon.batch(cmds)
        if bot is not None and wait:
            self.wait_until_stationary(bot, timeout_s=6.0, stable_for_s=0.5)
        # F51.2/F58 reset between tests. wait_until_stationary above
        # uses ?preserve=true (BotClient.status_lean) so it does NOT
        # clear lastMoveFailed / recentEscapes / recentStuckCells —
        # those persist by design for the agent's own decision-making
        # within a single agent session. But across pytest tests we
        # want a clean slate: a prior test's failed goto must not
        # poison the next test's position-guard. Hit GET /status
        # WITHOUT preserve=true to invoke the agent-style reset.
        if bot is not None:
            try:
                bot.get("/status?lean=true", timeout=3.0)
            except Exception:
                pass

    def verify_tester_ready(
        self,
        bot,
        *,
        expected_xz: tuple[float, float] | None = None,
        expected_y_at_least: float | None = None,
        min_hp: float = 19.5,
        xz_tol: float = 1.5,
    ) -> dict:
        """Assert pre-test conditions: Tester in survival mode, on the
        expected cell, at full (or near-full) HP.

        Returns the bot's lean status dict so the caller can reuse position
        / health values it already fetched. Raises AssertionError with a
        descriptive message on mismatch.
        """
        gm = self.rcon.run(
            f"execute in {self.world} run data get entity {self.bot_name} playerGameType"
        )
        # Survival=0, creative=1, adventure=2, spectator=3. Response looks
        # like "> Tester has the following entity data: 0\n>" — rcon-cli
        # tacks on prompt chars, so search for "data: <N>" rather than
        # using endswith.
        import re
        m = re.search(r"data:\s*([0-3])", gm)
        if not m and ("No entity" in gm or "entity was found" in gm.lower()):
            self.rcon.run(f"mvtp {self.bot_name} {self.world}")
            gm = self.rcon.run(
                f"execute in {self.world} run data get entity {self.bot_name} playerGameType"
            )
            m = re.search(r"data:\s*([0-3])", gm)
        if not m:
            self.rcon.run(f"gamemode survival {self.bot_name}")
            gm = self.rcon.run(
                f"execute in {self.world} run data get entity {self.bot_name} playerGameType"
            )
            m = re.search(r"data:\s*([0-3])", gm)
        assert m and m.group(1) == "0", (
            f"setup: {self.bot_name} not in survival gamemode (rcon said: {gm!r}). "
            f"Check that the fixture flipped back from creative."
        )
        status = bot.status_lean()
        hp = status.get("health") or 0
        assert hp >= min_hp, (
            f"setup: {self.bot_name} HP={hp} (need ≥{min_hp}) — "
            f"prior test damage didn't heal or the heal didn't propagate"
        )
        pos = status.get("position") or {}
        if expected_xz is not None:
            ex, ez = expected_xz
            dx = abs((pos.get("x") or 0) - ex)
            dz = abs((pos.get("z") or 0) - ez)
            assert dx <= xz_tol and dz <= xz_tol, (
                f"setup: {self.bot_name} at {pos}, expected x≈{ex} z≈{ez} (tol {xz_tol})"
            )
        if expected_y_at_least is not None:
            assert (pos.get("y") or 0) >= expected_y_at_least, (
                f"setup: {self.bot_name} y={pos.get('y')}, expected ≥{expected_y_at_least} "
                f"(bot may have fallen off the test surface)"
            )
        return status

    def teleport_bot(self, x: float, y: float, z: float, yaw: float = 0.0, pitch: float = 0.0) -> str:
        """Convenience: tp the configured bot into the test world at coords."""
        return self.rcon.run(
            f"execute in {self.world} run tp {self.bot_name} {x} {y} {z} {yaw} {pitch}"
        )

    def place_player(
        self,
        bot,
        x: float,
        y: float,
        z: float,
        *,
        yaw: float = 0.0,
        pitch: float = 0.0,
        wait: bool = True,
        expected_floor_y: int | None = None,
        expected_floor_block: str | None = None,
    ) -> dict | None:
        """Place the bot at (x,y,z) and wait until stationary.

        If expected_floor_y is given, assert floor alignment before tp.
        TP Y must equal floor_top_y + 1 (feet on floor, no free-fall drop).
        """
        if expected_floor_y is not None:
            import math

            fx, fz = math.floor(x), math.floor(z)
            if expected_floor_block is not None:
                if not self.rcon.block_is(
                    fx, expected_floor_y, fz, expected_floor_block, world=self.world
                ):
                    raise AssertionError(
                        f"place_player: expected floor {expected_floor_block} at "
                        f"({fx},{expected_floor_y},{fz}), but block differs. "
                        f"Fix arena setup before TP."
                    )
            if int(y) != expected_floor_y + 1:
                raise AssertionError(
                    f"place_player: TP Y={y} is not floor_top_y+1 ({expected_floor_y + 1}). "
                    f"Free-fall placement is forbidden; place props first, then TP."
                )
        self.teleport_bot(x, y, z, yaw, pitch)
        if wait:
            return self.wait_until_stationary(bot, timeout_s=3.0, stable_for_s=0.2)
        return None

    def move_to_safe(self, bot=None, *, safe_xyz: tuple[float, float, float] = (0.0, 65.0, 0.0)) -> None:
        """Step 4 of the canonical test sequence: park the bot at a known
        safe coord OUTSIDE the test arena. Run from a post-test cleanup
        hook so test #N's geometry (open pits, lava blocks, etc.) doesn't
        decide test #N+1's bot fate before #N+1's fixture has a chance to
        rebuild. Idempotent; safe to call multiple times.
        """
        sx, sy, sz = safe_xyz
        floor_y = int(sy) - 1
        ix, iz = int(sx), int(sz)
        self.rcon.batch([
            f"execute in {self.world} run fill {ix - 1} {floor_y} {iz - 1} {ix + 1} {floor_y} {iz + 1} minecraft:stone",
            f"execute in {self.world} run fill {ix - 1} {int(sy)} {iz - 1} {ix + 1} {int(sy) + 2} {iz + 1} minecraft:air",
            f"execute in {self.world} run tp {self.bot_name} {sx} {sy} {sz} 0 0",
        ])
        if bot is not None:
            try:
                self.wait_until_stationary(bot, timeout_s=4.0, stable_for_s=0.3)
            except AssertionError:
                # Post-test teardown is best-effort — a failure here
                # shouldn't mask the actual test result. Next test's
                # autouse pre-rescue picks up the slack.
                pass

    def flat_arena(
        self,
        bbox: tuple[int, int, int, int, int, int],
        floor: str = "grass_block",
        floor_y: int | None = None,
    ) -> str:
        """Build a flat playing field: air-fill `bbox`, then lay a single floor
        layer at the bottom (or at `floor_y` if specified).

        Replaces the legacy 4-line preamble that 30+ scripts duplicate:
            fill x1 y1 z1 x2 y2 z2 air
            fill x1 y1 z1 x2 y1 z2 <floor>

        Args:
            bbox: (x1, y1, z1, x2, y2, z2). y1 is the floor layer; y2 is the
                  top of the air column.
            floor: block name for the floor layer (default grass_block).
                  Pass 'minecraft:<kind>' or bare 'kind' — prefix added if missing.
            floor_y: override the floor row (default = y1 from bbox).
        """
        x1, y1, z1, x2, y2, z2 = bbox
        fy = y1 if floor_y is None else floor_y
        floor_full = floor if ":" in floor else f"minecraft:{floor}"
        return self.rcon.batch([
            f"execute in {self.world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air",
            f"execute in {self.world} run fill {x1} {fy} {z1} {x2} {fy} {z2} {floor_full}",
        ])

    def reset_workspace(
        self,
        bbox: tuple[int, int, int, int, int, int],
        *,
        floor: str = "grass_block",
        subfloor: str | None = None,
        floor_y: int | None = None,
        forceload: bool = False,
    ) -> str:
        """Lay a clean test arena. Assumes harness already rescued the bot.

        Geometry only — does not touch bot state or entities.
        """
        x1, y1, z1, x2, y2, z2 = bbox
        fy = y1 if floor_y is None else floor_y
        floor_full = floor if ":" in floor else f"minecraft:{floor}"
        cmds = []
        if forceload:
            cx1, cz1 = x1 >> 4, z1 >> 4
            cx2, cz2 = x2 >> 4, z2 >> 4
            cmds.append(
                f"execute in {self.world} run forceload add {cx1} {cz1} {cx2} {cz2}"
            )
        cmds.append(
            f"execute in {self.world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air"
        )
        if subfloor is not None:
            sub_full = subfloor if ":" in subfloor else f"minecraft:{subfloor}"
            cmds.append(
                f"execute in {self.world} run fill {x1} {y1} {z1} {x2} {fy - 1} {z2} {sub_full}"
            )
        cmds.append(
            f"execute in {self.world} run fill {x1} {fy} {z1} {x2} {fy} {z2} {floor_full}"
        )
        return self.rcon.batch(cmds)

    def grid_3x3(
        self,
        center: tuple[int, int, int] = (4, 65, 4),
        block: str = "cobblestone",
        height: int = 1,
        clear_bbox: tuple[int, int, int, int, int, int] | None = None,
        floor: str = "grass_block",
    ) -> str:
        """Build the canonical 3×3 pillar grid used by mining-family tests.

        Pillar foot-cells sit at `(cx±2, cy, cz±2)` and `(cx, cy, cz)` — i.e.
        x ∈ {cx-2, cx, cx+2}, z ∈ {cz-2, cz, cz+2}, with `height` blocks each
        stacked up from cy. With the default center (4,65,4) the grid
        matches the legacy test geometry (pillars at x∈{2,4,6}, z∈{2,4,6}).

        If `clear_bbox` is given, the area is air-filled and floored first.
        Otherwise the caller is expected to have called `flat_arena` already.
        """
        cx, cy, cz = center
        cmds: list[str] = []
        if clear_bbox is not None:
            x1, y1, z1, x2, y2, z2 = clear_bbox
            floor_full = floor if ":" in floor else f"minecraft:{floor}"
            cmds.append(f"execute in {self.world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air")
            cmds.append(f"execute in {self.world} run fill {x1} {y1} {z1} {x2} {y1} {z2} {floor_full}")
        block_full = block if ":" in block else f"minecraft:{block}"
        for dx in (-2, 0, 2):
            for dz in (-2, 0, 2):
                for dy in range(height):
                    cmds.append(
                        f"execute in {self.world} run setblock {cx + dx} {cy + dy} {cz + dz} {block_full}"
                    )
        return self.rcon.batch(cmds)

    def forceload(self, bbox: tuple[int, int, int] | tuple[int, int, int, int]) -> str:
        """Forceload a chunk or rectangular chunk range. Accepts either
        (cx, cz) for a single chunk or (cx1, cz1, cx2, cz2) for a range.

        Coordinates are CHUNK coords, not block coords. To forceload a region
        around block coord 0,0 → chunk (0,0) → call forceload((0,0)).

        Forceload is required if a test runs against chunks that aren't
        already loaded (e.g. fresh `landfolk-test` world startups). The
        legacy tests issued `forceload add ... ; forceload remove all`
        bracketing their runs; the harness defaults to NOT issuing these
        because most test runs hit already-loaded chunks. Tests that
        explicitly need it should call this helper.
        """
        if len(bbox) == 2:
            cx, cz = bbox
            return self.rcon.run(f"execute in {self.world} run forceload add {cx} {cz}")
        cx1, cz1, cx2, cz2 = bbox
        return self.rcon.run(f"execute in {self.world} run forceload add {cx1} {cz1} {cx2} {cz2}")

    def forceload_remove_all(self) -> str:
        """Mirror of `forceload`. Removes all forceloaded chunks in the world."""
        return self.rcon.run(f"execute in {self.world} run forceload remove all")

    def save_prefab(self, name: str, bbox: tuple[int, int, int, int, int, int]) -> None:
        vx, vy, vz = PREFAB_VAULT_ORIGIN
        if name not in _PREFAB_SLOTS:
            _PREFAB_SLOTS[name] = len(_PREFAB_SLOTS)
        slot = _PREFAB_SLOTS[name]
        if slot >= 20:
            raise RuntimeError(
                "prefab vault full (20 slots); grow PREFAB_SLOT_STRIDE or the vault slab"
            )
        dest = (vx + slot * PREFAB_SLOT_STRIDE, vy, vz)
        self.rcon.clone(bbox, dest, mask="replace", mode="normal")
        _PREFAB_REGISTRY[name] = (
            dest[0],
            dest[1],
            dest[2],
            dest[0] + (bbox[3] - bbox[0]),
            dest[1] + (bbox[4] - bbox[1]),
            dest[2] + (bbox[5] - bbox[2]),
        )

    def load_prefab(
        self,
        name: str,
        dest_origin: tuple[int, int, int],
        *,
        mask: str = "masked",
    ) -> str:
        if name not in _PREFAB_REGISTRY:
            raise KeyError(
                f"prefab {name!r} not saved; call save_prefab() at session setup"
            )
        return self.rcon.clone(_PREFAB_REGISTRY[name], dest_origin, mask=mask)
