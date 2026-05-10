#!/usr/bin/env python3
"""
react-stub.py — minimum-viable reactive layer for hermescraft.

Polls /scene + /observe at 2 Hz. Decides between IDLE / FIGHT / FLEE based on
hostile proximity and HP. Calls mc actions via the bot's HTTP API.

Purpose:
- Verify the signal layer (visible_entities, damage_telemetry) is sufficient
  for a non-LLM consumer to keep the bot alive.
- Establish baseline reaction times before adding modes (Sprint 2 step C).
- Surface gaps: signals missing? signals too late? actions too slow?

Run:
    MC_API_URL=http://localhost:3001 python3 scripts/react-stub.py [seconds]

Default duration 60s. Logs every decision + state change.
"""
import json
import os
import sys
import time
import urllib.request

API = os.environ.get("MC_API_URL", "http://localhost:3001")

# ── Reactive policy thresholds ────────────────────────────────────────────────
POLL_INTERVAL_S = 0.5       # 2 Hz
MELEE_RANGE = 4             # within 4 blocks of a hostile → fight
CREEPER_FLEE_RANGE = 6      # creepers detonate at <3, flee well before
LOW_HP_THRESHOLD = 8        # below this, flee instead of fighting
RECENT_DAMAGE_S = 2         # damage within last N seconds counts as "currently being hit"

# ── Action execution ──────────────────────────────────────────────────────────

def http_get(path):
    return json.loads(urllib.request.urlopen(f"{API}{path}", timeout=3).read())


def http_post(path, body):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=15).read())


# ── Read sensors ──────────────────────────────────────────────────────────────

def read_state():
    """Merge /observe + /scene into one decision-ready snapshot."""
    obs = http_get("/observe")
    scene = http_get("/scene").get("data", {})
    state = obs.get("state", {})
    hp = state.get("health", 20)
    food = state.get("food", 20)
    damage_telem = state.get("damage_telemetry") or {}
    recently_damaged = (
        damage_telem.get("last_damage", 0) > 0
        and damage_telem.get("seconds_ago", 999) <= RECENT_DAMAGE_S
    )
    visible = scene.get("visible_entities") or []
    hostiles = [e for e in visible if e.get("kind") == "hostile"]
    closest_hostile = min(
        hostiles, key=lambda e: e.get("distance", 999), default=None
    )
    creepers = [e for e in hostiles if e.get("type") == "creeper"]
    closest_creeper = min(
        creepers, key=lambda e: e.get("distance", 999), default=None
    )
    return {
        "hp": hp,
        "food": food,
        "recently_damaged": recently_damaged,
        "damage": damage_telem,
        "hostiles": hostiles,
        "closest_hostile": closest_hostile,
        "closest_creeper": closest_creeper,
    }


# ── Decide ────────────────────────────────────────────────────────────────────

def decide(s):
    """Return ('action', kwargs) or ('idle', None)."""
    creeper = s["closest_creeper"]
    if creeper and creeper.get("distance", 999) <= CREEPER_FLEE_RANGE:
        return ("flee", {"distance": 16, "from": "creeper"})
    if s["hp"] <= LOW_HP_THRESHOLD and s["recently_damaged"]:
        return ("flee", {"distance": 16})
    hostile = s["closest_hostile"]
    if hostile and hostile.get("distance", 999) <= MELEE_RANGE:
        return ("fight", {"target": hostile["type"], "retreat_health": 5, "duration": 6})
    return ("idle", None)


# ── Run ───────────────────────────────────────────────────────────────────────

def main():
    duration = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    deadline = time.time() + duration
    last_action = ("idle", None)
    last_action_at = 0
    print(f"[react-stub] poll {POLL_INTERVAL_S}s, duration {duration}s, API={API}")
    print("[react-stub] thresholds: melee≤{} creeper≤{} low_hp≤{}".format(
        MELEE_RANGE, CREEPER_FLEE_RANGE, LOW_HP_THRESHOLD))
    while time.time() < deadline:
        try:
            s = read_state()
        except Exception as e:
            print(f"[react-stub] sensor error: {e}")
            time.sleep(POLL_INTERVAL_S)
            continue

        action, kwargs = decide(s)
        # Only call action if it changed OR if 4s since last call (re-fires).
        repeat_ok = time.time() - last_action_at > 4.0
        if action != last_action[0] or (action != "idle" and repeat_ok):
            hostiles_summary = ",".join(
                f"{h['type']}@{h.get('distance', '?')}" for h in s["hostiles"][:3]
            )
            print(
                f"[t={time.strftime('%H:%M:%S')}] hp={s['hp']:.1f} food={s['food']} "
                f"hostiles=[{hostiles_summary}] dmg_recent={s['recently_damaged']} → {action} {kwargs or ''}"
            )
            if action != "idle":
                try:
                    res = http_post(f"/action/{action}", kwargs)
                    msg = (res.get("data") or {}).get("result") or res.get("result", "")
                    print(f"    → {msg}")
                except Exception as e:
                    print(f"    → ERROR: {e}")
            last_action = (action, kwargs)
            last_action_at = time.time()
        time.sleep(POLL_INTERVAL_S)

    print("[react-stub] done")


if __name__ == "__main__":
    main()
