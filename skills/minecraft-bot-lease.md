---
name: minecraft-bot-lease
description: "How a lease-mode colony worker acquires and releases a Minecraft body. Load when your profile runs with HERMES_BOT_LEASE=1 (no fixed MC_API_URL) — you must check out a body before any in-world `mc` action and release it when done. Covers the checkout/act/release ritual, --near/--cap selection, defer handling, renew, and the no-auto-checkout rule."
triggers:
  - bot lease
  - check out a body
  - no active bot lease
  - lease a bot
  - mc bot checkout
version: 0.1.0
status: prototype
metadata:
  hermes:
    tags: [minecraft, bot-lease, colony, hermescraft]
    category: minecraft-verb-bundle
---

# Bot lease — acquiring a body

You run in **lease mode** (`HERMES_BOT_LEASE=1`, no fixed `MC_API_URL`). You have
no body until you check one out. **Ordinary `mc` verbs hard-fail** with
`no active bot lease` until you do — there is no magic auto-checkout. Bodies
(mox/pip/zee) are a shared pool; the lease is the mutex (one lease per body), so
many workers run at once, each on its own body. Full spec:
`docs/architecture/bot-lease.md`.

## The ritual (every card)

1. **Check out a body** for the card's work location:
   `mc bot checkout --near <X,Y,Z> [--cap <scout|gather|build|mine>] [--mark <site>]`
   - `--near` picks the **nearest free body** to your target (the resource mark
     or base coords in your card). `--cap` filters to capable bodies.
   - Use `--mark` when the card is part of a multi-step chain at one site
     (`base_anchor`, `farm_*`, `mine_*`), so checkout prefers continuity.
   - `--bot <name>` forces a specific body (rarely needed).
   - Success prints the bound `bot` + `api_url`; now `mc status`/actions work and
     route to that body.
2. **Do the in-world work** (`mc move`, `mc dig`, `mc mark`, …) — your gaming
   skill (scouting/survival/building) drives the verbs.
3. **Release** before any desk work (`kanban_comment`, `kanban_complete`):
   `mc bot release`. After release, `mc` actions hard-fail again — that's
   correct; check out again if you have more in-world work.

## Reflexes

- **`no free body — defer`** (every body busy): do NOT spin-retry. The result
  carries `retry_after_ms` and `holders`. `kanban_block` with reason
  `no_free_body` and stop — the dispatcher retries you when a body frees.
- **Long actions:** ordinary verbs do NOT extend your lease. If a single step
  may outlive your turn budget, `mc bot renew` to extend it. (The body is never
  reclaimed mid-action, but renew keeps ownership after the action ends.)
- **`lease lost — re-checkout`:** your lease lapsed and was reclaimed. Stop
  assuming you hold the body — `mc bot checkout` again before acting.
- **Never** keep a body during desk work. Release the moment in-world work ends,
  even if the card isn't complete — that frees the body for other colonists.

## What you never do

- Never run an `mc` action verb without an active lease (it will fail).
- Never `mc bot release --force` — that's operator-only.
- Never pin a body in a card you file; let `--near`/`--cap` choose.
