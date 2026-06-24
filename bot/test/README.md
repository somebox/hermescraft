# Bot server tests (Tier 1)

Node unit and contract tests for `bot/lib/**` and `bot/cli/**`. No Minecraft server or live bot required.

```bash
cd bot && HERMES_VALIDATE=1 npm test
```

ADR for handler envelopes: [`docs/reference/bot/handler-contract-adr.md`](../../docs/reference/bot/handler-contract-adr.md). Shared assertions: [`_helpers/action-harness.js`](_helpers/action-harness.js).

## Taxonomy

| Bucket | Location | Role |
|--------|----------|------|
| Sync gates | `*-sync.test.js`, `actions-manifest.test.js`, `foundation.test.js`, `registry-guardrails.test.js` | CLI/registry/prompt drift prevention |
| Handler contracts | `**/*-contract.test.js`, `mining-dig.test.js`, `mining-collect.test.js` | `assertFailure` / `assertContract` on `mc` verbs |
| Handler specs | `actions/*.test.js` (non-contract) | Regressions; prefer `# spec` in title |
| Characterization | `*-characterization.test.js` | Golden masters; change only with sign-off |
| Runtime / shared | `runtime/**`, `shared/**` | nav-brief, regions, blueprints library, POI store, **`runtime/execution-kernel/**`** (bulk motor) |
| CLI | `cli/**` | Args, dispatch, HTTP client |
| Middleware | `middleware/**` | Announce, guards, task lifecycle |
| Integration (in name) | `integration/**` | Multi-module stubs; not live MC |
| Audit smoke | `commands-audit-coverage.test.js` | Registry presence; shrink as real contracts land |

## Pillar / vertical verbs

| Verb | Primary tests |
|------|----------------|
| `pillar_up` | `pillar-geometry`, `pillar-outcome`, `pillar-tracking`, `excavation-contract`, `queries.test.js` |
| `pillar_down` | `pillar-geometry`, `pillar-outcome`, `excavation-contract`, `nav-helpers.test.js` |
| `stair_up` / `stair_down` | `excavation-contract`, `stair-down-yaw`, `egress-protection` |

## Nav-brief

Slice tests under `runtime/nav-brief-*.test.js` and `runtime/observation-nav-payload.test.js` — shared fixtures intentionally minimal per file; see comments in `runtime/nav-brief.test.js` for the baseline.

## Blueprint plan JSON (contracts)

On-disk plans: `data/ops/plans/<plan_id>-plan.json`. Field names, footprint rules, and vocabulary: [`docs/specs/world/blueprints-grabcraft.md`](../../docs/specs/world/blueprints-grabcraft.md) ([Terminology](../../docs/specs/world/blueprints-grabcraft.md#terminology)).

| Area | Tests / code |
|------|----------------|
| Load / footprint / size caps | `runtime/blueprints/loader.test.js`, `footprint.js`, `limits.js` |
| Verify compare (v1 block id) | `runtime/blueprints/verify.test.js`, `compare.test.js` |
| Adopt / capture mutations | `runtime/blueprints/plan-mutations.test.js` |
| `mc blueprint` handlers | `actions/blueprint-building-contract.test.js` |
| Construct session + gates | `runtime/construct-*.test.js`, `actions/construct-contract.test.js`, `actions/construct-handler-filter.test.js` |
| Workset + kernel scope | `runtime/execution-kernel/workset-scope.test.js`, `runtime/construct-bulk-allow-unit.test.js` |
| Fixture plan regression | `runtime/starter-shelter-plan.test.js` (uses `data/ops/plans/starter_shelter-plan.json`) |

Python plan helpers (kanban cards, offline verify): `scripts/tests/test_gv2_card_validator.py`, `scripts/tests/test_plan_supply.py`, `scripts/tests/test_place_schematic_sign.py`. RCON paste/capture is not exercised in Tier 1 — see [`docs/guides/test-overview.md`](../../docs/guides/test-overview.md) Tier 2.

## Coverage matrix

Regenerate: `node scripts/bot-test-coverage-report.mjs` → `docs/reference/audits/bot-test-coverage-YYYY-MM-DD.md`.

Tier 3 (live bot) complements L0 success paths documented in [`docs/reference/bot/handler-response-contracts.md`](../../docs/reference/bot/handler-response-contracts.md).
