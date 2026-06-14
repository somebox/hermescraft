# Bot lease — live operator runbook

Spec: [`docs/architecture/bot-lease.md`](../architecture/bot-lease.md). Automated checks: `scripts/smoke-bot-lease.sh`.

## Preconditions

- `sqlite3` on PATH
- Repo root; `cd bot && npm test` green (includes `test/cli/lease-registry.test.js`)
- For **live** section: Mineflayer listeners up for registry bodies (at minimum **Mox :3007**, **Pip :3005** per `data/bots/*.yaml`)
- Optional third body **Zee :3006** for pool exhaustion checks

## Dry smoke (no MC required)

```bash
scripts/smoke-bot-lease.sh
```

## Phase 1 — Two-body spike (live)

Export a dedicated lease DB for the session (optional):

```bash
export HERMES_BOT_LEASE_DB=/tmp/bot-leases-smoke.db
rm -f "$HERMES_BOT_LEASE_DB"
export HERMES_BOT_LEASE=1
```

### 1. Hard-fail without lease

```bash
HERMES_BOT_LEASE=1 mc status
# expect: no active bot lease — run 'mc bot checkout'
```

### 2. Checkout → use → release

```bash
mc bot checkout --bot mox --json
HERMES_BOT_LEASE=1 mc status --json   # hits :3007
mc bot release
HERMES_BOT_LEASE=1 mc status           # fails again
```

### 3. Contention

Second terminal (different `HERMES_KANBAN_TASK` or adhoc owner):

```bash
export HERMES_BOT_LEASE=1
mc bot checkout --bot mox    # taken
mc bot checkout --bot pip    # succeeds
```

### 4. Active-job guard (optional)

Start a long `mc goto` on a leased body, then `mc bot release` → refused; with `HERMES_BOT_LEASE_ADMIN=1`, `mc bot release --force --as-operator` cancels and releases.

### 5. TTL reclaim

`mc bot checkout --bot mox --ttl 2`, wait ~3s idle, another owner `mc bot checkout --bot mox`.

### 6. Back-compat

Unset `HERMES_BOT_LEASE`; set `MC_API_URL=http://127.0.0.1:3007` — ordinary `mc status` uses env URL (landfolk path).

## Phase 2 — Genesis v2 trial (manual)

After `scripts/genesis-v2-mint-profiles.sh` (specialists have `HERMES_BOT_LEASE=1`, no `MC_API_URL`):

1. Start bodies per genesis v2 docs.
2. Add one manual card on board `genesis-v2`, e.g. `[LEASE-TRIAL] checkout pip`, body instructing: `mc bot checkout --bot pip` → `mc status` → `mc bot release`.
3. Dispatch worker; confirm lease comments visible via `mc bot status --pool`.

## After MVP (planned)

Nearest/capability checkout, kanban stamp on checkout, epic template integration — see [`bot-lease.md` § Deferred (post-MVP)](../architecture/bot-lease.md#deferred-post-mvp).

## Handoff checklist

- [ ] `cd bot && HERMES_VALIDATE=1 npm test` green
- [ ] `docs/reference/mc-cheatsheet.md` lists `mc bot`
- [ ] `scripts/smoke-bot-lease.sh` exit 0
- [ ] Phase 1 live steps signed off by operator
- [ ] Phase 2 genesis trial (optional)
