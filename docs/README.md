# Documentation index

High-level references for working on HermesCraft.

**CLI commands:** [mc-cheatsheet.md](mc-cheatsheet.md) is generated from `bot/cli/registry.mjs`. After changing the registry, run `node scripts/gen-mc-cheatsheet.mjs` — do not edit the cheatsheet by hand.

## Start here

| Doc | Purpose |
|-----|---------|
| [architecture.md](architecture.md) | Bot `lib/` layout, layers, action domains, state slices |
| [patterns.md](patterns.md) | Maintainability patterns (P1–P20) and convention checks |
| [agent-boundaries.md](agent-boundaries.md) | What lives in Hermes vs Mineflayer HTTP / `mc` CLI |
| [mc-cheatsheet.md](mc-cheatsheet.md) | One-line per `mc` command |
| [mc-commands.md](mc-commands.md) | Canonical verb names, args, and envelopes |

## Guides

| Doc | Purpose |
|-----|---------|
| [guides/running-steve.md](guides/running-steve.md) | Start Steve on ubuntu-host, watchers, force-reason mode |
| [guides/dashboard.md](guides/dashboard.md) | Fleet dashboard (port 3000), FPV, map tabs |
| [guides/testing.md](guides/testing.md) | Test tiers, what to run, CI vs local |
| [guides/test-world.md](guides/test-world.md) | `landfolk-test` Multiverse world for functional tests |
| [guides/agent-tests.md](guides/agent-tests.md) | LLM + bot end-to-end agent test runner |
| [guides/perception-digest.md](guides/perception-digest.md) | Advise layer, integration tests, `MC_FORCE_REASON` |
| [guides/run-logging.md](guides/run-logging.md) | `scripts/exp.sh` structured expedition logging |
| [guides/hermes-platform.md](guides/hermes-platform.md) | Hermes Agent capabilities, commands, and Landfolk integration practices |

## Design

| Doc | Purpose |
|-----|---------|
| [design/goal-profiles.md](design/goal-profiles.md) | Goal schema exercises (defender, builder, miner) |
| [design/phase-2/](design/phase-2/) | Phase 2 architecture (board, contracts, reactive layer, sprints) |
| [design/phase-3/](design/phase-3/) | Phase 3 steward / landfolk-ops kanban MVP |

## Features (in flight)

| Doc | Purpose |
|-----|---------|
| [features/designated-regions.md](features/designated-regions.md) | Region profiles, enforcement, sites (Phase 1 runtime) |
| [features/designated-regions-verification.md](features/designated-regions-verification.md) | Live-world verification checklist |
| [features/sign-anchored-placemarks.md](features/sign-anchored-placemarks.md) | Sign-based placemark design |
| [features/blueprints.md](features/blueprints.md) | GrabCraft JSON + future `mc construct` sketch |
| [features/landfolk-plugin.md](features/landfolk-plugin.md) | Hermes plugin for landfolk: kanban per-assignee concurrency, future home for mc-tools / compressor / memory / chat-adapter subsystems |

## Planning (logs and scratch)

| Doc | Purpose |
|-----|---------|
| [planning/README.md](planning/README.md) | Conventions for this folder |
| [planning/devlog.md](planning/devlog.md) | Rolling dev session log |
| [planning/expeditions/](planning/expeditions/) | Dated run postmortems |

## Archive

[archive/README.md](archive/README.md) — completed refactor plan, old dashboard specs, experiment findings, hackathon-era docs.
