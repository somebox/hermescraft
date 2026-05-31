# Playbook pass — test procedure

Companion to [followup-improvement-pass.md](followup-improvement-pass.md) and the IDE execution plan.  
**Gates** must pass before the next wave. **Stubs** are listed explicitly — a failed stub run is not a product regression.

---

## Wave 1 — CI (gate)

```bash
cd bot && HERMES_VALIDATE=1 npm test

node --test \
  test/shared/envelope.test.js \
  test/runtime/nav-jsonl.test.js \
  test/playbook-phase-set.test.js \
  test/playbook-registry.test.js \
  test/middleware/hint-injector.test.js

node scripts/check-conventions.mjs
scripts/regenerate-artifacts.sh
```

Note: spell **`regenerate-artifacts.sh`** (not `genenerate`).

---

## Wave 2 — Stage 0 (gate)

```bash
scripts/stress.sh noop
scripts/nav-telemetry.py --live --playbooks --compliance
```

**Expected before any `playbook phase set`:** stderr shows `live rows: 0` (or only `(null)` playbook buckets), exit code **0**, compliance JSON with `null_playbook_context: 1.0` when there are sync rows but no phase context — not an error.

Optional baseline stub:

```bash
scripts/nav-telemetry.py g-2026-05-30-3 --baseline-turns g-2026-05-30-3
```

---

## Wave 2b — JSONL chokepoint sanity (gate before Stage 1 live verbs)

With a bot running and profile known (e.g. `Tester` → `nav-tester.jsonl`):

```bash
# Issue several sync mc calls — mix success (status) and failure (bad move) if possible
tail -10 "${HERMESCRAFT_TMP:-/tmp/hermescraft}/nav-<profile>.jsonl" | jq '.schema_version, .actionName, .ok'
# Every row: schema_version == 1, actionName set, ok is boolean (true on success, false on soft failure)
tail -10 "${HERMESCRAFT_TMP:-/tmp/hermescraft}/nav-<profile>.jsonl" | jq -e 'select(.schema_version != 1 or (.ok != true and .ok != false) or (.actionName | not))' && echo "BAD ROW" || echo "schema ok"
```

Every line must include **`schema_version: 1`**, **`actionName`**, and **`ok`** as a boolean (`true` for successful sync actions, `false` when the handler returned `ok: false`). A success row missing `ok: true` would silently skew A2 counterfactual math — fix the chokepoint before proceeding.

**Scope:** JSONL is emitted for **sync POST** actions routed through `dispatchAction` (`move`, `craft`, `playbook_phase_set`, etc.). **GET fast-paths** (`status`, `observe`, `inventory`, …) also append rows **during playbook/card-bound work** via `logReadNavTelemetry` so A2 preflight reads count in `--compliance`. Outside playbook spans, GET handlers stay silent in JSONL (idle polling does not inflate logs).

**Profile tag:** rows land in `nav-<config.mc.username>.jsonl` (lowercased). If you see `nav-unknown.jsonl`, the HTTP `servicesProxy` is missing `config` — a live-only failure mode.

---

## Wave 3 — Stage 1 live bot (gate)

Requires landfolk-test (or your bot world). **Not gates:** stress YAMLs under `data/agent-tests/playbooks/` for `advise-on-stuck`, `recipe-bed-variant`, `craft-post-56-blue-wool` are **stubs** until scenarios are fleshed out — do not treat a missing/empty agent-test run as a failed gate.

| Check | Command / action | Pass |
|--------|------------------|------|
| #54 advise | `mc advise --reason="test"` | ≤25s, no PyYAML warning on stderr |
| #56 craft | Multi-variant bed/wool case (see crafting tests) | Correct recipe / no wrong `MISSING_INGREDIENTS` |
| #58 header | `mc status` | Nav line includes `suggested_hint` when useful (e.g. single open dir) |
| **Hint injector** | See below | First failure gets hint; dedup documented |

Real `move` failures often already include `next_action_hint` (tunnel/escape), so live runs mostly exercise the **skip-when-present** branch. **Dedup TTL and per-profile keys:** `bot/test/middleware/hint-injector.test.js`.

### Hint injector (live)

```bash
mc move <X> <Y> <Z>   # known unreachable / NAV_BLOCKED
# JSON or human error line must include next_action_hint

mc move <same X Y Z>  # within 60s, same (profile, action, code) dedup:
                      # second response may omit injected hint (dedup) — document observed behavior
```

Unit coverage: `bot/test/middleware/hint-injector.test.js`.

---

## Wave 4 — Stage 2a-S (gate)

**Order discipline (documented behavior):**

```bash
# Fresh process: no task_context
mc playbook phase set wood.chop_tall_tree preflight
# → MUST fail: TASK_CONTEXT_REQUIRED (refuse; worker SOUL binds task_context first)

mc task_context set hut1 --card t_test   # worksite then flags (registry examples)
# also accepted: mc task_context set --card t_test hut1
mc playbook phase set wood.chop_tall_tree preflight
# → ok; JSONL rows gain playbook_id + phase

mc task_context set hut2 --card t_other  # different card_id
# → playbook_context auto-cleared (re- phase set from run_state for A3)
```

Kanban:

```bash
scripts/kanban create "x" --assignee flint --body $'playbook: not.real\n'
# → rejected at facade
```

Checklist: [docs/features/2a-S-checklist.md](2a-S-checklist.md).

---

## Wave 5 prerequisites (before A1 matrix)

1. **`mc task_context set` token order** — All of these must parse (see `bot/test/cli/dispatch.test.js`):
   - `mc task_context set hut1 --card t_test` (worksite first, registry example)
   - `mc task_context set --card t_test hut1` (flags first)
   - `mc task_context set --card t_test` (card bind only; landfolk-test chop fixtures)
   A parse failure (`missing_card_id` / `missing_worksite`) looks like a preflight discipline failure in agent logs — fix CLI before blaming the model.

2. **JSONL profile + tmp dir** — Rows must land in `nav-<config.mc.username>.jsonl` under `HERMESCRAFT_TMP` (not `nav-unknown.jsonl`). Requires `servicesProxy` to include `config` on the HTTP app and per-call `logDir()` in `metrics.js` (shipped in `c82e882` and later).

3. **Playbook skills in Hermes hub** — Agent tests pass `--skills playbook-wood-chop-tall-tree`, which Hermes resolves under `~/.hermes/skills/gaming/<name>/SKILL.md`, not the repo `skills/` tree. After editing playbook docs, run:

   ```bash
   scripts/regenerate-artifacts.sh
   ```

   That syncs registry docs → `skills/playbook-*.md` and mirrors each `playbook-*.md` into the hub when `~/.hermes/skills/` exists. `landfolk deploy` runs the same script before profile sync.

4. **JSONL read vs act verbs** — Sync POST actions always log. GET perceive verbs (`inventory`, `status`, `scene`, `nearby`, `observe`) log **only while** `task_context.card_id` or `playbook_context` is set (playbook-card work). A2 `--compliance` preflight-before-act uses timestamp order: a registry preflight read must appear in JSONL **before** the first non-preflight act in each phase span. A1 medians from agent-test JSON reports use `mc_cli_invocations`; do not use raw JSONL row totals as observation-rate unless GET logging is on.

---

## Wave 5 — 2a-V A1 / A2 / A3 (gate after matrix)

Specs and shared card bodies: `data/agent-tests/playbooks/includes/chop-oak-8/`.

| Scenario | Command |
|----------|---------|
| A1 (one arm) | `scripts/stress.sh chop-prose-vs-playbook --arm playbook` (also `prose-minimal`, `prose-skilled`) |
| A2 | `scripts/stress.sh chop-preflight-refusal` |
| A3 | `scripts/stress.sh chop-checkpoint-resume` |
| **A4 (2b)** | `scripts/stress.sh chop-composition` — tall trunk + `pillar_up_safe` sub-play; JSONL `sub_playbook_id`; **≥8 oak_log in chest (96,65,53)** |

**Visual layout (no test run):** `scripts/show-arenas.py` — builds A1–A4 side-by-side arenas + signs, parks Flint at overlook `(67, 70, 40)`.

### Wave 5 status (2026-05-31)

| Scenario | Regression gate | A1 hypothesis gate |
|----------|-----------------|-------------------|
| A2 preflight-refusal | **PASS** (n=1) | — |
| A3 checkpoint-resume | **PASS** (n=1) | — |
| A1 three arms | Runnable | **Closed — falsified** n=5; see [baseline-turns-fixture.md](baseline-turns-fixture.md) |
| A4 composition | Runnable | **Telemetry OK; Flash completion weak** (n=3, 0/3 chest ≥8) |

Production default for simple chop: **prose-skilled** card body (no `playbook:`). Do not re-run A1 matrix at Flash.

After playbook doc edits: `scripts/regenerate-artifacts.sh` (hub mirror).

---

## Wave 6 — Granularity lab

Primary spec: [`wave-6-granularity-lab.md`](wave-6-granularity-lab.md).

### W6-T1 (complete)

| Scenario | Command |
|----------|---------|
| Tower mini | `scripts/stress.sh tower-reuses-pillar-up-safe --arm prose-skilled` |

**Verdict:** Option C — prose-skilled default for simple vertical build; playbook medium/coarse not for Steward templates on column task.

### W6-T3 (platform — run next)

**Before matrix:** A2 + A3 regression:

```bash
scripts/stress.sh chop-preflight-refusal
scripts/stress.sh chop-checkpoint-resume
```

| Scenario | Command |
|----------|---------|
| Platform (one arm) | `scripts/stress.sh tower-platform-3x3 --arm prose-skilled` |
| Matrix | `prose-skilled`, `playbook-coarse`, `prose-skilled-resume` × n≥3 |

Requires live bot (Flint `:3001`), Hermes, OpenRouter. Model: `deepseek/deepseek-v4-flash:exacto`.

```bash
scripts/regenerate-artifacts.sh
```

Record results in `wave-6-granularity-lab.md` § W6-T3 Results.

**Visual:** `scripts/show-arenas.py` includes W6-T1/T3 slabs (east of chop row).

---

## Wave 6b — Regression spot-checks

Same as Wave 1 targeted `node --test` list, plus after doc edits:

```bash
scripts/regenerate-artifacts.sh
# playbook-registry.test.js asserts registry doc ↔ skills/playbook-*.md bytes match
```

---

## Stage 4 genesis (blocked)

See [data/genesis-runs/STAGE4-RUNBOOK.md](../../data/genesis-runs/STAGE4-RUNBOOK.md) and [CONTENT-TRACK.md](../../data/genesis-runs/CONTENT-TRACK.md). Requires Wave 5 + content sign-off.
