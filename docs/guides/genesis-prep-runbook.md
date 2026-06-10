# Genesis run-prep checklist

Run before every `scripts/genesis.sh new-run`. Each step takes <30s; doing
them in order is the difference between "fresh sandbox + new SOULs honored"
and "stale process + stale doctrine + a wasted run."

## Sequence

```
1.  scripts/landfolk status                       # confirm fleet stopped
2.  git log --oneline -5                          # confirm recent commits in tree
3.  scripts/landfolk deploy                       # push SOULs to runtime profiles
4.  cat scripts/landfolk-dispatcher.sh | grep HERMES_BIN   # confirm absolute hermes path
5.  scripts/genesis.sh new-run --seed=<seed> --no-confirm
6.  data/genesis-runs/<run-id>/run.log            # tail to confirm setup steps ok
7.  scripts/kanban list-epics                     # confirm 6 P1 members
```

## Step details

### 1. Fleet stopped

`scripts/landfolk status` should show every roster bot as `DOWN`. If any are `OK`, run `scripts/landfolk stop` and wait. Stray processes inherit the wrong env (especially the orchestrator sandbox PATH for Steward) — this caused the dispatcher `gate-check FAILED` cascade in `g-2026-05-28-5`.

### 2. Recent commits

`git log --oneline -5` — verify the fixes from your last postmortem are actually committed. Stray edits in the working tree don't apply because:
- SOUL changes only propagate via `scripts/landfolk deploy`
- Sandbox stubs only install on bot start (taking the script as-of-start)
- Bot code (`bot/lib/**`) only takes effect when bots respawn

If your bug fix is sitting uncommitted, the run won't have it.

### 3. Deploy SOULs

`scripts/landfolk deploy` syncs `prompts/landfolk/*.md` and `skills/*.md` into `~/.hermes/profiles/<bot>/`, and **regenerates** `docs/reference/mc-cheatsheet.md` from `bot/cli/registry.mjs` (agent surface tiers from `registry-surface.mjs`). Skills that embed the cheatsheet pick up the new layout on the next context build; **required** every time you edit a SOUL, skill, or registry — even if you committed it, deploy is the runtime install step.

Watch for `✓ deploy complete` and no `ERROR` lines.

### 4. Dispatcher hermes binding

```bash
grep "HERMES_BIN=" scripts/landfolk-dispatcher.sh
# Expect: HERMES_BIN="${HERMES_BIN:-/Users/foz/.local/bin/hermes}"
```

This is the fix from `1ddb51d` that keeps Steward's orchestrator sandbox from binding the dispatcher itself. If the line is missing or commented out, the `gate-check FAILED` cascade from `g-2026-05-28-5` will reappear.

### 5. Kick off the run

```bash
scripts/genesis.sh new-run --seed=-1312751495452676979 --no-confirm
```

For A/B comparison against prior runs, use the same seed. For a "fresh" experiment with a new world, omit `--seed`. `--no-confirm` skips the interactive run-id prompt.

### 6. Verify setup steps

```bash
grep -E "seed_base_pad|system_chest|seed_cards|landfolk_start|snapshot_start" \
    data/genesis-runs/<run-id>/run.log
```

Every step should show `outcome: ok`. Hard-fails any of these means a setup
bug — investigate before bots start working real cards. Known shape:

```
seed_base_pad_warn  partial  filled 80/81 cells     ← tolerable (chunk boundary)
seed_base_pad       ok       duration_ms=~8000
system_chest_place  ok       duration_ms=~5000
seed_cards          ok       duration_ms=~3000
landfolk_start      ok       duration_ms=~24000
system_chest_fill   ok       duration_ms=~67000     ← post-fill verify is strict
snapshot_start      ok
```

### 7. Confirm board shape

```bash
scripts/kanban list-epics
# Expect: 4 epics, P1 has members=6
```

`members=6` confirms the survey card landed and the epic chain seeded
correctly. If `members<6`, `seed_starter_cards` had a problem.

## Common failure modes (and what they look like)

| Symptom at startup | Cause | Fix |
|---|---|---|
| Dispatcher logs `gate-check FAILED` every tick | Sandbox PATH bleed | Step 4 — confirm `HERMES_BIN` pin |
| `system_chest_fill` raises | Verify step caught empty chest | Re-run; if persists, check manifest in `scripts/system-chest.mjs` |
| `seed_base_pad: 0/N` raise | Chunk-load race not resolved | Re-run (the chunk-ready poll usually wins second time) |
| `members=0` on P1 epic | seed_starter_cards bug | Check `phase1-cards.yaml` has 6 entries, `genesis_lib.py` validator matches |
| Steward round 1 exit=142 | OBSERVE ritual still too heavy | Check her SOUL Phase-1 OBSERVE section wasn't reverted |
| Bots spawn but don't take cards | Dispatcher gate-check or sandbox issue | `tail /tmp/hermescraft/dispatcher.log` |
| `mc advise` fails with yaml import | PyYAML missing in bot's Python | Should be handled by `tests/_lib/config.py` fallback (commit `6b80c06`); if it bypasses, `pip install pyyaml` |

### Data snapshots in git

If you commit `data/locations-base.json` or retune `data/base-goals.yaml` for a
genesis benchmark, say so in the commit message (run id + intent). Those files
pick up reconciler timestamps and will conflict on the next run unless you treat
them as deliberate seeds with an agreed refresh cadence.

## When the checklist is wrong, fix the checklist

This doc is a record of pre-run setup learnings — when a new failure mode
turns out to be preventable by a pre-run check, add the check here. The
list grows; the runs get more reliable.
