# Hermes 0.14 → 0.15.2 upgrade guide (hermescraft)

Canonical runbook for upgrading the local Hermes install hermescraft uses (`~/.local/bin/hermes`, pip — not the homelab Docker stack).

- **Design primitives** (what architecture docs cite): [`../architecture/hermes-v0.15-reference.md`](../architecture/hermes-v0.15-reference.md)
- **Homelab precedent:** same jump on 2026-06-04 (commit `0790725` in `~/homelab`). Extra context in homelab Claude memory: `feedback_hermes_docker_tag_format`, `feedback_hermes_env_files`.

**Current:** `hermes-agent v0.14.0 (v2026.5.16)` at `~/.local/bin/hermes`. **Target:** `v0.15.2 (v2026.5.29.2)`. Do **not** stop at v0.15.0 — dashboard 401 reload-loop and kanban worker SIGTERM regression. v0.15.1 fixes both; v0.15.2 fixes packaging (`plugin.yaml` in wheel/sdist).

Docker Hub tags are date-based, not semver. `gh release view --repo NousResearch/hermes-agent --json tagName` is authoritative.

## Version map

| Release | GitHub / Docker tag | Notes |
|---|---|---|
| v0.13.0 | `v2026.5.7` | Multi-agent kanban, zombie detection |
| v0.14.0 | `v2026.5.16` | PyPI install, cross-session cache — **hermescraft today** |
| v0.15.0 | `v2026.5.28` | Swarm, decompose, promptware — **avoid pinning** |
| v0.15.1 | `v2026.5.29` | SIGTERM + dashboard fixes |
| **v0.15.2** | **`v2026.5.29.2`** | **Target** — worker SIGTERM, `.md` delivery, packaging |

Pinning Docker image `v0.15.2` fails with "manifest unknown"; use the date tag from `gh release view`.

## Kanban CLI surface (post-upgrade)

Run `hermes kanban --help` and diff against what [`scripts/kanban`](../../scripts/kanban) and [`landfolk-dispatcher.sh`](../../scripts/landfolk-dispatcher.sh) assume. Notable v0.15 additions:

`swarm`, `daemon`, `watch`, `stats`, `notify-subscribe` / `notify-list` / `notify-unsubscribe`, `decompose`, `specify`, `context`, `gc`, `heartbeat`, `assignees`, `runs`, `diagnostics` / `diag`, native **`promote --ids`**.

Hermescraft still reads `kanban.db` directly in places — schema drift is the main break mode (see verification below). Swarm topology is **not** our model ([architecture target](../architecture/target.md)).

## TL;DR

- Mechanical upgrade is ~30 minutes. Verification is the work — most risk is in the kanban facade's raw SQL and the worker prompt surface.
- Three things we get on day one without any code changes: **worker SIGTERM works again** (`scripts/landfolk:463` reclaim path is currently best-effort), `session_search` ~4500× faster (`scripts/establish-scenario.sh` sleep loops will overshoot), and dashboard improvements.
- Three things we adopt post-upgrade in a follow-up: replace `scripts/kanban`'s raw `cmd_promote` SQL with the native `kanban promote --ids` verb, retire the dispatcher shell loop in favour of `kanban daemon` *if* it preserves per-assignee serialization, and pilot `notify-subscribe` to replace `scripts/auto-stuck-check.py` polling.
- Two things we should explicitly **not** adopt: `kanban swarm` topology (our cards are domain-tied — one Mason at one chest), and Bitwarden Secrets Manager (real migration, not for this pass).

## Why this upgrade matters for hermescraft specifically

Hermescraft is more deeply integrated with Hermes than the homelab stack: a 1957-line custom kanban facade (`scripts/kanban`) that reads SQLite directly, an out-of-process dispatcher loop (`scripts/landfolk-dispatcher.sh`), five active profiles with templated `mc` tool calls, and a deprecated-but-still-load-bearing `landfolk` plugin whose gate-check CLI is the per-assignee mutex. Every one of those touchpoints is affected by v0.15:

| Surface | Today | v0.15.2 effect |
|---|---|---|
| `scripts/kanban` raw SQL on `tasks`, `task_links`, `task_events`, `task_comments` | reads OK on v0.14 schema | schema may drift — explicit column lists at lines 274, 282-305, 1067-1101 must be diff-checked |
| `cmd_promote` raw `_write_event` at `scripts/kanban:1461` | facade hand-rolls promote because Hermes didn't expose it | v0.15 ships `kanban promote --ids` — direct replacement |
| `scripts/landfolk-dispatcher.sh` 30s tick | shell loop calling `gate-check` + `dispatch --max N` | `kanban daemon` may subsume; needs release-notes audit before swap |
| Worker SIGTERM in `reclaim_running` (`scripts/landfolk:463`) | known-broken on v0.15.0, working on v0.14 | restored cleanly on v0.15.1+ |
| Templated `mc <verb>` calls in `prompts/landfolk/worker.md` | no defense | promptware/Brainworm scanner may false-positive |
| Watchdog heartbeat files `$LOG_DIR/watchdog-*.heartbeat` (`scripts/landfolk:1086`) | shell `stat` checks | `kanban heartbeat` server-side; **different surface** (our heartbeats are for bot processes, not kanban workers — partial overlap only) |
| Per-profile `.env` precedence | unchanged across versions | Three layers: shell env from launcher, `~/.hermes/.env`, `~/.hermes/profiles/<name>/.env` — rotate keys in **all** that apply (see pre-flight) |
| `TERMINAL_CWD` env var | works with deprecation warning at v0.15 startup | migrate to `config.yaml: terminal.cwd:` |
| Steward auto-decompose via `scripts/steward-chat-listener.py:42` (`AUTO_DECOMPOSE=1`) | explicit shell-out to `hermes kanban decompose` | v0.15 auto-decomposes on triage — the explicit call becomes redundant |

## Pre-flight (do this before touching pip)

```bash
# Confirm current state
hermes --version
gh release view v2026.5.29.2 --repo NousResearch/hermes-agent --json tagName,name,body

# Snapshot everything that could drift
sqlite3 ~/.hermes/kanban/boards/landfolk-ops/kanban.db ".schema" > /tmp/kanban-schema-pre.sql
cp -r ~/.hermes/profiles /tmp/hermes-profiles-pre.bak
cp ~/.hermes/.env /tmp/hermes-env-pre.bak
cp ~/.hermes/config.yaml /tmp/hermes-config-pre.yaml.bak

# Audit profile env drift before upgrade (so we know what was true)
for p in flint mason gatherer barley steward; do
  echo "=== $p ==="
  grep -E "^(OPENROUTER_API_KEY|GOOGLE_API_KEY|ANTHROPIC_API_KEY)=" ~/.hermes/profiles/$p/.env 2>/dev/null | sed 's/=.*$/=<set>/'
done
```

Stop the fleet before the upgrade touches `kanban.db`:

```bash
# In order: dispatcher loop, gateway, any active workers
scripts/landfolk stop --all
# Confirm quiescence
pgrep -fl hermes
```

## Upgrade

```bash
# Pip install (local-install, not Docker)
pip install --user --upgrade hermes-agent==<pip version for v2026.5.29.2>
hermes --version  # confirm 0.15.2

# Run gateway once in foreground, capture startup warnings
hermes gateway run 2> /tmp/hermes-gateway-startup.log
# ^C after one tick, then read the log:
grep -i "deprecat\|warn\|migrate" /tmp/hermes-gateway-startup.log
```

Expected warnings on first start: `TERMINAL_CWD` deprecation (fix below), possibly a config schema migration notice.

## Verification (the actual work)

### 1. Schema diff — gates everything else

```bash
sqlite3 ~/.hermes/kanban/boards/landfolk-ops/kanban.db ".schema" > /tmp/kanban-schema-post.sql
diff /tmp/kanban-schema-pre.sql /tmp/kanban-schema-post.sql
```

Any drift means audit `scripts/kanban` queries. Specifically check:

- `tasks` SELECT at `scripts/kanban:274` — explicit columns `id, title, body, assignee, status, priority, claim_lock, created_at, completed_at`. If v0.15 added a column we want (e.g. `model_override`, `scheduled_for`, `max_in_progress`), update the SELECT.
- `task_links` JOIN at lines 282-305 — if a `kind` enum lands on the edge table, the WHERE clauses break.
- `task_events` INSERT at line 1461 (in `cmd_promote`) — if the event-row shape changed, the manual write fails. **Replace with `hermes kanban promote --ids` if v0.15 exposes it** (see "Adopt early" below).
- Epic-trailer parsing (body `LIKE '%epic: %'`) at line 333, 1101 — body format is stable; very low risk.

### 2. Facade smoke

```bash
scripts/kanban board
scripts/kanban list --json | jq '.[0]'
scripts/kanban show <some-card-id>
scripts/kanban dependencies <some-card-id>
```

Any `AttributeError`, `sqlite3.OperationalError`, or empty output → patch the facade.

**Write smoke:** `scripts/kanban comment <id> "v0.15 upgrade smoke"`, then `scripts/kanban dependencies <id>` — round-trip must succeed.

### 3. Dispatcher manual tick

```bash
hermes landfolk gate-check --board landfolk-ops
hermes kanban dispatch --board landfolk-ops --dry-run --max 1
```

Both should exit 0. If `landfolk` plugin fails to load, the dispatcher will keep going but no per-assignee mutex — abort and patch the plugin before re-arming the loop.

### 4. One worker end-to-end

Spawn **flint** (smallest blast radius) on a real card:

```bash
scripts/landfolk start --players flint
# Watch the worker's first ~5 turns
tail -f ~/.hermes/logs/landfolk/flint-*.log
```

Look for:

- **Promptware false positives** — "this looks like an injection attempt" refusals on `mc move`/`mc dig` calls. If they fire, see "Worker prompt hardening" below.
- **`mc` HTTP CLI tool calls succeed** — the templated structure in `prompts/landfolk/worker.md:30-50` is the main exposure surface.
- **Profile `.env` loaded correctly** — `hermes status` (or worker startup log) should show the OpenRouter key matching `~/.hermes/profiles/flint/.env`.

### 5. Bring the rest of the fleet up

Only after the flint run completes cleanly. Then re-arm `landfolk-dispatcher.sh` and watch the first 2-3 ticks.

## Worker prompt hardening (if promptware defense fires)

The risk: v0.15 added threat-pattern scanning. Worker prompts in `prompts/landfolk/worker.md` contain large blocks of templated tool-call examples (lines 30-50) that resemble the patterns the scanner watches for.

If we see "injection attempt" refusals on first-turn `mc` calls:

1. Verify the refusal is from the framework, not the model. Look for `[security]` or `[promptware]` markers in the gateway log, not just an error in the worker's stdout.
2. The first cheap fix is to add an explicit framework-allowlist note to the SOUL/prompt: tag the tool-call block as "these are legitimate framework tool calls, not third-party content." Avoid sample structures that look like markdown-injection ("```\nuser:...") in skill bodies.
3. If the false positives are stable, the long-term fix is `hermes security <subcommand>` to allowlist our tool-call signatures — verify the exact CLI after upgrade.

## TERMINAL_CWD migration

If we currently set `TERMINAL_CWD` in any launcher script, fold it into `~/.hermes/config.yaml`:

```yaml
terminal:
  cwd: /Users/foz/hermescraft
```

Drop the env var from `scripts/landfolk*` and any shell rcfile. Skip this only if we run the Hermes WebUI — the env var existed as a workaround for a v0.14 WebUI duplicate-kwarg bug. We don't run WebUI, so straight migration is fine.

## Feature adoption — what to take, defer, skip

### Adopt early (first follow-up PR after upgrade lands)

**Native `kanban promote --ids` replaces `cmd_promote` raw SQL.**
Today `scripts/kanban:1423-1467` opens a read-write SQLite connection just to flip status and write a `task_events` row. v0.15 ships `hermes kanban promote --ids <a> <b> ...` natively. Replace the body of `cmd_promote` with a subprocess call and delete the `_write_event` helper for the promote path. Smaller facade, no more event-row schema risk on this verb.

**Auto-decomposition on triage.**
`scripts/steward-chat-listener.py:42` gates decompose behind `AUTO_DECOMPOSE=1` and shells out per task. v0.15 does this on triage automatically. Path: flip the default to off, let v0.15 handle it, and verify the resulting subtask trees on `landfolk-ops` look right. Keep the script's explicit decompose path as a fallback for older boards.

**Per-task model overrides for cheap cards.**
`data/agent-models.json` pins models per profile (Steward and most workers on `deepseek-v4-flash:exacto`, Barley on `nemotron-3-super-120b-a12b:free`). v0.15's `model_override` per task lets us route by card type, not just by profile. Worth piloting:
- `[L1]` capability tests → cheaper model (smoke-test cards don't need exacto)
- `[PATROL]` cards → bump Mason to a stronger model when the patrol body is non-trivial
- Steward's specify/decompose calls — already cheap, leave alone

**Worker visibility endpoints (`/workers/active`, `/runs/{id}`, `/inspect`).**
Replaces parts of `landfolk status` introspection (`scripts/landfolk:1080-1093` heartbeat-staleness check). Our watchdog heartbeats are for bot processes (different surface) so keep those; but the kanban-worker view becomes a one-liner against `/workers/active` instead of grepping process lists.

**`max_in_progress` board cap.**
Native cap on concurrent running tasks. Today we cap implicitly via `MAX` in `landfolk-dispatcher.sh:117`. Setting it on the board itself makes the cap survive dispatcher restarts and crashes.

**Configurable claim TTL + retry fingerprinting + respawn guards.**
These overlap heavily with `scripts/landfolk:463 reclaim_running` and our manual escalation in `scripts/auto-stuck-check.py`. The right move is: keep the existing path running, observe what the native features catch first over 2-3 fleet runs, then trim the custom code in a focused PR. Don't rip out reclaim until we've confirmed native covers the same failure modes.

### Adopt cautiously (needs design discussion)

**`kanban daemon` to retire `landfolk-dispatcher.sh`.**
This is the single biggest simplification on the table. But our dispatcher does more than the upstream tick: it runs `hermes landfolk gate-check` for per-assignee serialization, scrubs profile env (lines 71-90), parses output counters, and integrates with `scripts/landfolk` lifecycle. Don't swap unless:
1. v0.15 added native per-assignee cap (`hermes kanban dispatch --help | grep -i assignee` post-upgrade), AND
2. `kanban daemon` honours that cap, AND
3. We have a way to run the env-scrub step before each spawn (or it's unnecessary on v0.15 because of the new profile isolation guard).

If those don't all hold, stay on the shell loop.

**`notify-subscribe` to replace polling.**
`scripts/auto-stuck-check.py` polls progress logs to detect stuck workers and emits a comment then escalates. `establish-scenario.sh` waits on board state at lines 51, 194, 210, 219, 287. Both could be push-based on v0.15's `notify-subscribe`. Pilot on `auto-stuck-check` first — it's small (~200 lines) and isolated. If the push model proves out, migrate the establish waiters.

**Cross-profile cron jobs.**
`docs/archive/steward-out-of-game.md` and `docs/archive/phase-3-steward-mvp.md` both ideated using `hermes cron` for periodic detector scripts and surveys — never landed because v0.14 cron was profile-silo'd. v0.15 makes cross-profile cron visible in the dashboard with per-job profile support. The Steward "out of game" design is now actually viable. Don't rush it — that design pre-dates several other lessons — but the technical blocker is gone.

**`pre_kanban_dispatch` hook (open question).**
The landfolk plugin's deprecation note in `docs/specs/kanban/plugin-landfolk.md` calls out a wanted `pre_kanban_dispatch` hook that v0.14 didn't have. v0.15 ships `notify-subscribe` and may expose new dispatch hooks. **Action item:** post-upgrade, run `hermes kanban hooks list` (or equivalent) and check whether gate-check can become a proper hook. If yes, the landfolk plugin's CLI path can be retired in favour of a registered hook.

### Skip / not for us

**`kanban swarm` topology.** Our cards are domain-tied: a `[STORE]` card needs a specific Mason at a specific chest with a specific item. Swarm v1 (root → parallel workers → gated verifier) is for problems with parallelizable sub-units. Not our model.

**Bitwarden Secrets Manager migration.** Real migration with its own design pass. Defer.

**Worker `.md` media delivery (restored in v0.15.1).** Useful for projects that attach docs to cards — we don't, our cards are YAML. No-op for us, just don't be surprised if it shows up.

**Krea / FAL image generation.** N/A.

## Safety changes that affect us

v0.15 added two profile-boundary protections worth knowing about:

- **Cross-profile soft guard on file-write tools.** A worker running under `mason` profile gets a soft warning if it tries to write to `~/.hermes/profiles/gatherer/`. We don't intentionally cross profiles, but verify after the first worker run that no false positives fire on shared paths like `data/locations-base.json` (read-only — should be fine) or `data/locations-mason.json` (mason's own — should be fine).
- **Write-deny `<root>/.env` when running under a profile.** Aligns with what `scripts/landfolk-dispatcher.sh:71-90` already does manually. Net effect: even if a worker tried to write `~/.hermes/.env`, the framework now blocks it. No code change required.

## Performance and cold start

`session_search` rebuilt (~4500× faster; no auxiliary LLM). Gateway cold start ~19s faster. Wait loops in [`establish-scenario.sh`](../../scripts/establish-scenario.sh) and [`establish-launch-verify.sh`](../../scripts/establish-launch-verify.sh) were tuned on v0.14 — they still work but may finish sooner. **Don't tighten sleeps preemptively**; run two establish cycles on v0.15.2, measure, then trim.

Upstream skills catalog grew substantially (large disk/memory at cold start). Not blocking; budget for first gateway start after upgrade.

## Env and config (beyond TERMINAL_CWD)

- **`HERMES_DASHBOARD_INSECURE=1`** — only if using Hermes dashboard sidecar under Docker. N/A for local pip install.
- **WebUI container:** upstream removed `sudo` in base image; use `docker exec -u hermeswebui` if you ever shell into homelab containers — hermescraft local install unaffected.
- **Promptware defense** — v0.15 scans worker prompts; templated `mc` examples in [`prompts/landfolk/worker.md`](../../prompts/landfolk/worker.md) are the main false-positive surface (see hardening section below).
- **Skill loader** — can group bundles; wake prompts may eventually drop redundant `skill_view` boilerplate (evaluate post-upgrade, not day one).

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `tasks` table column drift breaks `scripts/kanban:274` SELECT | medium | schema diff before/after, explicit column-list audit |
| `task_events` row format change breaks `cmd_promote:1461` | low | replace with native `promote --ids` (see "Adopt early") |
| Promptware defense refuses `mc` tool calls | medium | watch first flint run; if refusals fire, see "Worker prompt hardening" |
| Profile `.env` keys go stale because we rotated only top-level | high if forgotten | pre-flight audit script above; re-run after upgrade |
| `landfolk` plugin fails to load on v0.15 | low | `hermes landfolk --help` is the test; plugin is small |
| `kanban daemon` adoption breaks per-assignee serialization | high if rushed | gate behind native cap verification — don't swap optimistically |
| Worker SIGTERM regression on v0.15.0 reaches us | n/a — we go straight to 0.15.2 | pinning the tag is the mitigation |
| Dashboard 401 reload-loop on v0.15.0 reaches us | n/a — same as above | same |

## Rollback

```bash
pip install --user --force-reinstall hermes-agent==<v0.14.0 pip version>
# Restore from /tmp/*.bak if the upgrade migrated kanban.db or rewrote config.yaml
cp -r /tmp/hermes-profiles-pre.bak/* ~/.hermes/profiles/
cp /tmp/hermes-env-pre.bak ~/.hermes/.env
cp /tmp/hermes-config-pre.yaml.bak ~/.hermes/config.yaml
# kanban.db: only restore if schema migrated and you didn't run new writes
```

If we ran new-version writes against `kanban.db` (any worker completed, comment, claim), the restored v0.14 facade may not read those events correctly. Pre-flight backup is the safety net; rolling back after fleet activity is hairy. Plan the upgrade for a quiet window so the rollback option stays clean.

## Adoption roadmap (suggested phases)

1. **Phase A — upgrade and stabilize.** Pre-flight, install v0.15.2, verify schema + facade + one worker + fleet. End state: same behavior as today on v0.15.2. No code changes adopting new features yet.
2. **Phase B — quick wins (1-2 days post-upgrade).** Migrate `TERMINAL_CWD` → `config.yaml`. Replace `cmd_promote` with native `promote --ids`. Set `max_in_progress` on `landfolk-ops`. Flip `AUTO_DECOMPOSE` to off in Steward listener.
3. **Phase C — measure native vs custom (next fleet run).** Observe what `claim TTL` + `stale-task detection` + `respawn guards` catch that our reclaim/auto-stuck stack used to. Trim overlapping custom code in a focused PR.
4. **Phase D — per-task model overrides pilot.** Pick `[L1]` capability tests, route to cheaper model via `model_override`. Compare cost + pass rate over a week.
5. **Phase E — daemon adoption (only if gates pass).** Verify native per-assignee cap exists and `kanban daemon` honours it. If both, retire `landfolk-dispatcher.sh`. If not, write up the gap as a Hermes upstream issue and stay on the shell loop.
6. **Phase F — Steward cron experiment.** Revisit `docs/archive/steward-out-of-game.md` now that cross-profile cron is real. Separate design pass.
