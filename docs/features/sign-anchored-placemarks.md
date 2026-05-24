# Sign-anchored placemarks

Status: draft / planning. No implementation yet.

## Problem

The current `mark` / `unmark` / `go_mark` system has two pain points:

1. **No clear lifecycle.** Marks accumulate forever. `unmark` is the only way out, and any bot can wipe any mark by name. There's no notion of who owns a mark or whether it's still relevant.
2. **Auto-marks are noisy.** Each bot death creates `death_N` permanently. After a few hours of play the locations file is mostly graveyard. The same problem will hit any other auto-marker we add later.

The current model also gives players no in-world way to participate. A player who wants to tell the bots "this is the front door of the mine" has to use chat commands the bots invented, instead of something Minecraft already provides.

## Concept

Use **wooden signs** as the in-world anchor for placemarks. A sign whose first line begins with `@` is treated as a named placemark. The sign is the source of truth — its block position, text, and existence drive the registry.

Two motivations:

- It's discoverable. Players already know how signs work. Crafting one and writing on it is the most natural "place a label here" gesture in Minecraft.
- It's auditable. You can see every named placemark by walking the world. There's no invisible state hiding in JSON.

## Goals

- Players can label spots in-world without learning a chat command.
- Multiple bots in the same world share the same set of named placemarks.
- Player-placed marks are protected from bots (incl. accidental break, fire, creepers).
- Bot-placed marks are persistent but not sacred — the placing bot or any player can remove them.
- Auto-marks (deaths, possibly others) decay on a schedule.
- Usage of each placemark is tracked, so we can surface stale marks instead of just deleting on time alone.

## Non-goals (for v1)

- Cross-dimension portals or fancy waypoint UI inside Minecraft.
- Editing sign text from outside the game.
- Replacing the existing `mc mark NAME` chat command. We'll keep it, but make it interoperate.
- Multi-line structured metadata in the sign text (categories, radii, etc.). v1 is just `@name` plus optional free-text note on the remaining lines.

## Sign protocol

A "placemark sign" is any standing, wall-mounted, or hanging wooden sign (any wood type) whose **front face** has line 1 starting with a `:id:` sentinel:

```text
:nagra: village
mason's place
near the well
```

```text
:m23: balder's mine
iron + coal
y=12 shaft
```

Format:

- Line 1 begins with `:<id>:` followed by optional descriptive text.
- `<id>` matches `[a-z0-9]{2,8}` — short, alphanumeric, lowercase. Hyphen and underscore disallowed in v1 to keep IDs cleanly scannable.
- Everything after the closing colon on line 1, plus lines 2–4, is the free-form description. Stored verbatim, shown in `mc marks` output.
- IDs are unique within a world. If a duplicate sign appears, the existing record wins and the new sign is ignored (with a chat warning to the placer).
- The placemark coordinate is the sign's block position. The sign's facing direction, wood type, and kind (standing / wall / hanging) are recorded for regeneration.

Anything that doesn't match `^:[a-z0-9]{2,8}:` on line 1 is just a normal sign and is ignored.

### Region and site directives (forward link)

A `:id:` placemark sign can carry additional directives that promote
it to a **region** and declare **sites** inside that region. See
[`designated-regions.md`](./designated-regions.md) for the full
syntax. Summary:

```text
:base1: main base
region=base
r=24
y=55..120
site:tower=350,72,-540
site:gate=346,64,-528
```

Placemarks without these directives behave exactly as described in
this document. Regions are an additive layer; the registry and sign
lifecycle described here are unchanged.

### Why `:id:` instead of `@`

The bracketing colon makes the boundary between identifier and description unambiguous on a single sign line, and reads naturally in chat (`go to :nagra:`). It also avoids collision with username conventions where `@` is common.

### Why the front face only

Java Edition 1.20+ signs have front and back text. Restricting to the front side avoids ambiguity and matches what a player sees when they walk up to a sign.

### ID assignment

- **Player-placed:** the player picks the ID by writing it on the sign. They get a free choice within the format rules.
- **Bot-placed:** the system auto-generates an ID. Convention: `<kind><n>` where kind is a one- or two-letter prefix and `n` is a small counter. E.g. `d3` for the 3rd recent death, `m12` for the 12th bot-placed mine marker. The counters are scoped per-world per-kind and roll over with cleanup.

## 1:1 signs and placemarks

Every placemark has exactly one sign in the world. Every `:id:` sign in the world has exactly one placemark record. There's no "registry-only" placemark and no "sign without a record" — they're two views of the same thing.

This means:

- A bot doesn't get a `place_sign` API. It gets `mc placemark create :id: TEXT [at X Y Z]`. The system handles whatever block-placement and sign-text-write is needed under the hood. The bot doesn't need to learn the Mineflayer sign-text dance.
- Deleting the sign deletes the placemark. Deleting the placemark removes the sign. There is no way to have one without the other.
- If sign-text-write fails (the spike below tells us how often), the system falls back to: place a sign, write what it can, store the full text in the registry. The sign block still exists, the registry still has the truth, and a regen pass can retry the text edit.

## Placemark types

| Type | Owner | Persistence | Cleanup |
| --- | --- | --- | --- |
| Player-placed | Player (treated as "external" under self-attribution; see below) | Forever, regenerated if destroyed by environment | Only when a player breaks the sign, or runs `mc unmark :id:` |
| Bot-placed | Bot username | Until removed | Owning bot, any player, or via `mc unmark :id:` |
| Death | Bot username | Short TTL (default 15 min) | Auto-expires; the system breaks the sign when the record expires |

Three types kept for clarity, even though "bot-placed" and "death" share most code — the difference is just the cleanup policy.

## Ownership and permissions

This is the trickiest part of the design. Mineflayer block events don't reliably tell a bot *who* placed or broke a block — they just see the resulting block update. Some options, ranked by my preference:

1. **Attribute by proximity at the moment the sign appears.** When a bot observes a new `@`-sign, it credits the nearest player within range as the owner. If no player is in range, the placemark is recorded as `unknown_owner` and treated as player-placed (sacred). Brittle if two players are nearby.
2. **Self-attribution only.** Bots know when they placed something. Anything a bot didn't place is "external" and treated as player-owned. Simpler, no proximity heuristic needed. Owner is identified as a generic "player" rather than a specific UUID — but for v1 that may be enough, since the rule we actually care about is "bots don't touch it."
3. **Server-side plugin.** Reading the actual placer from a Paper plugin event. Most accurate. Adds infrastructure we don't currently run.

**Recommendation:** start with option 2. It's enough to enforce the protection rule. We can promote to option 1 or 3 later if specific-player ownership becomes important (e.g., "only Foz can move @home").

Permission rules under option 2:

- Player-owned placemarks: bots will not break the sign for any reason (excavation, building, dig_area, auto-clear). They can be removed by any player breaking the sign in-game, or by a player issuing `mc unmark @name` from chat.
- Bot-owned placemarks: the placing bot or any player can remove. Other bots won't break the sign through ordinary work but may remove it via an explicit `unmark` command.
- All bots route their dig/break actions through a guard that refuses to target a known placemark sign block. This is where the protection actually lives.

## Detection and notification

A new placemark needs to enter the registry as soon as possible. Options:

- **Bot-observed.** When a bot sees a sign block change within its loaded chunks, it parses the front text. If `@`-prefixed, it registers the mark. Works only if a bot is nearby.
- **Player chat handshake.** Player chats `mark @home` (or `@home here`) and a bot who can see the player's recent sign placement confirms. Adds friction; rejected for v1.
- **Server-side scanner.** A separate process (the dashboard server, or a plugin) watches sign updates and posts to the registry. Doesn't require a bot to be nearby. Larger lift.

**Recommendation:** v1 uses bot-observed detection, with a one-time chunk scan when a bot logs in (walk-the-loaded-chunks for sign block entities). We accept the limitation that a sign placed in an unloaded chunk with no bot around won't register until a bot visits. In practice the workflow is "player + bot together," so this is fine.

When a bot registers a new mark, it broadcasts it:

- A system chat line (visible to players): `[marks] :nagra: registered at 358 66 -602`.
- An in-process event so other bots in the same world pick it up immediately.

## Storage and schema

The new registry is a **single shared file per world**, living next to the world data:

```text
server/<world>/placemarks.json
```

For example, `server/world/placemarks.json`, `server/landfolk-test/placemarks.json`. The file lives with the world it describes, which is the right place for "this is part of the world." It's gitignored — placemarks are runtime state, not source.

Each bot reads and writes through a shared module. There's no per-bot copy; everyone sees the same registry.

### Coexistence with the legacy system

We're not migrating anything. The old `mc mark / mc unmark / mc go_mark` commands keep operating on the existing `data/locations-*.json` files. The new `mc placemark` commands and `:id:` references operate on the new registry. The two systems live side by side.

Behaviour at the seams:

- `mc marks` (the listing) reads the union of both stores and sorts them together by recency. Legacy marks display with their plain name; new ones display with their `:id:`. The output makes the type obvious.
- Name-resolution in actions: a `:id:` reference always hits the new registry. A bare `name` reference still hits legacy. Different syntaxes, no overlap.
- No conversion tool, no automatic promotion. Players who want to move a legacy mark into the new system create a sign and let it disappear from legacy by manual `unmark`. We can add `mc placemark promote NAME :id:` later if the friction shows up; for v1 it's out of scope.
- Eventually the legacy path is deprecated. Not now.

This keeps the new feature additive and self-contained. Nothing breaks for users who never adopt it.

Schema sketch (not final):

```yaml
placemarks/<world>.json
  <id>:                              # the part inside the colons, e.g. "nagra"
    world:        <multiverse-world>
    coords:       [x, y, z]          # the sign's block position
    description:  <free-form text from line 1 tail + lines 2–4>
    sign:
      facing:     <direction>
      wood:       <oak|spruce|...>
      kind:       standing | wall | hanging
    owner:
      kind:       player | bot
      id:         <username|null>    # null for "external/unknown" under self-attribution
    type:         player | bot | death
    expires_at:   <iso8601 | null>   # set for type=death
    saved:        <iso8601>
    updated:      <iso8601>
    last_used:    <iso8601 | null>
    use_count:    <int>
```

The 1:1 invariant means we don't need a separate `sign.block_pos` — the placemark `coords` *is* the sign block. The `lines` field is folded into a single `description` since the parser concatenates them anyway.

Per-bot `locations-*.json` keeps the existing schema for non-sign legacy marks until they're migrated, plus per-bot read-only overlay (visit counts from this bot's perspective).

## Lifecycle

### Creation

- **Player path:** player crafts and places a sign, writes `:nagra: village` on line 1. Nearest bot observes the block update, parses text, writes registry entry, broadcasts.
- **Bot path:** a bot calls `mc placemark create :id: TEXT [at X Y Z]`. The system places a sign at the given coords (or the bot's current position), writes the `:id:` prefix on line 1 followed by `TEXT`, and adds the registry entry. The bot doesn't think about sign blocks — it thinks about placemarks.

### Read / use

- Any time a bot resolves `:id:` to coordinates for an action (`go_mark`, mark references in cards, etc.), increment `use_count` and update `last_used` on the shared record.
- Mere observational reads (the digest mentioning `:nagra:` for context) do **not** count. Only explicit-by-name resolution counts. This keeps the signal meaningful.

### Update

- Player breaks and replaces the sign, or edits text. The sign's coords change → registry updates the same record.
- An ID change (player edits line 1) is treated as delete-old + create-new. The old record's `use_count` does not transfer.
- The free-form description (line 1 tail + lines 2–4) can change without disturbing the ID, owner, or stats.

### Deletion

- Player breaks the sign → registry record removed, broadcast.
- Bot runs `mc unmark :id:` → registry record removed and the bot breaks the sign block.
- Death TTL expires → owning bot breaks the sign next time it's nearby; if no bot reaches it within a grace period, the record is dropped from the registry and the abandoned sign becomes a normal sign in the world (no longer protected).

### Regeneration

A player-owned sign that disappears (creeper, fire, lava, fall damage) is regenerated:

- The block at the recorded sign position is empty/invalid.
- The owning player is online OR the sign was destroyed less than N minutes ago.
- Some bot can reach the spot.

The first available bot crafts (or pulls from a known stash) a sign of the recorded wood type, places it on the recorded face, and writes the recorded text.

**Challenge to the original idea:** "bots can't accidentally delete it" is the easy half. The hard half is detecting "destroyed by environment" vs "destroyed by the owner." Without server-side hooks we can't tell. Our heuristic: if the owning player is online and within ~32 blocks of the sign at the moment it disappears, treat it as a deliberate removal and don't regenerate. Otherwise regenerate. Imperfect but probably good enough.

## Death placemarks

Deaths get a sign like any other placemark, since the model is 1:1. They're just short-lived.

- **Auto ID.** `:d1:`, `:d2:`, ... allocated per bot per world. Counter rolls over once a death entry is cleaned up.
- **Default sign text.** Line 1: `:d<n>: <bot_name> ♱` (e.g. `:d1: Steve ♱`). Subsequent lines stay blank in v1 — we can add cause-of-death or HP-on-death later if it earns its space.
- **Unicode caveat.** Minecraft's default sign font handles a lot of unicode but not everything. The dagger glyph `♱` (U+2671) renders cleanly on Java Edition's default font in current versions; if it ever falls back to a tofu box on some setup, the spike (item 1 in phasing) is the time to confirm and pick a fallback (e.g. `+`, `RIP`, or skip the glyph entirely).
- **Default TTL: 30 minutes.** Long enough to walk back across non-trivial distances. Cleared earlier if the bot successfully picks up its dropped items in the area.
- **Cap the count.** At most the last 3 deaths per bot exist at once. A 4th death rolls off the oldest, sign and all.
- **Sign placement fallback.** Death spots are often unsignable (lava, void, mid-mob, fall onto bedrock). The system tries the death block first; if it can't place a sign there it walks outward to the nearest standable surface within ~5 blocks and places it there. If even that fails, the death is logged but no placemark is created. Better to skip than to spam regen attempts forever.
- **Hidden from default listing.** `mc marks` shows death placemarks only under `--full` (see listing rules below). Most of the time they're transient noise.

If the sign-placement fallback misses too often in practice, we can revisit and allow registry-only death entries again — but starting strict keeps the 1:1 invariant honest.

## Usage tracking and decay

Two separate dials:

- **Use count + last used.** Already half-implemented. Hook into the name-resolution path so any explicit `:id:` reference bumps it. Persist across restarts (the shared registry already does this since it's file-backed).
- **Decay policy** is per-type:
  - `player`: never auto-decay. Stale-but-loved is still loved.
  - `bot`: warn at 30 days unused, suggest cleanup. Don't auto-delete.
  - `death`: hard TTL (30 min default), plus 3-entry cap per bot.

The decision to actually remove a player-owned mark is always manual.

## Listing and presentation

The `mc marks` command needs to be useful at a glance. The current implementation dumps every mark sorted by name — that scales badly once we expect dozens.

Following the project convention (`mc status`, `mc observe`, `mc scene` are all "lean by default, `--full` for everything"):

- **`mc marks`** (lean, default)
  - Sorted by **most recent activity** descending. "Activity" is `max(saved, updated, last_used)` — so a brand-new mark, a just-renamed mark, and a just-visited mark all float to the top.
  - Ties broken by `use_count` descending, then by ID alphabetically.
  - Capped at the top 10 entries.
  - Death placemarks are excluded from the lean view.
  - Each entry shows the ID, distance, description, and a small `(used Nx)` suffix when `use_count > 0`. The frequency stays visible without driving the sort.
  - Footer line: `... and N more (use --full to see all)` when truncated.
- **`mc marks --full`**
  - All placemarks including deaths.
  - Same sort key.
- **`mc marks :id:`** (single-mark detail) — already a use case via `go_mark`. Can also surface from the listing endpoint with the ID as a query param so the dashboard and bots have one path.

The argument parser supports flag-style args (see `customParse: true` patterns in `bot/cli/registry.mjs`); we'll use the same approach for `--full`. No need to invent a new convention.

### Why recency over frequency

I had this as `use_count` first earlier and reconsidered. The point of the lean view is "what's relevant right now," and three things all count as relevance: recently used, recently updated, recently created. A single recency key handles all three without special cases. Frequency-first hides new marks until they've earned visits, which makes the system feel forgetful — exactly the failure mode you flagged.

If a "what do I use most" view turns out to be useful later, we can add `mc marks --top` as a separate flag with `use_count` as the primary sort. Not for v1.

## Open challenges and edge cases

These are the things I want to nail down before any code lands:

- **Sign text from a bot.** You noticed text didn't appear when a bot placed a sign. Confirm whether `bot.updateSign()` works at all on the current Mineflayer version and protocol, and whether front-only vs front-and-back text needs different calls. The 1:1 invariant means bots *must* be able to write their own sign text, since they're the ones creating death markers and any future auto-marks. If the spike fails, the fallback is "place the sign, leave it blank, store the truth in the registry, retry text edit on a regen pass." That's not great — a blank sign in the world is confusing — so the spike's outcome matters.
- **Sign on unsupported block.** A sign placed on, say, the back of a piston gets destroyed when the piston retracts. We regenerate; the same physics breaks it again. Need a "regen failed N times → mark stale, stop trying" rule.
- **ID collisions across worlds.** `:home:` in the overworld and `:home:` in `landfolk-test` are different placemarks. The registry is keyed by `(world, id)`. Cross-world chat should be unambiguous about which world is meant.
- **ID collisions within a world.** Two players can independently write `:nagra:` on different signs. Resolution: first sign to register wins, second is ignored with a chat warning. The losing player can either rename or break their sign.
- **Owner identification under self-attribution.** A bot can't tell whether a player or another bot placed a sign, only that *it* didn't. If two bots are running and one places `:m12:`, the other will read it as "external = player-placed = sacred." Workaround: the placing bot writes its own record before any other bot observes the block, claiming ownership first. Requires that all bot-side placement go through the shared registry.
- **Sign text length.** A sign line is roughly 15 default-font chars. `:nagra:` eats 7 of them. The description fits whatever's left, with overflow continuing on lines 2–4. The parser doesn't enforce a length limit beyond what Minecraft itself allows.
- **Hanging signs vs standing signs.** Same protocol, but a hanging sign also dies if the block above it is removed. Regeneration code needs to verify the support block exists before retrying.
- **Inventory cost for regeneration.** A bot regenerating a sign needs a sign of the matching wood type. If none in inventory, the placemark goes `regen_pending` and a periodic pass retries. The bot may need to craft or fetch one — v1 just retries on a timer; later we can hook this into the goal/task system.
- **Race between observation and player edit.** Player places sign with `:home:`, then quickly edits to `:base:`. The registry needs to be eventually consistent — the *current* text of the sign block wins, not the order of events.
- **Migration.** None for v1. Legacy `data/locations-*.json` files keep working through the old commands; new `:id:` placemarks live in the new registry. Two stores, no automatic conversion. See "Coexistence with the legacy system" above.
- **Player breaks their own sign vs a creeper does.** Without server hooks we can't tell. Heuristic: if a player was within ~32 blocks at the moment the sign disappeared, treat as deliberate and don't regenerate. Otherwise regenerate. Imperfect; document it clearly so it's not surprising.

## Phasing

Rough order of work, no code yet:

1. **Spike: sign text from bots.** Confirm whether and how a bot can place a sign with text on the current Mineflayer version. The 1:1 invariant depends on this. Outcome of the spike informs everything downstream.
2. **Shared registry.** Single per-world file, ownership/type/sign metadata, all marks read/write through it. No sign integration yet — just unify storage and migrate the existing per-bot files into a read overlay.
3. **Block-update listener.** Bots observe sign placements/edits/breaks in loaded chunks, parse `:id:`-prefixed text, sync to the registry, broadcast.
4. **Initial chunk scan on login.** Find any pre-existing `:id:` signs in already-loaded chunks and reconcile against the registry.
5. **Protection.** Bot dig/break actions consult the registry and refuse to target a known placemark sign block.
6. **Bot-creates-placemark API.** `mc placemark create :id: TEXT [at X Y Z]` and the matching delete. Wraps the sign-place + sign-text-write flow so bots don't have to know the details.
7. **Death-mark refactor.** Replace the existing `death_N` accumulation with `:d<n>:` entries that obey TTL and the 3-entry cap.
8. **Regeneration.** Periodic check that registered signs still exist in the world; place missing ones, applying the "owner-near-the-loss" heuristic to skip recently-deliberate breaks.
9. **Listing rework.** `mc marks` lean (top 10 by frequency, no deaths) vs `mc marks --full`. Dashboard surface for `use_count` and `last_used`.

Steps 1–6 give the player-facing feature. Steps 7–9 are quality-of-life on top.

## Decisions locked

- **Sentinel:** `:id:` with optional descriptive text after. Format `^:[a-z0-9]{2,8}:`.
- **1:1 invariant.** Every placemark has exactly one sign and vice versa. Bots use `mc placemark create`; the system handles sign placement and text underneath.
- **Listing sort:** most recent activity (`max(saved, updated, last_used)`) desc, ties by `use_count` desc then ID. Lean view = top 10, deaths hidden. `--full` for everything.
- **Registry path:** `server/<world>/placemarks.json`, gitignored.
- **Migration:** none. Legacy and new systems coexist; listing unifies them on read.
- **Death TTL:** 30 minutes default, 3-per-bot cap, default sign text `:d<n>: <bot_name> ♱`.

## Still to confirm

- Sign-text writing from a bot — outcome of the spike (item 1 in phasing) governs whether bot-created placemarks ship in v1 or get pushed to v2. Player-placed signs work either way.
- Whether the dagger glyph `♱` renders on the default Minecraft font in all the protocol versions we care about. If not, fall back to `+` or drop the glyph.
- Whether 30-minute death TTL feels right in practice. Easy to tune from a config knob; not worth pre-debating.
