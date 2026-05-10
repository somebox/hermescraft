# Phase 2 — Appendix

Appendix A1–A8 of the Phase 2 architecture: deferred design notes (steward profile, marks sync, logistics planner, etc.).

---

# Appendix — Phase 3+ Roadmap (when Phase 2 is boring)

The destination architecture from the earlier draft, deferred until the Phase 2 loop is mechanical and bugs are rare.

## A1. Steward profile + body
A 6th profile `steward` with its own roaming Mineflayer body. Body is decoupled from role (role is body-independent; body provides diegetic chat presence). Aspirational tower built by the team as a kanban mission once efficiency justifies it. See earlier draft (commit `4ed4a55`) for full spec.

## A2. Marks sync (canonical → bot caches)
`POST /marks/replace` and `POST /marks/diff` endpoints; dispatcher hook to push relevant marks pre-spawn; chat-IPC handler in steward worker. Replaces the simple "coords inline in card body" pattern from §9.

## A3. Chest inventory in canonical
Promote `inventory_delta` metadata into a per-chest `inventory` field on chest marks. Audit cron tasks. Periodic ground-truth verification.

## A4. Logistics planner
Steward skill that runs a small rule engine over canonical state:
- chest occupancy > threshold → spawn overflow/rebalance card
- item count < floor → spawn supply card
- mark expired → spawn verify_mark card
- two cards need same chest → serialize via dependency
Distance computation, supply-chain efficiency analysis come *after* the rule engine works.

## A5. Mason + Barley cast expansion
Activated after L5 (build) and L6 (farm) pass with gatherer + flint covering temporarily. Each gets its own profile, body, port.

## A6. Custom dashboard
Web app reading from kanban DB + marks file + bot APIs + the event/feed schema (§13). Map view, inventory panel, mission feed, logistics overview, chat console.

## A7. L5–L8 capabilities
- L5 Build: `mc place_facing`, `mc place_against`, structure patterns, foundation handling
- L6 Farming & livestock: plant/harvest, breeding, food prep
- L7 Combat & survival: engage/disengage, threat-aware pathfind
- L8 Full logistics: multi-bot supply chains, treasury, rebalancing

## A8. Action layer polish
- `/api-spec` endpoint (OpenAPI for `/action/*`)
- Anti-revisit memory in pathfinder
- Custom metric registration in goal engine
- Token-diet `mc observe_lean`
