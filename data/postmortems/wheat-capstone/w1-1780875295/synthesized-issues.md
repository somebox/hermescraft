# Synthesized issues from `w1-1780875295` feedback

Deduped, deduplicated, severity-ranked. Source: per-role feedback in this
postmortem dir + `delta-vs-w1-1780871693.md`.

| ID | Severity | Status | Affected roles | One-line |
|---|---|---|---|---|
| I1 | **P0** | recurring | nav, builder, farmer, crafter | MC env vars (MC_API_URL/MC_USERNAME) not in worker shell at spawn |
| I2 | **P0** | new | crafter | Acceptance predicate `wheat>=60` runs *after* harvest card — by design fails; `chest_contains` predicate exists in manifest but is never evaluated |
| I3 | **P0** | recurring | nav | `wheat_plot` mark is a water block — navigator card body still no hint |
| I4 | **P0** | recurring | nav | `mc advise` KeyError `health_poll_interval_s` — r5 fix did not bite (config dict in `tests/_lib/bot.py:21` still missing the key path used at runtime) |
| I5 | **P0** | new | crafter | Verifier parks bot in water at `wheat_plot` → drowning damage during evaluation |
| I6 | **P0** | new | crafter | Predicate flapping: `READ_FAILED` cells marked `satisfied=false` instead of `evaluable=false`; needs retry-on-chunk-unloaded |
| I7 | P1 | recurring | nav, builder | No `mc terrain_top --batch` — 7-call survey per nav card, 5-call corner check per builder |
| I8 | P1 | recurring | farmer | No `mc farm_status --mark` — manual coord transcription each call |
| I9 | P1 | recurring | nav | `HERMES_NAV_BRIEF` documented but never active — skill describes non-functional feature |
| I10 | P1 | recurring | nav, builder, crafter | Skills bundle list often contains only `kanban-worker` at runtime, despite r0 contract test passing; bundle skills not auto-loaded |
| I11 | P1 | recurring | nav | No `exit_pos` / last-known-position in card metadata — every nav card opens with 5–8 orientation calls |
| I12 | P1 | new | farmer | Cron job created but `hermes gateway` not running → silent failure; no verb to check gateway liveness |
| I13 | P2 | recurring | farmer | `mc till_area` UNCHANGED counter on water cell reads as error (cosmetic) |
| I14 | P2 | recurring | crafter | Card body says "remove harvest-reminder cron" — no-op for two consecutive trials |
| I15 | P2 | new | builder | Surface Y shifted between runs (Y=64 → Y=65) — world-regen artifact; no detection mechanism |
| I16 | P2 | new | farmer | `bin/mc` wrapper depends on access to repo `data/bots/mox.yaml` — fragile under profile isolation (container/ssh) |

## Severity legend
- **P0** — blocks a future trial from being honest (env, acceptance correctness, verifier safety).
- **P1** — friction that adds turns/tokens but doesn't break results.
- **P2** — cosmetic or future-only concerns.

## The single dominant signal

**I1 (MC env injection) is the load-bearing problem.** Every role's #1
feedback bullet — across both trials — is the same. The r1 wrapper-on-PATH
approach in `w1_remediation_1780871693_b360234a.plan.md` did not bite:

1. Wrapper file is correct: `~/.hermes/profiles/<role>/bin/mc` exists and
   sets the env vars before `exec`ing the repo `mc`.
2. **PATH never includes that bin dir** in the worker shell. SOUL §Turn-1
   tells the agent to `export PATH="$HERMES_HOME/profiles/<role>/bin:$PATH"`
   but (a) the path expression is wrong (`HERMES_HOME` is already the
   profile dir, so the expression nests) and (b) agents do not auto-execute
   SOUL Turn-1 — they go to `mc status` cold.
3. Worker process env at spawn has no `MC_*` keys, confirming Hermes strips
   non-`HERMES_*` env at the spawn boundary regardless of dispatcher exports
   or `terminal.env_passthrough` config.

The next remediation must bypass the agent entirely — env must arrive at
spawn time via a Hermes-supported mechanism, not via a SOUL instruction the
agent might or might not read.

## Quick decision rules for the next plan

- **No more SOUL instructions for env setup.** Agents don't reliably read
  them. Either the env arrives via spawn config, or the bot won't be
  reachable.
- **Acceptance predicates must match card-completion semantics.** Don't
  test for the state the card eliminates.
- **Verifier must respect bot safety.** Move-to-safe-cell before scan.
- **A failed-read should never count as a failed predicate.** Treat
  `READ_FAILED` cells as `evaluable=false`.
