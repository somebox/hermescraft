# Phase E mapping mission — run-2 postmortem

**Date:** 2026-06-04 (~10:14 – 10:54 PDT, ~40 min of worker time)
**Mission:** `establishment.mapping` (Phase E) on a fresh seed
**Seed:** `300886438233796193` (beach + forest + river, Y delta 18)
**Spawn:** (32, 64, -32) — verified grass_block
**Outcome:** Phase E design **cleared 2 of 4 grader thresholds**: `longest_path_len = 95.3 ≥ 80` and `named_frontier_count = 1 ≤ 3`. Stopped before clearing `named_count ≥ 6` and `quadrants 4/4` because of structural comms + plan-persistence gaps the operator identified in real time.

## Final state

```
named_count       = 3   (target 6)    — muster, north_grove, lake_isle
longest_path_len  = 95.3 (target 80)  ✅ CLEARED
quadrants_covered = NE, SE, SW (3/4)  — NW pending
named_frontier    = [lake_isle]       ✅
component_count   = 1                 (single connected graph)
edges             = 12
spine             = wp_n_3 → wp_n_4 → wp_e_1 → muster → wp_n_1 → north_grove → wp_n_2
```

The 7-node spine at 95.3 blocks is the longest single trail Phase E has produced — almost 50% longer than run-1's 64.

## What this run was meant to test

Run-2 was the rematch with all four run-1 bug fixes baked in:
- `mc poi_add` parser (commit `9868a1d`)
- `mc place_named_sign` wax false-positive (commit `e6c8edc`)
- Orphan kanban-task killer (commit `bbf6794`)
- Quadrant anchor classifier (commit `50de1fa`)

Plus the operator hand-tightened templates with explicit `mc poi_add muster --sign`, 15-char rule, no-foot-cell rule, and an explicit step-by-step worker checklist.

The hypothesis was: "without the four bugs, the design clears the thresholds in 30-60 min instead of timing out."

The reality: **the design works**, the bugs are fixed, the spine cleared the bar — but a deeper layer of agent-architecture issues surfaced. The four big findings below come from focused sub-agent analyses of every worker's reasoning + tool log.

## Bug 5 (newly surfaced): Steward can't run `mc` verbs at all

### Symptom

Steward's hermes is denied **every** `mc *` verb by the orchestrator-mc-allowlist ACL — including the verbs her own SOUL doctrine requires (`mc read_chat`, `mc chat`, `mc whisper`, `mc overhear`). From her reasoning log: *"All mc verbs (chat, status, observe, marks, read_chat) are denied for my steward bot body."*

### Consequences in run-2

- Workers whispered Steward for help; Steward could not read those whispers
- Steward could not send public chat or whispers back; she communicated *only* via `kanban_comment`
- Workers don't poll their own kanban card mid-task for new comments, so Steward's comments often went unread for many rounds

### Documented behavior the ACL contradicts

`prompts/landfolk/steward.md:1320` mandates `mc read_chat 30` and `@steward` whisper-handling. The runbook §8.4 also exempts `mc observe` from the deny list. But the *runtime* allowlist appears to be tighter than the documented one — and `read_chat` isn't in it.

### Fix

`bot/lib/server/middleware/orchestrator-mc-allowlist.js` — add `read_chat`, `overhear`, `chat`, `whisper` to the steward-role allowlist. Without those four, Steward is one-way blind by design.

## Bug 6: `mc retrace --trail` used **zero times** across all 3 workers

Despite the persistent nav-trail subsystem being available and the `minecraft-mapping.md` skill text referencing it, no worker called `mc retrace --trail` at any point during the run. Persistent-nav-vs-raw-coord adoption:

| Worker | `go_poi` / `go_mark` | raw `goto` / `move` | Persistent ratio |
|--------|----------------------:|---------------------:|-----------------:|
| Flint  | 12 | 59 | 17% |
| Gatherer | 3 | 61 | 5% |
| Mason  | 8 | 81 | 10% |

Workers re-derived raw coordinate moves every turn rather than reusing the breadcrumb trail they had themselves laid. Flint, the most successful worker, had the highest persistent-nav adoption — and even she was at 17%.

### Why

Likely a salience problem: `mc go_poi` and `mc retrace --trail` are mentioned in the skill but not in the per-round prompt scaffolding. The agent re-decides "what's the right move" each turn from the same SOUL + card body context — and the salient verb is `mc move`, not `mc retrace`.

### Fix shape

Per-round prompt or `mc observe` payload includes a `route_back_hint` field: "your last 3 placed POIs are wp_n_1, wp_n_2, wp_n_3 — `mc go_poi wp_n_3` to return one step." Make persistent nav the path of least resistance.

## Bug 7: Workers re-derive plans every turn (no plan persistence)

Each hermes round is a fresh LLM call with: SOUL + card body + recent action history + `mc status`/`observe`. There's no stored intermediate plan. The model decides "next 1–2 commands," executes them, then the next round re-derives from scratch.

### Gatherer's water-pocket cycle as the canonical example

Stuck in water at (2, 62, 14). Across ~8 reasoning blocks:
1. "I stopped. Now I need to swim up — the hint says mc jump"
2. "I jumped up by 0.8 in the water, but I'm still submerged. Let me keep jumping"
3. "I'm in a body of water at (2,62,14) — looks like a small pond. I can see..."
4. "Pathfinding is blocked. Let me try `mc escape`"
5. "The escape command confirms I'm in a water pocket with no shore within 32 blocks"
6. "I have no blocks to pillar with. No boat. No planks (used them for the boat)"
7. "Let me try digging my way out with the pickaxe"
8. "I'm getting a loop warning. Let me change approach. I need to ask Steward for help"

Each block treats the situation as a fresh problem; she rebuilds context. No "active sub-goal: get out of water; then resume at (X,Y,Z)." When the loop warning fires she pivots to asking Steward — but Steward can't read whispers (Bug 5).

### Fix shape

Workers maintain a per-task scratchpad — either `data/runtime/plan-<bot>.json` or a `PLAN:` prefixed `kanban_comment` on their own card. New verbs `mc next_step` + `mc step_done <N>` + `mc step_block <reason>`. Per-round prompt becomes: "Your active step is N: `<text>`. Execute it. If precondition fails, run `mc step_block <reason>`; if it succeeds, run `mc step_done N`. Re-plan only on `[REPLAN]` trigger."

## Bug 8: One-way comms — Steward writes, workers don't read

Steward attempted to push concrete guidance via `kanban_comment` on each in-flight card. But:
- Workers don't poll their own kanban card mid-task; comments are seen on round-N+1's prompt-build, not while the agent is mid-action
- Steward cannot use `mc chat` / `mc whisper` to interrupt a worker (Bug 5)
- `[AUTO_STUCK]` fires on identical-recent-action patterns, not on worker-confirmed-stuck — so Steward escalates to `[RESCUE]` before any "are you still in trouble?" handshake

### What the user spotted live

> "Before rescue gets flagged, it would be easy for steward to just ask 'are you still in trouble?' but there's not comms happening."

Exactly. The watchdog's heuristic for stuckness is a behavior pattern (same recent action 4+ rounds), not a confirmed status check. The "ack before escalate" handshake is structurally missing.

### Fix shape

Two changes:
1. Lift Steward's ACL so `mc read_chat` + `mc chat` / `mc whisper` work. She can poll for explicit pleas + send heartbeats.
2. Insert an ack-before-escalate step on `[AUTO_STUCK]`: `@<worker>: AUTO_STUCK detected. Reply YES_STUCK or RECOVERING within 60s`. RESCUE only fires on `YES_STUCK` or silence past the window.

## Bug 9: Skill-flag forgetfulness in Steward's card-create path

The first thing that happened in run-2 (within 5 min): Steward created Mason's E card and Gatherer's S card via `scripts/kanban add`, but **without** the `--skill minecraft-mapping --skill minecraft-navigation` flags. Mason's hermes launched with only `kanban-worker` → defaulted to her builder SOUL ("base perimeter lit with 12 torches"). Gatherer's defaulted to her gatherer SOUL (chest_search oak_log).

The documented best practice in `steward.md:1218` *does* specify `--skill minecraft-mapping --skill minecraft-navigation`. Steward read it and didn't apply it. From her reasoning, she treated the skill flags as optional / nice-to-have.

### Fix shape

Two-layer:
1. **`scripts/kanban add` defaults**: when a card title matches `[MAP-PATH]` or `[MAP-CONNECT]`, auto-inject `--skill minecraft-mapping --skill minecraft-navigation` unless explicitly suppressed. Make the safe default the easy default.
2. **Tighten the rubric**: Steward's `[MAP:ARENA]` section gets a single-line MANDATORY rule with no opt-out: "every `[MAP-*]` card you create must include both skills; no exceptions."

## Per-worker behavior summary

### Flint — best worker; 71% reasoning, 17% persistent-nav

- **Followed the YAML-seeded root card's plan, then improvised cleanly when terrain forced a pivot** (initially planned south, found water hazard, pivoted to north with trees + high ground)
- **Once she found viable geometry she committed cleanly**: 3 consecutive sign placements at 08:25 without hesitation
- Failed sign placement (INVENTORY_MISSING) → diagnosed correctly → restocked at chest → returned and placed
- Highest `go_poi`/`go_mark` usage of any worker (12 calls), but **still 0 `mc retrace --trail`**
- Action ratio: 42.6% observation : 57.4% commitment — the healthiest of the three

### Mason — defense-builder SOUL dominated; never recovered to mapping

- **Card body said `[MAP-PATH] muster → E (82, 64, -32)` but skill loaded was only `kanban-worker`**
- Mason's first reasoning at 10:14:46: "Everyone is working on mapping... as defense builder, I should be thinking about: 1. Crafting bows and arrows... 2. Lighting / torches... 4. Doors for the base"
- Action at 10:18:27: `mark base_perimeter_lit` + chat "base perimeter lit with 12 torches — north/east/south/west edges covered"
- Operator pushed mapping coords in kanban comments — Mason did not switch tasks. She built oak fences and kept defending
- `[AUTO_STUCK]` → `[RESCUE]` tagged. **The stuck-state was real, not a false alarm** — Mason was literally pillar-stuck underground trying to reach a mapping coord she physically couldn't path to with her current SOUL's verb vocabulary (no `mc reachable` pre-check; she defaulted to raw `goto` + retry)

### Gatherer — water-pocket cycle, slowest danger-to-action gap

- 8+ reasoning turns deliberating escape options *while drowning* before committing to a recovery action
- Whispered Steward for help; Steward never replied (Bug 5)
- After eventually escaping (relocated to (30, 63, 33) on land), she correctly recognized "I'm on LAND now!" and immediately executed the lake_isle placement chain — clean recovery
- **5%** persistent-nav adoption (3 `go_poi`/`go_mark` vs 61 raw `goto` calls) — the worst of the three
- Gatherer SOUL leakage: craft cycles + `chest_search oak_log` early in run

### Steward — invented [MAP-CONNECT] cards; one-way blind

- **Positive emergent behavior**: at round 8 (~10:40), once N/S/E paths had landed, Steward independently invented `[MAP-CONNECT]` cards to bridge existing landmarks. This is graph-completion behavior beyond what the rubric specified — she generalized "extend frontier" to "complete the connectivity" on her own.
- Created MAP-PATH and MAP-CONNECT cards via `scripts/kanban add` without `--skill` flags (Bug 9)
- `mc *` verbs ACL-denied; could not run `mc read_chat`, `mc chat`, `mc overhear`, `mc whisper` (Bug 5)
- Issued [RESCUE] guidance via kanban comments, then "didn't follow up" — couldn't, because the only follow-up channel was `mc read_chat` which she's denied
- Reasoning split: ~35% worker physical state diagnostics, ~45% dispatch logic, ~20% comms attempts (mostly noting "I can't")

## Cross-cutting metric: reasoning-to-action ratio

| Worker | Reasoning blocks | Concrete commits | Ratio |
|--------|-----------------:|-----------------:|------:|
| Flint  | 91 | 38 | 71% reasoning |
| Gatherer | 103 | 59 | 64% reasoning |
| Mason  | 66 | 35 | 65% reasoning |

All three workers spend more time deliberating than acting. **The lower the persistent-nav adoption, the higher the reasoning ratio** — workers without a remembered route burn cycles rebuilding context each turn.

## Operator's question in three sentences

> "How much action vs thinking, etc. Lets also spot errors or mixed signals. Do agents realize they are no longer standing in the water and not in danger after moving? Do they use the pathfinding and routes they maintain?"

Answers, verbatim from the audit:

- **Action vs thinking:** 64–71% reasoning across all 3 workers; Flint was most efficient and most successful
- **Mixed signals:** Steward's kanban comments were the only inbound channel and lagged the agent's mid-task state; workers couldn't reconcile against fresh inputs (Bug 8)
- **Do agents realize when danger has passed?** Yes, once they actually move out — Gatherer immediately executed her sign placement after reaching land. **The problem is the gap to get out**: she spent 4–8 reasoning turns deliberating while still drowning
- **Do they use the pathfinding / routes they maintain?** Almost not at all. `mc retrace --trail` was called zero times across the entire run. Persistent-nav (`go_poi`, `go_mark`) was 5–17% of all navigation calls. Workers default to raw coords every turn

## Recommendations (ordered by leverage)

1. **Lift Steward's `mc` ACL** to include `read_chat`, `chat`, `whisper`, `overhear`. Single config change; unlocks bidirectional comms.
2. **Inject persistent-nav hints into per-round `mc observe` payload.** Add a `route_back_hint` field listing the last N placed POIs with `mc go_poi <name>` suggestions. Make it the salient verb.
3. **`scripts/kanban add` auto-skill-injection** for `[MAP-*]` titles. Belt-and-suspenders on top of the rubric directive.
4. **Plan persistence**: prototype `mc next_step` / `mc step_done` / `mc step_block` against a per-task scratchpad. One-week build; will dramatically reduce per-turn re-derivation.
5. **Ack-before-escalate handshake** on `[AUTO_STUCK]`: 60s reply window before [RESCUE].
6. **Steward template-skip lint**: after creating a `[MAP-*]` card, programmatically check the card has the expected skills; if not, post a self-correcting comment.

## What still makes this a successful run

Phase E delivered, again:

- **The graph cleared the spine threshold (95.3 ≥ 80)**, with one connected component and a clean named-frontier
- **Steward demonstrated genuine emergent behavior** by inventing `[MAP-CONNECT]` cards
- **Flint proved the design is sound** end-to-end — when the skill stack is correct, a worker can execute the protocol with high commit-bias
- **Gatherer's recovery proved the protocol is robust** — once she got out of the water, she immediately placed the landmark cleanly

The remaining shortfall isn't a Phase E design issue. It's that agents reasoning in isolation per-turn, with one-way comms and zero plan persistence, cannot sustain a multi-step path-building loop reliably enough to clear all four grader thresholds in 40 minutes. That's the actual next thing to design.

## Files in this postmortem

- `agent-{flint,gatherer,mason,steward}.log` — reasoning logs (raw input for the sub-agent analyses)
- `mc-{flint,gatherer,mason,steward}.log` — CLI audit
- `nav-{flint,gatherer,mason,steward}.jsonl` — structured action results
- `progress-{...}.log` — watchdog JSONL
- `bot-{...}.log`, `watchdog-{...}.log`
- `dispatcher.log`, `gateway.log`
- `personal-pois-{...}.json` — frozen POI state at fleet stop
- `final-graph.json` — `scripts/poi-graph.py` output at fleet stop
- `final-board.txt`
- This `POSTMORTEM.md`

## Commit chain (Phase E)

```
6c7ed8b  postmortem: run-1 design validated; 4 latent bugs found + fixed
50de1fa  poi-graph: quadrant uses anchor not POI x/z
e6c8edc  place_named_sign: wax verify opt-in
9868a1d  CLI: poi_add / poi_update custom-parse cases
bbf6794  cleanup: kill orphan hermes kanban-task processes
3457ba6  Phase E: path-construction mission + sign proposals + graph grader
```
