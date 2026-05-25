# Kanban + Work Assignment Cleanup Plan

**Status:** MVP implemented in hermescraft (2026-05-24). Stock Hermes + manual triage; live **Acceptance (MVP)** checklist below still needs a full in-game soak.
**Owner:** re44 + steward
**Created:** 2026-05-24
**Last updated:** 2026-05-24 (MVP landed; operator sync via `scripts/setup-landfolk-profiles.sh --apply-config`)

Companion: [docs/guides/hermes-platform.md](../guides/hermes-platform.md) — the broader Hermes platform strategy.

## Goal

Restore the landfolk kanban + work-assignment flow to **stock Hermes behaviour**, driven by agent prompts, skills, and a small purpose-built tool layer in this repo. Zero patches to Hermes framework code under `~/.hermes/hermes-agent/`.

The rule (architectural invariant from here on):

> **We do not patch Hermes. Hermes is updated regularly upstream and any local edits will be clobbered. We provide three layers — tools, skills, prompts — that live in this repo. Agents express landfolk behaviour through those layers; Hermes is the platform.**

## Recap (why this plan exists)

Over a 24 h period we tried to make the kanban flow do what we wanted by patching Hermes itself + adding helper daemons. It broke in subtle ways:

- Focus-hint contradicting orchestrator prompt (Steward chopped wood).
- Pull-router deadlock + 24 min silent gateway hang.
- Per-profile DB path divergence (Steward saw empty board).
- `inactive-cards-pauser` re-routed cards Steward was about to assign.

The fix is structural: roll back framework patches; express the same intent via repo-side tools, skills, prompts. Anything beyond that is hardening, not cleanup, and lives in the **Backlog** below.

## Decisions (locked)

| Tag | Decision |
|-----|----------|
| **D1** | Flint/Mason runtime: **kanban-only** (gateway dispatch). Continuous self-pull is deferred to backlog. Steward stays continuous. |
| **D2** | `auto_decompose: false` — triage cards **stay in `triage`** until Steward moves them. |
| **D3** | `kanban_*` patch tools: Steward shells out to `hermes kanban` CLI via terminal. No local patch. Upstream the 3 tools as a separate, optional effort. |
| **D4** | Steward cycle: bumped to **≥60 s** (from `sleep 5`). Hardcoded for MVP; env-tunable later. |
| **D5** | SOUL source-of-truth principle: `prompts/landfolk/<name>.md` is canonical. Automated sync between prompt files and profile SOUL is backlog. |
| **D6** | Auto-recovery: handled by Steward’s continuous loop for content decisions; structural failure detection is backlog. No new daemons in the MVP. |

## Target architecture (MVP shape)

```text
                ┌────────────────────────────────────────┐
                │  Operator (re44)                       │
                │  - drops triage via dashboard          │
                │  - reviews escalations on `re44` lane  │
                └───────────────┬────────────────────────┘
                                │
                ┌───────────────▼────────────────────────┐
                │  Hermes Gateway (UNMODIFIED)           │
                │  - kanban dispatcher                   │
                │  - auto_decompose: false               │
                │  - dispatches `ready` + assignee only  │
                └───────────────┬────────────────────────┘
                                │
        ┌───────────────────────┼────────────────────────┐
        │                       │                        │
  ┌─────▼─────┐           ┌─────▼─────┐            ┌─────▼─────┐
  │  Steward  │           │   Flint   │            │   Mason   │
  │ continuous│           │  kanban   │            │  kanban   │
  │ (≥60 s    │           │  worker   │            │  worker   │
  │  cycle)   │           │ ephemeral │            │ ephemeral │
  └─────┬─────┘           └─────▲─────┘            └─────▲─────┘
        │                       │                        │
        │   assigns explicit    │  dispatcher spawns     │
        │   assignee=flint/…    │  one process per       │
        │   on every `ready`    │  ready card            │
```

**Key behavioural rules:**

- **Steward is the only thing that assigns work.** Triage cards come from re44 / chat listener; Steward promotes to `ready` with an explicit assignee.
- **Workers are kanban-only**, dispatched ephemerally for each ready card. They use kanban tools (`kanban_show`, `kanban_complete`, `kanban_block`) for lifecycle — not the CLI.
- **No unassigned ready cards.** Steward’s job to keep the invariant; the framework will not route them.
- **No new daemons.** Pauser/supervisor stop being default-started; Steward’s loop is the only recovery in MVP.

---

## Lean MVP — “Patch-free stable Steward loop”

Six implementation phases (0–6). Work **one phase at a time**: implement → run that phase’s verification → **commit in this repo** before starting the next. Phases are ordered so each commit stays reviewable and revertable with `git revert`.

**Branching:** a single branch (e.g. `kanban-flow-cleanup`) with sequential commits is fine; merge to main when Acceptance (MVP) passes. Phase 4 includes a **local operator step** on `~/.hermes/hermes-agent` that is not committed to hermescraft — record it in docs or devlog in the same commit that updates operator instructions.

**Do not commit:** contents of `~/.hermes/hermes-agent/`, `~/.hermes/config.yaml`, or secrets. Phase 0’s patch file lives under `reports/expedition/` in this repo.

## Phase 0 — Snapshot before reverting

**Files:** `reports/expedition/2026-05-24-hermes-framework-patches.patch` (new)

```bash
git -C ~/.hermes/hermes-agent diff HEAD \
  > reports/expedition/2026-05-24-hermes-framework-patches.patch
```

**Why:** keeps a copy of the local patches in case a future upstream contribution re-derives them.

**Commit (optional):** if the patch file is added to the repo:

```text
Record Hermes kanban framework patch snapshot for landfolk cleanup.

- Add reports/expedition/2026-05-24-hermes-framework-patches.patch from local hermes-agent diff
```

## Phase 1 — Stop Steward acting like a worker

**Files:** `scripts/landfolk-control.sh`

**Anchor symbols** (line numbers drift; search these strings):

| Symbol | Location (approx.) | Issue |
|--------|-------------------|--------|
| `Steward) role="orchestrator"` | ~863 | Role gate for all items below |
| `starter_cmds=` Steward branch | ~879–882 | Already kanban-first (no `mc goals`) — keep as-is |
| `continue_prompt_full` orchestrator block | ~900–918 | Pull-router text in bullet list (~911) |
| `continue_prompt_minimal` orchestrator | ~920 | “pull-router routes” |
| `hermes chat … -s minecraft-goals` | ~1023, ~1046, ~1056 | Applies to **Steward round 1 and continues** today |
| `Current focus hint:` | ~1036–1037 | Appended on minimal continue rounds when `CONTEXT_MINIMAL_CONTINUE=true` — **including Steward** |
| `for blocked_cmd in curl … python3` | ~950–960 | Same stubs for all roles; blocks `scripts/roster.py` for Steward |
| `sleep 5` end of agent loop | ~1077 | All roles; bump for orchestrator only |
| `/Users/foz/.local/bin/hermes chat` in `awk` | ~1143, ~1152 | Hardcoded path in orphan-agent kill logic |

**Changes:**

1. **Focus hint:** when building `continue_prompt_round`, append `Current focus hint:` only if `role != orchestrator` (~1033–1038).
2. **Starter:** no change needed for Steward starter (already omits `mc goals`).
3. **`hermes chat` flags:** branch on `$role` — orchestrator drops `-s minecraft-goals` on **all** invocations (round 1 ~1023 and continue ~1046/1056). Consider `-t terminal,memory,skills` for Steward so profile kanban/skills load; workers keep `-t terminal,memory -s minecraft-goals`.
4. **Continue text:** in orchestrator `continue_prompt_full` (~911) and `continue_prompt_minimal` (~920), remove pull-router / default-unassigned language. Replace with explicit assign after `scripts/roster.py --assignable` (Hermes profile names: `flint`, `mason`, `gatherer` — lowercase, not display names like `Flint`).
5. **Cycle sleep:** after each round, `sleep 60` when `role=orchestrator`, else keep `sleep 5` (~1077).
6. **PATH:** build `restricted_bin` stubs only for `role=worker` (or skip `python`/`python3` stubs for orchestrator) so Steward can run `python3 scripts/roster.py` and blueprint scripts.
7. **Orphan kill:** replace hardcoded `/.local/bin/hermes chat/` match with a pattern using `command -v hermes` or generic `hermes chat` (~1141–1158).

**Verification:**

- Steward agent log (`/tmp/hermescraft/agent-steward.log` by default): round 1 query has no `mc goals`; no `task_start collect` in following tool output.
- `mc task_status` on Steward’s bot API port (`data/agent-models.json` → Steward `api_port`, default **3005**) reports idle across several cycles.
- From Steward’s session, `python3 scripts/roster.py --assignable` succeeds.
- Timestamp delta between consecutive “round=N agent=Steward” log lines ≥ 60 s.

**Commit:** after verification:

```text
Stop Steward continuous loop from inheriting worker goal prompts.

- Gate focus hint and minecraft-goals skill to worker role only
- Orchestrator continue text drops pull-router wording
- 60s sleep between Steward rounds; allow python3 for roster on Steward PATH
- Use generic hermes path in orphan agent kill logic
```

## Phase 2 — Make `auto_decompose: false` the default, and keep it

**Files:** `scripts/setup-landfolk-profiles.sh`, `~/.hermes/config.yaml`

**Changes:**

1. `patch_kanban_config` (~L514–558), `want` dict (~L526–531): set
   - `auto_decompose: false`
   - `auto_decompose_per_tick: 0`
   - keep `orchestrator_profile: steward`
   - remove `default_assignee` from `want` (triage stays unassigned until Steward assigns).
2. **Fix merge precedence** at ~L551: today `merged = {**existing, **want}` lets `want` overwrite operator edits. Prefer `{**want, **existing}` for keys operators should win on (`auto_decompose`, `auto_decompose_per_tick`), or skip overwriting when `existing` already defines them.
3. Have `--apply-config` call `patch_kanban_config` (today ~L577–579 skips it — silently incomplete).

**Verification (D2):**

- Run `scripts/setup-landfolk-profiles.sh` (not `--apply-config` alone until step 3 ships).
- Confirm `grep -A5 '^kanban:' ~/.hermes/config.yaml` shows `auto_decompose: false` (Hermes CLI key names vary by version; the file is the source of truth).
- Create a no-assignee triage card; wait 5 min; `hermes kanban --board landfolk-ops show <id>` still `triage`, no decomposer lines in `/tmp/hermescraft/gateway.log`.
- Run `--apply-config` again — `auto_decompose` stays `false`.

**Commit:** after verification. Run `scripts/setup-landfolk-profiles.sh` on the operator machine so `~/.hermes/config.yaml` updates locally; that file is **not** part of the git commit.

```text
Default landfolk kanban config to manual triage (auto_decompose false).

- setup-landfolk-profiles.sh sets auto_decompose false and fixes merge clobber
- apply-config runs kanban block so profile sync stays complete
```

## Phase 3 — Single triage path (chat listener)

**Files:** `scripts/steward-chat-listener.py`

**Changes:**

1. Default **`AUTO_DECOMPOSE=0`**: module default ~L42 and docstring ~L26 (`default 1` → `default 0`).
2. `decompose()` (~L121–131) stays gated; no call when default is 0 (~L185).
3. Update triage card body text (~L96) if it still tells Steward to “decompose into worker cards” via auto-fanout — ingress-only wording.
4. Docstring: chat listener is **ingress only**; Steward’s continuous loop decomposes.

**Verification:**

- `@steward test mining` in-game → one `triage` card assigned to `steward`, no children, no `kanban decompose` log line.

**Commit:**

```text
Chat listener creates triage only; disable default auto decompose.

- AUTO_DECOMPOSE defaults to 0 in steward-chat-listener.py
- Ingress-only docstring and triage card body wording
```

## Phase 4 — Revert Hermes framework patches

**Files:** `~/.hermes/hermes-agent/` (operator step, not in repo)

```bash
git -C ~/.hermes/hermes-agent checkout HEAD -- \
  gateway/run.py \
  hermes_cli/kanban_db.py \
  hermes_cli/kanban_decompose.py \
  tools/kanban_tools.py
# Match landfolk’s gateway lifecycle (scripts/landfolk cmd_start):
hermes gateway run --replace
```

**Verification:**

- `git -C ~/.hermes/hermes-agent diff HEAD` is empty.
- Steward uses `hermes kanban assign`, `hermes kanban reassign`, `hermes kanban archive` via terminal (D3). Confirm subcommands exist on your Hermes version (`hermes kanban --help`); adjust skill text if a verb is named differently upstream.
- D2 verification re-runs and still passes.

**Commit (hermescraft only):** document the operator step; no Hermes tree in git.

```text
Document reverting local Hermes kanban patches for landfolk ops.

- kanban-flow-cleanup Phase 4 operator commands and verification
- hermes-platform.md note on stock dispatcher after revert
```

Operator runs the `git checkout` and `hermes gateway run --replace` commands locally before or immediately after this doc commit.

## Phase 5 — Strip pull-router language from prompts/skills

**Files (search `pull-router`, `pull-model`, `auto_decompose: true`):**

| File | What to fix |
|------|-------------|
| `prompts/landfolk/steward.md` | § “The pull-model contract” (~L26–49): null assignee / pull-router |
| `skills/minecraft-steward-survey.md` | § “Prefer pull over assign” title (~L101) is mostly OK; delete pull-router lines (~L247–270). Keep explicit roster routing (~L108–120). |
| `docs/design/phase-3/steward-mvp.md` | Example kanban block (~L195–200); triage note (~L102) referencing auto_decompose |
| `scripts/setup-landfolk-profiles.sh` | `soul_for_worker` (~L176–248): `hermes kanban show/complete` CLI → kanban **tools** for dispatched workers. `soul_for_steward` (~L251–274): `[SUPERVISE]` from `steward-supervisor.py` — align with Phase 6 (supervisor off by default; blocked cards via Steward loop). |
| `docs/guides/hermes-platform.md` | Already targets manual triage; skim after Phase 5 for any stale CLI/tool wording. |
| `scripts/readme.md` | Daemon table (~L73): note pauser/supervisor no longer default-on after Phase 6. |

**Changes (text-only; structural SOUL split is backlog B-A):**

1. Steward continuous prompt (`steward.md`): every promoted `ready` card has explicit assignee from `scripts/roster.py --assignable`; Hermes assignee = lowercase profile name (`flint`, not `Flint`).
2. Survey skill: remove pull-router paragraphs; retain roster-based routing and re44 escalation lane.
3. `steward-mvp.md`: document `auto_decompose: false`, optional removal of `default_assignee: steward` if triage should stay unassigned until Steward acts.
4. Profile SOUL heredocs: worker lifecycle via **`kanban_show` / `kanban_complete` / `kanban_block`** (dispatched workers). Steward continuous loop uses **`hermes kanban`** CLI (D3).

**Verification:**

- `rg 'pull-router|pull-model' prompts/ skills/ docs/design docs/guides docs/features --glob '!**/archive/**'` returns no hits.
- Steward’s next session uses explicit `hermes kanban assign`, not null assignee promotion.

**Commit:**

```text
Align Steward prompts and skills with explicit kanban assignment.

- Remove pull-router language from steward.md and steward-survey skill
- Update steward-mvp kanban config example and setup SOUL heredocs
- Worker SOUL references kanban tools; Steward uses hermes kanban CLI
```

After commit, run `scripts/setup-landfolk-profiles.sh --apply-config` locally to push SOUL changes into `~/.hermes/profiles/`.

## Phase 6 — Daemon defaults stop launching pauser/supervisor

**Files:** `scripts/landfolk` (header comment ~L12–12, `cmd_start` ~L452–572, `usage()` ~L2–47)

**Changes:**

1. `cmd_start` initial flags (~L458): set `with_supervisor=0`, `with_pauser=0` (today both default **1**). Keep `with_listener=1`, `with_gateway=1`.
2. Update file header “DAEMONS” line to document new defaults (listener on; supervisor/pauser opt-in).
3. Keep `--without listener|supervisor|pauser|…` and `--no-supervisor` / `--no-pauser` working. Optional: if operator passes `--without pauser` or starts supervisor manually, print a one-line deprecation notice (MVP nice-to-have).
4. `usage()` / `scripts/readme.md`: document defaults. Pauser remains in repo for manual debugging (`python3 scripts/inactive-cards-pauser.py`) until backlog B-C deletes it.

**Verification:**

- `scripts/landfolk start` then `scripts/landfolk status`: listener + gateway up; no PIDs for `inactive-cards-pauser.py` or `steward-supervisor.py`.
- Pidfiles absent: `/tmp/hermescraft/state/inactive-cards-pauser.pid`, `/tmp/hermescraft/state/steward-supervisor.pid` (paths from `LOG_DIR` / `STATE_DIR` in `scripts/landfolk` ~L45–46).

**Commit:**

```text
Stop default-starting pauser and supervisor daemons on landfolk start.

- cmd_start defaults supervisor and pauser off; listener and gateway unchanged
- Update landfolk header, usage, and scripts/readme daemon table
```

---

## Execution checklist (MVP steps 0–6)

Repo work for steps 0–6 is **done** (single commit on `experiment/hermes-agents`). Use this table when reverting or re-auditing.

| Step | Phase | Repo changes | Verify (short) | Done |
|------|-------|--------------|----------------|------|
| 0 | Snapshot | `reports/expedition/2026-05-24-hermes-framework-patches.patch` | patch non-empty if Hermes was patched | yes |
| 1 | Steward engine | `scripts/landfolk-control.sh` | Steward log: no worker goals; roster.py works; ≥60s cycles | yes |
| 2 | Kanban config | `scripts/setup-landfolk-profiles.sh` | `auto_decompose: false`; merge preserves operator keys | yes |
| 3 | Chat ingress | `scripts/steward-chat-listener.py` | @steward → triage only by default | yes |
| 4 | Stock Hermes | `docs/guides/hermes-platform.md` ops checklist; operator reverts `~/.hermes/hermes-agent` | empty `git diff` in hermes-agent | yes (docs + operator) |
| 5 | Prompts/skills | steward prompt, survey skill, SOUL heredocs, steward-mvp | `rg pull-router` clean on live docs | yes |
| 6 | Daemon defaults | `scripts/landfolk`, `scripts/readme.md` | `landfolk start` → no pauser/supervisor by default | yes |

After deploy, walk through **Acceptance (MVP)** on a live session. If `~/.hermes/config.yaml` still has `auto_decompose: true` from an older setup run, set `false` once — later `--apply-config` merges preserve operator values (`{**want, **existing}`).

**Revert strategy:** each commit should be one logical revert (`git revert <sha>`). If Phase 4 docs landed before the operator reverted Hermes, revert order still works; re-apply local patches only if you intentionally roll back the whole effort.

---

## Acceptance (MVP)

- ✅ `git -C ~/.hermes/hermes-agent diff HEAD` is empty.
- ✅ Steward’s continue prompt never contains `Current focus hint:`; `mc task_status` reports Steward idle.
- ✅ `kanban.auto_decompose: false` survives a re-run of `setup-landfolk-profiles.sh` (full or `--apply-config`).
- ✅ A no-assignee triage card stays in `triage` for ≥5 min.
- ✅ Chat listener default `AUTO_DECOMPOSE=0`; no `kanban decompose` calls in normal operation.
- ✅ Workers run via gateway dispatch with explicit assignees; zero unassigned `ready` cards in a 1 h soak.
- ✅ `landfolk start` does not auto-start pauser or supervisor.
- ✅ `rg pull-router prompts/ skills/` returns no live hits.
- ✅ `hermes update` can be applied without breaking landfolk; the only post-update step is re-running profile sync to refresh bundled skills.

## Side-effects to verify (MVP)

| Side-effect | Where | Mitigation |
|-------------|-------|------------|
| Setup script clobbers `auto_decompose` | `scripts/setup-landfolk-profiles.sh` L514–558 | Phase 2 |
| `--apply-config` skips kanban merge | Same file ~L577 | Phase 2 |
| Hardcoded `/Users/foz/.local/bin/hermes` | `landfolk-control.sh` ~L1143, ~L1152 (orphan kill) | Phase 1 item 7 |
| Round 1 Steward still loads `minecraft-goals` | `landfolk-control.sh` ~L1023 | Phase 1 item 3 |
| `CONTEXT_MINIMAL_CONTINUE` + focus hint on Steward | ~L1034–1037 | Phase 1 item 1 |
| Catalog probe shows OFFLINE for unstarted bots | `scripts/roster.py` | Steward’s skill already filters via `--assignable`; backlog covers `--session` |
| `MC_USERNAME=Flint` vs Hermes profile `flint` | `landfolk-control.sh` L532 | Steward SOUL/skills already use lowercase; document explicitly in Phase 5 |
| Existing triage cards may be mid-decompose | After Phase 2 | One-time sweep; archive or re-triage as appropriate |

---

## Related docs and tests to update

There are **no automated tests** in this repo that assert kanban routing, daemon defaults, or Steward continue prompts. MVP verification is **manual** (log inspection + board state) unless you add checks below.

### Documentation (by phase)

| Phase | Docs |
|-------|------|
| 0 | Optional note in `reports/expedition/2026-05-24-session-handover.md` pointing at the patch file (historical; do not rewrite archive narratives). |
| 1–6 | `docs/guides/hermes-platform.md` — ops checklist, Steward vs worker runtime, daemon defaults after Phase 6. |
| 2, 5 | `docs/design/phase-3/steward-mvp.md` — kanban config block and triage workflow (~L102, ~L191–203). |
| 5–6 | `scripts/readme.md` — landfolk daemons table and `landfolk start` behaviour. |
| 5 | `docs/README.md` — index row for this plan (see repo index). |
| 4 | Short operator note in `docs/guides/hermes-platform.md` or devlog: “revert local Hermes patches” step. |

Leave **`docs/archive/**`**, expedition postmortems, and **`reports/expedition/*.md`** unchanged unless you add a one-line “superseded by kanban-flow-cleanup” link.

### Tests and fixtures (optional, not required for MVP)

| Opportunity | Where | Idea |
|-------------|-------|------|
| Shell smoke | New `scripts/test-kanban-mvp.sh` or `bot/test/` | Grep `landfolk-control.sh` for orchestrator: no `minecraft-goals` on Steward branch; no `Current focus hint` without role gate (static analysis). |
| Config merge | Small test around `patch_kanban_config` Python heredoc | Extract to function + assert `auto_decompose: false` does not clobber existing false (Phase 2). |
| Agent tests | `docs/guides/agent-tests.md`, `data/agent-tests/` | No change required for MVP; G21-style tests assume **continuous** Flint/Mason — orthogonal to kanban-only workers (D1). |
| CI | `docs/guides/testing.md` | Add a “Landfolk kanban MVP” manual checklist referencing Acceptance (MVP) above if operators want a repeatable ritual. |

### Runtime paths (conventions)

| Concept | Default path |
|---------|----------------|
| Logs / roster | `/tmp/hermescraft/` (`LOG_DIR`) |
| Pidfiles | `/tmp/hermescraft/state/` (`STATE_DIR`) |
| Gateway log | `/tmp/hermescraft/gateway.log` |
| Continuous agent home | `~/.hermes-landfolk-<name>/` (lowercase name) |
| Kanban profiles | `~/.hermes/profiles/{flint,mason,gatherer,steward}/` |
| Board DB | `~/.hermes/kanban/boards/landfolk-ops/kanban.db` (pinned in `landfolk-control.sh` via `HERMES_KANBAN_DB`) |

Bot display names in `data/agent-models.json` use capitalized keys (`Flint`, `Steward`); **kanban assignees** must match Hermes profile slugs from `scripts/setup-landfolk-profiles.sh` (`flint`, `mason`, `steward`, …).

---

## Known upstream limitations + landfolk workarounds

### L1. No per-assignee concurrency cap (stock Hermes ≤ v0.13)

**Symptom (2026-05-24 incident):** gateway-embedded dispatcher tick at 20:06 spawned 12 workers in one shot — 6 flint + 5 mason against 2 bot HTTP APIs. Workers serialized on shared bot state, sessions logged `Pos:null,66,null` / `NAV_BLOCKED from NaN,66.0,NaN`. Flint bot died; cascade auto-blocked 13 cards via `failure_limit=2` over 30 min before quiescing.

**Stock cap available:** `kanban.max_spawn` — global concurrency across the board. We set `max_spawn: 3` (one per online bot). Verified honored by gateway dispatcher at boot.

**Stock cap NOT available:** per-assignee / per-bot. The dispatcher loop in `hermes_cli/kanban_db.py:dispatch_once()` iterates ready cards by `priority DESC, created_at ASC` and spawns until the *global* cap is hit — it will happily spawn 3 workers for the same assignee. A `max_in_progress` parameter exists in the function signature as of v0.14 but is **unwired** (no config key reaches it).

**Upstream tracking:**
- [NousResearch/hermes-agent#29034](https://github.com/NousResearch/hermes-agent/issues/29034) — "Kanban defaults can auto-launch unbounded paid worker swarms across all boards" (same failure class)
- [NousResearch/hermes-agent#28805](https://github.com/NousResearch/hermes-agent/issues/28805) — "no config key for a worker concurrency cap (`max_spawn` only reachable via CLI)" — calls out `max_in_progress` as the unwired internal parameter

**Landfolk workaround (Option A — Steward per-bot mutex):** `prompts/landfolk/steward.md` § "Per-bot mutex" requires Steward to count `{ready, running}` for an assignee before promoting `todo → ready`. If ≥1, the card stays in `todo` until the bot's current card finishes. Combined with `max_spawn: 3`, this caps concurrency at 1 per bot at the orchestration layer — no framework patch.

**Sunset condition:** when #28805 lands and exposes `kanban.max_in_progress: 1` to the gateway-embedded dispatcher, delete the Steward mutex rule and rely on the stock cap.

---

## Backlog (deferred hardening)

These were in earlier drafts and remain valuable, but **don’t block** stable operations. Pull from this list one at a time, after the MVP has been running boring for ≥1 week.

### B-A. SOUL split into two prompt trees

`prompts/landfolk/<name>.md` (continuous) vs `prompts/landfolk/profiles/<name>.SOUL.md` (dispatched worker), with `scripts/setup-landfolk-profiles.sh` reading both instead of embedding heredocs. Add `--apply-config --check` to detect drift.

**Why deferred:** valuable for contributor ergonomics but doesn’t change runtime behaviour. Phase 5 keeps both heredoc and prompt file in sync manually for the MVP window.

### B-B. `STEWARD_CYCLE_S` / `LANDFOLK_WORKER_CYCLE_S` env tunables

Replace the Phase 1 hardcoded `sleep 60` with a documented env var read by `scripts/landfolk-control.sh` and surfaced in `scripts/landfolk usage()`.

**Why deferred:** Phase 1 already fixes the noisy 5 s default; per-session tuning is an ergonomic improvement, not a stability requirement.

### B-C. Deterministic board-health monitor

`scripts/board-health.py` (~150 LOC) — no LLM. Signals:

- `triage` age > 10 min → `kanban_comment @steward stale-triage`.
- `ready` + assignee not assignable → comment + `[HEALTH]` card.
- Same block-reason prefix on ≥2 cards in 30 min → `[BUG]` to re44.
- No Steward process AND blocked > 0 → `[HEALTH]` to re44.
- Gateway unresponsive → stderr + `[HEALTH]`.

Idempotent state in `~/.landfolk-board-health-state.json`; one alert per condition per hour. Hard rules: does **not** reassign, does **not** decompose, does **not** create planning cards. After it ships, delete `inactive-cards-pauser.py`.

**Why deferred:** Steward’s continuous loop handles structural failure in the happy path. Add this only when Steward downtime / offline-assignee deadlocks become a real-world pain point.

### B-D. Supervisor → watchdog

Rename `scripts/steward-supervisor.py` → `scripts/steward-watchdog.py` and reduce it to a process watchdog: restart Steward’s continuous loop if its PID dies. Strip the `[SUPERVISE]` card creation.

### B-E. `roster.py --session` mode

Add a flag that intersects the catalog (`data/agent-models.json`) with `/tmp/hermescraft/active-players` so Steward’s “assignable” check matches the current session, not the full catalog. Drop the legacy `active-profiles` shim once nothing reads it.

### B-F. Upstream `kanban_*` tools

Contribute to Hermes adding `kanban_unlink`, `kanban_archive`, `kanban_reassign` as first-class tools. Reference the snapshot from Phase 0. When merged upstream, swap Steward’s skill text from CLI calls back to the tools.

### B-G. Continuous worker pull (was “Phase 11”)

Add a self-pull stanza to worker continue prompts: `hermes kanban list --assignee <self> --status ready` → claim → run → loop, with a guard against duplicate dispatcher spawn. Revisit only when sustained queue depth justifies the LLM cost.

---

## Out of scope

- Bug fixes unrelated to routing layering (combat held-item swap, crafting shortfall fast-fail, LOS-gated flee, gateway-detection helper) — those stay regardless.
- Operator UX (status display, log aggregator, chat-in-game-from-CLI).
- Mineflayer bot internals.
