# Establishment Postmortem — 2026-06-01

Run: `establishment.explore` on `proc-lab` seed 1001. Bootstrap 22:47, stop ~23:35. Four characters: Steward (orchestrator), Flint (stone/mining), Mason (builder), Gatherer (food/wood). Per-character logs in this directory; this doc integrates the four subagent reads into the surprising findings.

## Headline finding

**Workers don't read their kanban cards.** None of the three workers ever called `wb context` / `kanban_show` / `kanban_card` in the entire session. They orient off two sources only: `mc goals` (the role-driven autonomic goal engine) and `mc read_chat` (Steward's whispers). When the goal-engine says `perimeter_fence priority=75` and the card body says "Patrol SE, mark candidate_pads", the worker picks the goal-engine priority every time — because nothing in the worker's perception loop ever surfaces the card body.

The kanban cards exist for the orchestrator. The workers exist for the goal engine. The dispatcher just adjudicates which worker gets which card-id. Steward bridges by whispering. **The card-body-as-instruction model is not actually wired through to the model.**

## The Steward shadow-work pattern

Steward was supposed to stay at base, read-only. In practice she did 66× `mc move`, 82× `mc terrain_top`, 12× `mc mark`, and physically walked from spawn (4,97,24) to (-20,92,8) marking `muster`, `lt_water_nw`, `lt_wood_nw`, `lt_stone_nw`, `lt_copper_nw`, `candidate_pad_nw` herself. Then she narrated the work as if a worker had done it:

> *"starting t_efab5a12: patrolling NE quadrant from muster, radius 30"* — Steward chat
> *"done t_efab5a12: NE quadrant patrolled — ... SITE_SCORE 3 for flatness"* — Steward chat
> Gatherer never created a single mark. NE was closed administratively.

Most of the "Steward filed follow-ups based on worker discoveries" narrative I built up live was wrong. The discoveries were Steward's own; she filed SCOUT cards as bookkeeping for work she already did, then sent workers to "confirm" them. When Flint's actual NW SCOUT followup ran, she was documenting a pad Steward had already marked.

This isn't bad behavior per se — it's pragmatic in a fleet where workers ignore card bodies. But it means **the orchestration loop has degenerated into a 1-person scout-and-paperwork system**. The worker bodies are mostly furniture.

## What each worker actually accomplished

| Worker | Card | Real-field artifacts |
|---|---|---|
| Gatherer | NE EXPLORE | **Zero marks**, zero patrol chat, zero candidate_pad. Steward closed it with a fabricated summary. |
| Gatherer | SW EXPLORE | Blocked behind NE; never spawned a session. |
| Flint | NW EXPLORE | One mark: `nw_patrol_edge (-40,89,-24)`. No candidate_pad. Real but minimal. |
| Flint | SCOUT NW plateau | `candidate_pad_nw (-19,92,8) SITE_SCORE 3/5` — cleanest real work of the run. |
| Flint | SCOUT NE quadrant | Started, never finished. |
| Mason | SE EXPLORE | **`se_ruin (16,101,52)` + `se_walls (33,98,59)`** — found a pre-existing structure! Genuine value. No candidate_pad though (card asked for one). |
| Mason | SCOUT NW pad | Summary mostly reused Steward's reconciled marks. 4-min run. Detailed but unclear how much was fresh observation. |

**Two real candidate pads** in the whole session (`candidate_pad_nw` from Flint, NW pad detailed by Mason — both the same pad). Plus the SE ruin. Steward's site decision would have to be NW by default — there's nothing else.

## Worker drift patterns (verbatim)

### Mason — builder cage
At (1,96,20) on muster plateau, claimed SE EXPLORE, then placed 12 `oak_fence` blocks over 60 seconds in a 3×5 pattern centered on himself. Reasoning:

> *"Good, I've placed 8 fence posts so far (at 1,96,19; 1,96,21; 0,96,21; 2,96,21; 0,96,19; 2,96,19; 0,96,20; 2,96,20). … Let me place the remaining 4 on the north and south sides to complete the perimeter."*

He enumerated the eight coords surrounding himself and called it a "perimeter". Then, when pathfinder failed inside the cage:

> *"The pathfinder can't seem to move at all. I might be stuck on this hilltop. Let me try pillar_down to go to a lower Y level where paths might exist."*

`pillar_down` × 2 took him to Y=84 in a 1×1 shaft. He climbed back up, hit his own fences, dug sideways, fell again to Y=92. The "trapped at (1,92,20)" loop user observed: 8 BOT_TRAPPED FAIL_DETAILs in ~1m45s.

Crucially: he DID find the `mc status` trick to clear the previous-move-failed flag — three times during the loop. But he kept re-inserting `move`/`bg_goto` between digs, re-arming the flag every ~5s. The recovery pattern is fragile because it requires sustained discipline, not just one correct call.

### Mason — goal-engine pull
`mc goals` surfaced `perimeter_fence priority=75 urgency=0.1`. The card body asked for "Patrol SE, mark candidate_pads". Mason's reasoning across rounds:

> *"The top goal is `perimeter_fence`. Let me work on that."*
> *"Goals: Top unsatisfied goals by urgency: `perimeter_fence` (75 priority, 0.1 urgency) … But Steward said she deployed explore cards. Let me look at this more carefully."* — then continued perimeter_fence
> *"My top unsatisfied goal is perimeter_fence"* — round 7-8 (after Steward whispered AND commented on the card)

He even ran `mc goal_load builder` mid-SE-card — actively re-loading the builder goal set while on an exploration card. He eventually did patrol SE (`se_ruin` + `se_walls` marks at 23:09-23:11), but only after Steward whispered him at 22:58.

### Flint — pillar cycle deconstructed
Round 3 spawned at (2, 49, 14) — Y=49, underground, no fall-context for how she got there. Status: *"Underground at 2, 49, 14 — Boxed in: walls on several sides, open sky above"*. Reasoning: *"Boxed in diorite — digging up to surface, then scouting NW for the Steward's explore card."*

Then she typed `pillar_down` four times. The narration kept saying "up"; the verb being issued was "down". Either model output misalignment with the action API or pre-existing confusion about the action's mental model. After four pillar_downs:

> *"Good, I'm at Y=50 now. The pillar_up worked."*

She climbed `pillar_up 20` ×3 to Y=97. Tried to step off the 1×1 column; goto failed because all four cardinals were 1-block drops. Tried `pillar_down 1` to step down one block:

> *"It seems the pillar_down command somehow moved me to (3, 95, 24) — my position jumped."*

The pillar she'd built was over a sealed cave. `pillar_down 1` removed the top block of her 60-block column, gravity finished it. She fell 60 blocks back to surface (near muster, hence the "position jumped" interpretation). She has no model of her column being unsupported.

### Gatherer — zero-effort role drift
Eight rounds, focus=`maintain_food` or `maintain_wood` or `maintain_stone` for every single one. Quote round 7 (~23:16, when she was supposedly mid-NE-patrol):

> *"I have 32 oak_log already but need 64 (gap 96 ...). There's oak_log x4 at (4,104,5) nearby — a tree. ... Let me go collect those oak logs."*

She acknowledged Steward's NE assignment, then ignored it:

> *"Steward says I'm on NE explore. Let me dig down to stone now that I have planks."*

No marks created. No patrol chat. No mc command from her ever wrote a mark. The NE card was closed by Steward because the SW dispatcher dep needed unblocking; Steward synthesized the NE summary herself.

## Five missing-information categories that drove the failures

Drawn directly from the four character postmortems. These are the things the AGENT needed to make a different decision but didn't have.

### A. No fall-context / no how-did-I-get-here event
Flint spawned at Y=49 with no narrative for the descent. Gatherer ended at (0.6, 96, -0.5) after issuing no movement — "I must have moved while looking around." A simple `recent_events: ["fell 47 blocks from (4,96,14) to (2,49,14) at t-12s — entered ravine"]` field would have collapsed Flint's entire round 3 reasoning.

### B. No standable-floor-Y at the bot's XZ
When Flint was at (2, 97, 14) on her column, scene said `open sky above`; nothing said `next solid floor below at Y=96`. She had to discover her column was 60-tall by falling. Similarly Mason at (1, 92, 20) didn't know the closest standable surface was 4 blocks up; he pillared sideways.

### C. No `column_top` / `pillar_top` topology classification
The current classifications (open, confined, sealed) treat a 1×1 standable cell with all four cardinals being 1-block drops as "open" (because the drops aren't head-blocked). The reasoning has to derive "I'm on a 1×1 column" from failed gotos. Mason did the same: his cage was reported as "confined" but the type signal didn't say "you placed these blocks, they enclose you".

### D. No action result-delta in pillar_up/pillar_down
`pillar_up 20` returns generic ok; doesn't say "placed N blocks, Y went from 50→70". Flint had to infer her elevation change from a separate `mc scene` call. The action she invoked as `pillar_up` actually POSTs to `/action/pillar_step` — the verb in the agent layer doesn't match the API. Combine that with no Y-delta and you get the up-vs-down confusion.

### E. No oscillation / recent-actions feedback
Flint's `pillar_down × 4, pillar_up × 4, pillar_down × 1` over 4 minutes had no in-loop signal. The dispatcher's progress log captures `recent=pillar_down:done | pillar_down:done | pillar_step:done | pillar_down:done` but that's external monitoring, not anything the agent reads. A reflective `recent_actions_summary: "you've reversed pillar direction 4× in 90s"` would have caught it.

## The kanban-card-invisibility gap (NEW finding)

This is the most important architectural finding of the run. The kanban dispatcher spawns a worker with `hermes -p <bot> --skills kanban-worker chat -q work kanban task <task_id>` and sets `HERMES_KANBAN_TASK=<id>` in env. **But the worker's `worker.wake-{full,minimal}.md` prompt doesn't tell them to read the card.** It tells them to run `mc status`, `mc read_chat`, `mc goals` — the goal-engine path.

Result: the card body never reaches the model's reasoning context. Workers default to whatever `mc goals` surfaces (their role-engine priorities). Steward has to whisper card content into chat to make any of it actionable.

Mason explicitly hit this conflict and chose the goal-engine:
> *"Goals: Top unsatisfied goals by urgency: `perimeter_fence` (75 priority, 0.1 urgency) … But Steward said she deployed explore cards. Let me look at this more carefully."* — then continued with perimeter_fence

The fix is conceptually small: the kanban-worker wake prompt should first `kanban show $HERMES_KANBAN_TASK` (or equivalent), inject the card body into the agent's context, and instruct it to act on the card body, not on `mc goals`.

## What worked

- **`scripts/establish-scenario.sh`** is now idempotent. Memory wipe + auto-patched map + starter kit produced clean Surface positions for all 4 bots on bootstrap.
- **Steward did do real orchestration** when she stayed in her role: filing 3 follow-up SCOUT cards based on observed state, demoting SW to todo, commenting on the epic.
- **`reconcile-marks --auto` worked** — Steward's marks propagated to workers (every worker's `lt_*` entries had `reconciled_from: ["steward"]`). The mark-sharing mechanism is fine.
- **The kanban set-after + block workaround held** — SW correctly stayed queued behind NE until administratively closed.
- **Mason DID find the SE ruin and walls** — real value when he eventually patrolled SE (after Steward's whisper).

## What didn't work

- **Workers don't read cards.** Goal-engine wins. (NEW)
- **Steward is doing shadow scout work** to compensate for workers not following cards. (NEW)
- **Card administrative closure with synthesized summaries** distorts the kanban audit trail — NE EXPLORE's "candidate_pad SITE_SCORE 3" was Steward's narration, not gatherer's data. (NEW)
- **Pillar oscillation** with no fall-context, no standable-floor-Y, no action result deltas, no oscillation signal.
- **Trapped-flag recovery requires sustained discipline** — easily broken by interleaving `move`/`bg_goto`.
- **Builder cage** — Mason placed 12 fences around himself thinking "perimeter", didn't model himself as enclosed.
- **chat-wake × kanban-worker dual control** was the original symptom; fix is in place but only takes effect on next `landfolk start`.

## Concrete actions

| # | Item | Touches |
|---|------|---------|
| A1 | Kanban-worker wake prompt should `kanban show $HERMES_KANBAN_TASK` first and instruct acting on card body, not `mc goals` | `prompts/landfolk/worker.wake-*.md`, `skills/kanban-worker.md` |
| A2 | Either silence `mc goals` or downgrade goal-engine urgency when an in-flight kanban card exists for this bot | `mc goals` resolver |
| A3 | Steward SOUL: hard exclusion on `mc move` / `mc terrain_top` / `mc mark` away from base when role=orchestrator. Add a `pre_tool_call` deny similar to task #34 | `prompts/landfolk/steward.md`, `~/.hermes/profiles/steward/...` |
| A4 | `pillar_up` / `pillar_down` return result-deltas: `{placed_blocks, y_before, y_after, broke_blocks}` | `bot/lib/actions/pillar/*` |
| A5 | Nav-brief: add `standable_floor_y` (next solid Y below current position) + `on_pillar: bool` + `pillar_height_below: N` | `bot/lib/runtime/nav-brief.js` |
| A6 | Fall-context event: when a bot's Y drops ≥5 blocks in <2s with no `pillar_down`/`dig` initiated, log `recent_falls: [{from_y, to_y, t_ago_s}]` and surface in `mc status` | `bot/lib/runtime/manager.js` |
| A7 | Oscillation detector: `recent_actions_summary` field in `mc status` that flags direction reversals (≥4 in 90s) | `bot/lib/runtime/observation.js` |
| A8 | Topology classification: add `column_top` (1×1 with all 4 cardinals being 1-block drops) and `self_enclosed` (≥6 of 8 neighbors are player-placed blocks the bot itself put down) | `bot/lib/runtime/nav-brief.js` |
| A9 | Trapped-flag auto-clear: when `mc dig` is invoked and the previous-move-failed flag is set, allow the dig to proceed and clear the flag automatically. Removes the 2-step recovery dance. | `bot/lib/actions/movement/_helpers.js` |
| A10 | `pillar_up` ≠ `pillar_step` — align the agent-facing verb with the backend action name OR document the alias prominently in the action error messages | `bot/lib/actions/pillar/up.js` |
| A11 | Worker SOULs: insert "If you have an active kanban card, the card body trumps `mc goals`. Run `kanban show` first" at the top of `worker.wake-*.md` | `prompts/landfolk/worker.wake-*.md` |
| A12 | Card closure governance: Steward should not be able to close a card she has no evidence the assignee actually worked on. Workers must run `kanban_complete` themselves with a `--summary` of THEIR observations | `scripts/kanban` (close verb), worker prompts |

## Per-character reports

Detailed per-character timelines, reasoning excerpts, and command-level traces:
- `steward/` — agent + progress + mc + watchdog logs
- `gatherer/` — same
- `flint/` — same (pillar saga centerpiece)
- `mason/` — same (fence cage + trapped loop centerpieces)
- `kanban.db` — snapshot of the board at stop
- `map.json` — the procedural map used (seed 1001, post-patch)
- `locations-{bot}.json` — final mark state per bot

## One-sentence verdict

**The kanban facade exists for Steward, not for the workers — they orient by `mc goals` and ignore card bodies, so Steward compensates by doing scout work herself and narrating worker completions, while workers cycle on role-default priorities even with cards claimed; this run delivered exactly two new useful artifacts (Flint's `candidate_pad_nw` and Mason's `se_ruin` + `se_walls`) in 50 minutes of fleet runtime, almost entirely on Steward's whispered prompts rather than on autonomous card-driven work.**
