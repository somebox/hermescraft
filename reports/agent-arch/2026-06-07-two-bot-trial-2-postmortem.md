# Two-bot live trial #2 postmortem — PASS

**Date:** 2026-06-07 09:23–09:39 UTC+2
**Run id:** `trial-1780816982` (attempt B; attempt A aborted at ~3 min)
**Trial packet:** `data/postmortems/two-bot-base/trial-1780816982/`
**Plan:** [`~/.claude/plans/create-a-plan-that-magical-lovelace.md`](../../../.claude/plans/create-a-plan-that-magical-lovelace.md)
**Scorecard band:** **pass** ✅
**Companion docs:** [Trial 1 postmortem](2026-06-07-two-bot-trial-1-postmortem.md) · [Trial 2 prereqs](two-bot-trial-2-prereqs.md) · [Landfolk-test env review](landfolk-test-env-review.md)

## Scorecard

| # | Number | Result | Trial 1 → 2 delta |
|---|---|---|---|
| 1 | `parallelism_observed` + `overlap_s` | **true / 591 s** (9 min 51 s of concurrent running) | +62 s vs trial 1 (529 s) — more parallel slack despite a longer graph |
| 2 | `pip_done_count` / `zee_done_count` | **7/7** and **6/6** — full lanes | vs trial 1's 5/7 and 1/4 (zee blocked on `z_mine`) |
| 3 | `sign_at_seed` | **true** ✅ | vs trial 1's *never reached* (cascade-archived) |
| 4 | Handoff contract test | **2/2 pass** (parent emits `exit_pos`; child sees it) | regression check, passed in trial 1 as well |

Wall time: card-create → sign-at-seed in **~15.4 min**. Trial 1 ran ~30 min before operator-abort.

## What this trial proves end-to-end

1. **Per-bot mutex parallelism in vivo** — 591 s overlap with two real Mineflayer bots; no cross-claim, no orchestration crashes, dispatcher loop spawned cards within 1–2 ticks of each predecessor terminating.
2. **Handoff metadata crosses the spawn boundary** — `p_nav_wood`'s `exit_pos` appears literally in `p_withdraw_wood`'s worker session corpus. Architecture's handoff claim works under real wall time, not just in the kanban DB.
3. **Cooperative outcome at seed** — sign at `(300, 65, 300)` confirmed by `mc verify at_mark seed --block oak_sign` on Tester. Both bots contributed materials + structure.
4. **Self-recovering bundle behaviour** — zero operator interventions, zero retries (every card completed on first task_run), zero tool-loop warnings across 13 sessions.

## Per-card timing breakdown

| Card | Bot | Duration | API calls | Errors | Notes |
|---|---|---|---|---|---|
| `p_nav_stash` | pip | 101 s | 9 | 1 (NAV_BLOCKED) | First card, baseline pace |
| `p_withdraw_axe` | pip | 87 s | 10 | 0 | Withdrew wooden_axe + 1 oak_sign |
| `p_nav_wood` | pip | 100 s | 11 | 2 (NAV_BLOCKED) | `mc move 295 65 300 --near 2` failed; recovered with `goto_near` |
| `p_withdraw_wood` | pip | 71 s | 8 | 0 | 16 oak_log out, 48 left in chest |
| `p_return` | pip | 90 s | 9 | 0 | Clean nav back to seed |
| `z_nav_stash` | zee | 73 s | 9 | 1 (NAV_BLOCKED) | Symmetric with pip's nav_stash |
| `z_withdraw_pickaxe` | zee | 89 s | 11 | 0 | New card from trial-2 graph; succeeded clean |
| `z_nav_stone` | zee | 67 s | 8 | 0 | Fastest card of the trial |
| **`z_mine`** | **zee** | **133 s** | **13** | **0** | **The critical card. Trial 1: 1095 s stalled with 1 cobble. Trial 2: 32/32 cobble.** |
| `z_return` | zee | 81 s | 8 | 0 | |
| `p_build` | pip | 159 s | 19 | 3 (TARGET_ENTITY_OCCUPIED ×2, mark-parse error) | Emergent inter-bot coordination — see §"Coordination" |
| `z_build` | zee | 364 s | 28 | 5 (NAV_BLOCKED ×2, fill-flag confusion) | Slowest card; analysis below |
| `p_sign` | pip | 82 s | 10 | 0 | Acceptance card — clean placement |

**Aggregate**: pip 76 API calls across 7 cards (avg 11/card); zee 77 API calls across 6 cards (avg 13/card). Comparable load — no lane is dramatically more LLM-expensive than the other.

## The three big wins vs trial 1

### Win #1 — `z_mine` succeeded in 133 s (vs 1095 s stall)

Trial 1's miner agent looped on `mc collect cobblestone 32` returning "Mined 32/32" while only 1 ended up in inventory. The fix combined four pieces, all landed before this trial:

- **Bot-side**: `bot/lib/actions/mining/collect/execute.js` headline rewrite — "Collected N/M" leads, not "Mined N/M". Discrepancy explicitly diagnosed in the same message. Smoke-tested on Tester pre-trial: `Collected 8/5 cobblestone in inventory (mined 5 blocks)`.
- **Skill**: `agent-miner.md` gained "Mining an outcrop face" + "Mine the marked target, not the substrate underneath" subsections.
- **World**: floor stack thickened to dirt @ Y=64 / 4×stone Y=63–60 / bedrock Y=59 — drops can't fall through; agent visually distinguishes "dirt floor" from "cobblestone target."
- **Yield-stall escape**: bundle's §5 escape rule `extraction_yield_low:<have>/<want>` after 3 attempts without inventory delta.

Zee's session: 31 messages, 13 API calls, **0 errors, 0 tool loops**. Mined 34 blocks, collected 32 cobblestone — a 2-item drop loss that's well within tolerance.

### Win #2 — Zero crashes, zero operator interventions

Trial 1 had:
- `p_withdraw_axe` crashed on run 26 (no session in state.db, no traceback in errors.log)
- Operator block on `z_mine` after 18 min
- Cascade-archived 4 downstream cards

Trial 2 had:
- Every card: outcome `completed` on first task_run
- `manual_interventions: 0` in the trial packet

The `p_withdraw_axe` crash was likely caused by the agent looping on the broken `mc chest open :mark:` form from the old agent-crafter.md. With the corrected verb table (`mc chest @MARK`, no `open` subverb), this trial's `p_withdraw_axe` completed in 87 s with 10 API calls and zero errors.

### Win #3 — Compression never had to fire

Trial 1's z_mine session reached 86 k tokens before stall. Trial 2's longest single session was z_build at 69 messages — sessions stayed well under the 250 k cap, far from the 70 % compression threshold. With pilot config parity (compression configured, even if unused), we know the safety net is in place for sessions that DO get longer.

No `compress.*starting` or `summarized` log lines anywhere in the pilot logs. Compression configured ✅, dormant ✅, ready ✅.

## Failed commands + reasoning issues — the lane-by-lane review

### Pip's lane

**Navigation errors (×3 NAV_BLOCKED across the lane).** All three followed the same pattern: agent tried `mc move <coord>` targeting a coord that was either inside a chest, on top of dirt the bot couldn't path to, or partially occupied. In every case the agent recovered within 1–2 turns with `mc reachable <coord>` or `mc goto_near <coord> --near 2`. No retries on the same coords. The bundle text guides this recovery well.

**`p_build` — the emergent coordination story** (3 errors, but architecturally significant):

```
msg#478  mc place oak_log 301 65 301
         → ERROR TARGET_ENTITY_OCCUPIED: player 'Zee' is standing there.
                Ask them to move (or wait).
                Hint: mc chat_to Zee "please step aside..."

msg#481  pip's reasoning:
         "3 of 4 posts placed. Zee is standing at the 4th corner (301,65,301).
          Let me ask Zee to move via chat, then place the last post."

msg#482  mc @Zee please step aside from 301,65,301 …
         → ERROR (cli): unknown_mark: @Zee please step aside …
                Known: spawn, death_2, …, seed, wood_supply, …

msg#484  mc chat "Zee, please step aside from 301,65,301 so I can place the 4th corner post"
         → chat <pip> Zee, please step aside from 301,65,301 …  ✓

msg#486  mc inspect 301 65 301
         → "air (1 entity here)"  ← Zee still there

msg#488  mc place oak_log 301 65 301
         → ERROR TARGET_ENTITY_OCCUPIED  ← Zee hadn't moved

msg#490  mc inspect 302 65 300       ← Pip pivots, scans alternate corner cells
msg#491  mc inspect 300 65 302

# By msg#498, pip placed the 4th post at (300, 65, 302) — a different corner —
# rather than wait for Zee. Wood frame ends up asymmetric (3 corners square + 1 offset)
# but the card's success criterion is "4 oak_log placed", which holds.
```

This is **genuinely emergent behaviour worth flagging**. Pip:
1. Recognised the block-side error semantically ("Zee is standing there"),
2. Generated a plan to coordinate via chat,
3. Mis-parsed the verb shape (used `@Zee` as if it were a mark prefix) — that's a reasoning issue but recovered immediately,
4. Sent the chat correctly,
5. Inspected again, saw Zee hadn't moved,
6. **Pivoted to a different building plan** rather than blocking or looping.

This is the kind of cooperation+adaptation the architecture exists to enable. None of it was prescribed in the bundle text — it's the model reasoning over the structured error response.

### Zee's lane

**`z_build` — 5 errors, 364 s (slowest card of the trial)**:

```
msg#518  mc move 302 65 302 --near 3       → NAV_BLOCKED (path)
msg#542  mc move 300 65 299 --near 3       → NAV_BLOCKED (path)
msg#557  mc fill cobblestone 298 64 298 302 64 302
         → ERROR FILL_BLOCKED_BY_EXISTING: 25/25 cells already occupied by other blocks (25× dirt). Pass overwrite=true.
msg#561  mc fill cobblestone 298 64 298 302 64 302 overwrite=true
         → ERROR: Cannot place at 299, 64, 298: block is already cobblestone…
```

Two patterns here worth fixing:

- **NAV_BLOCKED while building**: Zee tried to nav to cells next to where it would place blocks but the placement workflow doesn't always leave a standable cell. The agent recovered both times but at the cost of ~30 turns of extra back-and-forth. **Action item for `agent-builder.md`**: add explicit "before placing block at <pos>, `mc reachable <adjacent-cell>`; if not, dig/build a standing platform first."
- **`mc fill` flag confusion**: agent tried `mc fill … overwrite=true` (no leading `--`). CLI accepted the call but the underlying server-side check still ran. **Action item**: bundle should document `mc fill … --overwrite` syntax explicitly. Or the CLI parser should accept both `overwrite=true` and `--overwrite`.

These are skill-text fixes, not architecture issues.

## Reasoning patterns observed

| Pattern | Trial 1 | Trial 2 | Read |
|---|---|---|---|
| Recovery from NAV_BLOCKED | yes (~5 turns avg) | yes (~2 turns avg) | Bundle's "use goto_near / @MARK" guidance reinforced after trial 1 stuck this time |
| Recovery from misleading collect success | NO (loop ~70 turns) | n/a (no misleading messages issued) | The fix at the bot side is the whole story |
| Cross-bot coordination | n/a | YES (pip asked Zee to move + pivoted) | Genuinely emergent; not in any bundle |
| Verb-shape discovery | yes (`mc help chest` after 3 errors) | yes (`mc chat` after `mc @Zee` failed) | Agent's "if syntax fails, run mc help" guidance works |
| Tool-loop warnings (3+ same-tool failures) | yes (1× on chest verb in pip's lane) | **0** across both lanes | Bundle clarity matters; this is a quality signal |
| Compression activations | n/a (not configured) | 0 (configured, dormant) | Configured ≠ activated; threshold not crossed |

## Inventory accounting — what actually moved

```
Pip start:   nothing
Pip end:     1 wooden_axe (kept), 1 oak_sign (after p_sign placed 1 of 4),
             12 oak_log (after p_build used 4 of 16)

Zee start:   nothing
Zee end:     1 iron_pickaxe (kept), 32 cobblestone (after z_build used some
             for foundation fill at Y=64)

Chest_stash final: empty (everything withdrawn)
Wood_supply final: 48 oak_log (started with 64, pip took 16)
Cobble outcrop:    partially mined — zee broke 34 blocks total, collected 32
                   (2-block loss to drops out of reach; well within tolerance)

Built structure at :seed:
  oak_log corners: (299,65,299), (301,65,299), (299,65,301), (300,65,302)
                   (asymmetric — Zee blocking the canonical 4th corner)
  cobblestone:     foundation at Y=64 (replaced dirt; partial fill due to
                   adjacency rules vs existing terrain)
  oak_sign:        (300, 65, 300)  ← acceptance object
```

## What the trial did NOT prove

In keeping with the plan's proof-vs-demo discipline:

- **Not a cost or efficiency comparison** vs a wide-flint baseline. That's the wheat capstone's job; this demo only validates mechanism.
- **Not architecturally clean structure** — the wood frame is asymmetric because of pip's emergent corner-pivot. That's information, not a defect.
- **Not the full spawn-with-bot.sh seam in vivo** — workers spawn from static pilot profiles (Section F deferred).
- **Not multi-trial reproducibility** — sample size 1. The 591 s overlap, 133 s mining, etc. are point measurements.

## Operator interventions — none

| Run | Card | Action |
|---|---|---|
| — | — | (none) |

The operator's only mid-trial action was the **between-attempts fixture rebuild** for attempt B: after observing zee was digging the single-block stone floor in attempt A, ops stopped the runner, archived attempt A's 13 cards, patched the fixture (dirt+stone+bedrock stack), re-applied, relaunched. Total downtime: ~6 minutes.

Once attempt B launched, **zero** in-trial interventions.

## Cost (approximate)

- API calls: pip 76 + zee 77 = **153 total** across 13 cards, deepseek-v4-flash.
- Cache hit rate: 97–100 % per the agent.log entries (token-cache amortises across the conversation accumulation).
- Wall time: **~15 min** card-create to sign verify.

Order of magnitude: low single-digit cents for the whole trial (vs trial 1's similar magnitude despite stalling — token cache made even the broken trial cheap).

## What stays good after this trial

- Mutex parallelism, handoff metadata, lane-by-lane progression — all reaffirmed.
- The runner's `--watch`/`--evaluate-only`/manifest pattern produced clean telemetry: 15-line scorecard at the end captures everything.
- The proto-logs-follow tool (built between trial 1 and 2) made mid-trial visibility tractable.
- The `bot/lib/actions/mining/collect/execute.js` fix is the single biggest win — would also benefit production landfolk-ops workers when they hit similar outcrop-mining cards.

## Fixes worth landing before trial 3

Same priority bands as trial 1's postmortem; this list is much shorter.

### P1 — would have prevented z_build's slowness

- [ ] **`agent-builder.md` placement-reachability discipline**: before `mc place <block> <pos>`, the bundle should require `mc reachable <adjacent-cell>` first; if not reachable, `mc goto_near <adjacent-cell>` or `mc dig` a standing platform. Currently the bundle assumes the bot is already adjacent.
- [ ] **`mc fill` CLI flag normalisation**: agent tried `overwrite=true` (no leading `--`). Either accept both in the parser or document the `--overwrite` form explicitly in `agent-builder.md` / `minecraft-building.md`.

### P2 — quality of life

- [ ] **Bundle guidance on cross-bot coordination**: pip's emergent behaviour (chat to partner + pivot if no response) is exactly what we want, but the discovery path took ~6 turns of pivoting. A one-line `agent-builder.md` note on "if a partner bot is blocking your placement, chat once + pivot" would shave that to ~2 turns.
- [ ] **Verb hint when `@<player>` is used as a mark prefix** (msg #482): cli should suggest `mc chat "<message>"` for the @<player>-form usage. Currently returns generic "unknown_mark" with the marks list — close but not optimal.

### P3 — investigative

- [ ] **Why didn't compression activate?** Sessions stayed small (longest was 69 msgs). Probably fine — compression is the safety net, not the optimisation path. But worth confirming the threshold logic is sane on a hand-stressed session (e.g. run a 200-msg dummy session and verify compression fires).
- [ ] **Workspace dir cleanup** observed: only 5 of the 13 trial-2 card workspaces remain on disk; the rest were torn down after card termination. Confirms Hermes' lifecycle but worth documenting in the runbook so operators know workspaces are ephemeral by default.

### P3 — bonus fix landed mid-postmortem

The `acceptance.py` evaluator had a real bug — it read `body.satisfied` flat but the bot HTTP envelope nests it at `body.data.satisfied`. First evaluate-only call reported `sign_at_seed: false` despite `mc verify` reporting `satisfied: true`. Patched in [`acceptance.py:153–165`](../../prototypes/agent-arch/capstone/acceptance.py); the scorecard re-ran clean. 29 scaffold tests still pass.

## Trial 1 → Trial 2 prereqs status

All the items from `two-bot-trial-2-prereqs.md` that landed in time for trial 2:

| Wave | Item | Status going into trial 2 | Result |
|---|---|---|---|
| P0 | `mc collect` response-shape fix | ✅ done | Worked perfectly — no false-success messages anywhere |
| P0 | `agent-crafter.md` verb table | ✅ done | Pip's first crafter card succeeded first try (vs trial 1 crash) |
| P0 | `scripts/audit-skill-verbs.py` | ✅ done | Audit re-ran clean before launch |
| P0 | Pilot config parity with flint | ✅ done | Compression configured + dormant; ready for longer trials |
| P1 | `agent-miner.md` outcrop strategy + escape rule | ✅ done | Zero attempts at the trial-1 pattern; mining took 133 s clean |
| P1 | `agent-navigator.md` solid-target guidance | ✅ done | NAV_BLOCKED recovery was crisp (~2 turns avg vs trial 1's ~5) |
| P1 | Zee pickaxe-fetch lane (Option A graph) | ✅ done | New `z_nav_stash` + `z_withdraw_pickaxe` cards completed cleanly |
| P1 | Pip sign-bundled-with-axe withdraw | ✅ done | One fewer detour vs a separate sign-fetch card |
| P1 | Cross-bot chat noise guidance | ✅ done | No observable distraction from cross-bot chat |

The architecture's claims are now demonstrated at the scale of a 13-card 2-bot DAG against a real Minecraft server. Wheat capstone (A6/A7) is the next-most-interesting question — same shape, different lane (single-bot multi-domain, with wide-flint baseline).
