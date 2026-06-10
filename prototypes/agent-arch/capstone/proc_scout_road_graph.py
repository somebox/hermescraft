"""Proc-nav Road graph — two bots, multi-segment leveled corridor.

Catalog **ground-anchored** endpoints + agent ``road_bound_*`` marks
(``calibration/proc-nav-road.yaml``). Each segment gets **measure** + **clear**
cards (alternating Mox/Pip).

Graph name: ``proc-scout-road``.
"""

from __future__ import annotations

from .plan_verify_graph import OBSERVE_SKILLS
from .proc_nav_helpers import load_map_card
from .proc_scout_graph import PLAYBOOK, POSTMORTEM_MANIFEST, SCENARIO_MAP_JSON
from .road_config import (
    all_mark_names_for_graph,
    interior_bound_marks,
    load_road_config,
    road_segments,
)
from .wheat_graph import Card, Graph

BOT_MOX = "mox"
BOT_PIP = "pip"

ASSIGNEE_NAV_MOX = "navigator"
ASSIGNEE_NAV_PIP = "navigator-pip"
ASSIGNEE_BUILD_PIP = "builder"
ASSIGNEE_BUILD_MOX = "builder-mox"

NAV_SKILLS = (
    "kanban-worker",
    "agent-navigator",
    "minecraft-navigation",
    "minecraft-observe",
)
BUILD_SKILLS = (
    "kanban-worker",
    "agent-builder",
    "minecraft-building",
    "minecraft-mining",
    "minecraft-roadbuilding",
)

PLANNER_SKILLS = (
    "kanban-worker",
    "agent-planner",
    "minecraft-planning",
)

_ROAD_CFG = load_road_config()
ROAD_WIDTH_M = int(_ROAD_CFG["width_blocks"])
ROAD_CENTERLINE_BLOCKS_CATALOG = int(_ROAD_CFG["centerline_blocks"])
ROAD_SEGMENT_COUNT = int(_ROAD_CFG["segment_count"])
ROAD_SEGMENT_LENGTH = int(_ROAD_CFG["segment_length_blocks"])
ROAD_ENDPOINTS: tuple[str, ...] = tuple(_ROAD_CFG["endpoints"])
ROAD_INTERIOR_MARKS: tuple[str, ...] = interior_bound_marks(ROAD_SEGMENT_COUNT)
ROAD_ALL_MARKS: tuple[str, ...] = all_mark_names_for_graph(_ROAD_CFG)

# Persistent path for the road_plan.json artifact. Resolves W2-NAV-008
# (planner workspace is GC'd before downstream measure/clear cards can
# read the plan). Writing to data/runtime/ instead of $WORKSPACE keeps
# the plan available across the trial lifetime. Singleton; one active
# road trial at a time. Past trials should archive on completion.
ROAD_PLAN_JSON = "data/runtime/proc-nav-road-plan.json"


def _road_corridor_geom() -> dict[str, int]:
    """Derive corridor X/Z geometry from `last-scenario-map.json`.

    proc-nav-1781079999 postmortem (hypothesis A+B): card bodies hardcoded
    catalog coordinates (X=-1..1, Z = (seg-1)*12) while the materialized
    world placed the corridor at livemap X=-20 centerline, Z=-12..84. Every
    worker had to manually reconcile the two coordinate systems before
    issuing any mc verb. This helper reads the materialized map's overlook
    + return_post placements so card bodies emit livemap coords directly.

    Fallback values match the legacy catalog coords so the helper is safe
    on a clean checkout / before any materialization.
    """
    card = load_map_card()
    overlook = card.get("placements", {}).get("overlook") or card.get("overlook")
    return_post = card.get("placements", {}).get("return_post") or card.get("return_post")
    if (
        isinstance(overlook, (list, tuple)) and len(overlook) >= 3
        and isinstance(return_post, (list, tuple)) and len(return_post) >= 3
    ):
        center_x = int(overlook[0])
        corridor_z_start = int(overlook[2])
        # Corridor end = return_post Z. We don't trust it absolutely (the
        # canonical length is segment_count * segment_length_blocks from
        # config), but we use overlook Z to anchor the corridor's start.
    else:
        # Catalog default — same numbers the body used to hardcode.
        center_x = 0
        corridor_z_start = 0
    half = max(0, (ROAD_WIDTH_M - 1) // 2)
    x_min = center_x - half
    x_max = center_x + (ROAD_WIDTH_M - 1 - half)
    return {
        "center_x": center_x,
        "x_min": x_min,
        "x_max": x_max,
        "z_start": corridor_z_start,
    }


_GEOM = _road_corridor_geom()
ROAD_CORRIDOR_X_MIN = _GEOM["x_min"]
ROAD_CORRIDOR_X_MAX = _GEOM["x_max"]
ROAD_CORRIDOR_Z_START = _GEOM["z_start"]

ROAD_SPEC = (
    f"**Road:** {ROAD_WIDTH_M} blocks wide between catalog anchors "
    f"**:{ROAD_ENDPOINTS[0]}:** and **:{ROAD_ENDPOINTS[-1]}:** "
    f"({ROAD_CENTERLINE_BLOCKS_CATALOG} blocks centerline, {ROAD_SEGMENT_COUNT} segments). "
    "Interior boundaries are **agent `mc mark`** names "
    f"({', '.join(ROAD_INTERIOR_MARKS) or 'none'}) — not mapcatalog. "
    "Level walking surface per segment (dig/fill to target_y)."
)

ROAD_PLAN_SCHEMA = """
**`road_plan`** (JSON — one row per segment; automation clones worker cards from this):
```json
{
  "centerline_length_blocks": 48,
  "width_blocks": 3,
  "endpoints": ["overlook", "return_post"],
  "segment_boundaries": ["road_bound_1", "road_bound_2", "road_bound_3"],
  "segments": [
    {
      "id": 1,
      "from_mark": "overlook",
      "to_mark": "road_bound_1",
      "measure_bot": "mox",
      "clear_bot": "pip",
      "target_y": <int>,
      "passage": "dig|fill|stairs",
      "obstacles": []
    }
  ],
  "tooling": {"mox": ["iron_shovel", "iron_pickaxe"], "pip": ["iron_shovel", "iron_pickaxe"]},
  "automation_note": "same metadata schema for every segment_id"
}
```
"""


def _assign_measure(seg_id: int) -> tuple[str, str]:
    # proc-nav-1781079999 follow-up: collocate measure + clear on the
    # same bot per segment. Pre-fix the alternation was inverted
    # (measure-N and clear-N done by different bots), which created
    # cross-bot dependencies — clear-N would wait for the OTHER bot to
    # finish meas-N. With both bots running 8-card serial chains, the
    # cross-bot wait dominated the 2h trial time (~30-50 min cumulative
    # idle on the prior trial). Collocation: each bot owns alternating
    # segments end-to-end and runs its chain independently. Same total
    # work, same parallelism, no cross-bot handoffs.
    #   Pip:  segments 1, 3, 5, 7
    #   Mox:  segments 2, 4, 6, 8
    if seg_id % 2 == 1:
        return ASSIGNEE_NAV_PIP, BOT_PIP
    return ASSIGNEE_NAV_MOX, BOT_MOX


def _assign_clear(seg_id: int) -> tuple[str, str]:
    # Mirrors _assign_measure — same bot does the clear it just measured.
    if seg_id % 2 == 1:
        return ASSIGNEE_BUILD_PIP, BOT_PIP
    return ASSIGNEE_BUILD_MOX, BOT_MOX


def _plan_body() -> str:
    eps = ", ".join(f"**{m}**" for m in ROAD_ENDPOINTS)
    bounds = ", ".join(f"`{m}`" for m in ROAD_INTERIOR_MARKS) or "(agents define during explore)"
    return (
        f"Read under `$HERMESCRAFT_REPO`:\n"
        f"  1. **`{SCENARIO_MAP_JSON}`** — **ground-anchored** endpoints ({eps}); "
        f"interior marks {bounds}.\n"
        f"  2. **`calibration/proc-nav-road.yaml`** — segment count "
        f"**{ROAD_SEGMENT_COUNT}**, centerline **{ROAD_CENTERLINE_BLOCKS_CATALOG}** blocks.\n"
        f"  3. **`{PLAYBOOK}`** — proc-nav road section.\n"
        f"  4. `skill_view('minecraft-planning')`.\n"
        f"Optional: `{POSTMORTEM_MANIFEST}`.\n"
        f"{ROAD_SPEC}\n"
        f"Draft **`road_plan`** with **{ROAD_SEGMENT_COUNT} segment rows** (schema below). "
        "Alternate **measure_bot** / **clear_bot** Mox↔Pip per segment_id.\n"
        f"{ROAD_PLAN_SCHEMA}\n"
        "No `mc`. metadata.card_kind=research"
    )


def _segment_plan_body() -> str:
    seg_lines = "\n".join(
        f"  - Seg {sid}: {a} → {b}" for sid, a, b in road_segments(_ROAD_CFG)
    )
    return (
        f"Read **`corridor_profile`** (from parent SCOUT card metadata) + "
        f"**`{SCENARIO_MAP_JSON}`**.\n"
        f"Emit **`road_plan`** JSON with exactly **{ROAD_SEGMENT_COUNT}** segments:\n"
        f"{seg_lines}\n"
        f"\n"
        f"**Target Y discipline (CRITICAL — this is the bug from "
        f"`data/postmortems/proc-nav-lab/proc-nav-1780989125/postmortem-partial.md`):**\n"
        f"- The catalog endpoints in `{SCENARIO_MAP_JSON}` carry stale Y values "
        f"(the placement engine picks the highest cell in its target disc — "
        f"often 10+ blocks above or below the live walkable surface). "
        f"In the prior trial: catalog overlook Y=67 vs live surface Y=80 → 13-block drift.\n"
        f"- **NEVER** copy `placements.overlook[1]` or `placements.return_post[1]` from "
        f"`{SCENARIO_MAP_JSON}` into `road_plan.target_y_default` or any per-segment "
        f"`target_y`. They are catalog placement Y, NOT a road surface.\n"
        f"- **DO** set `road_plan.target_y_default = corridor_profile.elevation_median` "
        f"(the scout already computed this from a real `mc terrain_top` sweep).\n"
        f"- For per-segment `target_y`: default to `corridor_profile.elevation_median`. "
        f"The measure card may revise per-segment based on its own samples; the "
        f"planner just seeds the median.\n"
        f"- If the catalog endpoint Y differs from `elevation_median` by ≥4, you MUST "
        f"include an `obstacles[]` entry of the form "
        f"`{{type: 'catalog_y_drift', catalog_y: <N>, live_y: <M>, delta: <abs>}}` — "
        f"this is the audit trail proving you noticed and rejected the bad Y.\n"
        f"\n"
        f"Merge elevation + obstacles into the segment table; tooling per bot; echo "
        f"segment list for automation.\n"
        f"\n"
        f"**Output (persistent path — W2-NAV-008 fix):**\n"
        f"- Write the final `road_plan` JSON to `$HERMESCRAFT_REPO/{ROAD_PLAN_JSON}`. "
        f"This survives your workspace GC so downstream measure/clear cards can read "
        f"it. Use `write_file` or `cat > … <<EOF`.\n"
        f"- Also echo `road_plan` as `metadata.road_plan` on this card's completion "
        f"summary (for telemetry).\n"
        f"\n"
        f"No `mc`. metadata.card_kind=research; metadata.road_plan_path=`{ROAD_PLAN_JSON}`."
    )


def _explore_body() -> str:
    bound_list = ", ".join(f"**{m}**" for m in ROAD_INTERIOR_MARKS)
    z_min = ROAD_CORRIDOR_Z_START
    z_max = z_min + ROAD_CENTERLINE_BLOCKS_CATALOG
    x_min = ROAD_CORRIDOR_X_MIN
    x_max = ROAD_CORRIDOR_X_MAX
    return (
        f"Reach catalog endpoints **{ROAD_ENDPOINTS[0]}** and **{ROAD_ENDPOINTS[-1]}** "
        f"(each within **4 blocks**).\n"
        f"Along the centerline (~{_ROAD_CFG['segment_length_blocks']} blocks per segment), "
        f"**place ground-level marks** with `mc mark` for: {bound_list}. "
        "Use `mc inspect` / `mc scene` at each boundary so feet Y is standable.\n"
        "Walk full corridor; `mc scene` every **2 blocks**.\n"
        "\n"
        "**Target Y discipline (CRITICAL — read `skill_view('minecraft-roadbuilding')` "
        "section 'Target Y — derive from terrain, NOT from catalog placement'):**\n"
        f"- **Run this ONE LITERAL command** to sample the full 3-wide corridor in one "
        f"round-trip:\n"
        f"   `mc corridor_sample {x_min} {z_min} {x_max} {z_max} full=true`\n"
        f"  This returns per-cell `block_y`/`surface_y` + aggregate "
        f"`elevation_median`/`min`/`max`/`delta`. Foliage is excluded by default — a "
        f"spruce canopy doesn't register as ground (W2-NAV-015).\n"
        "- Copy `data.elevation_median` directly into `corridor_profile.elevation_median`.\n"
        "- **Never** copy the catalog endpoint Y (`overlook` / `return_post`) as a road "
        "target — the catalog placement engine often sits the anchor 10+ blocks above "
        "or below the live walkable surface. Use the terrain_top median.\n"
        "\n"
        "metadata **`corridor_profile`**: samples[], elevation_median (int), "
        "elevation_delta, obstacles[], "
        f"`segment_boundaries`: [{{mark, x, y, z}}], "
        f"anchors_reached: [{', '.join(ROAD_ALL_MARKS)}], centerline_length_blocks."
    )


def _meas_body(seg_id: int, from_mark: str, to_mark: str) -> str:
    # Corridor runs along +Z from overlook (Z=ROAD_CORRIDOR_Z_START) to
    # return_post. X strip is [ROAD_CORRIDOR_X_MIN..ROAD_CORRIDOR_X_MAX]
    # (livemap coords from last-scenario-map.json — proc-nav-1781079999
    # postmortem). The literal mc corridor_sample command is hardcoded so
    # the agent can't skip sampling — trial 1780989125 showed Pip accept
    # the planner's bad target_y without re-sampling. Literal verbs bite.
    z_start = ROAD_CORRIDOR_Z_START + (seg_id - 1) * ROAD_SEGMENT_LENGTH
    z_end = z_start + ROAD_SEGMENT_LENGTH
    x_min = ROAD_CORRIDOR_X_MIN
    x_max = ROAD_CORRIDOR_X_MAX
    return (
        f"**Segment {seg_id}:** `{from_mark}` (Z≈{z_start}) → `{to_mark}` (Z≈{z_end}) "
        f"per **`road_plan`**.\n"
        f"Repeat the standard measure contract (same schema every segment).\n"
        f"\n"
        f"**Step 1 — read the road_plan from the persistent path:**\n"
        f"   `cat $HERMESCRAFT_REPO/{ROAD_PLAN_JSON}`\n"
        f"Note `corridor_profile.elevation_median` (call it `corridor_median`) and the "
        f"planner's seeded `target_y_default` for this segment.\n"
        f"\n"
        f"**Step 2 — sample the segment's 3-wide cross-section in ONE call:**\n"
        f"   `mc corridor_sample {x_min} {z_start} {x_max} {z_end}`\n"
        f"This returns aggregate `elevation_median` for the segment (call it "
        f"`segment_median`). Foliage is excluded by default — spruce canopy doesn't "
        f"register as ground (W2-NAV-015). One round-trip instead of 9.\n"
        f"\n"
        f"**Step 3 — pin target_y to the corridor median (W2-NAV-017):**\n"
        f"   `target_y MUST equal corridor_median` UNLESS `abs(segment_median - "
        f"corridor_median) >= 2`.\n"
        f"- If divergence is < 2: set `target_y = corridor_median`. Segment boundaries "
        f"stay flush; no ±1 steps at z={z_start} or z={z_end}.\n"
        f"- If divergence is >= 2: set `target_y = segment_median` AND log an "
        f"`obstacles[].type='segment_y_anomaly'` entry with `{{segment_median, "
        f"corridor_median, delta}}`. This is the audit trail for an intentional step.\n"
        f"\n"
        f"**Step 4 — run `mc level_ground` dry-run for disposition classification:**\n"
        f"   `mc level_ground {x_min} {z_start} {x_max} {z_end} target=<target_y>`\n"
        f"Read `data.dispositions` and `data.dip_spans`:\n"
        f"- If `summary.deck_required_n > 0` or `summary.reroute_required_n > 0`, set "
        f"`passage='deck'` or `passage='reroute'` and pass the span coords through to "
        f"`obstacles[]`.\n"
        f"- Otherwise set `passage='dig'` or `passage='fill'` based on the cut/fill skew.\n"
        f"\n"
        f"**Step 5 — verify rejection of catalog Y:**\n"
        f"NEVER set `target_y` to the catalog endpoint Y. If the catalog Y at this "
        f"segment's endpoints differs from your terrain_top median by ≥4, log it in "
        f"`obstacles[]` as `catalog_y_drift` with `catalog_y`, `live_y`, `delta`.\n"
        f"\n"
        f"metadata **`segment_measurements`**: segment_id={seg_id}, from_mark={from_mark}, "
        f"to_mark={to_mark}, target_y (= corridor_median pinned, NOT catalog), "
        f"passage (dig|fill|deck|reroute), samples[], "
        f"dispositions{{level,cut,fill_shallow,fill_deep,no_floor}}, obstacles[], "
        f"width_blocks={ROAD_WIDTH_M}."
    )


def _verify_body() -> str:
    # Per-segment dispositions sweep. Each call surveys ROAD_SEGMENT_LENGTH+1
    # cells of the corridor (3 wide × 12+1 long = 39 columns), well above
    # level_ground's 16-col cap — but we want a single per-segment summary,
    # so split inside the agent's worker via 3-col sub-rectangles.
    z_max = ROAD_CENTERLINE_BLOCKS_CATALOG
    return (
        f"**Verify the finished road corridor across all "
        f"{ROAD_SEGMENT_COUNT} segments.**\n"
        f"\n"
        f"**Step 1 — read the road_plan for the canonical target_y:**\n"
        f"   `cat $HERMESCRAFT_REPO/{ROAD_PLAN_JSON}`\n"
        f"Use `corridor.target_y_default` (or `target_y_default` at top level) for the "
        f"sweep target.\n"
        f"\n"
        f"**Step 2 — walk anchors:** overlook → "
        f"{' → '.join(ROAD_INTERIOR_MARKS) if ROAD_INTERIOR_MARKS else '...'}"
        f" → return_post. `mc verify at_mark` on each agent `road_bound_*` "
        f"mark. Record `predicates[]` with each at_mark result.\n"
        f"\n"
        f"**Step 3 — dispositions sweep (NEW: W2-NAV-018 fix).** "
        f"For each segment, run a dry-run `mc level_ground` and assert "
        f"the surface is fully leveled.\n"
        + "\n".join(
            f"   `mc level_ground {ROAD_CORRIDOR_X_MIN} "
            f"{ROAD_CORRIDOR_Z_START + (sid - 1) * ROAD_SEGMENT_LENGTH} "
            f"{ROAD_CORRIDOR_X_MAX} "
            f"{ROAD_CORRIDOR_Z_START + sid * ROAD_SEGMENT_LENGTH} "
            f"target=<target_y>`  # seg {sid}"
            for sid in range(1, ROAD_SEGMENT_COUNT + 1)
        )
        + f"\n"
        f"Read `data.dispositions` for each. Acceptance rule:\n"
        f"   `dispositions.level + dispositions.preserved == columns_n`\n"
        f"   AND `dispositions.cut == 0` AND `dispositions.fill_shallow == 0` "
        f"AND `dispositions.fill_deep == 0` AND `dispositions.no_floor == 0`.\n"
        f"\n"
        f"**Step 4 — branch on the sweep result:**\n"
        f"- **All segments pass:** complete this card with "
        f"`verify_status=pass` and `dispositions_summary[]` populated for telemetry.\n"
        f"- **Any segment fails:** emit a follow-up `[CLEANUP]` kanban card via "
        f"`kanban_create` with `title='[BUILD] cleanup segment <id>'`, assignee mirroring "
        f"the original clear card (builder/builder-mox per id), and body specifying the "
        f"target_y + the failing cells. Complete THIS verify with "
        f"`verify_status=needs_cleanup` and reference the cleanup card id(s).\n"
        f"\n"
        f"metadata **`verify_results`**: predicates[], "
        f"dispositions_summary[{{segment_id, level, cut, fill_shallow, fill_deep, "
        f"no_floor, preserved}}], cleanup_cards[], verify_status, "
        f"position_at_complete, road_width_blocks={ROAD_WIDTH_M}, "
        f"segments_cleared={ROAD_SEGMENT_COUNT}."
    )


def _clear_body(seg_id: int) -> str:
    z_start = ROAD_CORRIDOR_Z_START + (seg_id - 1) * ROAD_SEGMENT_LENGTH
    z_end = z_start + ROAD_SEGMENT_LENGTH
    x_min = ROAD_CORRIDOR_X_MIN
    x_max = ROAD_CORRIDOR_X_MAX
    return (
        f"**Segment {seg_id}:** equip (`mc inventory`, metadata `tools_ready`); "
        f"clear **{ROAD_WIDTH_M} blocks wide** for Z={z_start}..{z_end} "
        f"(X={x_min}..{x_max}) per **`road_plan`**.\n"
        f"\n"
        f"**Step 1 — read the road_plan + this segment's measurements from persistent paths:**\n"
        f"   `cat $HERMESCRAFT_REPO/{ROAD_PLAN_JSON}`\n"
        f"Find this segment's entry: target_y, passage (dig|fill|deck|reroute), "
        f"obstacles[]. Also read the upstream measure card's "
        f"`segment_measurements` metadata for the same segment_id.\n"
        f"\n"
        f"**Step 2 — clear by passage:**\n"
        f"- `passage=dig` or `fill`: `mc clear_strip {x_min} {z_start} {x_max} {z_end} "
        f"y=<target_y> road_mode=true` (cuts trees; y = the bed's block_y — "
        f"clear_strip removes the cells ABOVE it), then "
        f"`mc level_ground {x_min} {z_start} {x_max} {z_end} target=<target_y> execute=true`.\n"
        f"- `passage=deck`: route around if reroute viable; else `mc deck` over the "
        f"flagged dip_spans.\n"
        f"- `passage=reroute`: emit a `[DEFER]` comment with the span coords, complete "
        f"this card with `obstacles_handled=[]` and a re-survey note.\n"
        f"\n"
        f"**Step 3 — verify the bed:** `mc level_ground {x_min} {z_start} {x_max} {z_end} "
        f"target=<target_y>` (dry-run) should now report `dispositions.level == columns_n` "
        f"and no remaining `dip_spans` with `suggestion != 'level_caps'`.\n"
        f"\n"
        f"metadata **`segment_cleared`**: segment_id={seg_id}, width_blocks={ROAD_WIDTH_M}, "
        f"target_y, blocks_touched, obstacles_handled[], post_verify_dispositions{{...}}."
    )


def build_proc_scout_road_graph() -> Graph:
    cards: list[Card] = [
        Card(
            slug="pn-plan",
            title="[RESEARCH] proc-nav road playbook",
            assignee="planner",
            omit_bot_prefix=True,
            body=_plan_body(),
            depends_on=(),
            skills=PLANNER_SKILLS,
        ),
        Card(
            slug="pn-explore",
            title="[NAV] scout road corridor",
            assignee=ASSIGNEE_NAV_MOX,
            bot=BOT_MOX,
            body=_explore_body(),
            depends_on=("pn-plan",),
            skills=NAV_SKILLS,
            work_at_mark="overlook",
        ),
        Card(
            slug="pn-segments",
            title="[RESEARCH] road segment table",
            assignee="planner",
            omit_bot_prefix=True,
            body=_segment_plan_body(),
            depends_on=("pn-explore",),
            skills=PLANNER_SKILLS,
        ),
    ]

    clear_slugs: list[str] = []
    for seg_id, from_mark, to_mark in road_segments(_ROAD_CFG):
        nav_assignee, nav_bot = _assign_measure(seg_id)
        bld_assignee, bld_bot = _assign_clear(seg_id)
        meas_slug = f"pn-meas-{seg_id}"
        clear_slug = f"pn-clear-{seg_id}"
        clear_slugs.append(clear_slug)
        cards.append(
            Card(
                slug=meas_slug,
                title=f"[NAV] measure segment {seg_id}",
                assignee=nav_assignee,
                bot=nav_bot,
                body=_meas_body(seg_id, from_mark, to_mark),
                depends_on=("pn-segments",),
                skills=NAV_SKILLS,
                work_at_mark=from_mark,
                # Bumped from the default 2 — proc-nav-1781079999 had
                # measure cards auto-gave_up under transient HTTP timeouts.
                max_retries=3,
            )
        )
        cards.append(
            Card(
                slug=clear_slug,
                title=f"[BUILD] clear segment {seg_id}",
                assignee=bld_assignee,
                bot=bld_bot,
                body=_clear_body(seg_id),
                depends_on=(meas_slug,),
                skills=BUILD_SKILLS,
                work_at_mark=from_mark,
                # proc-nav-1781079999: clear-1 reached gave_up after 2
                # timeouts on a forested segment with the work actually
                # complete. Allowing one more retry covers the
                # transient-timeout case without unbounding retries.
                max_retries=3,
            )
        )

    cards.extend(
        [
            Card(
                slug="pn-road-verify",
                title="[VERIFY] road corridor",
                assignee=ASSIGNEE_NAV_MOX,
                bot=BOT_MOX,
                body=_verify_body(),
                depends_on=tuple(clear_slugs),
                skills=OBSERVE_SKILLS,
                work_at_mark="return_post",
                # Verify across 8 segments + dispositions sweep is the
                # longest single card; allow extra retries against the
                # 30m max-runtime.
                max_retries=3,
            ),
            Card(
                slug="pn-plan-2",
                title="[RESEARCH] finalize road trial",
                assignee="planner",
                omit_bot_prefix=True,
                body=(
                    f"Read verify **`verify_results`** and all **`segment_cleared`** "
                    f"({ROAD_SEGMENT_COUNT} segments).\n"
                    f"Update **`{PLAYBOOK}`**; note automation repeatability.\n"
                    "metadata.card_kind=research"
                ),
                depends_on=("pn-road-verify",),
                skills=PLANNER_SKILLS,
            ),
        ]
    )

    return Graph(
        epic_slug="pn-road",
        epic_title="[NAV] Proc-scout road (two-bot)",
        epic_body=(
            f"{ROAD_SEGMENT_COUNT}-segment corridor ({ROAD_CENTERLINE_BLOCKS_CATALOG} blocks) "
            "on proc-nav-lab; Mox + Pip."
        ),
        cards=tuple(cards),
        acceptance_predicate=None,
        acceptance_predicates=(),
    )
