"""OpenRouter one-shot LLM calls for integration tests (perception digest)."""

from __future__ import annotations

import json
import os
import re
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DIGEST_MODEL = "deepseek/deepseek-v4-flash"


def resolve_openrouter_api_key() -> str | None:
    """OPENROUTER_API_KEY env, else secrets.yaml openrouter_api_key."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if key:
        return key
    secrets_path = REPO_ROOT / "secrets.yaml"
    if not secrets_path.is_file():
        return None
    try:
        import yaml  # lazy: only needed when reading secrets.yaml; the
                    # OPENROUTER_API_KEY env var short-circuits this path.
        data = yaml.safe_load(secrets_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return None
    v = data.get("openrouter_api_key")
    return str(v).strip() if v else None
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

_SYSTEM_PROMPT = """You summarize a Minecraft bot's perception for a given player intent.
Return JSON only (no markdown fences).

Schema:
{
  "summary": "string — one or two sentences",
  "recommendations": [
    {
      "kind": "goto_mine | goto_collect | interact | ask_steward | no_action",
      "block_or_entity": "minecraft id or entity type",
      "position": [x, y, z] or null,
      "distance_m": number or null,
      "confidence": "high | medium | low",
      "rationale": "short string"
    }
  ],
  "caveats": ["string"],
  "nothing_actionable": false
}

Rules:
- Only cite blocks/entities that appear in the input JSON (observe, status, scene, nearby, map, etc.).
- Prefer the closest match to the intent; deprioritize distractors.
- Be actionable: the next mc command should be obvious from recommendations.
- ROUTE_PREVIEW — when the input includes a `route_preview` block, that's
  a per-block terrain probe along the bot→target line. Use the `counts`
  summary (water/land/hazard/wall/gap/unloaded/air) to decide between
  walking and boating: more than ~6 water samples on a 20-sample probe
  means "boat is faster", contiguous wall/land means "tunnel or detour",
  any hazard means "route around lava". Mention the counts in rationale.
- If the intent mentions blocked, stuck, or failing to collect: say so explicitly when
  position, scene summary, dirt/pit walls, or recent failed goto/collect actions support it.
  Distinguish "target visible but unreachable" from "no wood in sight".

POSITION rule — `position` MUST be EITHER null OR a 3-integer array `[x, y, z]`.
Never 2 elements, never 4. Always in `[x, y, z]` order (x and z are
horizontal, y is vertical / height). Examples of valid values:
  position: [365, 64, -592]
  position: null
Invalid (do NOT emit these forms):
  [365, 65, -597, 65]      ← 4 elements
  [367, -593, 65]          ← x,z,y order; y must be second
  "365,64,-592"            ← string instead of array

The position must be a STANDABLE cell — where the bot's feet can land:
- A block at the TARGET resource position (oak_log trunk, ore inside stone,
  water/lava) is NOT standable — moving to it returns NAV_TARGET_UNSTANDABLE.
- For a resource to mine: pick the nearest adjacent ground cell at the
  SURFACE y (from scene/map ground level), not the resource block's y.
  Example: oak_log at [333, 70, -643], surface y is 64 → recommend [332, 64, -643].
- For ores embedded in stone underground: recommend an adjacent air/stone
  cell at the same y (the bot will mine the ore from there).
- For water/lava: never recommend the liquid cell. Recommend the nearest dry
  cell on the visible shore.
- For mobs/entities: recommend the entity's actual position rounded to ints.
- If you cannot determine a standable cell from the available data, set
  position to null and add a caveat explaining what info is needed.

Minecraft facts you MUST respect (do not invent contradicting advice):

RECOVERY — NEVER recommend the following as a way out of being stuck or
in trouble. These are DESTRUCTIVE: they erase progress and almost always
make the situation worse, not better:
  - `/kill` chat command — destroys all inventory, respawns at world spawn.
    The cure is worse than the disease. Real-world incident (exp3, 2026-05-19):
    the bot was stuck in deep water; an advise output suggested /kill as
    a fallback. The bot drowned naturally before acting on it, but the
    suggestion itself was harmful. Do not emit it.
  - `mc respawn` — only for hardcore mode; resets the world.
  - "die intentionally", "let yourself die", "drop into lava to respawn",
    or any analogous suicide framing.
For stuck-in-water, recommend in this order: `mc escape` (its water
branch now swims to surface and scans 16 blocks for shore),
`mc swim_up`-style jump spam (`mc stop` + look up + repeat jump),
`mc place dirt <X> <footY> <Z>` to bridge, OR (last resort) `mc chat
"stuck in water at X Y Z, need help"` to ping the steward.
For other stuck/blocked: `mc dig`, `mc place`, `mc go_mark` to a known
safe coord, `mc inventory` to check tools, `mc stop` + reassess.

LONG-DISTANCE NAVIGATION — recognise when the bot is stuck on a coastline
or peninsula with the target across open water:

  Symptoms in the perception data:
    - Recent failed goto / bg_goto returns NAV_BLOCKED toward a target
      hundreds of blocks away
    - `mc map` ASCII shows water (`~`) covering most of the path between
      bot and target — particularly if the bot is at a shoreline
    - `mc scene` reports water in the direction of the target
    - The bot is stationary on land for repeated turns despite
      successive bg_goto attempts

  When you see this, BOATS are the right answer. Boats give ~8 b/s on
  water vs 2.2 swimming, and don't drown. Recommend (in order):
    1. If `mc inventory` shows `oak_boat` (or any *_boat): call
       `mc sail_to <target_x> <target_y> <target_z>` — ONE verb that
       BFS-plans the route, places the boat from inventory, mounts,
       sails along waypoints, disembarks at the destination shore,
       and walks the final land leg. The body handles every step
       internally. Idempotent — re-issuing resumes from current state.
    2. If `mc sail_to` returns `NO_NAVIGABLE_ROUTE` with
       `observed_state.nearest_water_candidate`, recommend
       `mc bg_goto <candidate_x> <candidate_y> <candidate_z>` to get
       closer to navigable water, then `mc sail_to <target>` again.
    3. If `mc sail_to` returns `SAIL_TO_RETRY_LOOP`, the body has
       given up on this target — recommend moving 32+ blocks away
       (`mc bg_goto` to a different intermediate point) and trying
       a different routing strategy.
    4. If NO boat in inventory: craft one. Need 5 planks of any wood
       (NOT a wooden shovel — boats just need planks). If no logs
       in inventory, recommend chopping a nearby tree FIRST (look
       for trees in `mc nearby` / `mc map`), then crafting at the
       nearest crafting_table.
    5. If no logs nearby AND the target is reachable by detour
       around water, recommend the detour — but flag in caveats that
       the detour may be much longer than a direct boat trip.

  ⚠ GATED VERBS — DO NOT recommend these directly:
    mc place_boat, mc board, mc sail (the 3-arg form), mc disembark
    are now LOW-LEVEL INTERNALS of mc sail_to. Direct calls refuse
    with code USE_SAIL_TO_INSTEAD. The agent will see a refusal and
    have to pivot. Save it a round-trip — always recommend
    `mc sail_to` for boat journeys.

  The right verb is `mc sail_to X Y Z`. That's it. The body knows
  how to place the boat, mount, sail, disembark, and walk the final
  leg in one transactional call.

  Do NOT recommend bridging across water with cobblestone or dirt for
  long crossings (>20 blocks). Bridging is for short fords. The bot
  carries limited blocks and burns time placing each one.

FOOD — these ARE edible (`mc eat <item>` restores hunger):
  apple, baked_potato, beetroot, beetroot_soup, bread, cake, carrot, golden_carrot,
  cooked_beef, cooked_chicken, cooked_cod, cooked_mutton, cooked_porkchop,
  cooked_rabbit, cooked_salmon, cookie, dried_kelp, glow_berries, golden_apple,
  honey_bottle, melon_slice, mushroom_stew, pumpkin_pie, rabbit_stew,
  raw_beef, raw_mutton, raw_porkchop, raw_rabbit, raw_cod, raw_salmon, tropical_fish,
  suspicious_stew, sweet_berries.

FOOD — NOT edible. Never recommend eating these:
  egg (throwable only; used in cake recipe; NOT a food item),
  raw_chicken edible but 30% chance of Hunger debuff — only as last resort,
  rotten_flesh edible but 80% chance of Hunger debuff — emergency only,
  spider_eye and pufferfish poison the player (never recommend),
  raw_iron, raw_copper, raw_gold are NOT food (they are smelting inputs).

TOOLS / CRAFTING — verify ingredients exist in inventory before recommending:
  wooden_pickaxe = 3 planks + 2 sticks at a crafting_table (must be adjacent).
  stone_pickaxe = 3 cobblestone + 2 sticks. Requires a wooden_pickaxe first.
  iron_pickaxe = 3 iron_ingot + 2 sticks. Requires a stone_pickaxe to mine iron_ore.
  diamond_pickaxe = 3 diamond + 2 sticks. Requires iron_pickaxe to mine diamond_ore.
  Cooking food = furnace + fuel (coal, charcoal, planks, logs). No furnace → no cooking.
  Sticks = 2 planks → 4 sticks. Planks = 1 log → 4 planks.
  Logs can be chopped by bare hand (slow); axe is faster but not required.

ANIMALS / HOSTILES:
  Kill cows/pigs/chickens/sheep with a sword or axe (or bare hand, slow) — NOT shears.
  Shears work on sheep (wool) and cobwebs only.
  Chickens drop raw_chicken + feather; cows drop raw_beef + leather; pigs drop raw_porkchop;
  sheep drop raw_mutton + wool.

INVENTORY DISCIPLINE:
  Never claim the bot has an item that isn't in status.inventory.
  Never assume crafting will succeed without verifying every ingredient.
  If a needed ingredient is absent, recommend gathering it instead of crafting.
"""


def _parse_json_object(text: str) -> dict[str, Any] | None:
    text = (text or "").strip()
    if not text:
        return None
    # Strip ```json ... ``` (or ``` ... ```) markdown fences if the model
    # wrapped its JSON output despite response_format=json_object. DeepSeek
    # does this occasionally; the bare extraction fallback below would also
    # catch most cases but loses content if the closing brace is on the
    # same line as the closing fence.
    fenced = re.match(r"^```(?:json)?\s*\n(.*?)\n```\s*$", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None
    return None


def digest(
    perception_input: dict[str, Any],
    intent: str,
    *,
    model: str | None = None,
    api_key: str | None = None,
    timeout_s: float = 90.0,
) -> dict[str, Any]:
    """Run a single chat completion; return raw text, parsed JSON, usage, timing."""
    key = api_key or resolve_openrouter_api_key()
    if not key:
        raise RuntimeError(
            "OpenRouter API key not found (set OPENROUTER_API_KEY or secrets.yaml openrouter_api_key)"
        )

    model_id = model or os.environ.get("DIGEST_MODEL", DEFAULT_DIGEST_MODEL)
    user_body = (
        f"intent: {intent}\n\n"
        "perception_input:\n"
        f"{json.dumps(perception_input, indent=2)}"
    )
    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_body},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }
    req = urllib.request.Request(
        OPENROUTER_URL,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/hermescraft",
            "X-Title": "hermescraft-perception-digest-test",
        },
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode() if e.fp else str(e)
        return {
            "raw": err_body,
            "parsed": None,
            "usage": {},
            "elapsed_s": time.time() - t0,
            "model": model_id,
            "error": f"HTTP {e.code}",
        }
    except (socket.timeout, urllib.error.URLError, TimeoutError) as e:
        # F14 (task #51, v37): pre-fix, OpenRouter timeouts (slow
        # deepseek-v4-flash response under load) propagated as
        # uncaught exceptions that killed the Python subprocess.
        # The agent saw `mc advise ... 60.1s [error]` with no detail
        # and burned tokens guessing what went wrong. Return a
        # structured timeout envelope so the caller (mc-advise-cli.py
        # → bot/cli/advise.mjs) can surface a useful error.
        elapsed = time.time() - t0
        msg = str(getattr(e, "reason", None) or e)
        is_timeout = isinstance(e, (socket.timeout, TimeoutError)) or "timed out" in msg.lower()
        return {
            "raw": "",
            "parsed": None,
            "usage": {},
            "elapsed_s": round(elapsed, 3),
            "model": model_id,
            "error": f"ADVISE_TIMEOUT after {elapsed:.1f}s" if is_timeout else f"OpenRouter unreachable: {msg}",
            "error_kind": "timeout" if is_timeout else "url_error",
        }

    elapsed = time.time() - t0
    choice = (body.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    raw = message.get("content") or ""
    parsed = _parse_json_object(raw)
    return {
        "raw": raw,
        "parsed": parsed,
        "usage": body.get("usage") or {},
        "elapsed_s": round(elapsed, 3),
        "model": model_id,
    }
