# genesis-v2-card-exceptions

Low-cost exception handling for genesis-v2 workers and planner. Uses the kanban
facade only (`docs/guides/kanban-facade-runbook.md`).

## Tiers

1. **Validator warning (planner, pre-dispatch)** — Fix card text; no status change.
2. **Worker preflight (`CARD_REVIEW_NEEDED`)** — Before `mc bot checkout`:

   ```bash
   scripts/kanban comment <id> "CARD_REVIEW_NEEDED: missing done_when; observed=<fact>; suggested_fix=<one line>"
   ```

   Do not lease a body. End turn with optional review-block:

   ```bash
   scripts/kanban block <id> "card-review-needed: <one line>"
   ```

3. **Soft-help (already in-world)** — `kanban_comment` with evidence; optional
   `mc chat "@colony-planner <bot>: …"` only if already leased. Continue only if
   the next step is bounded and non-destructive.

4. **Hard safety block** — Comment + block with a structured prefix (below). Stop.

5. **Planner-owned review** — Planner or poller files bodiless
   `[GENESIS2:CARD-REVIEW]` / `[GENESIS2:RESCOPE]` for `colony-planner`, citing
   card id + validator/comment evidence. Original worker card stays blocked until
   replaced or amended.

## Structured reason prefixes

| Prefix | When |
|--------|------|
| `card-review-needed:` | Ambiguous spec; planner edit required |
| `schema-missing:` | Missing `mine_site`, `done_when`, checkout/release, etc. |
| `source-unverified:` | Phantom stockpile / chest coords |
| `site-occupied:` | Construct without survey/clear authorization |
| `nav-needs-material:` | Route repair needs dirt/cobble/scaffold, not valuable stock |
| `mc-server-down:` | 503 / dead-on-arrival; not a card logic failure |

## Facade commands

- Read: `scripts/kanban show <id>` (or `scripts/kanban card <id>` where aliased)
- Comment: `scripts/kanban comment <id> "<text>"`
- Block / unblock: `scripts/kanban block <id> "<reason>"` / `scripts/kanban unblock <id>`
- Avoid default `scripts/kanban reassign <id> colony-planner` on genesis-v2 worker
  cards; prefer comments + planner review/rescope cards.
