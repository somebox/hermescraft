"""Genesis-v2 worker-card validator (read-only, zero bot time).

Composes card_body_linter, card_kinds taxonomy, and mc verb registry checks.
Used by `scripts/gv2-validate-cards.py` and `scripts/kanban validate-board`.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from scripts.lib.card_body_linter import lint_card_body
from scripts.lib.card_kinds import VERB_REQUIRED_KINDS, parse_kind_from_title

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY = REPO_ROOT / "bot" / "cli" / "registry.mjs"

GV2_WORKER_ASSIGNEES = frozenset(
    {
        "colony-scout",
        "colony-gatherer",
        "colony-builder",
        "colony-farmer",
        "colony-miner",
        "colony-road",
    }
)

GV2_BODILESS_ASSIGNEES = frozenset({"colony-planner", "colony-overseer"})

CONTROL_KINDS = frozenset({"FEEDBACK", "RETRO", "MISSION"})

CANONICAL_INTENT_KINDS = frozenset({"CONSTRUCT", "MINE", "TILL", "SUPPLY", "SURVEY", "SCOUT"})
# Emergent title tags parsed for kind-specific rules (not all are verb-required).
EXTENDED_INTENT_KINDS = CANONICAL_INTENT_KINDS | {"FARM", "COOK", "VERIFY"}
# mine_site: is required only for dedicated extraction (MINE / mining-SUPPLY). SCOUT/
# SURVEY find a mine entry, CONSTRUCT/ROAD build — none should be flagged mining-intent
# just because a title/body says "mine entry" or matches the underground regex
# (gv2-2026-06-22-1 false-positives on "[SCOUT] find safe mine entry" + "[CONSTRUCT] Shelter").
NON_MINING_INTENT_KINDS = frozenset({"FARM", "TILL", "COOK", "SCOUT", "SURVEY", "CONSTRUCT", "ROAD"})

# Unambiguous underground / registry mining — not the English verb "mine" in farm prose
# ("mine nearby dirt", "mine stone for border").
STRONG_MINING_RE = re.compile(
    r"\b("
    r"stair_down|mine_open|mine_resume|mc mine\b|underground|shaft|"
    r"ore vein|cobble from underground|stone from (?:the )?mine|mine_site:"
    r")\b",
    re.IGNORECASE,
)

SUPPLY_MINING_TITLE_RE = re.compile(r"\b(mine|mining)\b", re.IGNORECASE)

FUEL_CONTEXT_RE = re.compile(r"^\s*(fuel|smelt_fuel)\s*:", re.IGNORECASE | re.MULTILINE)
FARM_PREP_CONTEXT_RE = re.compile(
    r"\b(till|plant|harvest|farm_|farm\b|wheat|hoe|crop|plot|seed)\b",
    re.IGNORECASE,
)
_FARM_PREFLIGHT_PROBE_RE = re.compile(
    r"^\s*mc\s+(farm_status|verify_plot)\b",
    re.MULTILINE | re.IGNORECASE,
)

_ANCHOR_RE = re.compile(r"^\s*anchor\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)
_SOURCE_TRUTH_RE = re.compile(r"^\s*source_truth\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)
_MINE_SITE_RE = re.compile(r"^\s*mine_site\s*:", re.MULTILINE)
_CHECKOUT_RE = re.compile(r"^\s*mc\s+bot\s+checkout\b", re.MULTILINE)
_RELEASE_RE = re.compile(r"^\s*mc\s+bot\s+release\b", re.MULTILINE)
_DONE_WHEN_RE = re.compile(r"^\s*done_when\s*:", re.IGNORECASE | re.MULTILINE)
_SKILLS_FIELD_RE = re.compile(r"^\s*skills\s*:", re.MULTILINE)
_VERB_LINE_RE = re.compile(r"^\s*mc\s+([a-z_][a-z0-9_]*)", re.MULTILINE)

_SURVEY_STEP_RE = re.compile(r"^\s*mc\s+(scene|observe)\b", re.IGNORECASE | re.MULTILINE)
_FOOTPRINT_RE = re.compile(r"^\s*footprint\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)
_PROTECTED_CELLS_RE = re.compile(r"^\s*protected_cells\s*:", re.IGNORECASE | re.MULTILINE)
_CLEAR_AUTH_RE = re.compile(
    r"\b(overwrite\s*=\s*true|mc\s+dig_area|mc\s+level)\b",
    re.IGNORECASE,
)

_SUPPLY_SOURCE_RE = re.compile(r"^\s*source\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)
_SUPPLY_DEST_RE = re.compile(r"^\s*destination\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)
_SUPPLY_QTY_RE = re.compile(r"^\s*quantity\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)
_SUPPLY_WITHDRAW_RE = re.compile(r"^\s*withdrawable\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)
_SCOUT_OUTPUT_RE = re.compile(
    r"^\s*(output_marks|required_output_marks|marks_out)\s*:\s*\S+",
    re.IGNORECASE | re.MULTILINE,
)
_SCOUT_CRITERIA_RE = re.compile(
    r"^\s*(suitability_criteria|criteria)\s*:\s*\S+",
    re.IGNORECASE | re.MULTILINE,
)

_PHANTOM_STOCK_RE = re.compile(
    r"\b(old stockpile|prior run stock|previous run|unverified stock)\b",
    re.IGNORECASE,
)

_VALUABLE_BRIDGE_RE = re.compile(
    r"\b(bridge|path repair|route repair|deck)\b.*\b(oak_log|oak_planks|"
    r"spruce_log|birch_log|planks|door)\b",
    re.IGNORECASE | re.DOTALL,
)

_WALL_FLOOR_RE = re.compile(
    r"\b(floor|roof|pad|slab)\b.*\bmc\s+wall\b|\bmc\s+wall\b.*\b(floor|roof|pad)\b",
    re.IGNORECASE,
)

_PLACE_BEFORE_SURVEY_RE = re.compile(
    r"^\s*mc\s+(place|fill)\b",
    re.MULTILINE | re.IGNORECASE,
)
_STARTER_SHELTER_TITLE_RE = re.compile(r"starter_shelter", re.IGNORECASE)
_SCHEMATIC_HARNESS_RE = re.compile(
    r"task_context\s+set|construct\s+show|workset\s+slices|ground_prep:",
    re.IGNORECASE,
)
_HAND_WORLD_FILL_RE = re.compile(
    r"^\s*mc\s+fill\s+[^\n]*\b-?\d+\s+-?\d+\s+-?\d+",
    re.MULTILINE | re.IGNORECASE,
)
_BASE_LAYER_RE = re.compile(r"^\s*layer\s*:\s*L[01]\b", re.IGNORECASE | re.MULTILINE)
_MATERIALS_REQUIRED_RE = re.compile(r"^\s*materials_required\s*:", re.IGNORECASE | re.MULTILINE)
_PREFLIGHT_RE = re.compile(r"^\s*preflight\s*:", re.IGNORECASE | re.MULTILINE)
_VERIFY_ON_SITE_RE = re.compile(r"^\s*verify_on_site\s*:", re.IGNORECASE | re.MULTILINE)
_SOURCE_TRUTH_HANDOFF_RE = re.compile(
    r"^\s*source_truth\s*:\s*.*\bhandoff\b", re.IGNORECASE | re.MULTILINE
)
_TITLE_L0_L1_RE = re.compile(r"\bL[01]\b", re.IGNORECASE)
_CHEST_FURNACE_PLACE_RE = re.compile(
    r"^\s*mc\s+place\s+.*\b(chest|furnace)\b",
    re.IGNORECASE | re.MULTILINE,
)
_VERIFY_LAYER_CMD_RE = re.compile(r"\bgv2-verify-layer\.py\b", re.IGNORECASE)
_VERIFY_GATE_RE = re.compile(r"^\s*gate\s*:\s*(ground|slab|fixtures)\b", re.IGNORECASE | re.MULTILINE)
_DEPENDS_ON_RE = re.compile(r"^\s*depends_on\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)
_PLAN_FIELD_RE = re.compile(r"^\s*plan\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)
_WORKSITE_FIELD_RE = re.compile(r"^\s*worksite\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)
_PHASE_LEVEL_RE = re.compile(r"^\s*(phase|level)\s*:\s*\S+", re.IGNORECASE | re.MULTILINE)

KNOWN_ALIASES = {
    "list_container": "chest",
    "cs": "chest_search",
    "find_in_chests": "chest_search",
    "pl": "place",
    "sm": "smelt",
    "p": "pickup",
    "near": "goto_near",
}


def load_registry_verbs() -> set[str]:
    if not REGISTRY.is_file():
        return set()
    text = REGISTRY.read_text(encoding="utf-8")
    found = set(re.findall(r"""g\(\s*['"]([a-z][a-z0-9_]*)['"]""", text))
    found.update(KNOWN_ALIASES.keys())
    return found


def is_gv2_control_card(title: str | None, assignee: str | None) -> bool:
    title = title or ""
    upper = title.upper()
    kind = parse_kind_from_title(title)
    if kind in CONTROL_KINDS:
        return True
    if assignee in GV2_WORKER_ASSIGNEES:
        return False
    if "[GENESIS2:" in upper and (assignee or "") in ("", *GV2_BODILESS_ASSIGNEES):
        return True
    if assignee in GV2_BODILESS_ASSIGNEES and kind not in VERB_REQUIRED_KINDS:
        return True
    return False


def effective_kind(title: str | None, explicit_kind: str | None = None) -> str | None:
    """Return explicit/parsed canonical intent kind, including later title tags.

    `parse_kind_from_title` intentionally only parses the first `[KIND]` prefix.
    Genesis cards often start `[GENESIS2:P1] [SUPPLY] ...`, so scan all bracket
    tags for the small set of intent kinds used by this validator.
    """
    if explicit_kind:
        return explicit_kind.upper()
    parsed = parse_kind_from_title(title)
    if parsed in EXTENDED_INTENT_KINDS:
        return parsed
    tags = re.findall(r"\[([A-Z]+)\]", title or "")
    for tag in tags:
        if tag in EXTENDED_INTENT_KINDS:
            return tag
    return parsed


def has_mining_intent(title: str | None, body: str | None) -> bool:
    """True when the card assigns underground extraction, not surface gather/farm prep."""
    kind = effective_kind(title)
    if kind == "MINE":
        return True
    if kind in NON_MINING_INTENT_KINDS:
        return False
    if FUEL_CONTEXT_RE.search(body or ""):
        return False
    blob = f"{title or ''}\n{body or ''}"
    if STRONG_MINING_RE.search(blob):
        return True
    # [SUPPLY] Mine coal / [SUPPLY] Mining run — not [SUPPLY] Gather oak logs
    if kind == "SUPPLY" and SUPPLY_MINING_TITLE_RE.search(title or ""):
        return True
    # Residual: SUPPLY body explicitly tasks underground extraction (not surface verbs)
    if kind == "SUPPLY" and re.search(
        r"\b(mine|mining)\s+(coal|iron|cobble|stone|ore|deepslate)\b", blob, re.I
    ):
        return True
    if FARM_PREP_CONTEXT_RE.search(blob) and not STRONG_MINING_RE.search(blob):
        return False
    return False


def _is_base_layer_construct(title: str | None, body: str | None) -> bool:
    """Pilot scope detector for base L0/L1 construct cards.

    Signals:
    - explicit `layer: L0|L1`
    - title mentions L0/L1 and base
    - body has both base_anchor and footprint language plus an explicit layer cue
    """
    title = title or ""
    body = body or ""
    if _BASE_LAYER_RE.search(body):  # explicit `layer: L0|L1`
        return True
    title_has_layer = bool(_TITLE_L0_L1_RE.search(title))
    title_has_base = "base" in title.lower() or "base_anchor" in body.lower()
    if title_has_layer and title_has_base:
        return True
    # Explicit schematic phase cue (phase: L0_* / L1_*). The old broad clause
    # (base_anchor + footprint + bare "layer") over-fired: a 9x9 wheat farm and an
    # L4 roof+fixtures card both got mis-flagged as base-layer (gv2-2026-06-24-7)
    # because "layer" appears in unrelated prose (e.g. "use construct workset"). A
    # base-layer card must carry an explicit L0/L1 signal — not just the word "layer".
    if re.search(r"^\s*phase\s*:\s*L[01]\b", body, re.IGNORECASE | re.MULTILINE):
        return True
    return False


def validate_card(
    *,
    title: str | None = None,
    body: str | None = None,
    assignee: str | None = None,
    kind: str | None = None,
    registry_verbs: set[str] | None = None,
) -> dict[str, Any]:
    """Validate one card. Returns {ok, errors, warnings, kind, assignee, ...}."""
    body = body or ""
    title = title or ""
    assignee = (assignee or "").strip()
    errors: list[str] = []
    warnings: list[str] = []

    lint = lint_card_body(kind=kind, title=title, body=body)
    errors.extend(lint["errors"])
    warnings.extend(lint["warnings"])
    resolved_kind = (effective_kind(title, kind) or lint.get("kind") or "").upper()

    if is_gv2_control_card(title, assignee or None):
        return {
            "ok": len(errors) == 0,
            "kind": resolved_kind or None,
            "assignee": assignee or None,
            "errors": errors,
            "warnings": warnings,
            "exempt": True,
        }

    if assignee and assignee not in GV2_WORKER_ASSIGNEES:
        if assignee not in GV2_BODILESS_ASSIGNEES:
            errors.append(
                f"assignee {assignee!r} is not a genesis-v2 worker "
                f"({', '.join(sorted(GV2_WORKER_ASSIGNEES))})"
            )

    if assignee in GV2_WORKER_ASSIGNEES:
        if _SKILLS_FIELD_RE.search(body):
            errors.append("worker card must not set a skills: field")
        if not _ANCHOR_RE.search(body):
            errors.append("body-using worker card missing anchor:")
        if not _SOURCE_TRUTH_RE.search(body):
            errors.append("body-using worker card missing source_truth:")
        if not _DONE_WHEN_RE.search(body):
            errors.append("body-using worker card missing done_when:")
        if not _CHECKOUT_RE.search(body):
            errors.append("body-using worker card missing mc bot checkout line")
        if not _RELEASE_RE.search(body):
            errors.append("body-using worker card missing mc bot release line")

    if has_mining_intent(title, body) and not _MINE_SITE_RE.search(body):
        errors.append(
            "mining-intent card missing mine_site: block "
            "(required for [MINE] and mining [SUPPLY] titles)"
        )

    if resolved_kind == "SUPPLY":
        if assignee in GV2_WORKER_ASSIGNEES:
            if not _SUPPLY_SOURCE_RE.search(body):
                errors.append("SUPPLY card missing source:")
            if not _SUPPLY_DEST_RE.search(body):
                errors.append("SUPPLY card missing destination:")
            if not _SUPPLY_QTY_RE.search(body):
                errors.append("SUPPLY card missing quantity:")
            if not _SUPPLY_WITHDRAW_RE.search(body):
                errors.append("SUPPLY card missing withdrawable:")
        if _PHANTOM_STOCK_RE.search(body):
            errors.append("SUPPLY card references unverified/old stockpile language")
        if re.search(r"\bchest\s+at\s+\(?\s*-?\d+", body, re.I) and not re.search(
            r"\b(chest_|source_truth:|mark |lt_wood|base_anchor)\b", body, re.I
        ):
            warnings.append(
                "SUPPLY cites raw chest coordinates without mark/source_truth — verify source"
            )

    if resolved_kind == "CONSTRUCT":
        if not _SURVEY_STEP_RE.search(body):
            errors.append("CONSTRUCT card missing survey step (mc scene/observe before placement)")
        if not _FOOTPRINT_RE.search(body):
            errors.append("CONSTRUCT card missing footprint:")
        if not (_PROTECTED_CELLS_RE.search(body) or _CLEAR_AUTH_RE.search(body)):
            errors.append(
                "CONSTRUCT card missing protected_cells: or explicit clear/overwrite authorization"
            )
        if _WALL_FLOOR_RE.search(body):
            warnings.append("CONSTRUCT may use mc wall for floor/roof — prefer mc fill")
        if _PLAN_FIELD_RE.search(body):
            if not _WORKSITE_FIELD_RE.search(body):
                errors.append("schematic CONSTRUCT (plan:) missing worksite:")
            if not _PHASE_LEVEL_RE.search(body):
                errors.append("schematic CONSTRUCT (plan:) missing phase: or level:")
        if (
            _STARTER_SHELTER_TITLE_RE.search(title or "")
            and _HAND_WORLD_FILL_RE.search(body or "")
            and not _SCHEMATIC_HARNESS_RE.search(body or "")
        ):
            errors.append(
                "starter_shelter CONSTRUCT must use the schematic harness "
                "(task_context set, construct show, workset-scoped fill, or L0 ground_prep) "
                "— do not file hand world-coordinate mc fill boxes"
            )
        lines = body.splitlines()
        survey_idx = next(
            (i for i, ln in enumerate(lines) if re.search(r"mc\s+(scene|observe)\b", ln, re.I)),
            None,
        )
        for i, ln in enumerate(lines):
            if _PLACE_BEFORE_SURVEY_RE.match(ln):
                if survey_idx is None or i < survey_idx:
                    warnings.append("placement/fill appears before mc scene/observe on shelter card")
                    break
        if _is_base_layer_construct(title, body):
            # Schematic/blueprint base-layer cards (plan:) express preflight as
            # construct-context verbs (mc task_context set + mc construct show) and
            # split materials/verify into sibling SUPPLY/VERIFY cards, so the manual
            # base-build FIELD requirements (preflight:/materials_required:/
            # verify_on_site:) don't apply — they're validated by the schematic
            # worksite/phase checks above. Without this exemption the validator blocks
            # its OWN bootstrap-filed L0/L1 cards ("missing preflight:"), which forces
            # the planner to abandon the blueprint pipeline for a manual shelter
            # (gv2-2026-06-24-4, t_c75761cf). The real invariants below still apply.
            schematic = bool(_PLAN_FIELD_RE.search(body))
            if not schematic:
                if not _PREFLIGHT_RE.search(body):
                    errors.append("base-layer CONSTRUCT missing preflight:")
                if not _MATERIALS_REQUIRED_RE.search(body):
                    warnings.append("base-layer CONSTRUCT missing materials_required:")
                if not _VERIFY_ON_SITE_RE.search(body):
                    warnings.append("base-layer CONSTRUCT missing verify_on_site:")
            if _CHEST_FURNACE_PLACE_RE.search(body):
                errors.append("base-layer L0/L1 CONSTRUCT must not place chest/furnace")
            if _SOURCE_TRUTH_HANDOFF_RE.search(body):
                errors.append(
                    "base-layer CONSTRUCT uses source_truth: handoff — file a done SCOUT/SURVEY "
                    "card and cite mark ids, not handoff-only prose"
                )

    if resolved_kind == "VERIFY":
        if assignee in GV2_WORKER_ASSIGNEES:
            # Schematic VERIFY cards (plan:) gate via `mc blueprint verify <plan>` — the
            # blueprint's own read-only diff — not the manual gv2-verify-layer.py probe.
            # The manual layer:/gate: + verify-layer.py requirements target the free-form
            # build_layer doctrine and wrongly rejected the bootstrap's OWN VERIFY cards
            # (all 3 in gv2-2026-06-24-7), blocking every blueprint per-layer gate.
            schematic_verify = bool(
                _PLAN_FIELD_RE.search(body)
                and re.search(r"mc\s+blueprint\s+verify\b", body, re.IGNORECASE)
            )
            if not schematic_verify:
                if not _BASE_LAYER_RE.search(body) and not _VERIFY_GATE_RE.search(body):
                    errors.append("VERIFY card missing layer: L0|L1 or gate: ground|slab|fixtures")
                if not _VERIFY_LAYER_CMD_RE.search(body):
                    errors.append(
                        "VERIFY card must invoke scripts/gv2-verify-layer.py (read-only gate probe)"
                    )
            if not _DEPENDS_ON_RE.search(body):
                warnings.append(
                    "VERIFY card missing depends_on: — wire kanban set-after from layer CONSTRUCT"
                )
            if not _DONE_WHEN_RE.search(body):
                errors.append("VERIFY card missing done_when:")

    if resolved_kind in ("SURVEY", "SCOUT") or assignee == "colony-scout":
        if assignee in GV2_WORKER_ASSIGNEES:
            if not _SCOUT_OUTPUT_RE.search(body):
                errors.append("scout/survey card missing output_marks:")
            if not _SCOUT_CRITERIA_RE.search(body):
                errors.append("scout/survey card missing suitability_criteria:")

    if resolved_kind in ("FARM", "TILL") or assignee == "colony-farmer":
        if assignee in GV2_WORKER_ASSIGNEES and FARM_PREP_CONTEXT_RE.search(body or ""):
            if not _FARM_PREFLIGHT_PROBE_RE.search(body or ""):
                warnings.append(
                    "FARM/TILL card missing mc farm_status or mc verify_plot preflight before bulk till/plant"
                )

    if _VALUABLE_BRIDGE_RE.search(body):
        errors.append(
            "card body specifies valuable blocks for bridge/path repair — use dirt/cobble"
        )

    verbs = registry_verbs if registry_verbs is not None else load_registry_verbs()
    if verbs:
        for line in body.splitlines():
            m = re.match(r"^\s*mc\s+([a-z_][a-z0-9_]*)", line)
            if not m:
                continue
            verb = m.group(1)
            if verb == "bot":
                continue
            if verb not in verbs and verb not in KNOWN_ALIASES:
                errors.append(f"unknown mc verb in body: {verb!r}")

    return {
        "ok": len(errors) == 0,
        "kind": resolved_kind or None,
        "assignee": assignee or None,
        "errors": errors,
        "warnings": warnings,
        "exempt": False,
    }


def validate_board_tasks(
    tasks: list[dict],
    *,
    statuses: set[str] | None = None,
) -> dict[str, Any]:
    """Validate many board rows. statuses=None means all tasks."""
    registry = load_registry_verbs()
    results: list[dict[str, Any]] = []
    invalid = 0
    for t in tasks:
        st = (t.get("status") or "").lower()
        if statuses is not None and st not in statuses:
            continue
        r = validate_card(
            title=t.get("title"),
            body=t.get("body"),
            assignee=t.get("assignee"),
            registry_verbs=registry,
        )
        r["id"] = t.get("id")
        r["status"] = st
        r["title"] = t.get("title")
        if not r["ok"]:
            invalid += 1
        results.append(r)
    return {
        "ok": invalid == 0,
        "invalid_count": invalid,
        "checked": len(results),
        "results": results,
    }
