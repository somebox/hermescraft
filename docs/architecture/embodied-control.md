# Embodied control: reflex-first bot ↔ agent interface

Status: **design exploration** (2026-06-10). Strategic vision for how Hermes workers act in Minecraft **without visual reasoning** and with a **bounded `mc` surface**. Card-level orchestration (narrow agents, one phase per card) lives in [`target.md`](target.md). This doc is the **vertical** complement: what the body does vs what the mind chooses.

**Living vocabulary.** Names here (reflex, taxi, macro, microscope, LOOK/GO/DO, playbook tiers) are **working labels**. Taxonomy churn is expected — driven by **evidence**, not prose debates (see [Evidence loop](#evidence-loop-policy) below).

| Related | Doc |
|---|---|
| Hermes vs bot responsibilities | [`../reference/hermes-mc-boundaries.md`](../reference/hermes-mc-boundaries.md) |
| Control path (`mc`, HTTP, marks) | [`bots-and-mc.md`](bots-and-mc.md) |
| Navigation refactor (brief, breadcrumbs, `move`) | [`../specs/nav/route-precompute-context.md`](../specs/nav/route-precompute-context.md) |
| Composable playbooks + task-shaped reads | [`../testing/playbooks/design-composable-playbooks.md`](../testing/playbooks/design-composable-playbooks.md) |
| Return envelopes + per-primitive contracts | [`../reference/bot/handler-response-contracts.md`](../reference/bot/handler-response-contracts.md) |
| Typed nouns, symmetric success, perceive lanes | [`../specs/mc/observation-verb-grammar.md`](../specs/mc/observation-verb-grammar.md) |
| Region selectors + query substrate (Layer A) | [`../specs/agent/scripting-layer-dsl.md`](../specs/agent/scripting-layer-dsl.md) |
| Fleet usage + registry hygiene audit | [`../reference/audits/audit-mc-commands-2026-05-29.md`](../reference/audits/audit-mc-commands-2026-05-29.md) |
| **Syntax today** (generated) | [`../reference/mc-cheatsheet.md`](../reference/mc-cheatsheet.md) ← `bot/cli/registry.mjs` |
| Intent taxonomy (legacy hand-maintained; sunsetting) | [`../reference/mc-command-reference.md`](../reference/mc-command-reference.md) |

---

## Convergence, not vision

Embodied control, the nav refactor, observation grammar, the scripting substrate, and composable playbooks already **point the same way**: reflex in the bot, **selection not derivation** in the agent, one envelope spine. The sprawl is in the **shipped agent-facing surface**, not in the thinking.

**Do not shrink the handler registry to fix discoverability.** Handlers are cheap, tested capability — a large registry is fine. What is expensive is **every verb being equally visible to every agent on every turn**. Strategy is to **formalize two layers** (below) and let surveys/failure tooling drive each consolidation — not another standalone vision doc. Prose here is **rationale**; [`bot/cli/registry.mjs`](../../bot/cli/registry.mjs) (and generated artifacts) are the **contract**.

**One sentence:** keep the big registry, define a **small generated agent surface** over it, fix the envelope and addressing shapes, and let **`mc-call-survey` / failure analysis / shadow flags** drive each facade — the configuration where agents (and later automation) can improve the surface themselves.

---

## Where the pain is (evidence baseline)

Re-measure after major taxonomy changes; sources linked, not duplicated.

| Signal | What it implies | Primary source |
|---|---|---|
| **181 registry verbs**, ~**30** carry most fleet traffic; **38** had **zero use** in a 7-day window | Cheatsheet reads like an **implementation catalog masquerading as an agent interface** | [`audit-mc-commands-2026-05-29.md`](../reference/audits/audit-mc-commands-2026-05-29.md), [`observation-verb-grammar.md`](../specs/mc/observation-verb-grammar.md) |
| **~44%** of `mc <verb> <material>` calls fail; dominated by **geometry** (`pathfind_failed`, `view_blocked`, `no_solid_neighbor`); naming **~0.5%** | Agents still **reason about space in the prompt**; nav brief / taxi doctrine attacks this | [`route-precompute-context.md`](../specs/nav/route-precompute-context.md), `scripts/analyze-mc-failures.py` |
| **Asymmetric envelope** — rich typed **failure**, success often **prose + ad-hoc `data`**; same entity (e.g. oak log) **three shapes** across `scene` / `find_blocks` / `inspect` | Hard to pipe output → input; blocks scripting Layer A | [`observation-verb-grammar.md`](../specs/mc/observation-verb-grammar.md) § response shapes |
| **Addressing re-learned per verb** — Point3, Box6, BoxXZ, `X Z W L D`, radius… | Large share of cheatsheet **apparent** complexity | [`scripting-layer-dsl.md`](../specs/agent/scripting-layer-dsl.md) Part 1 |

---

## Two layers: registry vs agent surface

| Layer | Purpose | Size / growth | Who sees it |
|---|---|---|---|
| **Registry** | Implementation catalog — handlers, aliases, HTTP routes, tests | **Large** (~181+ today); may grow freely | Developers, codegen, `mc commands`, full cheatsheet |
| **Agent surface** | Curated **core ~30–40** verbs organized by **LOOK / GO / DO + macros**, then **scoped again** per profile, skill bundle, and playbook phase | **Small per worker** | Hermes workers at runtime |

**Microscope tier:** everything in the registry that is **not** on the worker's current surface remains **reachable, documented, and valid** — used for recovery, debugging, and power-user flags — but **out of default view** (not loaded into turn-1 skill context, omitted from `mc help --profile`, etc.). This is already **half-built** via L2 agent bundles, playbook verb whitelists, and phase tables; make that **explicit policy**, not a side effect.

Lanes (align with nav + observation specs):

- **LOOK** — orchestration + task-shaped reads (`observe`, `status`, `scene`, facades like future `search`, verify kinds).
- **GO** — **`move`** (+ `stop`, `retrace`, `escape`; water/boat where assigned).
- **DO** — world/craft/combat **primitives and promoted macros** (`dig`, `place`, `collect`, …).
- **Microscope** — cell coords, raw `goto --raw`, bulk box dialects until region selectors land, low-traffic registry entries.

Profile/playbook docs own **which subset** each card loads — see [`hermes-agents.md`](hermes-agents.md), [`design-composable-playbooks.md`](../testing/playbooks/design-composable-playbooks.md).

---

## Delivery order (dependency chain)

Ship in this order; later steps get cheaper once earlier spines exist.

### Implementation status (2026-06-10)

| Delivery step | Status | Shipped artifact |
|---|---|---|
| **§1 spine (pilot)** | **Partial** | `bot/lib/shared/typed-nouns.js`; additive `block_ref` on `find_blocks` locations, `inspect` `data`, `scene` `visible_block_hits`; `HERMES_VALIDATE` warns on `find_blocks` / `inspect` only |
| **§4 agent surface (lite)** | **Partial** | `CmdDef.surface` via `bot/cli/registry-surface.mjs`; tier-grouped [`mc-cheatsheet.md`](../reference/mc-cheatsheet.md); `mc commands --tier core\|extended\|microscope` + JSON `surface` field |
| §2 addressing | Not started | — |
| §3 facades | Not started | — |
| §5 profile help | Not started | `mc help --profile` still future |

Baseline for tier tags: `scripts/mc-call-survey.py --minutes 10080` (416 calls / 8 sessions, 2026-06-10). High-traffic verbs promoted to **core** include `move`, `terrain_top`, `inspect`, `place`, `reachable` (see `registry-surface.mjs`).

### 1. Standardize the spine (highest leverage)

From [`observation-verb-grammar.md`](../specs/mc/observation-verb-grammar.md):

- **Typed noun vocabulary** — shared shapes for blocks/entities (`pos`, `dist`, `bearing`, …) regardless of which verb found them.
- **Symmetric success** — structured `data` / optional `state_after` (mirror failure's `observed_state`); **prose as projection**, not the only payload.
- **Shared error-code enum** where practical — same drift-stopper as action-contract.

Add **contract tests**: any verb emitting a block/entity uses the shared shape. Prerequisite for scripting **Layer A** and for agents/scripts piping results without regex.

### 2. One addressing grammar

[`scripting-layer-dsl.md`](../specs/agent/scripting-layer-dsl.md) **Part 1 (region selectors)** — single way to say `me r=1`, `@mark r=8`, `box(p1,p2)`, bearing offsets. Stops `dig_area`, `place_fill`, `level`, `scout`, `is_empty`, … each defining its own box/radius dialect. Required for honest playbook `act:` rows.

### 3. Consolidate by facade, not deletion

Pattern: **`move`** (canonical verb + flags; legacy names as aliases). Apply to clusters the data flags:

| Cluster | Direction | Priority |
|---|---|---|
| **Search** | One facade over `find` / `find_blocks` / `discover` / chest search habits | High — perception/discovery traffic |
| **Verify** | `verify <kind>` over scattered predicates (`verify_plot`, `is_sheltered`, `check`, …) | High |
| **Build namespace** | Optional categorical polish (`mc build …`) | Lower — survey shows pain in search/verify more than building |

Keep old verbs in the **registry**; facades route internally during migration.

### 4. Registry as sole source of truth

Target state (see audit fix list §A, §F):

- Add **`intent`** (and agent-surface tier: core / macro / microscope) on `CmdDef` in [`registry.mjs`](../../bot/cli/registry.mjs).
- **Generate** cheatsheet, profile-scoped help (`mc help --profile navigator`), and lane tables from registry — **not** three drifting taxonomies.
- **Sunset** hand-maintained intent in [`mc-command-reference.md`](../reference/mc-command-reference.md) (keep migration notes until generator covers chains/hints).
- Backfill registry hygiene: schema min/max on unbounded params, `examples` on bare verbs — generator surfaces gaps in CI.

### 5. Evidence loop policy

Instruments already exist; institutionalize as **policy**:

| Instrument | Use |
|---|---|
| `scripts/mc-call-survey.py` | Verb mix before/after taxonomy change |
| `scripts/analyze-mc-failures.py` | Failure mode (geometry vs naming) |
| Context-tests / agent-tests | Card-level regression |
| Shadow flags (`HERMES_NAV_BRIEF=shadow`, …) | Safe rollout |

**Rules:**

- Taxonomy or facade changes ship **behind a flag** when behavior-visible; include a **pre/post survey** note in the PR.
- A registry verb with **zero fleet use** after **N weeks** gets either a **card/playbook that exercises it** or **demotion to microscope tier** on generated agent surfaces — not silent deletion.
- **Defer scripting Layer A / Layer B** until spine (1) and selectors (2) land — per [`scripting-layer-dsl.md`](../specs/agent/scripting-layer-dsl.md).
- **Defer macro catalog expansion** — promote verbs when playbooks and trials prove need (`collect`, `sail_to`, plot verify, …), not pre-built long tail.

This loop is what makes taxonomy churn in [What evolves](#what-evolves-explicit) **safe for agents (and future AI maintainers)** to propose → validate → regenerate artifacts.

---

## Explicitly not doing

- **Big-bang v2 CLI grammar** (e.g. two-token `mc sense look`) — alias map, `prompts-sync` / cheatsheet CI, and **profile-scoped help** give discoverability with safer migration than retraining every prompt.
- **More parallel vision prose** — extend **registry + generated docs**; keep architecture docs as rationale and review checks.
- **Registry shrink-by-deletion** — hide from agent surface, keep handlers and tests.
- **Long-tail macro pre-build** — playbooks and genesis cards **promote** the next macro when data supports it.

---

## North star

Agents succeed because they **do not simulate the world block-by-block in language**. The Mineflayer stack is the **motor and sensory nervous system**: walking, reaching, collecting, and recovering from snags run **closed-loop in the bot**. The agent **plans in goals, marks, macros, and scripts** — choosing *what* to do next, not *how each footstep works*.

**Mind on the mission; body on the blocks.** Block-level commands stay available, but they are **microscope mode** — deliberate, token-heavy, and scoped — not the default way to perceive or act.

---

## Split of responsibility

| Layer | Owns | Does not own |
|---|---|---|
| **Agent** (Hermes worker) | Card goal, sequencing, when to escalate, workspace scripts, playbook phase choice, social policy | Pathfinding geometry, neighbor scans, pickup chains, retry loops on identical nav |
| **Bot** (`mc` → HTTP → Mineflayer) | Motor execution, fair-play limits, regions, durable marks/tasks, **honest** success/failure envelopes | Long-form strategy, kanban decomposition, cross-epic planning |
| **Host** (dispatcher, gate-check) | Body binding, mutex, spawn `MC_*`, recall/git | In-card tool selection |

Same split as [`hermes-mc-boundaries.md`](../reference/hermes-mc-boundaries.md), with the emphasis that the bot is not only **world truth** but **embodied competence**.

---

## Core values (shape refactors)

| Value | Meaning for development |
|---|---|
| **Reflex over reasoning** | If workers routinely “think through” pathfinding, voxel layouts, or dig→pickup chains in the prompt, move that logic into handlers, runtime, or macros. |
| **Taxi navigation** | Movement verbs express **intent to arrive** at a mark, region/site, or coordinate. The bot picks safe mode, doors, detours. Failure means **end the ride and replan** — not five identical `goto` attempts. |
| **Task-shaped perception** | Reads answer **human-scale questions** for the current job (stand of trees, plot readiness, chest run) instead of defaulting to raw block dumps. |
| **Macro-first execution** | Common jobs should be **one or few `mc` calls** with completion semantics agents can trust (`collect`, guided `construct`, playbook-shaped flows). |
| **One spinal protocol** | Every verb returns the same envelope shape so scripts, playbooks, and the LLM pipe **output → input** without ad hoc parsing. **Success must become as structured as failure** (typed nouns, symmetric `state_after`) — see [Delivery order §1](#1-standardize-the-spine-highest-leverage). |
| **Microscope on demand** | Cell coords, neighbor enums, blueprint cells, `mc check` — when macros and marks are not enough. **Not on the default agent surface** — see [Two layers](#two-layers-registry-vs-agent-surface). |
| **Shrink surface per decision** | Do not optimize for fewer handlers; optimize for **fewer equally-visible verbs per turn** (profile + playbook scope). |

---

## Operating metaphors (operational, not decorative)

### Motor control and reflexes

Creatures do not reason about ankle angles to cross a room. Likewise:

- **GO** (`move`, `stop`, `retrace`, `escape`) should feel like **ordering a limb**, not solving a maze in chat.
- **DO** (`dig`, `place`, `collect`, pillars/stairs, farming verbs) are **body actions** the bot completes or rejects with typed errors.
- Closed-loop behavior (doors, confined-space hints, collect until quota) belongs **in code**, documented via [`handler-response-contracts.md`](../reference/bot/handler-response-contracts.md).

### Taxi service (navigation)

1. **Request** — destination: `@mark`, `:region:/site`, or coordinates (prefer canonical **`mc move`** — see nav spec).
2. **Ride** — bot pathfinds, records trail/breadcrumbs where enabled, refuses bad detours unless `--force` / `--raw` escape hatches.
3. **Arrive or stall** — envelope says where you are and whether retry is safe.
4. **Stuck protocol** — `stop` → fresh **`mc observe`** (optional **`nav_brief`**) → pick a new line, DO primitive, or **`escape`** → if still blocked, **hand off** (card comment / block / replan), not infinite retry.

Skill doctrine: [`skills/minecraft-navigation.md`](../../skills/minecraft-navigation.md) (brief lines, confined mode).

### Ecological sight (perception zoom)

Perception has **zoom levels**. Agents should live at the middle by default:

| Zoom | Typical verbs / artifacts | Agent use |
|---|---|---|
| **Orchestration** | `observe`, `status`, goals/alerts slices | “Where am I in the job?” |
| **Task-shaped** | `inspect`, `verify`, `farm_status`, playbook-composed reads, domain summaries | “Forest / plot / pen — what matters *here*?” |
| **Locale chart** | `scene`, `nearby`, `map`, `find` | Recovery, scouting, when task lens is insufficient |
| **Microscope** | explicit coords, `is_empty` / `is_filled`, blueprint cells, `mc check` | Placement failures, legal boundaries, one-off fixes |

**Anti-pattern:** treating `scene`/`map` as the default every turn. That forces voxel reasoning in the LLM — the failure mode analyzed in [`route-precompute-context.md`](../specs/nav/route-precompute-context.md).

Playbooks encode **which lens each phase uses** ([`design-composable-playbooks.md`](../testing/playbooks/design-composable-playbooks.md) § domain-coupled perception). New perceive verbs should justify which zoom they serve.

### Macros, playbooks, and scripts (three tiers of “do”)

All tiers use the **same `mc` HTTP surface** — no second protocol.

| Tier | What | Example direction |
|---|---|---|
| **Reflex verb** | Single handler, tight contract | `dig`, `withdraw`, `move @base` |
| **Macro / compound** | Bot-orchestrated multi-step, one agent decision | Resource `collect`, `wood.chop_tall_tree`-class flows, `construct` / `repair` |
| **Agent script** | Shell in `data/workspace/.../scripts/` under OWNERS | Repeatable glue; composes envelopes |

Playbooks are **catalogued procedure + phase tables** over existing verbs; they add **no new mutation API**. Agents may **author scripts** when the catalog is almost right — scripts are wiring, not a bypass of bot policy (regions, fair-play).

---

## Agent loop (canonical cognitive rhythm)

Aligned with LOOK / GO / DO in the nav refactor ([`route-precompute-context.md`](../specs/nav/route-precompute-context.md)):

1. **LOOK** — task-appropriate snapshot (`observe`, or narrower reads).
2. **Choose** — pick a macro, brief line, mark, or script step (not a voxel plan).
3. **GO / DO** — one motor command (or one macro).
4. **Read envelope** — `ok`, `data`, or `error.code` + `next_action_hint` + `retry_safe`.
5. **Repeat or exit** — on nav stall, **replan** (taxi protocol); on card done, `kanban_complete` with handoff metadata.

Long work uses **`bg_*` / task** verbs where the registry exposes them so the agent is not simulating every tick.

---

## PR and design review checks

Before merging bot or skill surface changes, ask:

1. **Reflex test** — Does a typical successful outcome need **fewer** perception calls or manual nav steps?
2. **Taxi test** — Can the intent be expressed as **one destination** or **one macro**?
3. **Honest macro test** — Is `ok: true` forbidden when nothing meaningful happened?
4. **Envelope test** — Can the next step be chosen from structured fields without prose parsing? (If not, spine work §1 is not done for that verb.)
5. **Microscope test** — Is block-level detail **opt-in**, not the default payload?
6. **Script test** — Could a maintainer reproduce the flow as a short workspace script using documented fields only?
7. **Surface test** — Does this change belong on the **default agent core** for all workers, or only a profile/playbook/microscope tier?

---

## Relationship to card-boundary architecture

[`target.md`](target.md) resets **agent cognition** each card (narrow skills, fresh worker). **Reflexes persist in the bot** across cards: marks, trails, tasks, chest snapshots. Together:

- **Horizontal:** one phase, one expert, small verb whitelist.
- **Vertical:** each call is reflex-heavy, macro-friendly, envelope-consistent.

Pilot metrics (context size, turns, success rate) judge **bundle content and bot honesty** before blaming the model.

---

## What evolves (explicit)

Expect churn in:

- **Agent surface tiers** (core / macro / microscope) and generated `mc help --profile` — sourced from registry `intent` + tier fields, not prose tables.
- CLI **category names** (`perceive` vs legacy groups) and canonical nav verb (`move` migration).
- **Facades** (`search`, `verify <kind>`) over legacy verb clusters — registry retains aliases.
- Which operations are **macros** vs primitives — **playbook and trial promotion**, not upfront catalog builds.
- Playbook ids in [`data/playbooks/registry.yaml`](../../data/playbooks/registry.yaml) vs prose-only cards.
- **`nav_brief`** rollout flags and confined-mode hints.
- Agent profile roster and DSL parse shapes ([`hermes-agents.md`](hermes-agents.md)).

**Rationale** lives in this doc and linked specs; **syntax and agent-visible lists** come from [`registry.mjs`](../../bot/cli/registry.mjs) and generated [`mc-cheatsheet.md`](../reference/mc-cheatsheet.md). Re-run surveys when changing facades or surface tiers ([Evidence loop policy](#evidence-loop-policy)).

---

## Related

- [`target.md`](target.md) — agents, bots, cards, deliberate don'ts  
- [`bots-and-mc.md`](bots-and-mc.md) — fleet binding, marks, skill verb bundles  
- [`README.md`](README.md) — architecture folder index  
