# Phase 2 — Reactive layer (Layer 2)

Section 16 of the Phase 2 architecture (the autonomy-layers revision dated 2026-05-10). Authoritative spec for the reactive autopilot in `bot/lib/bot/reactive.js`.

## 16. Plan revision — autonomy layers (added 2026-05-10)

### Why this revision

Sprint 1 shipped ~40 L3 action contracts and 4 behavior_test fixtures. During combat fixture review the user surfaced a structural gap: **passing an L3 contract in isolation does not predict whether the bot will survive a real night.** Examples:

- `mc fight zombie` works when invoked. But the bot doesn't *know* a zombie has approached unless something tells it. If the agent has to scan the entire `mc observe` payload and reason "is there a zombie nearby" every cycle, reactions take seconds — too slow for melee.
- `mc flee 25` works when invoked. But an unattended bot never calls flee.
- `mc shoot zombie` works as a single-shot primitive, but doesn't kite. The bot fires arrows from its starting position while the zombie closes to melee.

The action layer is therefore necessary but insufficient. Three layers must coexist and we have to test each:

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3 — Strategic (agent brain)                               │
│   • picks which mode to be in                                   │
│   • invokes named macros for tasks                              │
│   • reasons about goals, plans, multi-step missions             │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2 — Reactive (mode-driven, in-bot)                        │
│   • mode = guard / normal / hold / sleep                        │
│   • auto-react to triggers WITHIN the mode's policy             │
│   • emits signals when the situation exceeds the mode's reach   │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1 — Macros (`mc *` actions, in-bot)                       │
│   • multi-step primitives (fight loop, pillar climb, pathfind)  │
│   • structured `{ok, data, error}` contract (§8)                │
│   • exposed to brain AND used internally by Layer 2             │
└─────────────────────────────────────────────────────────────────┘
```

### 16.1 Layer 1 — Macros (`mc *` actions)

**Status: largely shipped.** ~40 contracts green (L0/L3/ladders/combat). Each `mc <verb>` is a multi-step primitive: `mc pillar_step` jumps and places blocks; `mc fight zombie` loops attack-retreat; `mc goto_near` invokes pathfinder.

**Constraint:** macros are stateless w.r.t. modes. They execute, return, and don't change the bot's reactive posture. The brain's posture-change command is a separate `mc mode <name>` macro (see 16.2).

**Sprint 1 work continues:** finish food/hunger, sleep, basic crafting chains. No structural change.

### 16.2 Layer 2 — Reactive modes (NEW; refined 2026-05-10)

The bot maintains a single `ctx.mode` value. Each mode defines an automatic reaction policy: a set of triggers paired with **micro-actions**, evaluated every tick.

**Critical refinement: Layer 2 is a tactical autopilot, NOT a macro dispatcher.**

Initial design called Layer 2 macros internally (`mc fight`, `mc flee`). Testing showed this is wrong:
- `mc fight zombie 6 30` runs for up to 30 seconds. While it runs, Layer 2 can't re-evaluate. HP, threat, terrain, equipment changes all go unnoticed.
- `mc flee 16` does a long pathfinder.goto. The bot ends up 16+ blocks from its starting position — torn away from whatever the agent's task expected. Even worse, in a closed space the path may fail entirely or trace a chaotic detour.

Instead, Layer 2 issues **per-tick micro-actions**:

| Macro (Layer 1, agent-callable) | Reactive's micro-action equivalent |
|---|---|
| `mc fight zombie 6 30` (loops 30s) | `mc attack zombie` once per tick + 100ms back-step |
| `mc flee 16` (16-block escape) | step 1-2 blocks directly opposite the threat, then re-evaluate |

Properties:
- **Each tick: one short action that completes in ≤500ms.** The reactive loop re-runs at 400ms and reads fresh state.
- **Bounded movement.** Reactive never travels more than ~6 blocks from the anchor (the position where the agent's last explicit task left the bot). Beyond that, mode falls back to "hold" pending agent input.
- **Tracks the threat across ticks.** When fleeing, reactive monitors the threat's distance and stops moving once a safe gap is held. When fighting, reactive watches HP and switches to flee if it drops below threshold.
- **In closed spaces, flee is no-op.** If pathfinder can't move the bot anywhere safer (walled in), reactive recognizes "trapped" and falls through to fight. The agent gets a `notable_event: trapped_with_threat` so the strategic layer knows to re-plan.

This keeps the agent's mental model intact: "I told the bot to mine cobble at X. While doing that, it occasionally hit zombies for me, but it's still at X (within a few blocks)." vs. the broken model: "I told the bot to mine at X, now it's 25 blocks away because something startled it."

**Modes (initial set):**

| Mode | Auto-behaviors | When agent picks |
|------|----------------|-------------------|
| `normal` (default) | Bounded flee creeper at <6 blocks. Fight in self-defense (attacked OR melee range). Never wander past 6 blocks from anchor. Auto-eat (already handled by autoEat plugin). | General play; agent issuing tasks |
| `guard` | Engage hostiles in 12-block radius. Hold ground (≤16 blocks from anchor). Auto-flee creeper. | Defending a base, escort, sleep watch |
| `hold` | No auto-actions. Bot stays put, observes, emits signals only. | Pure observation, debugging, RP scenes |

**Reaction-time budget:** Layer 2 must react within **400ms** of trigger condition (one tick of the reactive loop). The tactical micro-loop is the entire reason Layer 2 exists.

### 16.2a Multi-bot considerations

The same reactive layer runs independently in each bot's process — Flint and Gatherer each maintain their own `ctx.mode`. Mode is not shared across bots; the agent picks per-character. This naturally supports scenarios like:
- Flint in `guard` mode at the base entrance; Gatherer in `normal` mode foraging.
- Both in `guard` during a raid drill.

The signal layer (§16.3) is also per-bot. Cross-bot coordination ("Flint sees zombie, Mason should help") is a Layer 3 strategic decision the agent makes by reading both bots' observations.

**Mode invocation:** `mc mode <name>` returns the previous mode name. Mode persists until changed. Default on bot start: `normal`. Implementation in `bot/lib/bot/reactive.js`.

### 16.2b Implemented micro-actions (as of 2026-05-10)

`decide()` returns one of these per tick:

| Action | Trigger | Behavior |
|---|---|---|
| `attack_step` | hostile in melee range (≤4.5) | Multi-target swing (skill-scaled), then strafe/back-step |
| `advance_step` | hostile in sight, out of melee, bot armed | Bounded forward sprint (~1.5 blocks); equips weapon en route |
| `flee_step` | creeper ≤6, low HP+damaged, OR ranged threat with no weapon | Bounded sprint AWAY, ±35° zig-zag, wall-aware; escalates to random angles when stuck |
| `hold` | mode=hold, anchor exceeded, or no triggers | No movement; reset stuck counter |

### 16.2c Combat skill (per-bot tunable)

`ctx.combat_skill ∈ [0, 1]` (default 0.5) scales lethality:
- **Multi-target probability** — closest hostile is always struck; each additional target rolls against `skill^N` (so skill=0.9 mops up 6 zombies, skill=0.2 stays single-target).
- **Tick rate** — low-skill bots skip attack ticks (skipBudget = round((1-skill)*2)); skill=0 swings every ~1.2s, skill=1 every 0.4s. Flee is never throttled.

Set via `mc combat_skill 0.9` or `COMBAT_SKILL=0.9` env var. Soldier ≈ 0.9, default ≈ 0.5, farmer ≈ 0.2.

### 16.2d Stuck escalation (shared across all movement steps)

`settleStuck()` runs after every movement step and increments/decays a shared `stuckTicks` counter:
- `stuckTicks=0` — normal jitter ±35°, 50% back / 25%×2 strafe
- `stuckTicks=1` — wider angles (±60°, ±90°), strafe-only retreat, longer movement duration
- `stuckTicks≥2` — fully random 360° angles (may move toward the enemy if needed); jump to dislodge from 1-block lips and mob pins

This is what makes the bot survive multi-zombie corner pins and pillar geometry that would otherwise leave it grinding into a wall.

**Reaction-time budget:** Layer 2 must react within **400ms** of trigger condition (one tick). Faster than the brain's observe→decide→act cycle (~3-10s) by 10-30×. This is the entire reason Layer 2 exists.

### 16.3 Layer 3 — Signal / alert contract (NEW)

When something happens that exceeds the current mode's auto-policy, the bot pushes a **signal** the agent must see on its next observe. Signals are urgency-tiered so the agent doesn't have to scan the dense observe blob to find what matters.

**Required fields in `mc observe.data` (additive):**

```yaml
urgent_alerts:                 # priority: critical — agent must act this cycle
  - { kind: "low_hp", hp: 4, threshold: 6, ts: 1778366135938 }
  - { kind: "creeper_in_blast_radius", entity_id: 442, distance: 2.8, ts: ... }
  - { kind: "drowning", air: 80, ts: ... }
  - { kind: "death_imminent", reason: "fall", predicted_dmg: 12, ts: ... }
notable_events:                # priority: high — agent should incorporate next decision
  - { kind: "took_damage", amount: 4.0, source: "skeleton", remaining_hp: 16, ts: ... }
  - { kind: "killed_target", target: "zombie", drops: ["rotten_flesh"], ts: ... }
  - { kind: "out_of_food", ts: ... }
  - { kind: "auto_action_fired", mode: "normal", action: "flee", target: "creeper" }
ambient_observations:          # priority: low — already in nearby_entities/scene/etc.
  # (existing observe fields, unchanged)
```

**Signal lifecycle:** queued in-bot, included in next `mc observe`, cleared after agent reads. Bot keeps a small ring buffer (16 entries per tier) to handle agent-poll latency.

**Auto-action transparency:** when Layer 2 fires a macro autonomously, it MUST emit a `notable_event` of kind `auto_action_fired`. The agent can then decide whether to override (return to mode `hold`, take manual control, etc.).

### 16.4 Test taxonomy v2 — A / M / I tests

Existing **L-tests** (capability tests, isolated `mc <verb>` invocation) are necessary but not sufficient. Add three new test classes:

**A-tests — Alert/signal contract tests.** Validate that the bot surfaces the right signals at the right urgency tier.

| Pattern | Setup | Action | Assertion |
|---------|-------|--------|-----------|
| A.1 | bot HP=20, summon zombie within 4 blocks | wait 2 ticks | `urgent_alerts` contains `low_hp` after first hit; `notable_events` contains `took_damage` |
| A.2 | bot HP=20, summon creeper within 4 blocks | wait 1 tick | `urgent_alerts` contains `creeper_in_blast_radius` |
| A.3 | bot food=4 | wait 1 tick | `urgent_alerts` contains `out_of_food` |
| A.4 | bot at Y=72 above stone Y=64 | wait fall | `urgent_alerts` contains `death_imminent` BEFORE the landing |

**M-tests — Mode policy tests.** Validate that each mode auto-reacts as specified.

| Pattern | Setup | Mode | Action | Assertion |
|---------|-------|------|--------|-----------|
| M.1 | bot at (0,65,0) | guard | summon zombie at (5,65,0) | within 1.5s, `auto_action_fired` event with action=fight; zombie dies; bot stays within 16 blocks of (0,65,0) |
| M.2 | bot at (0,65,0) | normal | summon creeper at (3,65,0) | within 0.5s, bot moves >5 blocks west; creeper does not detonate near bot |
| M.3 | bot at (0,65,0), food=4 | normal | wait | within 1s, `auto_action_fired` event with action=eat; food >=14 |
| M.4 | bot at (0,65,0) | hold | summon zombie at (3,65,0) | bot does NOT engage; HP drops; bot stays at (0,65,0); event log shows no auto_actions |

**I-tests — Integration / react-loop tests.** End-to-end with a stub or real agent driving the bot via signals.

| Pattern | Setup | Driver | Pass condition |
|---------|-------|--------|----------------|
| I.1 | bot in `normal` mode, surface arena, 3 zombies summoned over 30s | 50-line stub: poll observe at 1Hz, switch to `guard` if `urgent_alerts.low_hp` or `notable_events.took_damage`, switch back to `normal` after threats clear | bot alive after 60s |
| I.2 | bot in `normal` mode, given mining task; periodic mob spawns | stub: monitors task progress + threats; preempts to fight then resumes mining | mining task completes; bot alive |
| I.3 | full Hermes brain (`/goal mine 16 cobblestone`) under random mob spawns | real brain | task completes; bot alive; brain's reasoning log shows mode switches |

### 16.5 Where automated behavior makes sense (design rule)

| Decision class | Layer | Reason |
|----------------|-------|--------|
| "Move my feet to that block" | 1 (macro internal) | sub-second, no strategic content |
| "Place a block underfoot before jumping" | 1 (macro internal) | physics detail, single context |
| "Attack the entity in melee range right now" | 2 (mode auto) | <300ms react needed; trigger condition is unambiguous |
| "Flee from the fizzing creeper" | 2 (mode auto) | <500ms react needed; survival > everything else |
| "Eat when hungry" | 2 (mode auto) | passive trigger, no strategic ambiguity |
| "Should I fight this zombie or run?" | 3 (brain) | depends on goal, equipment, terrain — not reducible to a fixed rule |
| "Switch from mining to defending the base" | 3 (brain) | strategic context, mode change |
| "Build a shelter before nightfall" | 3 (brain) | planning + sequencing |

The rule of thumb: **if the right answer is a fixed policy that depends only on local sensor data and time, it belongs in Layer 2. If the answer depends on goals, knowledge, or judgment, it belongs in Layer 3.** Layer 1 is the toolbox both layers reach into.

### 16.6 Roadmap revision

Sprint 2 (this work) reframes around the new layers. Order of operations:

1. **(A) Alert audit** — instrument and inspect the current `mc observe` during attacks. Identify what's already there, what's missing, what's noise. Output: list of signals to add to §16.3.
2. **(B) Stub react-loop** — 50-100 line shell or python: polls observe at 2-5 Hz, looks for hostile entities and HP drops, calls `mc fight` / `mc flee`. Verifies (a) the signal layer is sufficient for a non-LLM consumer, (b) reaction times are fast enough, (c) which signals are too late or missing.
3. **(C) Mode primitives** — implement `mc mode normal | guard | hold` in the bot. Wire the auto-behaviors to mode policy. Ship M-tests.
4. **(D) Brain-driven I.1/I.2** — the original Phase 2 Sprint 1 exit gate, now with modes selectable. Brain picks mode, lets Layer 2 handle micro-defense, focuses on strategy.

Phase 2's previous Sprint 2 plan (L1 movement) is folded into Sprint 3 — movement contracts have been exercised enough by behavior_tests B1-B4 to defer the systematic L1 sweep.

### 16.7 Non-goals updated

Removing from §2 non-goals (now in scope):
- L7 combat & survival — pulled forward as part of Layer 2 modes.

Still non-goals:
- `mc mode sleep` — defer to Sprint 3.
- LLM brain training / fine-tuning.
- Multi-bot tactical coordination (e.g., flanking).

