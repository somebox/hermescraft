# Designated regions

> Status: **Phase 1 implemented** — bot-driven create/remove, policy enforcement,
> `mc check`, dashboard discs, worksite task context.
> Live sign-off: [`designated-regions-verification.md`](./designated-regions-verification.md).
> Placemarks: [`marks-sign-anchored.md`](./marks-sign-anchored.md).
> Phase 2+ (repair, construct envelopes, dashboard deep dive):
> [`../../archive/features/designated-regions-full.md`](../../archive/features/designated-regions-full.md).

## Problem

Global dig deny-lists (`isDigProtected` in `bot/lib/runtime/dig-tools.js`) cannot distinguish “cobble in the base wall” from “cobble in a vein far away.” **Regions** attach purpose and rules to volumes of space (`protect` / `resource` / `marker`). Inside a `mine` region the bot may dig freely; inside `base` it may not break structure blocks ad hoc.

## Region model

A region is an **annotation on a placemark** `:id:` (see placemarks spec). The registry row adds geometry, intent, sites, and capability flags.

Persistence: `data/regions-<world>.json` (per world).

```js
{
  id: 'base1',                          // matches placemark :base1:
  intent: 'protect' | 'resource' | 'marker',
  profile: 'base' | 'farm' | 'dock' | 'mine',
  anchor: { x, y, z },
  shape: {
    kind: 'column',                     // default: X/Z disc; y_min/y_max optional
    radius: 24,
    y_min: null,
    y_max: null,
  },
  sites: { tower: { x, y, z }, ... },
  capabilities: { /* resolved at load */ },
  status: 'active' | 'orphaned' | 'unanchored',
  created: '<iso>',
  notes: '',
}
```

| status | Meaning |
|--------|---------|
| `active` | Placemark sign present; anchor synced |
| `orphaned` | Sign destroyed; enforcement continues |
| `unanchored` | Created via `mc region_create`; no sign yet |

## Intent and profile

| intent | Meaning |
|--------|---------|
| `protect` | Preserve interior; ad-hoc dig/place denied (with profile tolerances) |
| `resource` | Operate intensively; dig/place allowed; may override global denylist |
| `marker` | Context only; no enforcement |

| profile | Default intent | Notes |
|---------|----------------|-------|
| `base` | protect | Structure-style tolerances |
| `farm` | protect | Mature-crop harvesting allowed |
| `dock` | protect | Seagrass/kelp tolerances |
| `mine` | resource | Overrides global denylist except containers |

Profile block lists: `bot/lib/runtime/regions/profiles.js`.

## Capability flags (agent-visible)

Surfaced on `mc regions` and `mc regions --at`. The agent reads flags, not raw intent alone.

| flag | protect (typical) | resource (typical) |
|------|-------------------|---------------------|
| `allow_ad_hoc_dig` | false | true |
| `allow_ad_hoc_place` | false | true |
| `allow_guided_edit` | true | true |
| `allow_harvest` | profile-dependent | true |
| `overrides_global_denylist` | false | true |

## Geometry

Default: **column** — X/Z disc, optional `y_min..y_max` (null = infinite Y). Optional `shape=sphere` on sign or create flags.

## Sites

Named sub-anchors inside a region: `:base1:/tower`, `:mine1:/entrance`.

- Declared on placemark sign: `site:tower=350,72,-540` (repeat per site).
- Or bot: `mc site_add :id:/name X Y Z` (see registry for canonical verb).

`mc goto` / movement that accepts placemark ids routes site refs through `go_site`.

## Bot-driven creation (CLI)

Bots do not write sign text reliably; registry verbs mutate `data/regions-*.json` directly. Enforcement is identical for `active`, `orphaned`, and `unanchored`.

| Verb | Role |
|------|------|
| `mc region_create` | Create region at bot position; `status=unanchored` until sign matches `:id:` |
| `mc region_remove` | Delete row (`--confirm`) |
| `mc region_update_intent` | Change intent (e.g. legacy `marker` escape) |
| `mc site_add` / `mc site_remove` | Maintain sites |
| `mc regions` | List regions; `mc regions --at X Y Z` previews policy at a cell |
| `mc regions_reload` | Reload store from disk |
| `mc regions_terrain` | Column top-solid survey for construct prep |
| `mc go_site` | Navigate to `:id:/site` |

Examples (see [`reference/mc-cheatsheet.md`](../../reference/mc-cheatsheet.md)):

```text
mc region_create :mine1: mine --r 12
mc regions --at 100 40 100
mc check dig 100 40 100
mc goto :base1:/tower
```

## Sign syntax (Path A)

On the placemark sign, after the `:id:` line:

```text
:base1: main base
region=base
r=24
y=60..80
site:tower=350,72,-540
```

`region=<profile>` required to promote placemark → region. Optional `intent=`, `shape=sphere`. Sign loss → `orphaned`; protection stays until `mc region_remove`.

## Resolver decision shape

Pure logic: `bot/lib/runtime/regions/resolver.js` (also driven by fixture `bot/test/runtime/regions/fixtures/scenarios.json`).

```js
{
  decision: 'allow' | 'deny',
  reason: 'REGION_PROTECTED' | 'REGION_OVERRIDE' | 'OUTSIDE_ALL_REGIONS' | ...,
  winning_region: { id, intent, profile, capabilities },
  losing_regions: [ { id, intent } ],
  matched_capability: 'allow_ad_hoc_dig' | ...,
  notes: '<optional profile hint>',
}
```

Overlap precedence (observable):

1. `resource` beats `protect` when the action is allowed in the resource region.
2. Same intent: smaller radius wins.
3. Tie: most recently updated.

## `mc check` (dry-run)

Side-effect-free preview of region policy for **dig** / **place** (and related verbs the handler supports). Returns the same envelope the real verb would use, plus `dry_run: true`.

Typical codes:

- **`REGION_PROTECTED`** — deny inside `protect` for ad-hoc dig/place.
- **`REGION_OVERRIDE`** — allow inside `resource` despite global denylist.
- **`OUTSIDE_ALL_REGIONS`** — no region matched; global rules apply.

Use before long walks or before bulk edits. Contract: [`reference/bot/handler-contract-adr.md`](../../reference/bot/handler-contract-adr.md).

**Allowed dig (resource) — shape:**

```jsonc
{
  "ok": true,
  "dry_run": true,
  "data": {
    "region_decision": {
      "decision": "allow",
      "reason": "REGION_OVERRIDE",
      "winning_region": { "id": "mine1", "intent": "resource", "capabilities": { "allow_ad_hoc_dig": true } }
    }
  }
}
```

**Denied dig (protect) — shape:**

```jsonc
{
  "ok": false,
  "dry_run": true,
  "error": {
    "code": "REGION_PROTECTED",
    "retry_safe": true,
    "observed_state": { "region_decision": { "decision": "deny", "reason": "REGION_PROTECTED", ... } },
    "next_action_hint": "mc go_site :base1:/gate  # or leave region"
  }
}
```

## Enforcement in handlers

Region checks run **before** legacy `isDigProtected` in dig/place/collect paths so refusals emit `REGION_PROTECTED` with region id and hints. Collect may skip region-denied cells in bulk with `skipped_region` / `region_protected` tallies.

Implementation tree: `bot/lib/runtime/regions/` (`store.js`, `resolver.js`, `profiles.js`, sign watcher registered from `bot/lib/runtime/manager.js` on spawn).

Reactive layer may emit `region_entered` / `region_exited` on boundary cross (see archive reactive-layer doc).

## Worksite-scoped authority (Phase 1.8)

Temporary ad-hoc edit inside a **protect** region for one kanban card:

| Piece | Role |
|-------|------|
| Card `worksite: hut3` | Steward names allowed protect region |
| `mc task_context set hut3` | Binds grant to active task |
| Resolver `WORKSITE_GRANT` | Allows dig/place when grant matches winning protect region |
| `mc task_context clear` | Clear on card complete/block |

`mc check` and live dig/place share the same resolve args so dry-run matches execution.

## Automated tests

| Area | Tests |
|------|--------|
| Resolver fixtures | `bot/test/runtime/regions/scenarios.test.js`, `resolver-unit.test.js`, `profiles.test.js` |
| Store / HTTP | `store.test.js`, `integration/regions-endpoint.test.js` |
| CLI create/remove | `bot/test/actions/region-create-contract.test.js` |
| Dry-run | `bot/test/actions/check-dry-run.test.js` |
| Live enforcement | `bot/test/integration/region-protection.test.js`, `region-place-bulk-protection.test.js`, `regions-task-context.test.js` |
| Mining bulk | `mining-collect.test.js` (`REGION_PROTECTED`) |
| Sign path | `sign-directives.test.js`, `sign-watcher.test.js` (when sign stack enabled) |

## Known limitations (Phase 1)

- **Single-writer JSON:** multiple bots do not auto-invalidate in-memory region cache; treat admin as one writer until reload discipline improves.
- **Guided edit:** construct mode scopes `fill`/`place`/`dig` to a plan workset when `HERMES_CONSTRUCT_CONTEXT=1` (see [`construct-canary.md`](../../architecture/construct-canary.md)). Resolver guided branches exist; ad-hoc defaults apply when construct context is off.
- **LAN trust:** bot HTTP auth unchanged.

## Quick verification

```text
mc region_create :mine1: mine --r 12
mc regions --at <inside mine>
mc check dig <inside mine>          # allow / REGION_OVERRIDE
mc check dig <outside>              # OUTSIDE_ALL_REGIONS or global rules
mc region_create :test_protect: base --r 8
mc check dig <inside protect>       # REGION_PROTECTED
mc region_remove :test_protect: --confirm
```

Full Path A/B tables: [`designated-regions-verification.md`](./designated-regions-verification.md).

## Related

- [`blueprints-grabcraft.md`](./blueprints-grabcraft.md) — plan JSON, verify, RCON capture/paste, construct mode.
- [`architecture/bots-and-mc.md`](../../architecture/bots-and-mc.md) — fleet marks and regions authority.
- [`reference/mc-command-reference.md`](../../reference/mc-command-reference.md) — memory/building verb taxonomy.
