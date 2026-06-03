# Mason — establish-2026-06-03 phase 8 (run-5)

**Window:** 04:48–06:15 UTC+2 (CEST), 1h 27m, 55 progress rounds.
**Card load:** 4 (1 EXPLORE done, 3 CONSTRUCT — 1 archived, 1 done, 1 running at stop).
**Sources:** `/tmp/hermescraft/{agent,hermes,progress,mc,bot}-mason.log`, `~/.hermes/kanban/boards/landfolk-ops/{kanban.db,logs/t_*.log}`.

## 1. Run timeline

- **04:50:04** — claims `t_f12d7ecb` [EXPLORE NW]; pos (-25,91,-5).
- **04:50–05:00** — 61 worker tool-calls, 28 `mc move` (13× `--near 2`, 14× `--raw`); progress err_pct: 65% at 04:59 (round 8) → 13.5% at 05:19 (r24) → 3.2% at 05:23 (r28). Marks: `nw_iron_vein`, `nw_coal_pocket{,_2}`. Closes 05:00:18 (10 min).
- **05:01:58** — Steward dispatches `t_174de3c0` [CONSTRUCT pad 9x9 @ base_anchor]; body is **prose** ("Level the area first, then fill 9x9 with cobble"). No literal verb. Claimed 05:02:05.
- **05:02–05:24** — worker emits 60 `mc inspect` + 22 `mc dig` + 13 `mc collect` + **0 `mc fill`** + 11 `mc level` + 2 `mc place` (counts from `logs/t_174de3c0.log`). Most time spent underground at Y=92 self-sourcing cobble. Steward reclaims 05:24:11: `"PHYSICALLY_STUCK: mason underground Y=92 mining 1 cobble/cycle for 21m. Will re-spec with cobble pre-supplied."` Archived 05:25:54.
- **05:25:29** — Steward emits `t_7d9b1fd4` [Fill 9x9 cobble pad] with **literal verb**: `mc fill cobblestone 15 101 49 23 101 56`. Promoted 05:30:09.
- **05:30–05:44** — pad rebuild completes ~14 min real (kanban `done` at 05:44:16). Worker is out-of-band so per-verb counts aren't in `mc-mason.log`; chat ("pad done") plus the clean close imply the verb was honoured. Mason chats `done t_174de3c0 … placed ~55 cobble, marked base_foundation` at 05:36:57 (race condition: she finished the pad before the archive event propagated — see `logs/t_174de3c0.log:661`).
- **05:38:34** — Steward dispatches `t_19305b13` [walls 3-high], body **prose again**, no literal verb.
- **05:53:12** — walls claimed (pid 80858).
- **06:00:25** — **Pattern A strikes**: Steward whispers `Rescue — you are at (7,98,25) … walls are at base_anchor (19,101,52)`. Mason had drifted to stone-mining instead of placing walls.
- **06:13:22** — first `wall:done` lands in progress log (r53), followed by `place_fill: FILL_PARTIAL`. East/north faces partial.
- **06:15:22** — `landfolk stop`; t_19305b13 reclaimed (terminated). Worker auto-recovers 06:16:15. **No iteration_budget_exhausted** for the walls card — run-stop preempted.

## 2. Friction patterns observed

Reference taxonomy from `phase7/THOROUGH-POSTMORTEM.md` + `FRICTION-NOTES-LIVE.md`.

- **Pattern A — bot drifts off-site.** Struck despite 8.A. At 06:00 Mason was at (7,98,25) self-sourcing stone while the build target was (19,101,52); rescue was a manual Steward whisper. The drift was *worker pathing during materials gathering*, not mark-mis-placement: she set `base_foundation` (worker log line 640: `mc mark base_foundation "9x9 cobble pad centered at (19,101,52)"`) while standing on the pad at Y=101, so the run-5 mark coordinate was correct. The 39m-stale `(12,102,14)` mark she observed via `mc marks` was a previous-session ghost; the run-5 overwrite landed cleanly. Pattern A in run-5 = bot-drift, not bad mark.
- **Pattern B — chest fiction.** Steward's body cited `se_shelter chest at 16,102,54`; that coord is an `oak_door`. Mason burned ~6 rounds (05:05–05:15) `chest_search`-ing before self-sourcing.
- **Pattern C — vertical-traversal NAV_BLOCKED.** Dominant `move` error in rounds 19-30 was `pillar_step: pillar_up could not place any blocks (Y=100) — headroom`. Matches kanban #38.
- **Pattern D — door-traversal stall.** `Could not traverse oak_door at 16,102,54: Opened oak_door but bot stalled at 14.5,92.0,52.7` recurs 5+ times in rounds 24–46.
- **Pattern E (fills run-5) — prose-card-inspect-storm.** Both prose-body CONSTRUCT cards collapsed to a manual inspect-then-dig-then-place loop. Pad t_174de3c0: 60 inspect / 22 dig / 13 collect / **0 fill** over 22 min → reclaimed. Walls t_19305b13: 74 inspect / 0 dig / 19 place / 6 safe_dig / 7 wall / 3 fill (worker log). Phase 8.4 SOUL had no card-body verb to fire on. This is the predicted failure mode in `feedback_steward_card_verbs.md`.

## 3. Phase 8 changes impact on Mason

- **8.A `MARK_NO_AT_COORD_IN_NOTE`** — **dormant.** Mason's one mark call ran on-pad with the note's coord triple matching her actual position; firing would have been a false alarm. The walls card body had no coord triple to anchor against either. Net: 8.A had nothing to catch in run-5.
- **8.B long-range `--near 2` default** — **helped NW NAV.** 13/28 `mc move` calls in `t_f12d7ecb` used `--near 2`. Progress log shows the lenient `No standable cell within 2 of` error (2 occurrences) and zero `within 1 of` over rounds 205–259. Recovery 65% → 3.2% err_pct in 24 min tracks the "lenient near-radius unsticks goto chains" pattern. Probable proximate cause of the NW card's clean 10-min close.
- **8.3 Steward kanban diagnostics** — exterior to Mason; visible only via Steward's smarter dispatch (the t_174de3c0 → t_7d9b1fd4 re-spec with literal verb). Indirect win.
- **8.4 Worker SOUL "card-body verbs are REQUIRED"** — **fired exactly once and worked.** t_7d9b1fd4's literal `mc fill` was respected; card closed in 14 min vs. 22-min sweep on t_174de3c0. On both prose cards the SOUL had nothing to anchor on and the inspect-storm recurred. SOUL is necessary but, alone, insufficient — it depends on Steward emitting literal verbs.

## 4. Recommendations for Phase 9

1. **Fix Steward (P1, blocking).** Emit literal `mc <verb> <args>` on the first line of every CONSTRUCT/TILL/MINE card body; prose annotations after. The one verb-first card succeeded in 14 min; the two prose cards burned 1h+ plus one manual reclaim and one manual whisper-rescue. Change `prompts/landfolk/steward.md` decomposition section to template-force `mc fill | mc wall | mc fence | mc dig_area …` at body-line-1. Pair-key with `feedback_steward_card_verbs.md`.
2. **Mason-side fallback: `wb escalate "prose_card_no_verb"` on claim.** Cheap regex check at task-claim in `prompts/landfolk/mason.md`. Turns a 22-min silent failure into a 1-min noisy one and forces Steward re-spec. Necessary because #1 will take time and the worker is the last line of defence.
3. **Don't self-source when chat says "supply chain incoming."** On both bad cards Mason abandoned the build to mine personally; both times the rescue cited the same shape ("supply: flint → chest → mason"). New SOUL bullet: *"If your card body cites a chest you cannot see, `wb block: chest_not_yet_stocked` instead of mining locally."* Cheaper than fixing kanban #38 and avoids the Y=92 trap that triggered the PHYSICALLY_STUCK reclaim.

Secondary: Pattern D (door-stall at 16,102,54, 5+ recurrences) is likely the cause of the r45 `error_loop` flip; tie to kanban #38a.
