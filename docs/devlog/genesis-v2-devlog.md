# genesis-v2 devlog

Running record of what we learned driving the genesis-v2 colony integration test
(procworld stack, specialist agents + body pool). Newest entries on top.

Related: [target architecture](../architecture/target.md),
[designated regions spec](../specs/world/designated-regions.md),
[genesis runbook (legacy core v1)](../guides/genesis-runbook.md).

---

## 2026-06-20 — gv2-2026-06-20-2 postmortem: control plane validated; 3-layer stall root cause

Capped 2h emergent run on `xiaomi/mimo-v2.5`, seed 63210, to validate the Phase 1–6
control-plane work + the mission-guard. Ran ~1h50m (manually stopped just before the
2h cap, at operator request, to dig into stalls). RETRO collected from all 7 agents
(gateway+bodies restarted post-stop WITHOUT re-mint to preserve run memory).

### Control-plane fixes — CONFIRMED working live
- **0 API errors** the whole run (mimo stable).
- **Mission-guard is load-bearing.** mimo repeatedly `kanban_complete`d its own standing
  `[MISSION]` (the SOUL prose did NOT stop it); the deterministic poller guard re-engaged
  it **38×**, keeping the colony producing — vs gv2-2026-06-20-1 which fully stalled at 7
  done when the planner closed the mission and nothing re-opened it. Removing the guard's
  total cap (kept only dedup-on-open) was necessary — the cap=5 was spent in 22min.
- **supervise-cap → park + `[RESCOPE]`** fired (80 parks); **MISSION-supervise exemption**
  held (0 SUPERVISE-of-MISSION); **`genesis-v2.sh stop` capture+teardown** validated live
  (16 artifacts incl. session dumps). The 2h auto-cap fire was NOT observed (pre-empted by
  manual stop) — code is unit-tested; live auto-fire still unproven.
- NOT exercised (conditions never arose): `tool_error_backstop`, `site advisory` (no
  base_anchor ever committed), `stock brief`. Armed, not validated.

### But the colony PLATEAUED — and the root cause is 3 layers deep
Converged to 12 marks by 66min, then churned: **185 done / 200 cards but 162 (88%) are
poller control cards** (SUPERVISE 100, MANAGE 38, RESCOPE 25) — only ~23 real work cards.
No base_anchor, no shelter, scattered marks, open-pit cobble pits = "messy map".

1. **Dense-forest pathfinding (the dominant cause — agent-unanimous).** All 5 workers'
   retros independently name it: *"dense spruce forest blankets every quadrant… every
   navigation-dependent card blocked with 10-15+ NAV_BLOCKED"* (gatherer); *"killed
   navigation, bots kept teleporting/stuck"* (builder); *"39-40 trees surround farm_plot
   from every direction, tried zee/pip/mox, all blocked"* (farmer). Seed 63210 is a spruce
   forest; the pathfinder can't route under canopy. This is THE embodiment ceiling.
2. **Concurrent commands on single bodies → `"goal was changed"` ×209.** Action logs show
   **226 (Mox) + 164 (Zee)** overlapping top-level command pairs (`move‖goto`, two
   `clear_strip` overlapping 43s). The body's `/action` HTTP endpoint has **no caller
   auth** — the lease is a CLIENT-side mutex only (mc CLI uses `ownerId()` just to pick the
   URL; sends no owner header; action log records no caller). Card-level corroboration:
   **peak 4 body-needing cards ran concurrently vs 3 bodies** (oversubscribed). Cannot yet
   attribute multi-agent vs single-agent bg/reactive overlap — the data doesn't exist.
   Reactive fall/hostile flee (`reactive.js`, not gated by `syncActionInFlight` like the
   water reactions) is one in-process source; a `pos.floored is not a function` crash
   (`reactive.js:261`, ×10) destabilizes the reactive tick.
3. **Backstop flood (second-order).** Nav failures → stalls → the supervise/park/manage
   machinery generates 162 control cards → the planner drowns processing them instead of
   building. The cure amplified the churn.

Plus footguns from retros: `mc mark --at BEFORE name` saved 4 marks at wrong coords
(scattered map); `clear_strip` drops the held tool on snow; pickaxe broke with no sticks
(gear/prereq gaps). The planner itself did real management (unlinked a dead dep chain,
archived a superseded shelter, fixed a wrong approach vector) — it's not pure churn.

### Next actions (ranked)
1. **Body-level owner enforcement** (verifies #2 AND fixes it): stamp `ownerId` on every mc
   request, log it per action, and have the body reject/log `/action` from non-lease-holders.
2. **Forest navigation** — the real ceiling: pathfinder can't route under spruce canopy;
   either pick non-forest spawn seeds or add canopy-aware routing / clear-first doctrine.
3. **Gate reactive fall/hostile-flee behind `syncActionInFlight`** + Vec3-guard `reactive.js:261`.
4. **Backstop damping** — auto-archive impossible cards instead of RESCOPE; quieter re-engage.
5. Fix `mc mark` arg order footgun; gear pre-departure checklist.

---

## 2026-06-20 — Issue-plan implementation (control-plane split): Phases 1–6

Implemented the genesis-v2 issue plan (control-plane split: agents choose among
well-shaped options; runtime/poller/overseer enforce sensing, budgets, verification).
All offline-tested; the live cognition/embodied gate + overseer-agent loop run at the
next genesis run. Commits `7702742`, `d1a3e7b`, `d9a6e57`, `47d1514`, `99a013c`, `6d62213`.

- **P1 — deterministic tool-error backstop.** Agents can't self-count failures
  (run-2 builder spun 252 before escalating). `detect_tool_error_spin` attributes
  failed actions to the RUNNING card via the lease (card→leased body) + the body's
  action JSONL windowed to run-start, and `block_card`s past 12 errors/5min; the
  blocked path re-engages the planner. Supervise-cap now PARKs (block + `[RESCOPE]`).
  `capture_run_artifacts` + `genesis-v2.sh stop` snapshot profiles/sessions (the
  per-turn dumps the next mint wipes) before teardown.
- **P2 — observe POI override.** `mc observe --full` preserves nearby_marks/signs/
  torches under nav-brief; otherwise an explicit `poi_omitted` marker (scouts read
  "absent" as "none" otherwise).
- **P3 — fell_tree.** Wall-clock cap (60s) + partial-progress return + reachability
  hints (boxed-in → clear_strip an approach); fixed survey-line fix-command form.
- **P4 — site-fit + stock.** `score_site`/`rank_candidate_pads`/`site_fit_brief`:
  stone is a build GATE, water a farm-viability WEIGHT (dry worlds are intentional);
  `file_site_advisory` nudges the planner off an unbuildable base_anchor.
  `file_stock_brief` surfaces deficits to the emergent planner (deduped) since
  emergent disables auto-SUPPLY. (Deferred: dependency visibility — parent links
  aren't in `list --json`; card standability lint — needs live `mc reachable`.)
- **P5 — verify by world-state, not marks.** `verify_built_structure` counts placed
  building blocks via RCON (run-2's shelter/farm/road weren't in the marks).
  `file_retro_cards` + `genesis-v2.sh retro` institutionalize the agent retrospectives.
  (Deferred to live: re-enable colony-overseer agent loop + post-BUILD verify wiring.)
- **P6 — revalidation.** Offline gate GREEN: **969 bot unit tests** (actions/runtime/
  cli) + **389 scripts/tests** (genesis2_lib incl. 26 new). Pre-mint LIVE gate still
  to run next session: terrain cognition/context/embodied ladder, plus live checks of
  the backstop, observe-POI, fell_tree-in-forest, site/stock advisories, and the
  overseer loop.

---

## 2026-06-19 — gv2-2026-06-19-2 (emergent, fixed): a near-complete colony; ceiling is site-fit + forest nav

Second emergent run, on **`xiaomi/mimo-v2.5`** (swapped from deepseek after run-1's
quota death; operator recall: more done with fewer errors/turns), seed 63210, same
dry calm world. Carried 5 fixes from run-1: model swap, `[MISSION]` exempt from
stall/blocked supervise, planner anti-duplicate + orient-first SOUL, stop-after-3
escalation SOUL rule, `fell_tree` as default bulk-wood. Ran ~2h, stopped by operator
after the build stalled. **Round feedback collected from all 7 agents before teardown
(RETRO cards).**

### What the agents actually accomplished (agent reports — the mark file undercounted)
External tracking (9 marks, board status) badly **understated** reality. Per the
agents' own retros:
- **builder:** built a **7×7 spruce-plank shelter** at base_anchor (verified by Mox).
- **farmer:** tilled a **5×5 wheat plot** near water, planted 10 seeds, marked `farm_wheat`.
- **road:** planned + **lit an 80-block route** (12 waypoints) base→water through forest.
- **miner:** supplied **~384 cobble** (3 SUPPLY cards); Mine1 active.
- **gatherer:** 2× 32 spruce logs → chest_wood, planted 3 saplings.
- **scout:** full 4-quadrant survey, scored 2 candidate pads, set base_anchor.
**Lesson: `mc` marks/registries are written inconsistently by agents, so mark-based
progress tracking undercounts real work.** A run is *more* done than the marks imply.

### Fixes that HELD (vs run-1)
- **Model: 0 API errors** the entire ~2h. mimo-v2.5 fully stable. The #1 run-1 killer is gone.
- **Churn controlled:** 0 SUPERVISE-of-MISSION (exemption works); clean 1-per-specialist
  FEEDBACK (anti-duplicate works); supervise capped at 3/worker.
- **Craft fix:** 0 window-races; all bench crafts server-side via PaperMCP.
- **Reached BUILD/FARM/ROAD/MINE** — first time past prerequisites; shelter + farm + road
  + cobble all actually produced. Run-1 never left prerequisite-gathering.
- **Planner adapted well:** detected the 9×9 cobble shelter was *physically impossible*
  (190 cobble, no stone at base), re-scoped to a plank-only shelter that succeeded.

### The real ceiling (from agent feedback — reordered from my external read)
1. **Site-fit was poor and cascaded.** base_anchor (-15,64,-45) had **no stone within
   ~20 blocks and water only at a frozen lake ~85 blocks away** (scout scored it 2/5 but
   it was still chosen). This *caused* the cobble-shelter impossibility (builder, planner),
   the far-water farm (farmer), and redundant stone re-supply (miner). **Site selection
   must weight stone + liquid-water proximity, and reject low-scoring pads.**
2. **Dense spruce forest = navigation hell.** `fell_tree` *was* used but **timed out
   repeatedly**; bots got stuck in canopy; pathfinder couldn't route through trunks
   (gatherer's "30-min navigation fight"; builder trapped underground 18 min). My
   "fell_tree ignored (0 uses)" read was wrong — it was *attempted and failing* in dense
   forest. Want `fell_tree --clear_radius` and/or tree-density scouting before dispatch.
3. **No chest stock visibility.** builder blocked repeatedly by empty chest_wood; miner
   over-supplied with no "sufficient" signal; planner wants stock flags. This is exactly
   the deferred inventory-gate / base-goals work.
4. **No auto-archive of impossible/superseded tasks.** Impossible t_c531e81c was never
   archived → mox kept burning cycles; 4 SUPERVISE cards piled on the same target;
   dependency edges to blocked parents silently block children with no planner visibility.
5. **Cards lack scout-provided coords** (farmer/builder self-select sites = wasted turns).
6. **`mc observe`/`scene` lossy mode silently strips marks/signs/torches** under
   `HERMES_NAV_BRIEF=1` (scout: +2-3 turns/card); wants a `--full` override.

### Fix verdicts
- Model swap, MISSION-exemption, anti-duplicate, craft, supervise-cap: **CONFIRMED.**
- **stop-after-3 escalation (SOUL text): FAILED.** Builder spun ~252 tool errors before
  blocking twice. Agents can't self-count failures across turns — this needs a
  **deterministic auto-block** backstop, not SOUL prose.
- **fell_tree-as-default (SOUL text): inconclusive/misdiagnosed** — used but timing out in
  dense forest; the problem is the *verb's forest behavior*, not agent verb-choice.

---

## 2026-06-19 — gv2-2026-06-19-1 (first emergent run): planning works, killed by API quota

First **emergent-mode** run (no phases/gates; planner gets a standing `[MISSION]`,
proposes → consults specialists per epic → decomposes → manages). Model:
`deepseek/deepseek-v4-flash:exacto`. Seed 63210, dry calm world.

**Headline: the run died of OpenRouter quota, not agent logic.** From ~16:45 every
agent's LLM calls returned `402` (weekly credit limit: *"requested up to 32768
tokens, can only afford 17180"*) / `403`. That coincides exactly with the late-run
"stall" — `done` flat at 18, cards going blocked, planner "churning" supervises.
Post-16:45 behavior is confounded; **valid window ≈ 15:44–16:44.**

**What worked (healthy window):**
- **Craft fix (PaperMCP-first):** 0 window-races; mox did 2 clean server-side crafts.
- **Advise suppression:** 0 `mc advise` attempts this run (was 10 across prior runs).
- **Emergent planning was real:** planner produced an 8-epic plan; builder/farmer/road
  each *ran* (15:44–15:51) and answered their `[FEEDBACK]` consult card before idling.
- **Escalation used (partially):** gatherer called `kanban_block` 3× when truly stuck.
- **Real output:** base sited+marked (31,63,-51), 32 spruce logs → `chest_wood`, mine
  opened (`mine_entrance` 2,71,-28).

**Real gaps (independent of quota):**
- **`fell_tree` = 0** — gatherer ignored the skill's whole-tree verb, used `mc collect`.
- **Decomposition never reached BUILD/TILL** — only prerequisite SUPPLY/CLEAR/SCOUT
  cards issued, and all blocked (wheat seeds, cobblestone, clear-site) → no shelter/farm.
- **Embodiment is the bottleneck:** gatherer logged 66 tool errors (pathfinder give-up,
  "trapped all 4 cardinal dirs," `pillar_up` could-not-place) fighting plateau terrain
  for wheat seeds — 1414 log lines, repeated traps.
- **Uneven escalation:** miner/scout had 24/20 tool errors but **0** `kanban_block` —
  retry-spun instead of escalating.
- **Churn (real, secondary):** poller supervised the standing `[MISSION]` card 3×;
  planner re-filed duplicate `[FEEDBACK]` cards.

**Fixes applied for next run (offline; effective on re-mint / poller restart):**
1. Model → `xiaomi/mimo-v2.5` (more done with fewer errors/turns per operator recall).
2. `[MISSION]` exempt from `detect_stalled_workers` + `detect_blocked_workers`.
3. Emergent planner SOUL: ORIENT-first (read board each cold dispatch) + NO-DUPLICATE-CARDS rule.
4. Escalation SOUL (all agents): hard **stop-after-3-failures → `kanban_block`** rule.
5. `fell_tree` made the DEFAULT bulk-wood method (survival skill + gatherer SOUL).

---

## 2026-06-17 — craft window-race: verified, isolated, mitigated (PaperMCP-first)

gv2-2026-06-17-4 stalled at P2 (no wood/farm). Dug into it with the live bodies.

**Root cause (confirmed):** mineflayer 4.23 + Paper 1.21 3×3 table-craft window
race (#3399). Native `b.craft` lands only ~1-in-5 attempts. Run logs: 48 crafts
raced, 18 ran the full 6-retry loop, 9 PaperMCP fallbacks fired (9/9 succeeded,
tools got made). It's a PERFORMANCE problem, not functional — but each bench
craft burns ~4–5s of racing, and that devours worker iteration/time budget.

**Isolated:** the reliable PaperMCP server-side craft was the LAST resort —
`MAX_CRAFT_ATTEMPTS = requiresBench ? 6 : 1`, fallback only after all 6 native
attempts fail.

**Live-debug findings:**
- PaperMCP server-side commands are 100% reliable live (fill/setblock/tp/give
  9/9 across two setups) — exactly what `serverSideCraftFallback` uses (clear +
  give). The fix's mechanism is proven, not just logged.
- A bot stuck in water can't hold still to craft at all — a plain 2×2 stick craft
  timed out at 30s while pip was in a water-escape loop (18 min). So the colony's
  craft failures are window-race PLUS environmental instability (watery base).
- Couldn't force a clean isolated native-craft count on a test platform — the
  live bots won't stay where they're tp'd (they path back to their work area;
  `goals-*.json` is empty so it's not a persisted goal). Native rate is well
  sampled by the run logs anyway.

**Fix:** `crafting.js` now does the PaperMCP server-side craft FIRST for bench
recipes when `paperMcpConfig()` is non-null (ingredients intact), skipping the
racy native loop; bodies without PaperMCP (or a fallback that doesn't land) fall
through to the native retries unchanged. Backward-compatible — the 41 existing
craft tests pass (no PaperMCP in the test env → native path).

---

## 2026-06-16 — gv2-2026-06-16-1 live findings (Gaps 1–5 validation + new base-prep gaps)

First live run with Gaps 1–5. **Validated WINS (the new behaviors fire in-world):**
fell_tree (gatherer, 7 logs), clear_strip + level_ground (builder BASE-CLEAR),
place_torch, kanban_block (110×), --mark base_anchor (47×). Infra healthy
(poller/watchdog/lease clean). But the run surfaced a cluster of NEW gaps:

- **Cross-run memory contamination (operator-confirmed).** `mint` clears the
  top-level `MEMORY.md` but NOT `memories/MEMORY.md` (it held a prior-run `@23:12`
  entry in an `@01:05` run) and **preserves the 88MB `state.db` by design**. Stale
  marks/decisions carry across runs. Fix: new-run must fully wipe agent working
  memory (`memories/` + reset `state.db`) per round.
- **BASE-CLEAR vs the pre-rendered shelter (self-inflicted scope bug).** BASE-CLEAR
  `clear_strip`/`level_ground` over the "~10×10 footprint around base_anchor"
  overlaps the boot-rendered 7×7 shelter → the builder digs up the shelter from
  inside, stuck + destructive. Re-scope: clear/flatten AROUND the shelter (tree
  removal + wall perimeter), EXCLUDE the shelter footprint (the render preps it).
- **Base site not inspected for safety.** Scouts mark candidate pads and
  BASE-SELECT picks one (base_anchor=47,-49) without checking it's dry/solid/flat
  → base placed over water; bots drown. Need a real site inspection (reject/flag
  water under/around the pad; require solid flat ground).
- **Leveling must FILL/COVER water + voids, not just dig.** Operator: "water around
  the base — fill or cover with blocks to make it safe to walk." Base prep must
  produce a solid, water-free, walkable pad (level_ground fill + a deck/fill pass
  over water), as part of leveling.
- **Agents don't treat water as a hazard.** They walk/fall in and drown instead of
  noticing "water around base = red flag → fill/cover before building/walking."
  Needs a skill/SOUL red-flag.
- **`mc advise` still attempted 62×** despite the SOUL "non-actionable" rule — the
  bot's own error hints keep tempting the model. Neutralize the hints at source.
- **Chest-snapshot capture-content still zero** (totals 0, chests_fresh 4) — `items`
  not captured. Inventory gate + supply loop correctly stayed fail-safe (0 supply
  cards), so nothing stalled, but the capture path needs fixing for those to bite.

### Fixes (this round — offline-validated, not yet run live)
- **Water safety is now deterministic.** `shelter_setblock_commands` force-fills a
  solid 2-layer cobble foundation under an 11×11 pad + drains standing water above
  it — base is dry/solid regardless of anchor (no longer dependent on agent
  leveling). Pinned by `test_shelter_render_makes_safe_dry_foundation`.
- **BASE-CLEAR scope fixed + site inspection added.** BASE-SELECT inspects the pad
  (`mc terrain_top … radius=5`) and rejects water; BASE-CLEAR excludes the
  pre-rendered footprint (base_anchor ± 3), clears/levels only the apron +
  door-exit corridor. Building skill flags water + points to `mc deck`. (Correction:
  `level_ground`/`deck` fill only AIR, not water — skill + template now say so.)
- **Memory wipe per round (real fix).** `mint` resets `state.db` (+ wal/shm) and
  `sessions/`, not just `*.md` — the message-history DB was the cross-run `@23:12`
  source (and the road-planner clone ships its own history). Auth is in
  `.env`/`config.yaml`, so safe. (Assumes hermes recreates `state.db` on boot —
  confirm next run.)
- **`mc advise` neutralized at source.** `bot/lib/shared/escalation-hint.js`
  degrades all 8 stuck/blocked hints to `kanban_block` when `MC_SUPPRESS_ADVISE_HINTS=1`
  (genesis bodies set it; default-off = prod-safe, identical string). Unit-tested.
- **Capture-content is NOT a code bug.** `snapshotChestAtPosition` is correct;
  `total=0` = nothing deposited. Real gap = GATHER never deposits + chests lack a
  `chest_*` mark to deposit into — a sequencing concern, addressed via handoff.
- **Handoff convention (Option B).** Shared SOUL HANDOFF block: read predecessor's
  note on pickup (`kanban show <prior_id>`), post a structured `HANDOFF:` comment
  before `kanban_complete`. Planner rule 7 + P1 CARD-WIRING inject a
  `Continues from <prior_id>` pointer when wiring `after:`. Chosen over single-card
  stage-rotation to avoid a poller state machine; `kanban show` already surfaces
  parent comments, so no new tooling.

---

## 2026-06-16 — door + gate traversal: matrix-mapped; E/W reliable, N/S a framework limit

Investigated the shelter-door egress ceiling test-first. Built a comprehensive
functional matrix (`tests/functional/test_door_pathfind.py`): `{oak_door,
oak_fence_gate} × facing{N,S,E,W} × hinge{L,R} × open{T,F} × method{goto_near
(pathfinder), through (robust)}` = 48 cells, plus a shelter-egress test
(`test_shelter_egress.py`).

**Empirical result:**
- **E/W doors + ALL fence gates (every facing): 100% reliable**, both methods —
  guaranteed + hard-asserted.
- **N/S-facing DOORS: framework limitation.** Pathfinder crossing of N/S doors
  races (door opens, path re-eval lags → bot stalls outside; north fails
  open+closed via pathfinder). The robust `through` direct-walk wedges at the
  door-cell center on a south-facing closed→opened door — the door DOES open
  (confirmed `open=true`), but the centered 0.6 hitbox wedges. Mitigations
  (F69c sneak, F69d strafe-nudge, F69e retreat-then-pathfinder) took south-closed
  0→1/6 — not solved. It's a real N/S handedness in mineflayer-pathfinder + door
  swing/collision, below our action layer.

**Decision (operator): enforce E/W + document the limit.** E/W is already the
shelter spec (`genesis2_lib.shelter_setblock_commands` renders `facing=east`).
Shelter egress through the E/W door is reliable — `test_shelter_egress.py` passes
for move/through/goto_near. N/S door cells are `xfail(strict=False)` in the matrix
(regression guard for the reliable set); the `through` hardening is kept (no
regression, marginal N/S help).

**Shelter egress was NOT a door-mechanic bug** — the E/W shelter egress passes
cleanly in isolation. The live "cannot exit shelter, door" was most likely
terrain/approach (base not cleared — see the base-clearing observation), not the
door itself.

**Deferred:** true any-facing door traversal needs a mineflayer-pathfinder-level
fix for the N/S handedness (or a custom door-cross routine). Tracked as a known
limitation; build E/W doors until then.

---

## 2026-06-16 — SESSION WRAP-UP: resilience + agent self-correction validated (P1–P3)

**Outcome.** Run `gv2-2026-06-15-5` cleared **P1 ✅ P2 ✅ P3 ✅** — every implemented
phase — on one clean run, self-recovering through every failure mode. This is the
deepest and cleanest genesis-v2 run to date. The colony built a base + shelter +
storage, tilled a farm by water, and opened a registered mine, then advanced into
P4 (whose gate is an unbuilt stub). All the fixes below were proven live, in order
of discovery this session.

### The arc — what got fixed (each validated live)
1. **Craft blocker (PaperMCP).** Genesis bodies never sourced repo `.env`, so
   `PAPERMCP_TOKEN` was absent → `serverSideCraftFallback` off → ~50% of 3×3 table
   crafts silently no-op'd (this killed runs -1/-2 at GATHER). Fix: `genesis-v2.sh`
   + `restart_bodies` source/inject the token. Verified token-in-env + live
   PaperMCP round-trip; crafting reliable since.
2. **Lease leak on worker death (deadlock in -3).** A timed-out/killed worker never
   ran `mc bot release`, so its body stayed leased for the 1h TTL; all three leaked
   → pool deadlock. Fix: **touch-on-use renewal + short idle TTL** (600s,
   `HERMES_BOT_LEASE_TTL_S`) in `lease-registry.mjs` — a live worker renews on every
   command, a dead one lapses fast; plus genesis `reap_orphan_leases` (poller reaps
   terminal-owner leases ≤60s) + boot `clear_pool_leases`.
3. **Gateway dispatch-task death (silent stall in -4).** The hermes asyncio
   dispatcher can throw on a worker-crash path and die while the event loop keeps
   running — process looks alive, dispatch/promotion stop. (Root-caused via py-spy:
   main thread healthy in `select`, dispatch task gone — NOT a poller hang; the
   poller was just idle.) Fix: poller **watchdog** restarts the gateway when
   `gateway.log` goes silent while cards wait (3 auto-recoveries in -5).
4. **Dispatcher fragility.** `kanban.failure_limit` was being applied as **1** (a
   9-day-stale gateway); one mimo protocol slip killed a card. Fix: config → **3** +
   gateway restart baked into `new-run`.
5. **Mine-registry world mismatch (P3 stuck in -4).** Bodies write mines to
   `mines-world.json` (regionsWorld resolves to "world"); the P3 gate read a
   nonexistent `mines-genesis2.json`. Fix: `check_phases` reads the file the bodies
   write, **filtered to genesis-pool-authored mines** (production mines excluded);
   boot strips prior-run genesis mines for a clean slate. P3 passed automatically in -5.
6. **Agent self-correction (the -5 build).** Replaced the mechanical gate-gap card
   with an **OVERSEER agent**: at a phase transition (frontier idle + gate unmet)
   the poller files an `[OVERSEE]` card carrying the gate state; the read-only
   `colony-overseer` confirms the gate or files the missing worker card(s) with
   judgment. Plus **verify-before-complete** in every SOUL, and a **planner
   skill-routing** fix (route by assignee, never invent a `skills` field — killed
   the `minecraft-scouting` vs `-site` "Unknown skill" errors).
7. **One-command clean launch.** `new-run` now does the full reset end-to-end:
   clean shutdown (poller + stale workers + gateway --replace) → re-mint 8 profiles
   (skills copied) → Multiverse world regen → restart bodies → wipe leases/marks/
   mines → archive board → reseed → fresh poller.

### What -5 proved about the self-correction layer
- **Overseer works end-to-end:** it corrected the P1 chest gap (3 OVERSEE cards →
  chest placed → P1 closed) and stayed **quiet for P2/P3** (they passed cleanly).
  Fires only where correction is needed.
- **verify-before-complete is the WEAK layer.** mimo still completed BUILD with 1 of
  2 chests; the overseer is what caught it. Treat per-agent self-check as soft;
  the overseer is the real backstop.
- **Defense-in-depth held:** watchdog (gateway), lease reaper (bodies), supervise
  (stuck workers), overseer (gate gaps), failure_limit (crash churn) — each caught
  a distinct failure, none alone sufficient.

### The one real ceiling: shelter-door egress (gameplay, not infra)
Builders repeatedly stuck *"cannot exit shelter, door…"* (the door-direction
limitation) — it nearly exhausted the overseer's cap-of-3 in P1 before a retry got
through. This is the only failure no agent/infra mechanism can fix; it needs a
code/spec change. **Top priority for the next iteration.**

### Prioritized next-iteration backlog
- **P0 — Shelter door egress.** Fix the rendered door facing (face the working/
  approach side) and/or bot door traversal; bake into the shelter spec. The hard ceiling.
- **P1 — Escalation + verification.** Stuck workers hallucinate `mc advise` (exit 1);
  teach SOULs to `kanban_block` with a reason (or add a real escalate verb). Decide
  whether to strengthen verify-before-complete or lean on the overseer as primary.
- **P2 — Gameplay skills.** Gatherer should use `fell_tree` (not random block hunt);
  miner should place torches → coal in the supply chain; base area should be
  cleared/flattened; resource gathering should be first-class in planning.
- **P3 — Lease policy.** Prefer **card-chain continuity** over `--near`/inventory;
  detect true-idle as "last card was a chain end"; put idle bodies on chores.
- **P4 — Phase coverage.** Build the P4 (roads) + P5 (steady-state) gates to extend
  past the current P1–P3 implemented set.

---

## 2026-06-15 — gv2-...-5 live observations (operator, for wrap-up)

Captured while watching the agent-self-correction run. Not yet acted on —
candidate work items for the next iteration.

**Gameplay / worker-skill gaps**
- **Gatherer ignores `fell_tree`.** It searched semi-randomly for blocks instead
  of using the `fell_tree` primitive. The survival skill/SOUL should direct wood
  collection through `fell_tree` (whole-tree, efficient) rather than ad-hoc block
  hunting.
- **Miner should place torches** when possible — which means **coal must be in the
  supply chain** (mine → coal → torches for lit, safe descents). Today mining
  doesn't light itself.
- **Base area + surroundings should be CLEARED** — fell trees, flatten ground,
  open up space around `base_anchor`. There's no clear/flatten step today; the
  base gets built into unprepared terrain.

**Planning emphasis**
- **Resource gathering should be more prominent in planning** — the planner
  under-weights raw-material supply; gather/stock should be a first-class,
  recurring concern, not an afterthought behind structure cards.

**Shelter egress / escalation (live stall on gv2-...-5 P1)**
- **Door egress is a hard blocker.** Builders repeatedly stuck *"cannot exit
  shelter, door…"* (t_90c1b722 supervised 3× to the cap, then t_bbfb343b retried
  same) → can't place the P1 chest → P1 stalls. This is the known door-direction
  limitation: the bot can't traverse the rendered E/W `oak_door` in its working
  direction. Fix the shelter render's door facing (face the working/approach side)
  and/or the bot's door traversal — this MUST land in the shelter spec.
- **`mc advise` is hallucinated.** A stuck worker invented `mc advise --reason …
  --target …` to ask for help; the verb doesn't exist (exit 1). The real
  escalation is `kanban_block` (which the supervise detector keys on) — teach the
  worker SOULs to `kanban_block` with a precise reason when stuck, OR add a real
  `mc advise`/escalate verb. Right now stuck workers have no working help path.
- **Supervise can't fix structural problems.** It re-engages the planner, but a
  door-direction wall isn't fixable by re-filing cards — it cycles to the cap and
  parks. Structural/skill gaps need a code/spec fix, not more supervise cards.

**Lease policy — card-chain continuity (design idea)**
- A bot lease should **stick to the same card SERIES (chain) when possible** —
  prioritise chain continuity OVER `--near` location or inventory. When binding a
  bot to an agent, check whether the **previous linked card in the chain used the
  same bot** and prefer it.
- **True-idle detection:** a bot is genuinely idle only when the last card it
  worked was the **end of a chain** (no further children / dependents). 
- **Idle bots should do chores** — scouting, food, wood, etc. — rather than sit
  free. Surface productive filler work for chain-ended bodies.

---

## 2026-06-15 — run gv2-2026-06-15-4 postmortem: gateway dispatch-task death

First run with the lease-release-on-timeout fixes live. **The lease fixes held**
(pool clean throughout — no leak, no deadlock). But the run stalled early, at the
scout→P1-work handoff, for a completely different reason — and the first diagnosis
("poller hung") was **wrong**. py-spy settled it:

- **Poller (ours): healthy.** `py-spy dump` showed it asleep in `time.sleep`
  (`genesis-v2-poller.py:119`). Its log only *looked* frozen because the run was
  stalled — no card transitions → nothing actionable → nothing to log. It was idle,
  not stuck. (Same for the "poller hang" suspected in run-3 — a misread.)
- **Gateway (vendored hermes-agent): dispatch task dead.** `py-spy dump` showed the
  asyncio event loop *alive and healthy* (`select`/`run_once`/`run_gateway`), but
  the dispatcher had stopped. Classic asyncio failure: an unhandled exception inside
  the dispatch coroutine kills that task silently while the loop keeps spinning, so
  the process looks fine but never dispatches/promotes again. Matches the log: last
  tick (18:11:46) was `crashed=1 … auto_blocked=1` (a mimo protocol-violating
  scout), then dispatch stops forever; a leaked `CLOSE_WAIT` socket to an LLM/443
  endpoint is the half-cleaned-up error path.

Chain: mimo protocol violation (worker exits rc=0 without `kanban_complete`/
`kanban_block`) → worker crash + auto_block → **exception takes out the dispatch
task** → no promotion → P1-work cards (BASE-SELECT/GATHER/BUILD) stuck in `todo`
→ stall. Promotion logic itself (`kanban_db.py:2886`, promote when all parents
done/archived) is correct — it just stopped being called.

Aggravator: `effective_limit: 1` — the **9-day-old gateway was running stale config**
(`config.yaml` already said `failure_limit: 2`); one mimo slip killed a card.

**Fixes shipped:**
1. `config.yaml kanban.failure_limit` → **3** (was being applied as 1 from stale
   gateway). More retry tolerance for mimo's flaky protocol compliance + fewer
   auto_blocks means the dispatch-killing path is hit less often. Needs a gateway
   restart to load.
2. **Gateway dispatch watchdog** (`genesis2_lib.maybe_restart_dead_gateway`, wired
   first in the poller loop): if `gateway.log` is silent past `GATEWAY_STALE_S`
   (180s) while genesis cards await dispatch (ready/todo), bounce the gateway
   (`hermes gateway run --replace`), cooldown-guarded (300s) against restart loops.
   A single mimo crash can no longer silently freeze a whole run.
3. Manual gateway restart recovered run-4 in place — dispatch + promotion resumed
   immediately, the `gave_up` scout retried under the higher limit, and a
   subsequent `crashed=1/auto_blocked=1` was absorbed *without* killing dispatch.

Durable upstream gap (not ours to patch cleanly): the hermes dispatch task should
be supervised/wrapped so it can't die unhandled. The watchdog is our backstop.

---

## 2026-06-15 — run gv2-2026-06-15-3 postmortem: lease-leak deadlock

First run with the **PaperMCP craft fix live** (genesis bodies now source repo
`.env` → `PAPERMCP_TOKEN` reaches them → `paperMcpConfig()` non-null →
`serverSideCraftFallback` enabled; verified token-in-env on all three bodies +
live PaperMCP auth/`execute_command` round-trip). The craft blocker is gone.

**Progress (gates confirm it was real):** P1 ✅ (base_anchor + 2 chests + buildable
shelter) and P2 ✅ (wheat plot tilled beside water + storage organized + ≥3
resource marks) both passed legitimately. P3 partial — MINE-NAVIGATE + MINE-OPEN
done, but the mine registry stayed at 0 entries (P3 gate fails `mine entries
0<1`) and MINE-SUPPLY never ran.

**Why it stopped — a stale-lease deadlock (not normal blocking):**
- A gatherer task `t_4091f488` (`[P2] collect wheat seeds by breaking grass`) went
  `timed_out → gave_up → archived` and **never released its bot leases on pip+zee**.
  A third lease on mox was held by another timed-out owner. → **0 free bodies for
  ~1h**; every work card then blocked `no_free_body`. The card's own diagnosis:
  *"pip/zee owned by archived task t_4091f488 … requires manual lease release."*
- Root mechanism: `lease-registry.reapExpiredIdle`/`isReclaimable` only reclaim a
  lease once `expires_at_ms < now` — i.e. **after the full 1h TTL** — regardless of
  whether the body is idle or the owning task is dead. The lease layer is
  deliberately task-agnostic, so it can't know the worker died. A worker that
  times out/gives up/is killed never runs `mc bot release` → its body is locked
  for up to an hour.
- Compounding: the poller filed the **max 3 supervise cards/worker** (cap hit on
  all stuck workers); the planner correctly said it needed a *manual lease
  release* — which the agent layer can't do. After the leases finally TTL-expired
  (DB empty now, bodies free), `requeue_deferred` didn't pick the cards back up
  because their *terminal* block reasons aren't the `no_free_body`-deferred type it
  matches (FARM=`prerequisite: waiting for seeds`, MINE-SUPPLY=`help-needed:
  navigation/water`). So the poller now silently no-ops every 60s.
- Secondary real blockers (legit gameplay gaps, independent of the leak): the
  gatherer couldn't collect wheat seeds by breaking grass (the timeout that
  started the cascade); MINE-SUPPLY couldn't path to the mine entrance ("frontier
  far away; water issue").

**Fix (lease-release-on-timeout), shipped this session:**
1. **Touch-on-use renewal + short idle TTL** (the architectural root-cause fix, all
   consumers — `bot/cli/lease-registry.mjs`). Every leased `mc` command now renews
   the lease (`resolveLeaseUrl` pushes `expires_at_ms` out by one TTL, `max()` so a
   longer explicit lease is never shrunk). `DEFAULT_TTL_S` dropped 3600→**600s**
   (env override `HERMES_BOT_LEASE_TTL_S`). A live worker keeps its body by using
   it; a worker that **times out / is killed** stops issuing commands → its lease
   lapses within one TTL → the next checkout reclaims the idle body. The keystone
   invariant holds: `resolveLeaseUrl` only renews an *existing valid* lease, never
   re-acquires a released/expired one (no silent auto-checkout). Cuts the leak from
   ~1h after a single checkout to ≤10 min after the last command.
2. **Genesis runtime reaper** — `genesis2_lib.reap_orphan_leases()` each poller tick
   releases any pool lease whose owner kanban task is terminal (archived/done/
   cancelled) or absent from the board, via a new `mc bot release --owner <id>`
   path. `release()` still refuses a busy body. Reaps in ≤60s where the owner is
   already known-dead — faster than waiting out even the short TTL.
3. **Boot clean-slate** — `genesis2_lib.clear_pool_leases()` at new-run start drops
   every genesis-owned lease on the pool bodies, so a fresh run can't inherit a
   prior run's leak ("mox owned by previous run").

Not yet addressed (next iteration): (a) the supervise-cap + terminal-block-reason
combo that prevents auto-recovery once bodies free up — `requeue_deferred` should
also re-engage cards stuck purely behind a (now-resolved) lease shortage; (b) the
gameplay gaps (grass→seeds, mine-entrance navigation over water).

---

## 2026-06-15 — CRAFT root cause: table-window race (the real blocker)

Both the deepseek and mimo stabilized runs (gv2-2026-06-15-1/2) stalled at the
**same place** — GATHER, unable to craft the stone tool set — isolating the blocker
as the craft path, NOT the model (mimo reached base+shelter in ~12 min vs deepseek
~50, then both hung at GATHER with chests=0; BUILD waits on GATHER → P1 never gates).

**Root cause (reproduced clean: table at 0.7m + materials present):**
- 3×3 table recipes (`stone_pickaxe` `needsTable:true`) need `b.craft` to open the
  crafting-table WINDOW; that window-open **silently fails ~50%** (4/8 in test) —
  `b.craft` returns having crafted nothing, no error → `CRAFT_NO_OP`.
- 2×2 recipes (`oak_planks` `needsTable:false`) craft in the bot's own inventory
  grid (no window) → never fail. Explains "planks work, tools don't."
- Failures **cluster** for a few seconds, so the in-process 6-retry (all within
  ~4s) can fail as a block; the agent then wastes wood placing extra tables.
- The designed mitigation `serverSideCraftFallback` (clear ingredients + give
  result, bypassing the window) is OFF — gated on `paperMcpConfig()`, and no
  `PAPERMCP_TOKEN` is set on the bodies.

**Fix options:** (1) enable PaperMCP (`PAPERMCP_TOKEN` env + plugin) → the existing
fallback deterministically completes table crafts; (2) if no PaperMCP, add a
server-side craft fallback over rcon (poller-side, or a node rcon client in the
bot); (3) retry-hardening alone won't beat a 50% clustered failure. The lease
material/tool handoff (inventory stranded per-body) is a SEPARATE, secondary gap.

**Runs gv2-2026-06-15-1/2 abandoned** (deepseek slow; mimo stalled on craft + the
diagnosis hand-fed Mox tools). Re-run clean after the craft fix.

---

## 2026-06-15 — stabilization slice (implementation)

Shipped the **minimum slice** from the Genesis V2 Stabilization plan (Option **A**
for shelter: rcon setblock render at `base_anchor` after BASE-SELECT).

**Code / templates**
- Per-run `regions-world.json` from `data/genesis-v2/templates/regions-world.template.json`
  (single buildable `shelter`, no protect trap).
- `probe_natural_spawn` / `find_good_spawn`: hard-fail without surface water within
  `SURFACE_WATER_RADIUS` (48) unless dev override.
- Poller: `sync_body_pool_gates` (`awaiting_free_body`) then `requeue_deferred`
  (`no_free_body` only); `maybe_render_shelter_for_run` when `base_anchor` exists.
- P1 epic: forbid ad-hoc `region_create protect`; BUILD = verify/furnish inside boot
  `shelter` + `mc task_context set shelter`; BASE-SELECT uses `mc mark … --at`.
- Escape enclosure uses **`forceEscape`** on internal `dig` (not CLI `mc dig --force`), so
  landfolk protect regions are not griefable; generic `--force` still only bypasses
  global structural denylist + other non-region guards.
- Shelter rcon render **`fill`s interior air** and clears cells outside the east door.
- `sync_body_pool_gates` **caps releases** to `_free_body_count()` (same as requeue).
- Offline tests: `scripts/tests/test_genesis2_lib.py`, `scripts/lib/gv2_template_contract.py`.

**Verification run (this session)**
- `node --test bot/test/integration/region-protection.test.js` — pass (6/6).
- Python: `scripts/tests/test_genesis2_lib.py` — run locally with pytest in a venv
  (`python3 -m venv .venv && pip install pytest && pytest scripts/tests/test_genesis2_lib.py`).
- **Live** `genesis-v2.sh new-run` not executed here (requires homelab MC + gateway +
  body pool). Next operator step: verification ladder in plan Phase 6, then new-run
  without `--spawn` unless bypassing water probe.

**Remaining gaps (belt)**
- Live capture of `pos.floored` stack if escape still fails in-water paths.
- Gateway admission to eliminate spawn→block race (poller gate only reduces churn).
- P2+ inventory gates when chest snapshots return quantities.

---

Asked each agent (bot-less `[FEEDBACK]` card) to review its genesis-v2 cards and
report WORKS / NEEDS-IMPROVEMENT / IDEAS. Returns from all six roles (scout,
gatherer, builder, farmer, miner, planner). Independently corroborates the diagnoses
above and adds concrete execution-layer bugs.

### Confirmed by multiple agents
- **Region-protected shelter traps bots** — gatherer ("single biggest failure",
  ~40 min wasted), builder, miner. Plus: **`mc escape` is broken**
  (`pos.floored is not a function`) and **`mc pillar_up` returns POLICY_DENY**
  inside the protect region — so the in-region self-rescue path doesn't exist. Top
  priority; validates the door-blueprint + region-lifecycle + worksite fixes.
- **Body contention (`no_free_body`) is the #1 throughput bottleneck** — scout:
  **15 of ~20 sessions blocked**; 3 bodies shared across all roles starves every
  queue, and each block **wastes a full agent spawn** (skill load + kanban + memory
  read) for zero world output. → dispatch should gate on body availability
  (don't spawn a worker that will immediately block), and/or grow the pool / batch
  cards. Ties to the dispatcher concern in the operational-layer research.
- **Card coords not standable** — scout: cards gave spawn/site coords inside
  structures or on unstandable terrain (e.g. 0,65,0; 64,83,-96). Coords in card
  bodies must be validated standable (matches the spawn-probe findings).
- **Navigation unreliable** — scout (`mc goto` NAV_FAILED/timeout), miner
  (pathfinder failures), builder (door placement timeout). Recurring execution-layer
  reliability gap.
- **Duplicate + oversized cards** — farmer: two identical farm cards dispatched
  minutes apart (planner should dedup in-flight cards); a **9×9 (81-block) farm at a
  waterless base** with no `till_area` in the spec — oversized + mis-sited. Matches
  the "start small" sizing + farm-needs-water points.

### Planner (orchestrator) adds
- **One admin issue blocked 3 cards across 2 phases** — the region-trap at
  base_anchor stalled roof-patch + mine-supply + water-supply. Single point of failure.
- **No fast-path for admin-only blockers** — SUPERVISE is the wrong tool when the
  answer is "operator must edit region protection"; the planner kept re-investigating
  (**10 supervise cycles on one card**). Confirms the escalation cap (now 3) and argues
  for a distinct **needs-operator** terminal state that pings the human, not churn.
- **Prerequisite chains not enforced** — the water-supply card was spawned before its
  inputs could exist (water bucket ← 3 iron ← a mine, none present). The planner must
  not emit a card whose inputs can't exist yet; sequence water *after* iron/mine.
- **Checkout coords vs. actual base** — cards used the seed spawn (258,79,-53) but the
  base settled at (223,80,-15); workers reconciled mid-run. Bind cards to the
  `base_anchor` mark, not the spawn coord.
- **Validated**: the decomposition model (epic → 2-4 specialist cards), `after:`
  sibling chains (no deadlock), and the **retry pattern** (block stale card → new card
  same spec) — that's how BUILD recovered.
- Self-reported counts: **160 cards / 55 done / 9 blocked**; top blockers =
  region protection, no iron for water bucket, bot trapped in shelter. (160 cards is
  itself a churn signal — supervise + retries + dupes across the run series.)

### Validated — what WORKS (don't regress)
- **Literal `mc` verb lines in cards** — farmer: "the single best thing in the card
  design… no ambiguity, no improvisation." Echoed by gatherer.
- **Lease checkout/release + `--cap` filter** — clean when a body is free.
- **Structured handoff metadata in `kanban_complete`** (scout, farmer) — downstream
  verify without re-reading.
- **Batch verbs** (`mc collect N`, `till_area`); **scout handoff template** +
  **WATER_DROUGHT flag**; **chat narration**; **crafting wooden-vs-stone diagnostic**.

### New concrete bugs to fix (agent-sourced)
1. **`mc escape` — `pos.floored is not a function`** — Report not reproduced on the
   current escape handler (`bot/lib/actions/queries/escape/`); `mc dig` already uses
   `Vec3` for `blockAt`. Same symptom was fixed elsewhere (sail_to, v22). Residual
   risk: `escape/strategies.js` still calls `b.blockAt({x,y,z})` with plain objects
   — align with `Vec3` and capture a live stack if the TypeError recurs.
2. **`mc mark --at`** — No CLI/parser regression found (`parseMarkFlags` + tests in
   `mark-at.test.js` / `mark-soft-warn.test.js`). Run-time failure mode is usually
   **omitting `--at`** (mark saves at bot feet → `MARK_NO_AT_COORD_IN_NOTE`) or HTTP
   bodies with flat `x/y/z` instead of nested `at: {x,y,z}` (`locations.resolvePlace`).
   Fix path: planner/card templates always emit `--at` on remote coords; optional
   hard-fail in `mc mark` when note contains a coord triple and `--at` is missing.
3. **Body-pool contention** — **Verified:** workers block with `no_free_body`; poller
   only **requeues** deferred cards via `_free_body_count()` (`genesis2_lib.requeue_deferred`).
   Hermes dispatcher still spawns agents with no pool check → wasted turns. Fix path:
   gate dispatch on `mc bot status --pool` (free ≥ 1) or poller `blocked` on ready
   lease cards while `free == 0`; grow pool / batch cards as ops mitigation.
4. **Card coords standable** — **Verified gap:** `scripts/lib/card_body_linter.py`
   requires `mc` verb lines but does **not** call `mc reachable` / standability.
   Spawn probe checks biome/flatness/wet feet, not card target cells. Fix path: at
   card emit (planner or `kanban add` lint), reject or rewrite coords where
   `target_standable` is false; use `best_stand` in the card body.
5. **Door placement timeout; nav flakiness** — Door flake **confirmed** for N/S closed
   doors (`tests/functional/test_door_pathfind.py`, xfail). E/W shelter rule in devlog
   is the right mitigation. `mc goto` timeouts are a broad pathfinder/reliability class
   (preflight + `closest_standable` hints exist); track per-postmortem, not one quick fix.

### Verification notes (code review 2026-06-15)

**Shelter trap + in-region self-rescue (confirmed in code, not just agent narrative).**
- `genesis-v2.sh` calls `wipe_marks()` only — **`data/regions-world.json` is not reset**
  on new-run (contrast `scripts/genesis_lib.py` template render). Stale protect regions
  can accumulate.
- **`mc escape` / `mc pillar_up` inside a protect region:** `enclosure_inside` auto-dig
  uses `mc dig --force`, but `dig.js` **still returns `REGION_PROTECTED`** (no
  `forceEscape` bypass on region deny). Trapped branch calls `pillar_step` without
  `--force`; headroom dig uses `shouldSkipDigAt` → **`POLICY_DENY`** unless
  `force && isGenuinelyStuck()`. **`shouldSkipPlaceAt` has no escape bypass** (place
  path is separate). Net: policy blocks self-rescue inside protect even when the trap
  is the colony's own sealed shelter.
- **Fix path (ordered):** (1) door-bearing blueprint + correct region geometry (primary);
  (2) reset/template `regions-world.json` per run; (3) wire `mc task_context set` /
  `worksite:` on BUILD cards (today only illustrated for mine in `phase-epics.yaml`);
  (4) optional belt: extend `forceEscape` to `enclosure_inside` + genuinely-stuck
  `pillar_up` when `WORKSITE_GRANT` is active — do not rely on this instead of doors.

**Duplicate / oversized farm cards** — Not enforced in genesis templates or poller;
  dedup and farm sizing remain **planner / overseer** responsibilities (devlog sizing
  rules are correct; no code gate yet).

**What still WORKS** — Agent praise for literal `mc` lines, lease defer/requeue pattern,
  and handoff metadata matches existing templates and `genesis2_lib` behavior.

---

## 2026-06-15 — operational layer & phase sizing (research)

> target.md defines the **roles** (planner / dispatcher / execution / overseer) and
> the **card-flow**, but is thin on the **operational dynamics** — *when/how often*
> each agent engages, *what board signals* trigger which agent, and how readiness is
> guaranteed across the lease pool. That operational layer is the next research area.

### Phase sizing — start small, wall later
- The base starts **small**: a shelter building + chests nearby, ~**10×10** footprint.
- **Walls come later and sit farther out** (a defensible perimeter ring), which feeds
  back into:
  - **base location** — pick a site with room to expand the wall ring, and
  - **leveling** — clear/level the *larger* wall footprint, not just the building pad.
- **First farm: near water AND close to base — but the base need not be next to
  water.** Water is a *farm* constraint, not a *base* constraint. The planner should
  read this straight from the requirements (don't force the base onto the shoreline).

### Tool/material readiness across lease handoffs (operational requirement)
The lease pool **decouples expertise (agent) from inventory (body)**. A body that
just finished one task may be poorly equipped for the next mission a *different*
agent leases onto it — tools don't follow the worker, they sit in whatever body had
them. Consequences for card breakdown:
- **Tools live in shared base chests**, never assumed in a body's inventory.
- **Every card's first step is a precondition check** — "withdraw/equip the needed
  tool from a chest, or craft it" — not "assume I have a pickaxe."
- The **crafter agent maintains a standing tool stock** in chests (spare
  pickaxes/axes/shovels) + material buffers, so any leased body can equip before its
  mission. (This is why the roadmap's standing goals include a *spare tool stock*.)

### Multi-agent board scanning (not just the planner)
Generalize the supervisor we built (poller → planner on stalls) into a **periodic,
multi-agent operational layer** — each agent scans the board for *its* concern:
- **crafter** — scans cards + chest inventories for material/tool gaps; pre-stocks
  tools/materials so downstream cards aren't blocked on a missing pickaxe.
- **builder** — reviews cards that need better build planning (vague "build shelter"
  → a sized, E/W-door, blueprint-backed card).
- **overseer / verifier** — verifies completion + catches structural defects (door
  faces E/W? farm hydrated? chests accessible?).
- **planner** — decomposition + roadmap ordering.

So the board is a shared substrate that several specialist agents *read and improve*,
not a pipeline only the planner touches. Each wakes on a relevant board signal or a
cadence, contributes its expertise, and exits — same fresh-scope discipline as
execution cards.

### Open research questions (the operational gap)
1. **Triggers & cadence** — what board signal wakes which agent (event vs. periodic
   sweep), and how often, without burning tokens.
2. **Concern → agent mapping** — crafter/builder/overseer scan filters; what each is
   allowed to change on a card it didn't create.
3. **Readiness guarantee** — where the "ensure tools/materials before a mission"
   check lives (card-template precondition vs. crafter pre-stock vs. dispatcher).
4. **Anti-thrash** — coordination so multiple scanners don't fight (escalation caps,
   ownership of a card, idempotent edits). We already hit runaway churn once.
5. **Where this lands in target.md** — promote the operational layer from implicit to
   a documented section (role table is static; operations are dynamic).

---

## 2026-06-15 — base & shelter spec + planner roadmap (operator requirements)

### Door facing — bot traversal limitation (MUST be in the shelter spec)
mineflayer-pathfinder's "open the door and walk through" is **reliable for
EAST/WEST-facing doors but FLAKY for NORTH/SOUTH-facing closed doors** — a
documented framework limitation (`test-door-pathfind.py`, the 4 N/S closed cases
are `KNOWN_FRAMEWORK_LIMITATIONS`/xfail). On a N/S door the bot opens it
(`door_now=open`) but then stalls ~5-6 s without committing to the path through the
open cell; the pathfinder timeout fires and it ends touching the wall's outer face.
Suspected race between the door-open action and pathfinder's path re-evaluation.

**Shelter spec rule:** shelter/base **doors MUST face east or west.** Place the
doorway so the door's `facing` resolves to E/W; never rely on a N/S-facing door for
routine traversal. (Revisit if the upstream pathfinder race is fixed.) This pairs
with the door-bearing blueprint requirement — the blueprint must orient its door E/W.

### Base site
- A **leveled, cleared** footprint (flat ground, obstructions removed) so it can
  later be **walled** to control mob approach — a defensible, gated perimeter.
- Shelter from a **deterministic, door-bearing blueprint** (E/W door), not LLM
  free-build (see the trap diagnosis above).
- **Supplies/chests easily accessible** — near the entry/work area, organized per
  resource (wood / stone / food / tools), not buried inside a sealed room.

### Base-location selection (what scouting is for)
Choosing the base site is a real optimization, informed by scouting:
- **Water access** for farming (surface water / pond within ~N blocks), and/or
- **Route access** (good corridors to resource clusters + room to expand).

P1 scouting gathers candidate pads + resource/water marks to make this call.
**Scouting does not stop after P1** — it continues throughout the run to find new
resource areas, water, and expansion sites as the colony grows.

### Planner roadmap
The planner should work from a **roadmap** — an ordered, goal-driven guide rather
than rigid one-shot phases (ties into the gating section below):
- **Essentials first:** base (leveled + walled-capable) → tools → food → storage.
- **Then expansion:** mine, roads, more farm/storage, perimeter walls, new sites.
- **Standing goals kept topped up continuously** (not once):
  - **food** stock,
  - **building materials** (wood, cobblestone) stock,
  - **tools** — maintain a healthy *spare* stock (pickaxes/axes/shovels), not a
    single set; tools wear out and workers need replacements on hand,
  - chests organized + accessible per resource.

The roadmap orders *intent*; the planner emits parallel work as prerequisites allow
(see gating). "Phases" are roadmap milestones for reporting, not execution walls.

---

## 2026-06-14/15 — first sustained run series (runs gv2-...-8 → -13)

### What got validated (keep)
- **P1 completes end-to-end** (scout → base-select → gather → build → 2 chests).
- **Poller-authoritative phase advance + anti-cascade**: epics P2..P5 seeded
  `blocked` (parked); the poller completes a phase's epic and unblocks the next
  ONLY when the real world-gate passes. A planner/worker finishing its turn early
  can no longer cascade phases. Proven by `scripts/test-phase-transitions.py`
  (no-agent transition test).
- **Crafting window-race retry**: `b.craft` silently no-ops ~1-in-5 for table
  recipes (no PaperMCP fallback on these bodies); in-process retry fixed it.
- **Supervisor (planner re-engagement)**: the poller detects stuck workers
  (running too long OR blocked for a substantive reason) and files a
  `[SUPERVISE]` card so the planner intervenes; escalations capped per worker.
- **Spawn quality gates**: reject water/frozen/desert/mountain spawns
  (`execute if biome` + flatness sampling); `--spawn X,Y,Z` operator override.
- **Marks → shared reconcile** in the poller loop; deferred-worker requeue.

### Why the proven base-protection + shelter didn't land here
Legacy genesis (core v1) was **deterministic + templated**; genesis-v2 swapped
that for LLM free-building and dropped the supporting machinery. The protect
*mechanism* worked (it denied digging, as designed) — but its companions did not,
so the shelter became a worker trap.

1. **Shelter: deterministic blueprint → LLM free-build.**
   Legacy renders `data/ops/plans/hut1-guard-tower-plan.json` — a 238 KB blueprint
   with **34 `oak_door` blocks** + 618 air cells, placed identically every run
   (`plan_id`, footprint, materials). Real doors = guaranteed egress.
   genesis-v2's BUILD is an LLM agent free-building from prose ("5×5 walls + roof,
   leave a 1-block doorway"); it produced a **sealed, doorless box**. No blueprint,
   no `mc construct`/`mc blueprint`.
2. **Protect region: templated geometry → ad-hoc + never reset.**
   Legacy renders `regions-world.template.json` at boot. genesis-v2 has no regions
   template; `genesis2_lib` only **reads** `regions-world.json` and `wipe_marks`
   never clears it → regions are created ad-hoc at runtime AND accumulate across
   runs (stale `hut1`/`shelter`). The protect region wound up enclosing
   `base_anchor` (the universal nav target) with no usable egress.
3. **No worker-egress escape hatch.** designated-regions §1.8 (`worksite:` +
   `mc task_context set` → `WORKSITE_GRANT`) is never wired in genesis-v2 cards, so
   a worker sealed inside a protect region can't dig out either. Legacy got away
   without it because the doors gave physical egress.

**Net:** a protect region is safe around a structure-with-doors and a trap around
an LLM-sealed box. genesis-v2 kept the lock and removed the door.

**Fix direction**
- Build the shelter from a **deterministic door-bearing blueprint** via
  `mc construct`/`mc blueprint` + `plan_id` (port hut1 or a small plan), not LLM
  free-build.
- **Template + reset** the protect region per run (correct geometry, positioned so
  base_anchor work happens *through* a door, not sealed inside); clear
  `regions-world.json` on `new-run` (**verified:** `genesis-v2.sh` only wipes marks;
  port `genesis_lib` template render or delete+seed on `new-run`).
- Wire `worksite:`/`task_context` on cards that legitimately edit inside a protect
  region (belt-and-suspenders egress per the spec). **Verified gap:** BUILD/shelter
  cards do not set task context; escape/pillar/dig stay region-blocked without it.
- **Self-rescue policy:** `mc dig --force` does not bypass region protect
  (`dig.js` `runPreDigGuards`); treat operator `/tp` or worksite grant as the hatch
  until blueprint+door fixes remove the trap class.

### Other environment findings
- **Dry spawn**: flat+temperate isn't enough; plains can lack surface water within
  48 blocks, and a bucket needs iron (P3). P2 farming then can't complete. Add a
  **water-proximity** criterion to spawn selection, OR let the planner source
  water (dig-to-water / relocate farm), OR relax the P2 farm gate.
- **Supervisor runaway churn**: a structurally-stuck worker (admin-needed) drove
  31 supervise cards before the cap was added. Lesson: any escalation loop needs a
  budget/cooldown + an explicit "parked for operator" terminal state.
- **Live mid-run relocation only half-works**: moving bodies doesn't move the work
  — seeded cards bake in the spawn coords. Re-anchoring needs a board re-seed (or
  the `--spawn` override at boot).

---

## Open design issue: phase gating over-serializes the fleet

**Symptom.** The 5-phase chain (P1→P5), plus the planner's intra-phase dependency
chains, leave bots idle. Example: in P1 one scout explores while two bots sit
idle — they *could* be gathering wood/stone for the shelter, which doesn't depend
on the scout result at all.

**Root.** The gate conflates two different things:
- *"Phase complete"* — a real milestone (base exists, mine open), worth gating on.
- *"Permission to do any later work"* — which the current design also gates on, and
  shouldn't. Much "later" work has no real dependency on the current phase finishing.

So we serialize on **phase boundaries** when we should serialize only on **data
dependencies** (does this card's input — a mark, a material, a site — exist yet?).
A protect/gate that blocks *nonsense ordering* (mining with no pickaxe) is good; one
that blocks *independent parallel work* (gather wood while scouting) wastes the fleet.

**How to relax it (incremental → target):**
1. **Parallelize within a phase (cheap, now).** The planner should emit a parallel
   DAG, not a serial chain. P1: `scout`, `gather_wood`, `gather_stone` all dispatch
   immediately; only `base_select` waits on scouts, and `build` waits on
   (base_select AND materials). Today's decomposition chains everything → idle bots.
   This is a planner-instruction + dependency-wiring change, not a gate removal.
2. **Let phases overlap where safe (medium).** Replace the hard "P(n+1) blocked
   until P(n) gate" with **card-level readiness**: a card is ready when *its own*
   prerequisites exist, regardless of phase. P2 water-scouting can begin during P1.
   Keep the world-gate only as the *phase-complete signal* (for reporting / the
   overseer), not as a wall on starting prerequisite-met work.
3. **Goal-driven planning (target).** Per [target.md](../architecture/target.md):
   the **planner** plans continuously against colony goals + world state and emits
   intents; the **dispatcher** binds them to free bots; the **overseer/verifier**
   judges goal satisfaction. "Phases" become reporting groupings, not execution
   gates. The fleet is filled by available work, not drained by sequential walls.

**Keep the anti-cascade win.** Whatever replaces hard gates must preserve the
property the poller-authoritative design gave us: *a phase/goal is only declared
done when the real world-state confirms it* — narration/turn-completion must never
advance the colony.

---

## Architecture alignment: drop "Steward"; it's not an agent

[target.md](../architecture/target.md): **there is no Steward orchestrator.** The
concerns split into distinct profiles:

| Concern | Target agent | genesis-v2 today |
|---|---|---|
| Planning (goals → intents/cards) | `@planner` | folded into `colony-steward` |
| Allocation (bind work to free bodies) | `@dispatcher` | the bot-lease pool (close, but implicit) |
| Execution | `@navigator`/`@miner`/`@builder`/… | `colony-scout`/`gatherer`/`builder`/… ✓ |
| Review / verify | `@overseer` (+ verify) | **missing** |

Changes for future runs:
- **Rename `colony-steward` → `colony-planner`** (it does planning/decomposition).
  "Steward" is neither an agent role in the target nor a character. (In progress.)
- **Make dispatch explicit.** The bot-lease pool already does dispatcher-style
  binding (nearest/free body); name it and treat it as the `@dispatcher` concern
  rather than burying it in worker SOULs.
- **Add an overseer/verifier concern.** Today the *poller* is the only verifier
  (world-gate checks). A `@overseer` agent should judge phase/goal completion and
  do per-card verify (e.g. "did BUILD actually leave a door?", "is the farm
  hydrated?") — catching exactly the shelter-trap / dry-farm classes before they
  stall the colony. The poller stays the deterministic gate; the overseer adds
  judgment the gate can't encode.

---

## Prioritized improvements for the next run

1. **Door-bearing shelter blueprint** (kills the trap class). Deterministic
   `mc construct`/blueprint with a door, not LLM free-build.
2. **Region lifecycle**: template + per-run reset of `regions-world.json`; wire
   `worksite`/`task_context` on BUILD cards (not only mine examples in templates).
3. **Execution self-rescue vs region policy** — verified: `mc escape` auto-dig and
   `pillar_up` headroom dig hit `REGION_PROTECTED` / `POLICY_DENY` inside protect
   without worksite/`--force`+`forceEscape`; fix trap class first, then optional
   policy alignment.
4. **Dispatch body gate** before spawn (`mc bot status --pool`); complements
   `requeue_deferred`.
5. **Card coord standability** at emit (`mc reachable` / `best_stand` rewrite).
6. **Parallelize the P1 decomposition** (gather ∥ scout); gate cards on data
   dependencies, not phase walls.
7. **Spawn water-proximity** — `probe_natural_spawn` does not require nearby surface
   water today; add criterion or planner water-sourcing.
8. **Rename steward → planner**; name the dispatcher concern; add overseer/verify +
   in-flight card dedup (farmer duplicate-farm report — no code gate yet).
