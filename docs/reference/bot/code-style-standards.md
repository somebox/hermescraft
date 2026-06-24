# Bot code style standards

Concise conventions for `bot/` handlers, CLI, and HTTP. Normative contracts live in
[handler-contract-adr.md](./handler-contract-adr.md) and
[handler-response-contracts.md](./handler-response-contracts.md). Tests:
[bot/test/README.md](../../../bot/test/README.md), P9 in
[engineering-patterns.md](../engineering-patterns.md).

## Naming

| Layer | Rule |
|--------|------|
| Public verbs | **snake_case** on ACTIONS map, HTTP `/action/*`, registry `path` |
| JS identifiers | **camelCase**; constants **SCREAMING_SNAKE**; private modules **`_` prefix** |
| Files | **kebab-case** `.js` under `lib/`; **`.mjs`** under `cli/` |
| Domain factories | **`createDomainActions(deps)`** at top-level action modules (CI: `actions-manifest.test.js`) |
| Internal-only callables | **`_name`** on ACTIONS; not camelCase fake verbs |
| Factory suffixes | `Part` (building shards), `Handlers` (mining/water), `Queries` (read-only) |

### CLI / handler alias table (do not rename without triple gate)

| Agent CLI | HTTP handler key | Notes |
|-----------|------------------|--------|
| `pillar_up` | `pillar_step` | Registry aliases: `tower`, `pillar` |
| `mc bg goto` | `/task/goto` | Hook deny sees first token `bg`, not `goto` |

Renames require: `registry.mjs`, `scripts/regenerate-artifacts.sh`, `prompts-sync.test.js`.

## Parameters

- Handler first parameter: **`args`** (prefer over `body`).
- Parse at boundary: **`coord3`, `box6`, `boxXZ`, `itemName`, `count`, `bool`** from `bot/lib/actions/_args.js`.
- **`box6` / `boxXZ`** return corners as given; use **`normalizeInclusiveBox6`** after parse for loops.
- **`boxXZ`**: any of `x1,z1,x2,z2` → corner mode; pit needs `x,z,w,l`; mixed pit+corner fails; pit `w,l` should be ≥ 1.
- **`bool(v, default)`**: documented falsy (`false`, `no`, `0`, `off`) and truthy (`true`, `yes`, `1`, `on`); other strings → `Boolean(v)`.
- Wire fields: **snake_case**; internal flags: **`_camelCase`** when agent-invisible.
- Defaults: **`??`** for nullish; numerics via **`Number.isFinite`**, not `||`.
- Parse/shape errors: **`INVALID_ARGS`** (not `INVALID_ARG`).
- **Y**: when both `y` and `surface_y` are set, **`surface_y` wins** (`bot/lib/runtime/coordinates.js`).
- **`customParse`** verbs skip `argSchema`; handlers still use `_args`.

## Geometry

- **BlockPos**: integer `{ x, y, z }`, **Y = block_y** at API edge ([world-coordinates.md](../world-coordinates.md)).
- **BlockBox**: inclusive `{ min, max }` from `normalizeInclusiveBox6({ x1…z2 })`.
- **Responses**: prefer **`bounds: { x1, y1, z1, x2, y2, z2 }`**; legacy `box: { xmin… }` is deprecated mirror only.
- **Anchor**: **`toBlockPos(anchor)`** for `[x,y,z]` or `{x,y,z}`.
- **Footprint**: `metadataFootprint` uses **1-based** local ranges; `tightFootprintFromCells` is **0-based** — do not mix without `resolveFootprint`.
- Motor units: `{ x, y, z, id }` per `execution-kernel/order.js`.

## Errors and logging

### Handler tier (P9)

- Use **`ok()` / `fail()`** only at handler boundaries (`action-contract.js`).
- Success must include **`ok: true`** (boolean) so **`validate()`** passes in unit tests.
- Failures: **`error: { code, message, retry_safe, observed_state?, next_action_hint? }`**.
- **`validate()`** does not check `data.success` vs top-level `ok`; ADR requires they agree when both are present.

### Intentional semantics (not style bugs)

- **Soft success**: `ok: true` for benign empty work (e.g. no mark, no hostiles) — allowed per movement/combat contracts.
- **`dig_area`**: `ok: true` with `dug: 0` and `errors[]` may remain — product semantics.

### Transport tier (HTTP routing)

Separate from handler P9:

- Sync `/action/*` spreads handler result; outer `{ ok: true, ...result }` can mask missing handler `ok`.
- 409 sync overlap, unknown action, orchestrator 403, bot not ready may use **string `error`** or structured `{ code, message }` — document changes in `task-lifecycle.test.js`.
- **Task POST**: read **`status: 'refused' | 'started'`**; 250ms race in `task-lifecycle.js` (fast `ok: false` → refused).

### Logging

- No new ad hoc `console.log` in actions; use injected **`log`** dep.
- Optional structured dispatch completion line (action, ok, code, duration_ms).

## Phase gates

```bash
cd bot && npm test
node scripts/bot-test-coverage-report.mjs --check
```

Coverage audit: `docs/reference/audits/bot-test-coverage-*.md`.

## New handler checklist

1. Domain handler + factory wired in `actions/index.js`.
2. `_args` parsers at entry; `ok()` / `fail()` at exit.
3. snake_case ACTIONS key; registry + cheatsheet regen.
4. `*-contract.test.js` with `assertContract` / `assertFailure` from `test/_helpers/action-harness.js`.
