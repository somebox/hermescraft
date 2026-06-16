# Bot lease (librarian)

Status: **MVP implemented** (in-repo). Agents explicitly check out a Minecraft **body** for an in-world phase, renew while acting, and release when done. This is **additive** beside Hermes **card claim** and landfolk gate-check mutex — see [board-dynamics.md](board-dynamics.md).

Companion: live steps in [../guides/bot-lease-live-runbook.md](../guides/bot-lease-live-runbook.md). This doc is the canonical spec (D1–D9 landed); design history lived in a Claude plan since repurposed for the genesis-v2 colony reconcile/run work.

---

## Problem

A kanban **card** can stay open through desk-work (comments, `kanban_complete`) while the **body** is idle in-world. Frozen `MC_API_URL` at spawn ties one profile to one HTTP port for the whole worker session. Genesis v2’s 1:1 specialist→body mapping leaves other bodies unused during long scout phases.

**Bot lease** decouples “who owns the card” from “who controls the body right now.”

## Three concepts (do not merge)

| Concept | Meaning |
|---------|---------|
| **Card claim** | Hermes: this agent is responsible for this task (`claim_lock`, worker lifecycle). Unchanged. |
| **Bot lease** | This session controls this registry body (`~/.hermes/bot-leases.db`). New. |
| **Checkout policy** | Which free body to pick ([board-dynamics.md](board-dynamics.md) bind rules — pull face via `mc bot checkout`). MVP: explicit `--bot` + tie-break; see § Deferred. |

**Keystone invariant:** No silent auto-**checkout**. After `mc bot release` (or once a lease lapses), action verbs hard-fail until `mc bot checkout` — `resolveLeaseUrl` only ever renews an *existing, still-valid* lease, never re-acquires a released or expired one.

**Touch-on-use renewal (release-on-timeout):** ordinary `mc` verbs renew the active lease on every command — each command pushes `expires_at_ms` out by one TTL (`max()`, never shrinking a longer explicit lease). This is how a body frees itself on worker **timeout/kill**: a dead worker issues no more commands, so its lease stops being renewed, lapses within one TTL (`DEFAULT_TTL_S`, default 600s, override `HERMES_BOT_LEASE_TTL_S`), and the next checkout reclaims the now-idle body — instead of lingering for the full TTL after a *single* checkout. `mc bot renew` still sets an explicit window for unattended holds.

## State machine (per body)

```
none ──checkout──▶ leased ──release──▶ none
leased ──ttl lapse + not-busy──▶ expired_idle ──reclaim──▶ none (may re-lease)
leased ──reclaimed by another──▶ lost (renew fails; action verbs hard-fail)
leased ──release --force (operator)──▶ none
```

## Storage

- Path: `~/.hermes/bot-leases.db` (override: `HERMES_BOT_LEASE_DB`)
- Table `bot_leases`: `bot` PK, `api_url`, `world`, `owner_id`, `lease_version`, `leased_at_ms`, `expires_at_ms`, `profile`
- Mutations use conditional writes on `(bot, owner_id, lease_version)`; `lease_version` increments on checkout/reclaim (fencing).

## Owner identity (MVP)

| Context | `owner_id` |
|---------|------------|
| Kanban worker (`HERMES_BOT_LEASE=1`) | `${HERMES_KANBAN_BOARD}:${HERMES_KANBAN_TASK}[:${HERMES_SESSION_ID}]` — stable across the worker's many `mc` subprocess calls (NOT `pid`, which differs per invocation) |
| Manual smoke (no task) | `cli:adhoc[:${HERMES_BOT_LEASE_OWNER}]` |

Upgrade to Hermes session id when stable env export exists (§ Deferred D5).

## Busy and reclaim

Busy signal: `GET /task` on the body’s `api_url` — busy when `data.sync != null` or `data.task != null`.

| Lease | `/task` | Reclaimable at checkout? |
|-------|---------|---------------------------|
| expired | idle | Yes |
| expired | busy | No |
| expired | unreachable | Yes |
| not expired | any | Never |

## Environment

| Variable | Purpose |
|----------|---------|
| `HERMES_BOT_LEASE=1` | Enable lease-aware `mc` (no `MC_API_URL` on genesis v2 specialists) |
| `HERMES_BOT_LEASE_DB` | Optional path to lease SQLite file |
| `HERMES_BOT_LEASE_ADMIN=1` | Required with `mc bot release --force --as-operator` |
| `HERMES_KANBAN_BOARD` | Part of `owner_id` for workers |
| `HERMES_KANBAN_TASK` | Required for worker checkout/release/renew |

Lease-mode workers must **not** set `MC_API_URL` or `_MC_API_URL_LOCKED` (genesis v2 mint). Landfolk flint/mason remain on frozen `MC_API_URL`.

## `mc bot` verbs (MVP)

See [mc-cheatsheet.md](../reference/mc-cheatsheet.md) for generated help.

- `mc bot checkout [--bot <name>] [--near X,Y,Z] [--cap <skill>] [--mark <name>] [--ttl <s>] [--json]` —
  lease a body; defer returns `retry_after_ms` and `holders[]`
- `mc bot release` — refuse if body busy; `mc bot release --force --as-operator` with admin env cancels job first
- `mc bot renew [--ttl <s>]`
- `mc bot status [--pool] [--json]`

Body pool: `data/bots/*.yaml` (`api_port`, `username`, optional `caps: [...]`).

### Checkout ranking (D1–D3, board-dynamics pull face)

Among free (or reclaimable) candidates, after the explicit-`--bot` shortcut:

1. **Capability filter (D2):** drop bodies whose `caps` don't include `--cap`. A
   body with **no `caps`** is universal (passes any `--cap`) — the current
   generic pool is unaffected. (Registry-flag path; inventory snapshot deferred.)
2. **Continuity (D3):** prefer the body whose `bot_last_mark` matches `--mark`
   (it last worked that mark). Stored in a sibling `bot_last_mark(bot, mark, ts)`
   table, written on a `--mark` checkout; survives release.
3. **Nearest (D1):** ascending distance from `--near` to each candidate's
   `GET /health` position (probed **only** when `--near` is given).
4. **Least-recently-leased → lexical** (tie-break; LRL orders currently-held
   leases — once released the row is gone, so sequential free picks fall to
   lexical. Concurrent holds + `--near` are the real self-balancers).

### Audit stamp (D4)

On a successful checkout with `HERMES_KANBAN_TASK` set, the lease **best-effort**
stamps the card: `hermes kanban --board <board> comment <task> "leased_bot=<bot>
v<version>"`. A failed stamp **never** fails the checkout (audit is advisory).

## Worker ritual (genesis v2 lease-mode)

1. `mc bot checkout --bot <name>` or `mc bot checkout` (tie-break)
2. In-world work (`mc` action verbs)
3. `mc bot renew` during long steps if needed
4. `mc bot release` before desk-work / `kanban_complete`
5. On `no free body — defer`: `kanban_block` with reason `no_free_body` (do not spin-retry)

## Relation to dispatcher bind

Target [@dispatcher](board-dynamics.md) **push-binds** `metadata.bot` at card write time. **Pull-checkout** is the same policy store accessed at runtime (`mc bot checkout`). MVP implements pull only; push via Python dispatcher is deferred (D11).

**genesis-v2 uses the lease as its body-mutex (D9):** the colony boot does NOT run the landfolk gate-check / `landfolk-dispatcher`. Expertise profiles (colony-scout/gatherer/builder) are lease-mode over a shared body pool (mox/pip/zee); the hermes gateway dispatches ready cards concurrently and each worker leases a distinct free body (`--near` self-balances, excess defers). The per-assignee gate-check would re-serialize same-expertise cards, so it's intentionally dropped here. Landfolk production is unchanged (still gate-check + frozen `MC_API_URL`).

---

## Deferred (post-MVP)

Track status here (`planned` → `done` + PR link). Do not rely on chat or Cursor plan alone.

| ID | Capability | Trigger | Status |
|----|------------|---------|--------|
| D1 | `mc bot checkout --near X,Y,Z` | Live two-body spike signed off | done |
| D2 | `mc bot checkout --cap <skill>` (registry-flag; inventory deferred) | After D1 or parallel | done |
| D3 | `last_mark` (`bot_last_mark` table) + `--mark` on checkout | With D1 | done |
| D4 | Kanban audit on checkout (`leased_bot=…` comment) | Bodiless workers on real board | done |
| D5 | `owner_id` Hermes session suffix | Stable `HERMES_SESSION_ID` / run id | planned |
| D6 | `spawn-with-bot.sh --lease-mode` | Optional; mint covers genesis | planned |
| D7 | Genesis `phase-epics.yaml` + scout cards pull-lease decomposition (location-tagged, `--near`) | After D1–D4 on manual `[LEASE-TRIAL]` | done |
| D8 | `skills/minecraft-bot-lease.md` + mint install | With D7 | done |
| D9 | Assignee model: expertise profiles + body pool; **lease replaces gate-check as the genesis-v2 body-mutex** | With D7; explicit decision | done |
| D10 | Release lease on worker death | TTL-only reap pain in production (1h leak deadlocked gv2-2026-06-15-3) | done — touch-on-use renewal + short idle TTL (general); genesis poller `reap_orphan_leases` reaps terminal-owner leases each tick + boot `clear_pool_leases` clean-slate |
| D11 | Python dispatcher reads `bot-leases.db` | Pull path stable | planned |
| D12 | Landfolk fleet lease-mode migration | Operator decision; default stay on `MC_API_URL` | planned |
