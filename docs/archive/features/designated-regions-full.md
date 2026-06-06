# Designated regions with maintenance rules (full archive)

> **Superseded for day-to-day use** by the trimmed spec
> [`docs/specs/world/designated-regions.md`](../../specs/world/designated-regions.md).
> This file keeps Phase 2/3 sketches, dashboard detail, milestones, and rollout checklists.

> Status: **Phase 1 implemented** (bot-driven create/remove, policy
> enforcement, `mc check`, dashboard discs, worksite task context).
> Live sign-off and Path A (sign sync) checks:
> Verification log: [`docs/specs/world/designated-regions-verification.md`](../../specs/world/designated-regions-verification.md).
> Placemarks: [`docs/specs/world/marks-sign-anchored.md`](../../specs/world/marks-sign-anchored.md).
>
> **Revision note (2026-05):** simplified for agent fit. Key changes
> from the prior draft:
>
> - regions are an attribute of a placemark (`:id:`), not a parallel
>   naming system
> - default geometry is a vertical **column** (X/Z disc + optional Y
>   bounds), not a sphere
> - region policy is exposed as observable **capability flags**
>   instead of an implicit type→policy mapping
> - new dry-run primitive `mc check <verb>` with full envelope
>   examples
> - `mc repair` and the future `mc construct` share a
>   `guided_edit_progress` envelope
> - **named sites** declared as `site:name=x,y,z` directives on the
>   parent placemark sign — no secondary signs
> - **bot-driven creation** via `mc region create` / `mc site add`
>   (bots cannot reliably write sign text), with a third
>   `unanchored` status for regions that exist in the registry
>   before any sign anchors them
> - reactive `region_entered` / `region_exited` events on the
>   reactive layer
> - dashboard 2D map renders region discs, sites, and status overlays
> - damage detection (Phase 2) deferred until per-edit attribution
>   exists in multi-bot worlds

## Context

Recurring problem: the bot accidentally damages base, farms, and other
built structures while doing normal chores — breaking cobble out of a
wall while looking for ore, chopping a planted tree, leaving creeper
holes unfilled. The existing `isDigProtected()` deny-list in
`bot/lib/runtime/dig-tools.js` catches specific block names globally,
but it can't tell "the cobble in the foundation of the base" from
"the cobble in a vein 200b away" — so it either refuses too much
(blocking real mining) or too little (Steve breaks a wall).

We rejected per-block attribution last time ("a lot of tracking").
The better framing: **regions of in-world space, each with a
purpose (base / farm / dock / mine), each with rules**. Inside a
base region we forbid breaking the structure blocks AND we actively
detect & repair damage (creeper holes, broken fences). Inside a mine
region we explicitly allow what's forbidden elsewhere. Outside any
region the bot behaves as today.

This also unblocks **pending task #34** (mining ergonomics — stance,
auto-clear, block-placement): those workstreams need permission to
edit terrain freely, which is exactly what a `mine` region grants.

The existing sign-anchored placemarks idea
([`sign-anchored-placemarks.md`](../../specs/world/marks-sign-anchored.md),
currently draft) is the right interface: a player places a sign
in-world, the bot reads it, the region is created. Simple, visible,
owned by the world.

## Approach

Three phases. Phase 1 is the MVP and gives ~80% of the value. Phases
2 and 3 are sketches.

### Region model (shared by all phases)

A region is an **annotation on an existing placemark** (see
[`sign-anchored-placemarks.md`](../../specs/world/marks-sign-anchored.md)).
The placemark's `:id:` and sign position are the region's identity
and anchor; the region row adds geometry, policy, and sites.

Region rows live in `data/regions-<world>.json`:

```js
{
  id: 'base1',                          // matches placemark :base1:
  intent: 'protect'|'resource'|'marker',// behavior class
  profile: 'base'|'farm'|'dock'|'mine', // optional defaults bundle
  anchor: { x, y, z },                  // mirrored from placemark
  shape: {
    kind: 'column',                     // default: X/Z disc, infinite Y
    radius: 24,
    y_min: null,                        // optional Y bounds (null = infinite)
    y_max: null,
  },
  sites: { tower: {x,y,z}, entrance: {x,y,z} }, // optional sub-anchors
  capabilities: { ... },                // resolved at load; see below
  status: 'active' | 'orphaned' | 'unanchored', // unanchored = bot-created, no sign yet
  created: <iso>,
  notes: '<inherited from placemark description>',
}
```

The placemark id is the only name; there is no parallel
`<type>:<name>` namespace. Cross-world uniqueness is the placemark
registry's concern.

### Intent and profile

`intent` is the primary axis the agent reasons about. There are
exactly three:

| intent | meaning | typical default behavior |
|---|---|---|
| `protect` | preserve everything inside | dig denied (with tolerances), place denied |
| `resource` | a place we operate intensively | dig allowed (can override global denylist), place allowed |
| `marker` | memory/context only | enforces nothing |

`profile` (optional) selects a defaults bundle — block-name
tolerances and which capability flags flip. Profiles never invent
new intents.

| profile | default intent | notes |
|---|---|---|
| `base` | protect | structure-style block tolerances |
| `farm` | protect | mature-crop harvesting allowed |
| `dock` | protect | tolerates seagrass/kelp regrowth |
| `mine` | resource | overrides global denylist except containers |

Block-name details live in `bot/lib/runtime/regions/profiles.js` and
are editable without touching the resolver.

### Capability flags (agent-visible)

Each region resolves to a set of capability flags at load time.
**These are the public contract** — the agent reads them rather than
inferring policy from `intent` or `profile`. Surfaced verbatim in
every `mc regions --at` response.

| flag | typical for `protect` | typical for `resource` |
|---|---|---|
| `allow_ad_hoc_dig` | false | true |
| `allow_ad_hoc_place` | false | true |
| `allow_guided_edit` | true | true |
| `allow_harvest` | profile-dependent | true |
| `overrides_global_denylist` | false | true |

Anything more granular than these flags (specific block-name
tolerances) is profile data and surfaces as a `notes` string, not
as a separate flag the agent has to learn.

### Geometry: column by default

The default shape is a **vertical column over an X/Z disc**. Bases
are columns, not balls — a sphere `r=24` excludes a watchtower at
`y+25` and includes bedrock at `y-24`, which is wrong for almost
every real base.

Shapes available in v1:

- `column` (default): `{ kind:'column', radius, y_min?, y_max? }`.
  Both bounds null = infinite Y.
- `sphere`: `{ kind:'sphere', radius }` — kept available for cases
  where it genuinely fits, not the default.

(Polygon and bounding-box shapes remain Phase 3, unchanged.)

### Sites: named sub-anchors (parent-sign directives)

Inside a region, an optional `sites` map names sub-locations. This
lets missions reference "the tower at base" or "the mine entrance"
without raw coordinates:

```text
:base1:/tower
:mine1:/entrance
```

**Sites are declared on the parent placemark sign**, not on
secondary signs. A separate sign per site adds in-world clutter and
brittleness (creeper breaks one site sign and the rest of the
region is fine). The directive form keeps the region's geometry
**and** its named landmarks in one place the player owns:

```text
:base1: main base
region=base
r=24
y=55..120
site:tower=350,72,-540
site:storage=348,63,-535
site:gate=346,64,-528
```

Format: `site:<name>=<x>,<y>,<z>`.

- `<name>` matches `[a-z0-9]{2,12}`.
- Coordinates are absolute world coords. (We could add region-local
  coords later if it earns its space; not in v1.)
- Site coords are **not** required to be inside the region's shape
  — useful for "the dock that belongs to this base" cases — but
  `mc regions` flags out-of-region sites in its summary.

Sites resolve through every action that takes a placemark id
(`mc goto :base1:/tower`, `mc construct --site :base1:/tower`,
etc.) and inherit their parent region's capabilities.

### Bot-driven creation (no sign-writing required)

Bots **cannot reliably write sign text** on the current
Mineflayer/server stack (see the spike in
[`sign-anchored-placemarks.md`](../../specs/world/marks-sign-anchored.md)). To
let bots create regions and sites without depending on that spike,
the registry has its own write commands. These mutate the registry
directly and do **not** place or modify any sign.

| Verb | Effect |
|---|---|
| `mc region create :id: <profile> [--r N] [--y min..max] [--intent X]` | Creates a region row with no in-world anchor sign. Status = `unanchored`. |
| `mc region remove :id:` | Removes a region (orphaned or otherwise). Requires explicit confirmation flag. |
| `mc site add :id:/<name> X Y Z` | Adds a site to an existing region. |
| `mc site remove :id:/<name>` | Removes a site. |

Three statuses a region can have:

| status | sign in world? | enforcement | how to reach it |
|---|---|---|---|
| `active` | yes (placemark sign present, matches `:id:`) | full | player places sign with `region=…`, or `mc region create` + player later places a matching `:id:` sign |
| `orphaned` | was, now missing | full | the placemark sign was destroyed |
| `unanchored` | never had one | full | `mc region create` by a bot, before any sign exists |

Enforcement is identical across all three statuses — region safety
does not depend on the sign existing right now. The sign is the
**player-owned, in-world view** of the registry; the registry is
the source of truth.

When a player later places a placemark sign whose `:id:` matches an
`unanchored` region, the sign-watcher promotes the region to
`active` and updates the anchor to the sign's position. Any region
directives on that sign override the registry values (player wins),
otherwise the registry values stay.

This means a bot can say in chat:

```text
mc chat "set up a temporary protect region :mine1: r=12 around me"
mc region create :mine1: mine --r 12
```

…and the region works immediately, no sign required. The player
can later place a sign at the mine entrance to anchor it visually.

### Sign syntax (region directive on a placemark sign)

A region is born from an existing placemark sign. The same sign
that defines `:base1:` adds region directives on subsequent lines:

```text
:base1: main base
region=base
r=24
y=60..80
```

- `region=<profile>` is the only required directive to promote a
  placemark to a region. The profile picks the default intent.
- `r=<radius>` defaults to 16 if omitted.
- `y=<min>..<max>` optional; bounds Y for `column` shapes.
- `intent=<intent>` overrides the profile's default intent
  (e.g. `region=base intent=marker` for an "I labeled this but
  don't protect it" region).
- `shape=sphere` opt-in to spherical geometry.
- `site:<name>=<x>,<y>,<z>` declares a named sub-anchor (see Sites
  above). Repeat the directive for each site; no secondary signs.

Sign length is finite. If site directives overflow what fits on a
sign, declare the remainder via `mc site add` from a bot or via a
future "extended description" placemark (out of scope for v1).

If the placemark sign is removed (creeper, fire, accident) but the
region row exists, the region enters `status: 'orphaned'`.
Protections **stay in force**; `mc regions` flags the region for
attention. Explicit removal requires `mc region remove :base1:`.
This prevents an accidental sign loss from silently disabling base
protection.

## Phase 1 (MVP) — passive protection + agent awareness

Goal: stop the bot from breaking base/farm/dock blocks, and let it
mine freely inside designated mines. No active repair yet.

### Milestones and build order

Phase 1 ships in seven milestones, each with concrete deliverables
and a verifiable acceptance criterion. Each milestone leaves the
existing test suite green (currently 605/605) and adds its own
tests. **No milestone is "shipped" until its acceptance criterion
passes.**

Dependency graph:

```text
1.0 (validation harness + resolver)
   ├─ 1.1 (store + read endpoint + mc regions)
   │     ├─ 1.2 (bot-driven create)
   │     ├─ 1.3 (mc check)
   │     │     └─ 1.4 (enforcement hooks)
   │     ├─ 1.5 (sign watcher)
   │     └─ 1.6 (dashboard, parallelizable from here)
   └─ 1.7 (agent prompt + envelope polish, last)
```

#### Milestone 1.0 — Validation harness + resolver (pure JS)

Builds the policy contract before any production code touches the
bot.

- **Deliverables:**
  - `bot/lib/runtime/regions/resolver.js` (no Mineflayer deps)
  - `bot/lib/runtime/regions/profiles.js`
  - `bot/test/runtime/regions/fixtures/scenarios.json`
  - `bot/test/runtime/regions/scenarios.test.js`
- **Verifiable:**
  - `./scripts/run-tests.sh --bot` reports the new scenario test
    file passing; existing 605/605 unchanged.
  - Fixture file covers all 10 scenarios listed in the harness
    section, including `unanchored` status.
- **Blocks:** everything else in Phase 1. Do not start 1.1 until
  this lands.

#### Milestone 1.1 — Store + read endpoint + `mc regions` (no enforcement)

Read-only surface. No protections wired yet.

- **Deliverables:**
  - `bot/lib/runtime/regions/index.js` (store + load/save)
  - `data/regions-<world>.json` created on first write
  - GET `/regions` endpoint in `bot/lib/server/http-app.js`
  - `mc regions [--at x,y,z]` verb in `bot/cli/registry.mjs`
  - `regions_here` field added to `/status` + `/observe`
    (lean and full)
  - `ctx.runtime.regions` field in
    `bot/lib/server/state.js` `createRuntimeState()`
- **Verifiable:**
  - With a hand-crafted `regions-<world>.json` containing a
    `protect` region: `mc regions` lists it, `mc regions --at X Y Z`
    returns capabilities, `mc status` includes the region in
    `regions_here` when the bot is inside.
  - `mc dig` still works exactly as before (no enforcement yet).
  - 605/605 still green; new endpoint tested in
    `bot/test/integration/listener-health.test.js` style.

#### Milestone 1.2 — Bot-driven creation (`mc region create` / `mc site add`)

Unblocks all later milestones from depending on the sign-watcher
spike.

- **Deliverables:**
  - `bot/lib/actions/regions/create.js`
  - `bot/lib/actions/regions/sites.js`
  - CLI verbs: `mc region create/remove`, `mc site add/remove`
  - All four verbs route through standard action envelope
    (`fail()` / `ok()` from `shared/action-contract.js`).
- **Verifiable:**
  - `mc region create :test1: mine --r 8` writes a region;
    `mc regions` lists it with `status: unanchored`.
  - `mc site add :test1:/door 100 64 100` adds the site;
    visible in `mc regions`.
  - `mc region remove :test1: --confirm` removes it.
  - Refusal envelopes use stable codes
    (`INVALID_ID`, `REGION_EXISTS`, `REGION_NOT_FOUND`,
    `MISSING_CONFIRM`).

#### Milestone 1.3 — `mc check <verb>` dry-run primitive

Ship the dry-run BEFORE enforcement so we can test the resolver
against real action paths without breaking blocks.

- **Deliverables:**
  - `bot/lib/actions/observe/check.js`
  - `mc check <verb> [args]` verb (initially supports `dig` and
    `place`)
  - Shared envelope shape with `dry_run: true` flag (see
    "Envelope shape" section below)
- **Verifiable:**
  - `mc check dig X Y Z` inside an `unanchored` region (created
    via 1.2) returns a `REGION_PROTECTED` envelope.
  - `mc check dig X Y Z` outside any region returns
    `decision: allow` with no side effects.
  - Snapshot test: state of `ctx.runtime.recentDigFailures`
    is unchanged before and after `mc check` runs.
  - No block in the world is broken or placed by any
    `mc check` invocation.

#### Milestone 1.4 — Enforcement hooks in `mc dig` and `mc place`

Wire the resolver into the real action handlers.

- **Deliverables:**
  - Region check in `bot/lib/actions/mining/dig.js` before
    `isDigProtected`
  - Region check in `bot/lib/actions/building/place-single.js`
    before inventory check
  - Region check in the four `isDigProtected` filter loops in
    `bot/lib/actions/excavation.js`
  - Region check in `bot/lib/actions/building/terrain.js`
  - Region check in `bot/lib/actions/building/pillar.js`
  - `bot/test/integration/region-protection.test.js`
- **Verifiable:**
  - **Parity test:** for each of dig and place, run `mc check`
    then the real verb on the same target. Envelope codes and
    `winning_region.id` must match byte-for-byte (excluding the
    `dry_run` flag).
  - Inside a `protect` region: `mc dig cobblestone` returns
    `REGION_PROTECTED`. No block broken (verified by reading the
    block back).
  - Outside any region: `mc dig cobblestone` succeeds (preserves
    existing behavior).
  - Inside a `resource` region with `overrides_global_denylist`:
    `mc dig <globally-protected-block>` succeeds.
  - All other action-contract tests remain green.

#### Milestone 1.5 — Sign watcher (player-driven creation)

Adds the visible in-world surface. Independent from enforcement;
can ship in parallel with 1.4 if 1.2 is done.

- **Deliverables:**
  - `bot/lib/runtime/regions/sign-directives.js` (parser)
  - `bot/lib/runtime/regions/sign-watcher.js`
  - Hook from `bot/lib/runtime/manager.js` spawn callback
- **Verifiable:**
  - Place a sign with valid region directives → bot observes the
    `blockUpdate` event → `mc regions` lists the new region with
    `status: active`.
  - Break the sign → `mc regions` reports `status: orphaned`,
    enforcement still active (verify with `mc dig` returning
    `REGION_PROTECTED`).
  - Place a sign matching an existing `unanchored` region id →
    region promotes to `active`, anchor updates to sign position.
  - Sign directive parser unit tests: accepts the documented
    format, rejects malformed input with a clear error.

#### Milestone 1.6 — Dashboard map integration

Visual surface for operators. Can ship in parallel with 1.4–1.5
once 1.1 is done.

- **Deliverables:**
  - `/regions` proxy in `dashboard/server.js`
  - Region disc rendering in `dashboard/static/app.js`
    `renderMap()`
  - New hit-target kinds `region` and `site`
  - Inspector panel: capabilities + sites + "preview policy here"
    button that calls `mc check`
- **Verifiable:**
  - Existing `bot/test/runtime/water-route.test.js`-style test
    pattern adapted: render the map with a synthetic region
    payload, assert hit-target list contains a `region` kind.
  - Manual smoke: create a region via 1.2 → reload dashboard →
    see the disc on the map with the correct color for its intent.

#### Milestone 1.7 — Agent surface polish

Last; depends on the envelope being final.

- **Deliverables:**
  - `prompts/landfolk/steve.md` "Respecting regions" section
  - `next_action_hint` quality pass for every `REGION_PROTECTED`
    envelope (concrete `mc check` or `mc goto :id:/gate` hints)
  - `regions_here` capability flag rename audit
- **Verifiable:**
  - Manual prompt-eval session: Steve in `:base1:` is asked to
    "dig cobblestone for the chest". He reads `regions_here`,
    declines or moves outside, **does not retry the same cell
    more than once**.
  - Smoke check against `mc-cheatsheet.md` patterns — no stale
    references to deny-list-only protection.

### New module: `bot/lib/runtime/regions/`

**`index.js`** — public API:

- `createRegionStore({ dataDir, world })` — same signature as
  `createLocationsStore({ dataDir, username })` in
  `bot/lib/runtime/locations.js`. Note: `createLocationsStore` is
  **per-bot** (keyed by `username`); the region store must be
  **per-world** (shared across bots on the same world). Signature
  differs intentionally.
- `regions.list()` — all regions for this world.
- `regions.at(x, y, z)` — regions whose volume contains the point.
- `regions.resolve(verb, args, position, block, ctx)` →
  decision object (see below). One resolver used by every action.
- `regions.upsertFromPlacemark(placemark)` — derive region from
  placemark + region directives.
- `regions.removeById(id)` — explicit removal.

The store file lives at `data/regions-<world>.json` (world-scoped,
not bot-scoped) and is loaded/saved with the same atomic-write
pattern as `createLocationsStore` (read file → mutate → write).

**`profiles.js`** — profile defaults table (block-name details +
which capability flags flip). Exports `PROFILES` and helpers
`applyProfile(region)`, `isProtectedInRegion(blockName, region)`,
`isToleratedBreak(blockName, region)`.

Note: block-name sets in `PROFILES` must **not** overlap with or
try to replace `PROTECTED_DIG_BLOCKS` in `dig-tools.js`. Region
profiles layer on top; the global denylist still applies unless
`overrides_global_denylist` is true.

**`resolver.js`** — pure decision function with no Mineflayer
dependency. Same module used by the standalone validation harness
(see below).

### Resolver decision shape

```js
{
  decision: 'allow' | 'deny',
  reason: 'REGION_PROTECTED' | 'REGION_OVERRIDE'
        | 'OUTSIDE_ALL_REGIONS' | 'INTENT_MARKER_NOOP' | ...,
  winning_region: { id, intent, profile, capabilities },
  losing_regions: [ { id, intent } ],   // overlapping regions not selected
  matched_capability: 'allow_ad_hoc_dig' | 'allow_guided_edit' | ...,
  notes: '<profile-specific tolerance hint, optional>',
}
```

Overlap precedence is **observable**, not buried in code:

1. `resource` intent beats `protect` intent for actions the resource
   region allows.
2. Within the same intent class, the smaller-radius region wins
   (most specific).
3. Ties broken by most recently updated.

`mc regions --at x,y,z` returns the same shape as a preview, so the
agent can predict outcomes without acting.

### New primitive: `mc check <verb> [args]`

Side-effect-free dry-run. Returns the envelope the real verb would
emit, including refusal envelopes. Cheap (no LLM, no world edit).

Used by the agent to:

- predict refusals before walking 200 blocks to a target
- validate a `mc construct` plan against current region policy
- choose between two candidate sites

`mc check` is the agent-friendly equivalent of asking "if I did X
here, what would happen?" without consuming a turn on a real
attempt.

#### Envelope shape

`mc check` always returns the **same envelope** the real verb
would return, plus a top-level `dry_run: true` field. Two examples:

**Allowed dig inside a resource region:**

```jsonc
{
  "ok": true,
  "dry_run": true,
  "verb": "dig",
  "args": { "x": 100, "y": 40, "z": 100 },
  "data": {
    "would_break": { "block": "stone", "cell": { "x": 100, "y": 40, "z": 100 } },
    "region_decision": {
      "decision": "allow",
      "reason": "REGION_OVERRIDE",
      "winning_region": {
        "id": "mine1",
        "intent": "resource",
        "profile": "mine",
        "status": "active",
        "capabilities": {
          "allow_ad_hoc_dig": true,
          "allow_ad_hoc_place": true,
          "allow_guided_edit": true,
          "overrides_global_denylist": true
        }
      },
      "losing_regions": [],
      "matched_capability": "allow_ad_hoc_dig"
    }
  }
}
```

**Denied dig inside a protect region:**

```jsonc
{
  "ok": false,
  "dry_run": true,
  "verb": "dig",
  "args": { "x": 348, "y": 62, "z": -540 },
  "error": {
    "code": "REGION_PROTECTED",
    "message": "dig refused: cobblestone at 348,62,-540 is inside :base1: (profile=base, intent=protect). ad-hoc dig not allowed.",
    "retry_safe": true,
    "observed_state": {
      "region_decision": {
        "decision": "deny",
        "reason": "REGION_PROTECTED",
        "winning_region": {
          "id": "base1",
          "intent": "protect",
          "profile": "base",
          "status": "active",
          "capabilities": {
            "allow_ad_hoc_dig": false,
            "allow_ad_hoc_place": false,
            "allow_guided_edit": true,
            "overrides_global_denylist": false
          },
          "sites": ["tower", "storage", "gate"]
        },
        "losing_regions": [],
        "matched_capability": "allow_ad_hoc_dig"
      },
      "block": "cobblestone",
      "cell": { "x": 348, "y": 62, "z": -540 }
    },
    "next_action_hint": "mc goto :base1:/gate   # leave region first, or use mc repair if this is damage"
  }
}
```

Both shapes match the standard action envelope contract
(see [`docs/reference/bot/handler-contract-adr.md`](../../reference/bot/handler-contract-adr.md))
so the agent's existing reading code applies without changes.

### Hook into existing dig path

The integration has two separate call sites, which the plan must
address independently because `isDigProtected` is used differently
in each place.

**1. `bot/lib/actions/mining/dig.js`** — calls `isDigProtected`
directly at line 103 and returns a `PROTECTED_BLOCK` envelope. This
is the primary user-facing refusal. Region check goes here, before
the existing call, to emit the new `REGION_PROTECTED` code with
richer detail instead of the generic `PROTECTED_BLOCK` code:

```js
// Region check (new, runs before the global denylist check)
if (ctx.runtime?.regions) {
  const r = ctx.runtime.regions.resolve('dig', { ad_hoc: true }, cell, target.name, ctx);
  if (r.decision === 'deny') {
    recordDigFailure('REGION_PROTECTED');
    return fail('REGION_PROTECTED', `Cannot dig ${target.name} — inside region :${r.winning_region.id}: (${r.winning_region.intent})`, {
      retry_safe: false,
      observed_state: { region: r.winning_region, matched_capability: r.matched_capability, block: target.name, cell },
      next_action_hint: `mc check dig ${cell.x} ${cell.y} ${cell.z}`,
    });
  }
  // Resource region can lift the global denylist
  if (r.winning_region?.capabilities.overrides_global_denylist) {
    // skip global isDigProtected below
    goto postProtectionCheck;
  }
}
if (isDigProtected(target.name, { x, y, z }, ctx)) { ... }
postProtectionCheck:
```

Note: `fail()` is already imported from `../../shared/action-contract.js` in `dig.js`, and `recordDigFailure` is defined as a closure at the top of the `dig` function — both can be used directly.

**2. `bot/lib/actions/excavation.js`** — calls `isDigProtected` at
four locations (lines 134, 339, 552, 690 confirmed by code
inspection). Each is a filter inside a loop, not a user-facing
refusal, so the integration style is different: call
`regions.resolve` inline in each filter and skip the block if denied.

**3. `bot/lib/actions/building/place-single.js`** — imports
`isDigProtected` for the `RELOCATABLE_INFRASTRUCTURE` path only,
not for general placement protection. `mc place` needs its own
region check added **before** the inventory check:

```js
if (ctx.runtime?.regions) {
  const r = ctx.runtime.regions.resolve('place', { ad_hoc: true }, { x, y, z }, blockName, ctx);
  if (r.decision === 'deny') {
    return fail('REGION_PROTECTED', `Cannot place ${blockName} — inside region :${r.winning_region.id}: (${r.winning_region.intent})`, {
      retry_safe: false,
      observed_state: { region: r.winning_region, matched_capability: r.matched_capability, block: blockName, cell: { x, y, z } },
      next_action_hint: `mc check place ${blockName} ${x} ${y} ${z}`,
    });
  }
}
```

**4. `bot/lib/actions/mining/collect/index.js`** — code inspection
shows `isDigProtected` is **not called here**. The collect action
drives `mc dig` internally, so protection already applies through
path 1 above. No direct integration needed in collect itself.

**`ctx.runtime.regions` is the shared accessor.** It must be
initialised in `createRuntimeState()` in `bot/lib/server/state.js`
(or lazily set at startup), not threaded through function args.
This matches how `ctx.runtime.recentPlaces` is already accessed
by `isDigProtected`. The region store is passed in at startup:

```js
// in server.js startup, after loading regions:
ctx.runtime.regions = createRegionStore({ dataDir, world });
```

Refusal envelope shape (same for dig and place):

```js
{
  code: 'REGION_PROTECTED',
  message: '...',
  retry_safe: false,
  observed_state: {
    region: { id, intent, profile, capabilities },
    matched_capability: 'allow_ad_hoc_dig',  // or allow_ad_hoc_place
    block: name,
    cell,
  },
  next_action_hint: 'mc check dig X Y Z',
}
```

### Sign discovery

Mineflayer fires events for block updates. Bot event listeners are
registered in `bot/lib/runtime/manager.js` inside the `spawn`
callback (confirmed by code inspection — all `bot.on(...)` calls
are made there after the bot is ready). The sign-watcher must
register its listeners in the same place, injected as a setup step
alongside the existing `chat`, `health`, and `blockBreakProgressObserved`
listeners.

Add `bot/lib/runtime/regions/sign-watcher.js` and call it from
`manager.js` after bot spawn:

```js
// in manager.js, after existing bot.on() registrations:
if (ctx.runtime.regions) {
  setupRegionSignWatcher(ctx.world.bot, ctx.runtime.regions);
}
```

`setupRegionSignWatcher` subscribes to:

- **`blockUpdate`**: if the updated block was a sign whose
  position matches a region anchor, re-parse (sign edited) or
  set `status: 'orphaned'` (sign broken).
- **On-demand chunk scan**: a one-time pass over loaded chunks
  at spawn to pick up pre-existing signs. Use
  `bot.world.getColumn(cx, cz)` to iterate loaded chunk
  columns — there is no `chunkColumnLoad` event emitted for
  already-loaded chunks at login time; a scan is needed
  instead.

For **newly placed signs** (player places a region sign while
bot is running): the `blockUpdate` event fires when a sign is
placed. Parse the text via `bot.blockAt()` after the event.

Best-effort: if a chunk unloads and a sign there is later
destroyed, the bot won't observe it. The `orphaned` status and
"enforcement without the sign" design means this is safe —
protection continues until explicitly removed.

Note: `chunkColumnLoad` is an event available in some versions
but not reliable across all protocol versions the bot targets.
**Do not rely on it.** Use `blockUpdate` + initial spawn scan.

### Surface to the agent

- `mc regions [--at x,y,z]` — lists regions sorted by distance,
  each entry includes `id`, `intent`, `profile`, resolved
  `capabilities`, and `sites`. With `--at`, also returns the
  resolver preview for that point.
- `/status` and `/observe` include `regions_here: [{ id, intent,
  profile, capabilities }]` when the bot is inside ≥1 region. The
  agent reads capabilities directly — no inference from `profile`.
- `mc check <verb> [args]` (new) — dry-run preview for any
  policy-aware action.
- **Reactive events** (Phase 2 of
  [`reactive-layer.md`](../phase-2-design/reactive-layer.md)):
  emit `region_entered` and `region_exited` when the bot crosses a
  boundary. Lets the agent switch mode at the edge (mining stance
  on entry to `:mine1:`, etiquette on entry to `:base1:`) without
  polling `/status`.
- Refusal envelopes name the region id, the matched capability,
  and a concrete `mc check` hint so the agent can iterate without
  guessing.
- Prompt update: `prompts/landfolk/steve.md` gets a short
  "Respecting regions" section naming the three intents and the
  capability flags. The body enforces; the prompt just informs.

### Tests by milestone

This table maps each automated test to the milestone it gates,
ensuring nothing ships without coverage. All tests live under
`bot/test/`.

| Milestone | Test file | Asserts |
|---|---|---|
| 1.0 | `runtime/regions/scenarios.test.js` | Resolver matches fixture expectations for every scenario in `scenarios.json` |
| 1.0 | `runtime/regions/resolver-unit.test.js` | Column containment (infinite/bounded Y), sphere containment, overlap precedence |
| 1.0 | `runtime/regions/profiles.test.js` | Profile defaults apply correctly; capability flags stable |
| 1.1 | `runtime/regions/store.test.js` | `upsertFromPlacemark` + `removeById` round-trip; atomic write |
| 1.1 | `integration/regions-endpoint.test.js` | GET `/regions` returns the expected shape; `mc regions --at` resolves |
| 1.2 | `actions/region-create-contract.test.js` | `mc region create/remove`, `mc site add/remove` return stable error codes |
| 1.3 | `actions/check-dry-run.test.js` | `mc check dig` matches the real envelope; no side effects (`recentDigFailures` unchanged) |
| 1.4 | `integration/region-protection.test.js` | Dig refused inside `protect`; allowed in `resource`; parity with `mc check` |
| 1.4 | `integration/region-place-protection.test.js` | Place refused inside `protect`; allowed in `resource` |
| 1.5 | `runtime/regions/sign-directives.test.js` | Parser accepts valid directives, rejects malformed |
| 1.5 | `runtime/regions/sign-watcher.test.js` | Sign placed → region active; sign broken → status orphaned |
| 1.6 | `dashboard/regions-render.test.js` (in `dashboard/test/`) | `renderMap()` produces region disc + site hit-targets from synthetic payload |
| 2a | `runtime/regions/edit-log.test.js` | Self-attribution; cross-bot attribution; environment fallback |
| 2b | `runtime/regions/damage-detector.test.js` | Suppresses attributed edits; fires on environment edits |
| 2c | `integration/repair-flow.test.js` | `mc repair` restores damaged cells; `materials_missing` populated when inventory empty |
| 2d | `runtime/regions/guided-envelope.test.js` | `guided_edit_progress` shape stable across `mc repair` and `mc check repair` |

The 605/605 existing test count must remain green after every
milestone. New tests are additive.

### Live verification

```text
# --- Path A: player-driven (sign) ---
# Place a placemark sign at (350,64,-540) reading:
#   :base1: main base
#   region=base
#   r=24
#   y=55..120
#   site:tower=350,72,-540
#   site:gate=346,64,-528
mc regions                       # lists :base1: status=active + sites
mc check dig 348 62 -540         # preview: REGION_PROTECTED, no break
mc dig 348 62 -540               # REGION_PROTECTED envelope
mc dig 200 62 -540               # outside region → ok
mc goto :base1:/tower            # routes to declared site coords

# --- Path B: bot-driven (no sign needed) ---
mc region create :mine1: mine --r 32
mc site add :mine1:/entrance 100 41 100
mc regions                       # :mine1: status=unanchored, fully enforced
mc check dig 100 40 100          # preview: allow (resource override)
mc dig 100 40 100                # stone in mine → ok even if globally protected

# Player later places a sign matching :mine1: → status promotes to active.
# Player breaks the :base1: sign → status flips to orphaned, protection stays.
mc region remove :base1: --confirm   # explicit removal required
```

## Phase 2 — damage detection + repair (revised order)

Damage detection requires per-edit attribution. Without it, in any
multi-bot world a repair by bot A fires a "damage" alert at bot B.
Ship in this order. Each milestone follows the same Deliverables /
Verifiable contract as Phase 1.

### 2a. Edit log (prerequisite)

Small ring buffer of every world edit observed in loaded chunks:

```js
{ actor: 'steve'|'mason'|'player:<name?>'|'environment',
  ts, cell, before, after, attribution_confidence }
```

Attribution sources (best-effort, ordered):

1. The bot itself: 100% confidence when the edit comes from a
   handler completion (`mc dig`, `mc place`, `mc repair`).
2. Other bots: via the existing in-process event bus when multiple
   bots run in the same process; remote bots are `unknown`.
3. Players: heuristic — any player within ~6 blocks at the edit
   instant gets attributed with low confidence.
4. Everything else: `environment` (creepers, fire, fall damage,
   piston physics, etc.).

The edit log is the foundation for damage detection **and** future
audit ("who broke the door?"). It replaces the prior
`recentPlaces` exemption with something both bots can share.

- **Deliverables:**
  - `ctx.runtime.regionEditLog` field added to
    `createRuntimeState()` (bounded ring buffer, lazy decay).
  - `recordEdit({actor, cell, before, after})` helper called from
    `dig.js`, `place-single.js`, `excavation.js` on successful
    edit completion.
  - `blockUpdate` listener wired in `manager.js` that records
    unattributed edits as `environment`.
- **Verifiable:**
  - Two bots in the same process: bot A digs a cell, bot B's edit
    log shows the edit with `actor: 'steve'` (or whatever A's
    name is), not `environment`.
  - Solo bot blows up a creeper near a sign → edit log records
    `actor: 'environment'`.
  - Unit test: ring buffer cap and TTL behave like
    `recentPlaces`.

### 2b. Damage detection

After 2a is in place:

- On `blockUpdate` inside any region, consult the edit log. If the
  edit was attributed to a known bot or recent player, suppress.
- If unattributed or attributed to `environment`, record a
  `damage_entry` keyed by `region.id`.
- Surface via `buildTypedAlerts()` with `type: 'area_damaged'` and
  fields `{ region_id, count, sample_cells, repair_blocks_needed }`.

- **Deliverables:**
  - `regions/damage-detector.js` module.
  - `area_damaged` alert type added to `buildTypedAlerts()`.
- **Verifiable:**
  - Bot A repairs a hole inside `:base1:` → bot B does not see an
    `area_damaged` alert for that cell.
  - A creeper destroys a fence inside `:base1:` → both bots see
    `area_damaged` listing the cell.
  - No false positives from the bot's own `mc dig` of a tolerated
    block (e.g. crops in a farm region).

### 2c. `mc repair [region]`

Orchestrates repair using the shared guided-edit envelope (below).
Phases: `plan → gather → place → verify`.

- **Deliverables:**
  - `mc repair [region]` verb routing through
    `plan → gather → place → verify`.
  - `region_decision` consulted at each `place` step
    (guided edit path; `allow_guided_edit` must be true).
- **Verifiable:**
  - Smoke test: drop dirt blocks from a `:farm1:` fence (manually
    via raw HTTP or world-edit), then run `mc repair :farm1:` →
    fence restored, alert clears.
  - Inventory-empty path: `mc repair` returns
    `materials_missing` populated, completes the cells it could,
    no crash.

### 2d. Shared envelope: `guided_edit_progress`

Both `mc repair` and the future `mc construct` emit this. One
shape, one prompt:

```js
{
  total_cells: N,
  done_cells: N,
  materials_needed:  [ { name, count } ],
  materials_missing: [ { name, count } ],
  blocked_cells:     [ { cell, reason } ],   // e.g. occupied by an entity
  current_phase: 'plan'|'gather'|'place'|'verify'|'done',
  next_step: '<short description>',
}
```

The agent learns this shape once and reuses it across every guided
edit verb that ships later.

- **Deliverables:**
  - Envelope freeze: the shape is documented in
    [`docs/reference/bot/handler-contract-adr.md`](../../reference/bot/handler-contract-adr.md)
    before any consumer ships.
  - Both `mc repair` and `mc check repair` return this shape.
- **Verifiable:**
  - Snapshot test: `mc check repair :base1:` and `mc repair
    :base1:` produce envelopes with identical fields.
  - Schema test: the shape conforms to the documented spec; new
    fields are additive only.

### 2e. Auto-repair (optional, gated)

A reactive event `auto_repair_started` for trivial cases (single
dirt hole in grass, dirt available in inventory). Off by default;
agent enables via `mc mode auto_repair=on`.

- **Deliverables:**
  - `mc mode auto_repair=on|off` verb wired into `ctx.runtime`.
  - Reactive handler in `bot/lib/runtime/reactive.js` that emits
    `auto_repair_started` and runs the same guided-edit pipeline.
- **Verifiable:**
  - With `auto_repair=off` (default): an area_damaged alert
    fires, no automatic action taken.
  - With `auto_repair=on`: trivial cases (single dirt-in-grass
    hole, materials in inventory) are repaired without an explicit
    `mc repair` call; `auto_repair_started` reactive event
    visible in `mc observe`.

## Phase 3 (sketch) — richer regions

- **Polygonal shapes**: sign directive `polygon=x1,z1;x2,z2;x3,z3`
  (cylinder over a 2D polygon with a Y range). Containment via
  ray-casting test.
- **Multi-sign regions**: two signs defining opposite corners of a
  box, named the same → bounding-box region.
- **Per-region overrides**: sign directive `protect+=ladder` or
  `tolerate+=oak_log` to tweak the static policy.
- **Region templates / inheritance**: `type=base+nether` for
  variants.
- **Visualization**: `mc regions --render` paints region edges in
  the dashboard FPV.

## Mining task #34 integration

Task #34's workstreams 2-4 (stance, auto-clear, block-placement)
become natural follow-ups inside any region with
`overrides_global_denylist` set (in practice: the `mine` profile):

- **Stance**: when starting `mc collect` inside such a region, allow
  the ergonomic stance helpers freely; outside, refuse risky stances
  near regions.
- **Auto-clear**: `mc dig_area` consults the resolver's
  `overrides_global_denylist` capability rather than checking a
  hard-coded type string.
- **Block-placement**: `mc place` inside a region with
  `allow_ad_hoc_place` skips the "infrastructure-relocatable"
  suggestion path and just places.

Task #34's pending sub-items can be re-scoped as "implement against
the capability flags" once Phase 1 ships — they no longer depend on
type names.

## Dashboard map integration

The 2D dashboard map (`dashboard/static/app.js` `renderMap()` and
`dashboard/static/map2d.js`) already renders placemarks ("POIs")
as diamonds and agents/humans as circles. Regions and sites fit
underneath as new layers, projected on the X/Z plane.

### Rendering rules

Layers drawn bottom-to-top so smaller things sit on top of larger
ones:

1. **Region shape** — filled disc for `column`/`sphere` (radius
   from `shape.radius`). Stroke + fill colored by `intent`:

   | intent | fill | stroke | opacity |
   |---|---|---|---|
   | `protect` | warning amber | solid | low (~0.15 fill, full stroke) |
   | `resource` | accent blue | solid | low fill, full stroke |
   | `marker` | muted gray | dashed | very low fill |

2. **Region status overlay**:

   - `active` — solid stroke, region id label at the anchor.
   - `orphaned` — dashed red stroke + warning glyph at the anchor,
     tooltip explains "sign missing — protection still active."
   - `unanchored` — dotted stroke; tooltip "no sign yet."

3. **Sites** — small filled dots inside the region, labeled with
   the site name. Click-target priority is higher than the region
   disc so a tight cluster of sites is still selectable.

4. **Placemarks (existing POIs)** — unchanged; diamonds.

5. **Humans/agents (existing)** — unchanged; circles on top.

### Selection and inspector

`mapHitTargets` already supports `kind` + `id` for click selection.
Two new kinds:

- `kind: 'region'`, `id: ':base1:'` — clicking the disc selects
  the region.
- `kind: 'site'`, `id: ':base1:/tower'` — clicking a site dot
  selects the site.

When selected, the inspector panel shows:

- For a region: `id`, `intent`, `profile`, `status`, resolved
  capabilities, list of sites, link to "preview policy here"
  (which calls `mc check dig`/`mc check place` against the region
  anchor and renders the envelope).
- For a site: `id`, parent region, coords, distance from the
  selected agent.

### Data path

The dashboard already polls bot endpoints. Add one read endpoint:

`GET /regions` →

```jsonc
{
  "world": "world",
  "regions": [
    {
      "id": "base1",
      "intent": "protect",
      "profile": "base",
      "status": "active",
      "anchor": { "x": 350, "y": 64, "z": -540 },
      "shape": { "kind": "column", "radius": 24, "y_min": 55, "y_max": 120 },
      "capabilities": { "allow_ad_hoc_dig": false, "allow_ad_hoc_place": false,
                        "allow_guided_edit": true, "overrides_global_denylist": false },
      "sites": [
        { "name": "tower",   "x": 350, "y": 72, "z": -540 },
        { "name": "storage", "x": 348, "y": 63, "z": -535 },
        { "name": "gate",    "x": 346, "y": 64, "z": -528 }
      ],
      "notes": "main base"
    }
  ]
}
```

The dashboard reads this on the same poll as `/marks` /
`/agents` / `/status`. No new bespoke pipeline.

### Camera / bounds behavior

`boundsXZ()` currently fits to POIs + agents + humans. Extend the
points list to include region anchors **and** the four cardinal
extents of each region disc (anchor ± radius on X and Z), so a big
region doesn't get clipped at the edge of the view.

### Out of scope for the first dashboard pass

- Y-bounded shading (would need a Y selector on the map).
- Polygon shapes (Phase 3).
- 3D / FPV rendering (deferred to a separate Phase 3 task).

## Standalone validation harness

Before any Phase 1 code lands, add a pure-JS scenario harness with
**no Mineflayer dependency**. It exercises `resolver.js` directly
against fixture scenarios. Catches policy regressions cheaply and
forms the contract that `mc check`, `mc repair`, and the future
`mc construct` all reuse.

**Location:** `bot/test/runtime/regions/scenarios.test.js`
**Fixtures:** `bot/test/runtime/regions/fixtures/scenarios.json`

### Fixture file shape

The fixtures file is a JSON document with a top-level
`scenarios` array. Each scenario provides regions + a list of
decisions, each with an `expect` block matching the resolver
output. Numbers and capability flag names are stable; new fields
on the resolver must be additive.

```jsonc
{
  "$schema": "../../../../../data/region-scenarios.schema.json",
  "scenarios": [
    {
      "name": "column with Y bounds denies above ceiling",
      "regions": [
        {
          "id": "base1",
          "intent": "protect",
          "profile": "base",
          "status": "active",
          "anchor": { "x": 0, "y": 64, "z": 0 },
          "shape": { "kind": "column", "radius": 8, "y_min": 60, "y_max": 80 }
        }
      ],
      "decisions": [
        {
          "name": "below floor: outside region",
          "verb": "dig",
          "args": { "ad_hoc": true },
          "position": { "x": 3, "y": 40, "z": 3 },
          "block": "cobblestone",
          "expect": {
            "decision": "allow",
            "reason": "OUTSIDE_ALL_REGIONS",
            "winning_region": null
          }
        },
        {
          "name": "inside Y band: protected",
          "verb": "dig",
          "args": { "ad_hoc": true },
          "position": { "x": 3, "y": 70, "z": 3 },
          "block": "cobblestone",
          "expect": {
            "decision": "deny",
            "reason": "REGION_PROTECTED",
            "winning_region": "base1",
            "matched_capability": "allow_ad_hoc_dig"
          }
        }
      ]
    },
    {
      "name": "overlap: nested resource inside protect",
      "regions": [
        {
          "id": "base1", "intent": "protect", "profile": "base",
          "status": "active",
          "anchor": { "x": 0, "y": 64, "z": 0 },
          "shape": { "kind": "column", "radius": 16 }
        },
        {
          "id": "mine1", "intent": "resource", "profile": "mine",
          "status": "active",
          "anchor": { "x": 0, "y": 30, "z": 0 },
          "shape": { "kind": "column", "radius": 4 }
        }
      ],
      "decisions": [
        {
          "name": "inside inner resource: allowed",
          "verb": "dig",
          "args": { "ad_hoc": true },
          "position": { "x": 1, "y": 30, "z": 1 },
          "block": "stone",
          "expect": {
            "decision": "allow",
            "reason": "REGION_OVERRIDE",
            "winning_region": "mine1",
            "matched_capability": "allow_ad_hoc_dig"
          }
        },
        {
          "name": "inside outer protect ring: denied",
          "verb": "dig",
          "args": { "ad_hoc": true },
          "position": { "x": 10, "y": 64, "z": 10 },
          "block": "cobblestone",
          "expect": {
            "decision": "deny",
            "reason": "REGION_PROTECTED",
            "winning_region": "base1",
            "matched_capability": "allow_ad_hoc_dig"
          }
        }
      ]
    },
    {
      "name": "orphaned region still enforces",
      "regions": [
        {
          "id": "base1", "intent": "protect", "profile": "base",
          "status": "orphaned",
          "anchor": { "x": 0, "y": 64, "z": 0 },
          "shape": { "kind": "column", "radius": 8 }
        }
      ],
      "decisions": [
        {
          "name": "dig still denied in orphaned region",
          "verb": "dig",
          "args": { "ad_hoc": true },
          "position": { "x": 2, "y": 64, "z": 2 },
          "block": "cobblestone",
          "expect": {
            "decision": "deny",
            "reason": "REGION_PROTECTED",
            "winning_region": "base1",
            "matched_capability": "allow_ad_hoc_dig"
          }
        }
      ]
    },
    {
      "name": "guided edit allowed in protect region",
      "regions": [
        {
          "id": "base1", "intent": "protect", "profile": "base",
          "status": "active",
          "anchor": { "x": 0, "y": 64, "z": 0 },
          "shape": { "kind": "column", "radius": 8 }
        }
      ],
      "decisions": [
        {
          "name": "ad-hoc place denied",
          "verb": "place",
          "args": { "ad_hoc": true },
          "position": { "x": 1, "y": 64, "z": 1 },
          "block": "cobblestone",
          "expect": {
            "decision": "deny",
            "reason": "REGION_PROTECTED",
            "winning_region": "base1",
            "matched_capability": "allow_ad_hoc_place"
          }
        },
        {
          "name": "guided place (via mc repair) allowed",
          "verb": "place",
          "args": { "guided": true, "source": "repair" },
          "position": { "x": 1, "y": 64, "z": 1 },
          "block": "cobblestone",
          "expect": {
            "decision": "allow",
            "reason": "REGION_GUIDED_EDIT",
            "winning_region": "base1",
            "matched_capability": "allow_guided_edit"
          }
        }
      ]
    },
    {
      "name": "site resolution inherits parent capabilities",
      "regions": [
        {
          "id": "base1", "intent": "protect", "profile": "base",
          "status": "active",
          "anchor": { "x": 0, "y": 64, "z": 0 },
          "shape": { "kind": "column", "radius": 16 },
          "sites": [
            { "name": "tower", "x": 0, "y": 80, "z": 0 }
          ]
        }
      ],
      "decisions": [
        {
          "name": "goto :base1:/tower resolves correctly",
          "verb": "resolve_site",
          "args": { "ref": ":base1:/tower" },
          "expect": {
            "decision": "allow",
            "reason": "SITE_RESOLVED",
            "winning_region": "base1",
            "resolved": { "x": 0, "y": 80, "z": 0 }
          }
        }
      ]
    }
  ]
}
```

Scenarios to cover in the first release:

1. **Column infinite Y**: `protect r=8` at origin denies dig at
   `(3,-20,3)` and `(3,200,3)`.
2. **Column with Y bounds**: same region with `y=60..80` allows dig
   at `(3,40,3)`, denies at `(3,70,3)`.
3. **Overlap precedence**: nested `resource r=4` inside `protect r=16` —
   dig allowed inside the inner region, denied in the ring.
4. **Ad-hoc vs guided edit**: `place` denied in `protect`; same
   cell with `place { guided: true }` allowed.
5. **Marker TTL expiry**: marker region with `expires_at` past
   enforces nothing and is excluded from `regions_here`.
6. **Named site resolution**: `:base1:/tower` resolves to the
   declared coords and inherits the region's capabilities.
7. **Orphaned region**: placemark sign removed — region still
   denies ad-hoc dig until `mc regions remove`.
8. **Profile defaults — farm**: allows harvest of mature wheat,
   denies dig of `oak_fence`, denies ad-hoc `place` of cobblestone.
9. **Capability override**: `resource` region with
   `overrides_global_denylist: true` allows dig of a block in the
   global denylist; same dig outside the region is refused.
10. **Dry-run parity**: every scenario above must produce identical
    envelopes when run through the `mc check` path.

Adding a new case is a JSON edit, no JS changes. The same fixture
file is intended to be reused by `mc construct` tests once that
ships.

## Critical files

| File | Change |
|---|---|
| `bot/lib/runtime/regions/index.js` | **NEW** — registry, store, `at`/`resolve`/`upsertFromPlacemark` |
| `bot/lib/runtime/regions/resolver.js` | **NEW** — pure decision function, no Mineflayer deps |
| `bot/lib/runtime/regions/profiles.js` | **NEW** — profile defaults table |
| `bot/lib/runtime/regions/sign-directives.js` | **NEW** — parse `region=`/`r=`/`y=`/`site=` on placemark signs |
| `bot/lib/runtime/regions/sign-watcher.js` | **NEW** — chunk/block event subscriptions; hooks into placemark observer |
| `bot/lib/actions/mining/dig.js` | Add region check before `isDigProtected`; emit `REGION_PROTECTED` envelope using existing `fail()` and `recordDigFailure` |
| `bot/lib/actions/excavation.js` | Add resolver check in each of the 4 `isDigProtected` filter loops (lines 134, 339, 552, 690) |
| `bot/lib/actions/building/place-single.js` | Add region check before inventory check; emit `REGION_PROTECTED` envelope using existing `fail()` |
| `bot/lib/actions/building/terrain.js` | Add resolver check at its `isDigProtected` call site |
| `bot/lib/actions/building/pillar.js` | Add resolver check at its `isDigProtected` call site |
| `bot/lib/runtime/manager.js` | Call `setupRegionSignWatcher(bot, ctx.runtime.regions)` after existing `bot.on()` registrations in spawn callback |
| `bot/lib/server/state.js` | Add `regions: null` to `createRuntimeState()` (set to the loaded store at startup); add `regionEditLog: []` for Phase 2 |
| `bot/lib/actions/observe/check.js` | **NEW** — `mc check <verb> [args]` dry-run primitive |
| `bot/lib/actions/regions/create.js` | **NEW** — `mc region create/remove` (registry write, no sign) |
| `bot/lib/actions/regions/sites.js` | **NEW** — `mc site add/remove` |
| `bot/lib/server/http-app.js` | New `/regions` and `/check` endpoints |
| `bot/cli/registry.mjs` | New verbs: `mc regions [--at x,y,z]`, `mc check <verb> [args]`, `mc region create/remove`, `mc site add/remove` |
| `dashboard/static/app.js` | `renderMap()` extended: draw region discs, sites, status overlays; new hit-target kinds `region` and `site` |
| `dashboard/static/map2d.js` | Helpers for radius rendering and bounds extension (cardinal extents of region discs) |
| `dashboard/server.js` | Proxy `/regions` from the bot HTTP API to the dashboard client |
| `bot/lib/runtime/observation.js` | Surface `regions_here` (with capabilities) in /status + /observe |
| `bot/lib/runtime/reactive/region-events.js` | **NEW** (Phase 2 reactive) — emit `region_entered`/`region_exited` |
| `data/regions-<world>.json` | **NEW** (auto-created) — registry file |
| `prompts/landfolk/steve.md` | Brief "Respecting regions" section (intents + capabilities) |
| `bot/test/runtime/regions/scenarios.test.js` | **NEW** — runs the standalone fixture harness |
| `bot/test/runtime/regions/fixtures/scenarios.json` | **NEW** — fixture cases (see harness section) |
| `bot/test/runtime/regions/*.test.js` | **NEW** — unit tests (resolver, directive parser, store round-trips) |
| `bot/test/integration/region-protection.test.js` | **NEW** — `mc dig`/`mc check` inside/outside regions |

## Existing utilities to reuse

- **`createLocationsStore`** in `bot/lib/runtime/locations.js` —
  copy the atomic load/save pattern (read → mutate → `fs.writeFileSync`).
  Important difference: `createLocationsStore` is **per-bot** (file
  named `locations-<username>.json`); the region store must be
  **per-world** (file named `regions-<world>.json`, shared across
  bots). Copy the pattern, not the function.

- **`isDigProtected`** in `bot/lib/runtime/dig-tools.js` — five
  confirmed call sites: `dig.js` (1), `excavation.js` (4),
  `place-single.js` (1, for infrastructure relocation only),
  `building/terrain.js` (1), `building/pillar.js` (1),
  `queries/inspect.js` (1). Region check goes **before** the
  existing `isDigProtected` call in each action handler that
  produces a user-facing refusal. Inner-loop callers in
  `excavation.js` just skip the block.

- **`ctx.runtime.recentPlaces`** in `bot/lib/server/state.js` —
  already defined as a 64-entry ring buffer with 15-minute TTL in
  `createRuntimeState()`. For Phase 2 edit log, extend
  `createRuntimeState()` to add a `regionEditLog` field there.
  Do not add a new top-level state slice for it.

- **`buildTypedAlerts()`** in `bot/lib/runtime/observation.js` —
  returns an array of alert objects built from live bot state. For
  Phase 2 damage alerts, add an `area_damaged` entry when
  `ctx.runtime.regionEditLog` has unattributed edits inside a
  `protect` region. Keep the pattern: no args, pure read of `ctx`.

- **`buildMarksListApi()`** in `bot/lib/server/http-app.js` (wraps
  `buildMarksList` from `locations.js`) — follow the same pattern
  for the `/regions` GET endpoint. `/marks` returns distance-sorted
  entries; `/regions` should do the same.

- **`fail()` and `ok()`** from `bot/lib/shared/action-contract.js`
  — already used in `dig.js` and `place-single.js`. All new action
  handlers must use these helpers, not bare object returns.

- **`bot.on(...)` registration** is done in `manager.js` inside the
  `spawn` callback. The sign-watcher must be registered there, not
  in a standalone file that tries to self-register.

- **`ctx.runtime.recentDigFailures`** ring buffer (defined in
  `state.js`) — pattern for the future `regionEditLog`: bounded
  array, lazily decayed on read, capped at N entries.

## Known limitations (Phase 1)

- **Single-writer JSON store:** `data/regions-world.json` is loaded per bot process. Multiple bots on one world do not invalidate each other's in-memory cache automatically; last writer wins on disk. Treat region admin as one steward/bot at a time until Phase 2 cache reload.
- **`ad_hoc: false` / `guided: true`:** resolver supports guided branches, but most CLI verbs still pass ad-hoc defaults. Phase 2 will wire guided construction explicitly.
- **No HTTP auth:** bot API trust model is unchanged (LAN deployment assumption).

## Worksite-scoped authority (Phase 1.8)

Per-card grants to edit inside one **protect** region without flipping intent:

| Piece | Role |
|-------|------|
| Card YAML `worksite: hut3` | Steward materializes which protect region the worker may edit |
| `mc task_context set hut3` | Worker binds grant to `HERMES_KANBAN_TASK` (POST `/task-context`) |
| Resolver `WORKSITE_GRANT` | Allows ad-hoc dig/place when `task_worksite` matches winning protect region |
| Expiry | Default 30 minutes, max 4 hours; lazy expiry on read; refresh by re-posting same `card_id` |
| `mc task_context clear` | Worker clears on `kanban_complete` / `kanban_block` |

`mc check dig|place` and live dig/place share `buildRegionResolveArgs`, so dry-run previews include the active worksite. Bulk dig/place skips protected cells with `skipped_region` / `region_protected[{id,count}]` in the action envelope.

**Escape hatch:** `mc region_update_intent <id> marker` remains for legacy cards; prefer `worksite:` on new decomposition. See [phase-3 steward MVP](../phase-3-steward-mvp.md) construct example.

## Out of scope (this plan)

- Polygons / arbitrary shapes (Phase 3).
- Damage detection and `mc repair` (Phase 2; requires edit log first).
- Auto-repair behavior (Phase 2e).
- Blueprint-driven `mc construct` implementation (design linkage
  noted in [`blueprints-grabcraft.md`](../../specs/world/blueprints-grabcraft.md)).
- Per-region config files — profile defaults live in code.
- Bot-driven sign-text writing (deferred; bots use
  `mc region create` / `mc site add` instead).
- Region-local coordinates for site directives (sticking with
  absolute world coords in v1).
- Server-side authoritative attribution of edits (Phase 2a is
  best-effort only).
- Multi-world / dimensional support beyond the current
  one-overworld assumption (the file path is per-world but
  dimensions like nether/end are deferred).
- 3D / FPV visualization of regions (Phase 3); dashboard 2D map
  only in v1.
- Y-bounded shading on the dashboard map (would need a Y selector).

## Rollout checklist (per milestone gating)

Each milestone must complete its own row before the next begins.
The Phase 1 rollout is considered done when row 1.7 is checked off
and the live-verification block in `### Live verification` (above)
passes end-to-end on the running test world.

| # | Milestone | Pre-flight | Tests added | Live check |
|---|---|---|---|---|
| 1.0 | Validation harness + resolver | `run-tests.sh --bot` green | `scenarios.test.js`, `resolver-unit.test.js`, `profiles.test.js` | n/a (pure JS) |
| 1.1 | Store + `/regions` + `mc regions` | 605/605 + 1.0 tests green | `store.test.js`, `regions-endpoint.test.js` | hand-crafted file → `mc regions` lists it |
| 1.2 | Bot-driven create/remove | 1.1 green | `region-create-contract.test.js` | `mc region create :test1: mine` round-trips |
| 1.3 | `mc check <verb>` | 1.2 green | `check-dry-run.test.js` | `mc check dig` previews refusal; no block broken |
| 1.4 | Enforcement hooks | 1.3 green | `region-protection.test.js`, `region-place-protection.test.js` | parity test: `mc check dig` envelope == `mc dig` envelope |
| 1.5 | Sign watcher | 1.4 green | `sign-directives.test.js`, `sign-watcher.test.js` | place sign → active; break sign → orphaned; protection stays |
| 1.6 | Dashboard map | 1.1 green (1.4 optional) | `dashboard/test/regions-render.test.js` | reload dashboard → region disc visible, correct color |
| 1.7 | Prompt + envelope polish | all previous green | n/a (manual prompt-eval) | Steve in `:base1:` declines dig, doesn't loop |
| 2a | Edit log | 1.4 + 1.5 green | `edit-log.test.js` | two-bot edit attribution observable |
| 2b | Damage detection | 2a green | `damage-detector.test.js` | creeper damage fires alert; bot repairs suppressed |
| 2c | `mc repair` | 2b green | `repair-flow.test.js` | manual hole → `mc repair` → restored |
| 2d | Guided envelope freeze | 2c green | `guided-envelope.test.js` | shape stable; documented in action-contract.md |
| 2e | Auto-repair (gated) | 2d green | reactive integration test | `auto_repair=on` triggers without explicit call |

If any milestone's tests or live check fails, **do not advance** —
revert the partial work or fix forward, then re-run the row.
