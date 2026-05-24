# Designated regions — Phase 1 verification log

Companion to [`designated-regions.md`](./designated-regions.md). Records live-world checks for Path A (sign-driven) and Path B (bot-driven). Automated tests cover resolver, store, enforcement, `mc check`, CLI dispatch, and dashboard render; this log is for end-to-end checks on a running bot + world.

## Path B — bot-driven (no sign)

Run with a connected bot (`mc status` ok). Replace `<inside mine>` / `<outside>` with coords you know are inside/outside the created regions.

| Step | Command | Expected | Result | Notes |
|------|---------|----------|--------|-------|
| 1 | `mc region create :mine1: mine --r 12` | ok, region written | _pending_ | |
| 2 | `mc regions --at <inside mine>` | `:mine1:` listed, `allow_ad_hoc_dig: true` | _pending_ | |
| 3 | `mc check dig <inside mine>` | `decision: allow`, `REGION_OVERRIDE` or similar | _pending_ | |
| 4 | `mc dig <inside mine>` | block breaks (or ok envelope) | _pending_ | |
| 5 | `mc check dig <outside>` | `OUTSIDE_ALL_REGIONS` | _pending_ | |
| 6 | `mc region create :test_protect: base --r 8` | ok | _pending_ | anchor at bot or set anchor via store |
| 7 | `mc check dig <inside protect>` | `REGION_PROTECTED`, hint mentions `mc go_site` | _pending_ | |
| 8 | `mc region remove :test_protect: --confirm` | removed | _pending_ | |
| 9 | `mc region remove :mine1: --confirm` | removed | _pending_ | |

**Automated coverage (no live world):** region create/remove contract tests, `region-protection.test.js`, `check-dry-run.test.js`, `go-site.test.js`, `observation-regions-here.test.js`, CLI `mc goto :base1:/tower` → `go_site`.

## Path A — player-driven (sign)

Requires Mineflayer to expose sign text on `blockUpdate` (see [`sign-anchored-placemarks.md`](./sign-anchored-placemarks.md)).

| Step | Action | Expected | Result | Notes |
|------|--------|----------|--------|-------|
| 1 | Place placemark sign with `region=base`, `r=24`, sites | `mc regions` → `status: active` | _pending_ | |
| 2 | `mc check dig` inside base | `REGION_PROTECTED` | _pending_ | |
| 3 | Break sign | `status: orphaned`, dig still protected | _pending_ | |
| 4 | Place sign matching `:mine1:` unanchored region | promotes to `active` | _pending_ | |

## Sign-off

Phase 1 live sign-off when Path B table is filled with pass/fail and Steve prompt smoke (1.7) is done on a protect region.

- [ ] Path B complete on test world
- [ ] Path A complete or deferred with documented blocker
- [ ] Dashboard reload shows region disc after create
