# Phase-12 establish replay — postmortem

**Date:** 2026-06-03 19:18 – 20:13 local (~55 min run)
**Run ID:** `phase12`
**World:** proc-lab, seed=1001
**Fleet:** Steward, Flint, Mason, Gatherer (Barley not started)
**Models:** main `deepseek/deepseek-v4-flash:exacto`; aux compression `google/gemini-2.5-flash` → `flash-lite` → `flash-lite-preview-09-2025` (patched mid-run)

**Outcome:** Epic `t_b652205c [ESTABLISH:BASE]` ended **4/6 done · 1 in-flight · 1 ready**. All four EXPLORE cards closed; Mason's CONSTRUCT pad card never started building. Two cards filed against re44 (one valid, one hallucinated).

---

## Timeline (key events)

| Time | Event |
|------|-------|
| 19:18 | Boot — bots TP to muster (4,77,24); first round=1 starts on 300s timeout |
| 19:21 | Dispatcher spawns 3 kanban workers (Flint NE, Mason NW, Gatherer SE) |
| 19:23 | First round 142 timeouts on all four agent-loops (SIGALRM at 5 min); rounds restart |
| 19:29 | **Steward round 3 hallucinates role-gate deny** → files `t_aaff40ca [BUG] mc role-gate blocks ALL verbs for steward` against re44 (agent-steward.log L2602–2744). False — only field verbs were denied. |
| ~19:32 | **Patch 1 applied**: compression threshold/target_ratio raised from `0.2/0.2` to `0.7/0.3` after observing 41+ compressions per worker in 11 min |
| 19:34 | Mason NW closes cleanly (37 compresses pre-patch); claims SW (pid 32416 — new threshold, old aux model) |
| 19:37 | **Patch 2 applied**: aux model centralised in `data/agent-models.json`; switched `gemini-2.5-flash` → `flash-lite` |
| ~19:40 | Patch tuned: `flash-lite` → `flash-lite-preview-09-2025` |
| 19:45–46 | Gatherer SE (55 compresses, pre-patch) and Flint SW-supplement close |
| 19:53 | Mason SW closes (10 compresses, post-threshold); claims CONSTRUCT `t_0cf9e920` (worker pid 92827, all patches) |
| 19:55–20:12 | **Mason loops on CONSTRUCT** at pos (-20,70,-2), 6+ min frozen with `recent=[goto_near:error, move:done, pillar_step:done, move:error]` (progress-mason.log L226–270) |
| 19:54 | Operator whisper #1 sent via Gatherer body: "try pillar_up 7" |
| ~19:57 | **Steward round 9 correctly identifies Mason as PHYSICALLY_STUCK** (agent-steward.log L5358) and runs `kanban reassign t_0cf9e920 gatherer` (L5556–5562). Reassign ineffective — see root cause #1 |
| 20:08 | Operator whisper #2 sent (Gatherer body): `mc reachable + place dirt + compare best_stand` |
| ~20:10 | Steward files second blocked card `t_e3608ec3` (the gatherer pickup also auto-stuck) |
| 20:13 | Operator stops fleet for postmortem |

---

## Root causes

### 1. Reassign-without-reclaim leaves a zombie worker holding the mutex
At 19:57 Steward correctly diagnosed Mason as stuck and reassigned `t_0cf9e920` to Gatherer. **But Mason's kanban worker process (pid 74713) kept the card lock** because Steward used `kanban reassign` only — not `kanban reclaim --force` to break the lock or kill the worker first (agent-steward.log L5751–5816). Gatherer then tried to pick up the card and hit the same physical stuck pattern; the card re-BLOCKED (board-final L13). The reassign path is missing a reclaim step.

### 2. Steward hallucinated the role-gate "bug"
At round 3 (~19:29) Steward called a forbidden field verb, got the structured deny message — which *lists the allowed read-only verbs in prose* — and **misread the list as also being denied** ("observe, status, scene, inventory all blocked"). She filed `t_aaff40ca [BUG] mc role-gate blocks ALL verbs for steward` and used that belief to justify NOT calling `mc chat` or `mc observe` for the rest of the run (agent-steward.log L5374, L5865–5899).

The gate is correct. Verified by independent code read:
- `bot/lib/server/middleware/orchestrator-mc-allowlist.js:30-39` — proper allowlist semantics, JSON-loaded at module init
- mc-steward.log: zero denies on `observe`, `status`, `inventory`, `scene`, `terrain_top`, `chest_search`, `chat`, `map` — all returned **200**
- Only field verbs (`move`, `dig`, `collect`, `equip`, `bg_collect`, `pillar_up`, `goto_near`, `find_blocks`) hit 403, which is the intended behavior

### 3. Mason never calls `mc reachable`, never reads chat
Mason's whole stuck loop is mechanical: `pillar_step → move → goto_near → terrain_top`, retry. Across the 16-minute stuck window:
- **`mc reachable` calls: 0** on CONSTRUCT (was 1 on SW, 0 on NW)
- **`mc read_chat` calls: 0** across the entire session (nav-mason.jsonl). Operator's two whispers landed in chat but Mason never read them.
- `PILLAR_FAILED` is a known timing race (skills/kanban-worker.md:516) that resolves on the second call — Mason hit it but didn't retry per the rubric
- AUTO_STUCK + stuck_warning at 15.4min fired and Mason acknowledged it (worker log L207, progress L273) — but he then immediately retried the same `mc move 4 77 26 --near 2` without changing tactic

The verbs `reachable` and `read_chat` are documented in `skills/minecraft-navigation.md:60,89,143` and `skills/minecraft-building.md:49,115,152` but **never tied to the stuck-recovery decision tree in kanban-worker.md**. They're vocabulary, not requirements.

### 4. Worker-routing bug — gatherer talking to steward's port
The blocked card `t_e3608ec3` worker log shows the gatherer worker connected to `MC_API_URL=http://localhost:3005` (Steward's port) instead of `:3001` (Gatherer's). Field actions routed to Steward's gated body got correctly 403'd, then the worker misdiagnosed it as a profile config bug. Likely root: a leaked env var or dispatcher mis-routing when the reassign happened. Needs deeper trace.

---

## What landed cleanly (mid-run fixes)

| Fix | Result |
|---|---|
| `establish-preflight.sh --skip-diagnostics` default | Run launched after first attempt aborted on stale-fleet diagnostics |
| Compression policy `0.7/0.3` (from `0.2/0.2`) | **73% drop in compression frequency** — Mason NW pre-patch 37 vs SW post-patch 10 on similar workload (kanban-worker-logs/*) |
| Aux model centralized in `data/agent-models.json` | `setup-landfolk-profiles.sh` clean of model strings; `patch-landfolk-compression-config.py` reads JSON; runtime YAML confirmed `model: "google/gemini-2.5-flash-lite-preview-09-2025"` |
| No OOM, summary failures, or context overruns observed |

---

## Open issues

| # | Issue | Severity | Where |
|---|-------|---|---|
| 1 | Reassign doesn't reclaim — zombie workers hold mutex | **HIGH** — blocks orchestrator's main rescue tool | Steward skill + `hermes kanban reassign` semantics |
| 2 | Mason missing required `mc reachable` + `mc read_chat` on stuck-detect | **HIGH** — operator whispers ignored, no path comparison | `skills/kanban-worker.md` rubric |
| 3 | Deny message lists allowed verbs in prose → Steward misreads as denied | **MEDIUM** — already filed as friction in runbook §8.4, recurred this run | `orchestrator-mc-allowlist.js` deny message + steward.md "deny reading" rubric |
| 4 | Worker routing: gatherer worker on `t_e3608ec3` connected to port 3005 | **MEDIUM** — corrupts post-reassign work | dispatcher env propagation or reassign codepath |
| 5 | Aux model centralization left `patch_compression_model` as dead code in `setup-landfolk-profiles.sh` | **LOW** — back-compat shim, no harm | cleanup later |
| 6 | False bug card `t_aaff40ca` and re-filed `t_e3608ec3` clogged board | **LOW** — needs operator triage when re-running |

---

## Recommended next steps (priority order)

1. **`reassign-and-reclaim` semantic in Steward skill** — when reassigning a stuck card, the orchestrator MUST first call `hermes kanban reclaim --force <id>` to break the prior worker's mutex, OR explicitly kill the worker PID. Codify in `skills/kanban-orchestrator.md`. Without this fix, the orchestrator cannot rescue a stuck worker — proven this run.

2. **Hard-wire stuck-recovery rubric in `skills/kanban-worker.md`** — on any `pillar_step:error`, on 2 identical `recent[]` tuples, OR on `stuck_warning`: MUST run (a) `mc read_chat 20`, (b) `mc reachable <target>`. If `target_standable=false`, navigate to `best_stand` instead of retrying the prior verb. Retrying without these probes is the anti-pattern.

3. **Re-word the orchestrator deny message** so it cannot be re-parsed as a global deny. Current format names allowed verbs in prose; switch to: `"<verb> denied for orchestrator profile. This verb is in the deny list — calling it does not affect other verbs."` Drop the allowed-list mention from the deny payload entirely; the SOUL/skill carries that.

4. **Trace the worker-routing bug** — capture `MC_API_URL` from the dispatcher spawn env for `t_e3608ec3` at reassign time. Likely a profile-env passthrough issue or a stale env in the orchestrator's reclaim/reassign code.

5. **Preserve the compression+aux-model wins** — both patches verified clean. Land the source changes (`scripts/patch-landfolk-compression-config.py`, `data/agent-models.json`, `scripts/setup-landfolk-profiles.sh`) on a commit, plus the runbook update already made.

6. **Eventually remove `patch_compression_model` shim** from `setup-landfolk-profiles.sh` once nothing depends on it externally.

---

## Fixes applied post-stop (2026-06-03)

Four orchestration-side fixes landed after the postmortem (Mason's body/stuck work is being tracked separately):

| # | Fix | Where | Tests |
|---|-----|-------|-------|
| 1 | `hermes kanban reassign` atomically reclaims any active claim (SIGTERM/SIGKILL host-local PID, clear lock, change assignee in one tx). `--reclaim` flag deprecated to no-op for back-compat. Fixes the Mason→Gatherer zombie-lock cascade (root cause #1). | `~/.hermes/hermes-agent/hermes_cli/kanban_db.py:reassign_task`, `hermes_cli/kanban.py` | 3 new tests in `tests/hermes_cli/test_kanban_core_functionality.py`: `test_reassign_task_atomically_reclaims_running_lock`, `test_reassign_running_with_live_lock_kills_host_local_worker`, `test_reassign_remote_host_lock_clears_db_but_skips_kill`. All 18 reassign+spawn tests green. |
| 2 | Worker-spawn env scrub: dispatcher's `_default_spawn` drops `_MC_API_URL_LOCKED`, `MC_API_URL`, `MC_USERNAME` from the child env before Popen. Profile `.env` re-establishes them. Fixes the gatherer-on-port-3005 routing leak (root cause #4). | `~/.hermes/hermes-agent/hermes_cli/kanban_db.py:_default_spawn` | 1 new test: `test_default_spawn_scrubs_leaked_mc_routing_env_vars`. |
| 3 | Orchestrator deny message no longer names allowed verbs in prose. Steward can no longer misparse it as a global deny. Fixes root cause #2 (the false `[BUG]` card cascade). | `bot/lib/server/middleware/orchestrator-mc-allowlist.js:orchestratorMcDenyReason`, `scripts/hermes-hooks/orchestrator-deny.sh:81` | All 16 bot gate tests + 57 hook regression tests still green (they pin only the `mc <verb> is denied` prefix). |
| 4 | `~/.hermes/config.yaml:kanban.max_spawn` raised from 3 → 5 (=workers+1 slack). A stuck worker holding a slot can no longer starve the ready queue. | `~/.hermes/config.yaml:560` | No code change. |

Steward skill (`prompts/landfolk/steward.md`) updated at L235 and L336 to reflect the new reassign semantics (`--reclaim` flag is no longer needed). All Hermes-upstream changes captured in `reports/expedition/2026-06-03-hermes-framework-patches.patch` for future replay / upstream PR.

**What's still open after these fixes:**
- Root cause #3 (Mason's missing `mc reachable` + `mc read_chat` on stuck-detect) — body/stuck work, separate track.
- Per-assignee multiple-claim cap — not exercised in phase-12 but a latent footgun (dispatcher's only cap is global `max_spawn`); follow-up if it ever surfaces.

## Files snapshot

All evidence preserved in `data/postmortems/establish-2026-06-03-phase12-fleet-logs/`:
- `agent-*.log`, `progress-*.log`, `mc-*.log`, `nav-*.jsonl`, `bot-*.log`, `watchdog-*.log` per profile
- `gateway.log`, `dispatcher.log`
- `kanban-worker-logs/{NE,SE,NW,SW,SW-suppl,CONSTRUCT,steward-blocked}.log`
- `board-final.txt`
