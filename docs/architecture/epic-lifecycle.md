# Epic lifecycle: metadata, kanban links, and card modes

Status: **design exploration** (2026-06-05). How an epic relates to child cards, how **one bot** runs many **agent** phases, progress, review, and aftermath. Complements [`target.md`](target.md), [`hermes-agents.md`](hermes-agents.md), [`bots-and-mc.md`](bots-and-mc.md), [`board-dynamics.md`](board-dynamics.md).

Implementation today: [`scripts/kanban`](../../scripts/kanban) (epic trailer vs real dependencies). Hermes fields: [`hermes-v0.15-reference.md`](hermes-v0.15-reference.md).

---

## Epic metadata contract

Epic root card (and optionally the `[PLAN]` triage child) carries **structured metadata** in Hermes `tasks.metadata` (JSON). Planner and dispatcher **copy** relevant keys onto execution children at create time.

| Key | Required | Meaning |
|---|---|---|
| `bot` | recommended | Default body for all bot-bound children (`metadata.bot` after materialize). Set once at assignment — not repeated in every DSL line. |
| `playbook` | no | Workspace-relative path, e.g. `production/ingest/playbooks/wheat-rotation.md`. Copied into child bodies or read at spawn preflight. |
| `acceptance` | recommended | Short checklist (strings or `{ id, text }[]`) overseer uses at judgment. |
| `region` | no | Designated region id for dig/place enforcement (bot `regions` API). |
| `card_kind` | no | On any card: `epic` · `plan` · `execute` · `research` · `review` · `clarify` · `maint` — drives spawn skills and toolsets (see below). |

**Bot inheritance** when creating a child:

1. Explicit `metadata.bot` on the child.
2. Else epic `metadata.bot`.
3. Else `@dispatcher` bind for `needs_bot` cards ([`board-dynamics.md`](board-dynamics.md)).

**Mass rebind:** when default bot goes `down`, dispatcher `PATCH` epic `metadata.bot` + all **ready** children with the old bot; comment on epic; optional `@navigator` verify on the new body.

---

## Epic membership vs execution order (`scripts/kanban`)

Hermes `--parent` mixed two meanings and blocked dispatch. The **facade** splits them:

| Facade flag | Effect |
|---|---|
| `--epic <id>` | Body trailer `epic: <id>`. **Membership only** — does not wait for epic to be `done`. |
| `--depends-on <id>` | Real `task_links` edge — child cannot promote until prerequisite is **done**. |

**Rules:**

- Tag every child with `--epic <root>`.
- Chain **execution** phases with `--depends-on` (survey → pad → plant → deposit).
- Do **not** make the epic root a `depends-on` parent of all children (epic stays an orchestrator/tracker; children would never promote).

**Progress (MVP):** `scripts/kanban epic <id>` — count children with epic trailer by status (`done` / `total`). No separate progress store unless dashboard wants a cached field.

**Done:** all **required** execution children `done`, no blocking children without waiver, **`@overseer` review card** `done`, then epic root marked `done`.

---

## Task spec vs `@agent` in the body

Two equivalent inputs to `@planner`:

| Style | Example | Assignee |
|---|---|---|
| **Spec list** (preferred for epics) | `- Survey 16×16 at :field_south:` · `- Level pad` · `- Plant wheat 9×9` | Planner **routes** each line to an agent (`navigator`, `builder`, `farmer`, …) via registry + task kind. Flexible when survey adds steps. |
| **Explicit DSL** | `@navigator to :field_south:` | Parser sets `assignee` literally; use when routing is already decided. |

`@agent` in text is **not required** for decomposition. Multi-line **`@bot` DSL** examples and parser shape order: [`hermes-agents.md`](hermes-agents.md) (§ Planner routing).

**Agent choice at decompose time** uses a small **task-kind → assignee** map (later `data/agents.yaml`), e.g. `survey|travel → navigator`, `level|structure → builder`, `till|plant|harvest → farmer`, `chest|deposit → crafter`. Planner may re-route when comments or recall add constraints.

---

## Kanban `@mentions` (comments)

**Mentions do not wake Hermes by themselves.** A `@farmer` in a comment is inert until something creates or reassigns work.

| Pattern | Behavior |
|---|---|
| Comment `@farmer can you update the playbook?` | Operator or `@overseer` creates a card **`assignee=farmer`**, `card_kind=research`, body quotes thread — or **`scripts/kanban assign <id> farmer`** on an existing clarify card. |
| Clarification needed mid-epic | `[CLARIFY]` card, `assignee=planner` or domain agent, **`depends-on` blocked child** optional; no bot. |
| Expected responder | **Assignee** on the card is the contract; mention is human hint only unless tooling syncs assignee from first `@profile` in comment (optional landfolk hook — **not designed**). |

---

## Card modes: bot-bound vs desk

Workers know mode from **`metadata.bot`** + **`metadata.card_kind`** (and title tags). Same Hermes **profile** (`farmer`, `miner`, …); different spawn **skills** and tools.

| Mode | `metadata.bot` | `card_kind` | Behavior | Typical skills |
|---|---|---|---|---|
| **Execute** | set | `execute` | `mc` verbs, movement, recall write, handoff metadata | L0 kanban + L1 survival + L2 `agent-*` + L3 `minecraft-*` (nav, mining, farming, …) |
| **Research** | unset | `research` | Read/write workspace, playbook edits, recall read | L0 + L2 agent bundle **Research section** + `kanban-file` / workspace tools — **no** `minecraft-navigation` on spawn |
| **Review** | unset | `review` | Compare acceptance vs child summaries, spawn verify | L0 + `agent-overseer` |
| **Clarify** | unset | `clarify` | Read epic + comments, emit revised spec or new children | L0 + `agent-planner` |
| **Plan** | unset | `plan` | Decompose epic spec → child creates | L0 + `agent-planner` |
| **Observe** | set or unset | `observe` | Desk or in-world peek for verification / fair-play evidence; title often `[VERIFY]` | L0 + role bundle observe section — see [`observe-cards.md`](observe-cards.md) |

**Same expertise, different context:** `@farmer` execute uses **`minecraft-farming`** + playbook coords (often scripted grid); `@farmer` research uses file tools only. `@miner` execute loads **`minecraft-navigation` + mining** for uneven terrain; desk mode does not.

**Desk skill catalog (L3 cross-cutting):** not one profile per concern — shared companions loaded only on desk cards:

| Skill | Use |
|---|---|
| `kanban-worker` | L0 all |
| `kanban-file` / workspace allowlist | ingest paths |
| `agent-<role>.md` Research section | domain writing rules |
| `minecraft-planning` | planner clarify/plan (shrinking) |

Bookkeeping/recall API tools attach to **planner/dispatcher/overseer** profiles via landfolk plugin, not separate Hermes profiles ([`hermes-agents.md`](hermes-agents.md) additional ideas).

---

## Example: wheat farm epic (concise lifecycle)

Full **board timeline**, handoff JSON, latency notes, and artifact map: **[`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md)**.

Summary: **`metadata.bot=mox`** on epic; spec list → planner routes assignees; execute chain with optional **auto-nav leg** before deposit; clarify + overseer review + farmer doc before epic **done**. Progress = **`kanban epic`** child counts.

| Step | Assignee | Bot | Design status |
|---|---|---|---|
| Epic + plan + research | overseer / **planner** / **farmer** (desk) | — | Metadata + facade **spec**; planner/farmer profiles partial |
| Survey → deposit | **navigator** → **builder** → **farmer** → (**navigator** leg) → **crafter** | mox | Navigator pilot; farmer/crafter/builder **not ready** for full run |
| Clarify / review / doc | **planner** / **overseer** / **farmer** | — | **Spec**; overseer/farmer execute later |

---

## Position-aware legs (auto-navigation)

Planners should **not** guess the bot’s XYZ after several cards. They declare **known anchors** (marks); a **transition hook** inserts **`navigator`** phases when the next work card’s place is unreachable from the last **handoff** position.

### What the planner specifies (stable)

On the epic or each execution child:

| Field | Meaning |
|---|---|
| `work_at` | `:mark:` where the phase acts (field, chest, pad) |
| `places` (epic) | Map of roles → mark id, e.g. `farm: field_south`, `deposit: chest_food`, `home: base_anchor` |

Spec list example — **no** explicit nav lines:

- Survey 16×16 at **`places.farm`**
- Level pad at **`places.farm`**
- Till & plant at **`places.farm`**
- Deposit surplus at **`places.deposit`**

The planner does **not** insert “walk to chest” unless the operator wants a dedicated scout card. Travel between anchors is **derived**.

### What each worker reports (volatile)

Every bot-bound **`kanban_complete`** includes handoff (see agent bundles):

- `exit_pos` `{ x, y, z }` (from `mc status` / bot HTTP)
- `work_at_mark` when relevant
- optional `inv_summary` for deposit cards

Marks resolve via **`locations-base.json`** or `GET /marks` — same as `:mark:` validation.

### No mid-card agent swap

The **farmer** does not “hand off to navigator” inside one card. If the farmer finishes at the field and the chest is far away, either:

1. **Preferred:** a **`[NAV]`** card is **inserted** between farmer **done** and crafter **ready**, or  
2. **Fallback:** crafter turn-1 hits **`OUT_OF_RANGE`** / blocks with `needs_nav:<mark>` and the hook inserts nav (reactive).

Both keep **one agent = one card**.

### Transition hook (automatic, on the fly)

Run after **`kanban_complete`** (landfolk `post_tool_call`) and/or on **`@dispatcher`** tick before promoting the next card on the same **`metadata.bot`**:

```
inputs:
  bot          from completed card metadata.bot
  from_pos     handoff.exit_pos (else GET /status on bot HTTP)
  next_card    next ready/todo child on this bot lane for same epic (by depends-on graph)
  to_mark      next_card.metadata.work_at or parsed :mark: from body

if next_card is null or next_card.assignee == navigator:
  skip

if distance(from_pos, coords(to_mark)) <= R_near:   # e.g. 16–24 blocks, or goto-near “close enough”
  skip

insert:
  scripts/kanban create "[NAV] mox to :{to_mark}:" \
    --assignee navigator --epic <id> \
    --depends-on <completed_id> \
    metadata: { bot, work_at: to_mark, auto_leg: true, idempotency_key: "<completed>-leg-<to_mark>" }

rewire:
  depends-remove(next_card, completed_id)
  depends-add(next_card, new_nav_id)
```

**Who runs it:** deterministic **script** (dispatcher tick or plugin hook) — **not** planner LLM. Uses **`scripts/kanban depends-add/remove`**.

**Commands when the nav card runs:** **`navigator`** worker → **`mc goto` / `mc move`** toward `to_mark` (same as today’s nav pilot).

### When plans change mid-flight

| Situation | Behavior |
|---|---|
| **`[CLARIFY]`** changes mark or adds step | **Planner** edits **ready/todo** children; **archive** or cancel **ready** cards with `metadata.auto_leg=true` whose `work_at` no longer matches; hook re-runs on next complete. |
| **Stale nav** already **running** | Let it finish or preempt per URGENT rules; do not duplicate if `idempotency_key` matches. |
| **Rebind** bot mid-epic | New body: optional auto **`[NAV]`** to next `work_at` from **live** `/status`, not old handoff. |

Planner **does not** rewrite finished cards; it only adjusts the **DAG forward** from the first non-`done` node.

### Deposit-after-harvest (wheat example)

1. **`farmer`** completes at **`places.farm`**, handoff `exit_pos` = field.  
2. Hook sees next **`crafter`** `work_at` = **`places.deposit`** (`:chest_food:`), distance large.  
3. Inserts **`[NAV] mox to :chest_food:`** (`assignee navigator`).  
4. **`crafter`** runs adjacent to chest; **`mc deposit`** / chest verbs only.

If farm and chest share a base compound (`R_near` small), **no** nav card — crafter runs immediately after farmer.

### Reactive fallback (mc/bot)

If a work agent starts without a preceding leg (planner omitted hook, threshold too tight):

- Bundle **turn-1:** resolve mark; if `distance > reach`, **`kanban_block`** with `needs_nav:<mark_id>`.  
- Same hook on **`blocked`** event → insert **`[NAV]`**, **`depends-add`**, **`unblock`** after nav **done** (mirror repair-chain pattern in [`board-dynamics.md`](board-dynamics.md)).

Bot already returns **`OUT_OF_RANGE`** with `bot_position` in several actions — use that as signal.

### Design status

| Piece | Status |
|---|---|
| Handoff `exit_pos` on complete | **Spec** in bundles / [`impact.md`](impact.md); partial in runtime |
| Epic `places` / child `work_at` | **Spec** (this section); not in kanban metadata yet |
| Leg-insert hook | **Design**; natural home: landfolk `post_tool_call` + dispatcher |
| Mark coord resolver | **Today:** locations-base + `/marks` |
| Planner omits nav lines | **Doc** preference; templates should follow |

---

## After epic `done`

| Aftermath | Who | Output |
|---|---|---|
| Recall | workers during execute | `subject=wheat`, `type=resource` etc. ([`data-api.md`](data-api.md)) |
| Playbook merge | farmer doc card | `production/ingest/playbooks/wheat-rotation.md` — overseer approve |
| Judgment log | overseer | `operations/generated/epic-judgments.jsonl` |
| Compaction (later) | `[COMPACT] geo` | `geo/generated/worksites.json` |
| Script fix | `[BUG]` on back-office | `@engineer` MR if e.g. validate-farm-patch.py wrong |
| Recurring maint | planner/dispatcher preset | `[FARM]` / `[MAINT]` cards on schedule — **separate** from establish epic; inherit `metadata.bot` from preset |

---

## Related

- [`bots-and-mc.md`](bots-and-mc.md) — registry, spawn / `MC_*`, mutex  
- [`target.md`](target.md) — card flow summary  
- [`board-dynamics.md`](board-dynamics.md) — bind, mutex, rebind  
- [`hermes-agents.md`](hermes-agents.md) — profiles and L0–L3 layers  
- [`example-wheat-farm-walkthrough.md`](example-wheat-farm-walkthrough.md) — board timeline example  
