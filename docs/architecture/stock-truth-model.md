# Stock Truth Model

Status: proposal for genesis-v2 remediation follow-up. Indexed from [`README.md`](README.md) § Maturity; cited by [`target.md`](target.md).

## Why this exists

Current supply logic treats base stock as a single number (`totals` from chest snapshots).
That is useful, but it mixes different truths:

- `stored`: items were seen in a chest snapshot.
- `reachable`: a worker can get to a known storage location.
- `withdrawable`: a worker can actually withdraw required items at runtime.

Recent failures show that `stored > 0` alone is not enough for promotion or card routing.
We need these truths separated so planner/poller decisions use the right signal.

## Truth levels

For each resource (`wood`, `stone`, `coal`, `food`), track:

- `stored_count`: summed from `base-inventory.py` snapshots (existing behavior).
- `reachable_count`: portion of `stored_count` in storage marks that are currently reachable.
- `withdrawable_count`: portion that passes runtime withdraw checks from an execution body.

And for each storage mark:

- `snapshot_fresh`: latest snapshot exists and is recent enough.
- `mark_valid`: mark exists and is not stale.
- `path_reachable`: movement check to the chest position succeeds.
- `container_usable`: `chest`/`withdraw` preflight succeeds.

## Decision contract

Use the same metric class everywhere:

- **Planner briefing / stock cards**
  - show all three levels (`stored/reachable/withdrawable`) plus gap reason.
  - queue supply by `withdrawable` shortfall, not only `stored`.

- **Phase/promotion gates**
  - gate build/tool prerequisites on `withdrawable_count >= target_min`.
  - allow advisory warnings when only `stored` is present but not withdrawable.

- **Worker card generation**
  - if `stored>0 && withdrawable==0`: create repair/unblock storage card, not gather card.
  - if all levels are low: normal source-gather supply card.

## Minimal implementation path

1. Extend `base-inventory.py --suggest-json` output with per-mark health and per-resource
   `stored/reachable/withdrawable` counts.
2. Update `detect_supply_deficits()` in `scripts/genesis2_lib.py` to compute deficit class
   (`stored_gap`, `reachable_gap`, `withdrawable_gap`).
3. Update `file_stock_brief()` and `file_supply_card()` to branch by deficit class.
4. Update promotion checks that consume stock to require `withdrawable` for critical items.

## Test targets

- unit: resource classified as `withdrawable_gap` when snapshots exist but withdraw probe fails.
- unit: `file_supply_card()` emits storage-repair card body for `withdrawable_gap`.
- integration: card with same resource does not loop gather when only storage usability is broken.
- integration: promotion blocked when `stored` is sufficient but `withdrawable` is below target.
