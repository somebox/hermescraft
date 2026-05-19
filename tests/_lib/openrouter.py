"""OpenRouter one-shot LLM calls for integration tests (perception digest)."""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import yaml

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
    timeout_s: float = 60.0,
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
