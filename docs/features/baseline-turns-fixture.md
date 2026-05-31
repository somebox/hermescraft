# Baseline turns — playbook pass (fixture A1)

Per-run genesis output still lands under `data/genesis-runs/<run_id>/findings/baseline-turns.md` via `nav-telemetry.py --baseline-turns`. This file tracks **fixture A1** medians for Stage 4.

Stage 4 A1 **% improvement target: N/A** (A1 falsified n=5, 2026-05-31). Wave 6
tower lab tracks hard-task granularity separately — see
[`wave-6-granularity-lab.md`](wave-6-granularity-lab.md).

## Genesis aggregate (g-2026-05-30-3)

See postmortem under `data/genesis-runs/g-2026-05-30-3/findings/` (local, gitignored) and:

```bash
scripts/nav-telemetry.py g-2026-05-30-3 --baseline-turns g-2026-05-30-3
```

## Fixture A1 — chop-oak-8 (2a-V)

**Arenas:** three 10×10 grass slabs in a row at `z=45..55` (A1 `x=50..60`, A2 `x=62..72`, A3 `x=74..84`). Tree/chest coords in each YAML and `includes/chop-oak-8/goal.txt`. FPV layout without running a test: `scripts/show-arenas.py`.

Run matrix (≥5× per arm):

```bash
for arm in prose-minimal prose-skilled playbook; do
  for i in 1 2 3 4 5; do
    scripts/stress.sh chop-prose-vs-playbook --arm "$arm"
  done
done
```

Archive JSON under `data/agent-tests/runs/` with card-body content hash.

### Pilot run (n=1, `google/gemini-2.5-flash`, 2026-05-31)

Infrastructure fixes in this window: JSONL `HERMESCRAFT_TMP` + profile tag, Hermes playbook hub mirror, contiguous A1 arena, cleanup `fill` from y=65, agent-test kanban facade guidance (see playbook doc).

| Arm | mc CLI calls | ok:false (report) | Notes |
|-----|-------------|-------------------|--------|
| prose-minimal | 11 | — | 12 oak deposited; lowest call count at n=1 |
| prose-skilled | 28 | — | 6 oak deposited (under 8 target) |
| playbook | 38 | — | Phases walked; 6 oak; ~10 calls overhead vs minimal (ritual + mistaken kanban/scene attempts before skill/doc fix) |

**Not a falsified A1 at n=1** — playbook did not beat prose on tool calls. Interpretation: single-tree landfolk-test is too easy for structure to pay off; playbook ritual + agent-test toolset gap inflated playbook arm; need n≥5 and/or harder tasks (branching, resume, handoff) before Stage 4 % target.

**A2 / A3 (n=1, same session):** PASS — preflight `prep_required_unmet:axe` via `scripts/kanban block` (8 mc); A3 resume from `[run_state]` → 8 deposited (9 mc). Usable as **regression** gates independent of A1 medians.

### Medians (fill after n≥5)

**2026-05-31 matrix #1 (15 runs, pre-parser-fix):** SNBT parser bug — chest pass/fail invalid; numbers discarded.

**2026-05-31 matrix #2 (15 runs, post-parser-fix 211bb5b/1e5b221):** gemini-2.5-flash, 16 dirt + park-@-(52,65,51), honest chest predicate. Chest median includes the 1 starter log placed by prep — a true deposit shows chest ≥ 9.

| Arm | n | mc median (range) | mc mean | chest ≥8 pass | chest median | inv_excl clean | playbook verb |
|-----|---|--------------------|---------|---------------|--------------|----------------|---------------|
| prose-minimal | 5 | **29** (8–33) | 24.8 | **3/5** | 9 | 4/5 | 0/5 |
| prose-skilled | 5 | **18** (12–35) | 19.6 | **4/5** | 9 | 5/5 | 0/5 |
| playbook | 5 | **35** (22–55) | 35.6 | **0/5** | **1** | 5/5 | 4/5 (23 calls) |

**Verdict:** A1 hypothesis (*playbook ≤ both prose arms on tool calls/errors*) is **falsified at n=5** on this fixture. Playbook arm has ~2× the median mc calls of prose-skilled (35 vs 18) **and** 0/5 deposit completion vs 4/5 for prose-skilled. Every playbook run ended with `chest=1` (the starter log untouched). The ~5–8 mc calls per run spent on `mc playbook phase set` ritual + `[run_state]` kanban comments consumed enough of the 30-turn budget that no playbook agent finished chopping, let alone depositing.

**Pass (A1, original):** playbook medians ≤ both prose arms on tool calls and errors + chest ≥8 + inv_excludes clean. **Not met.**

## Fixture A4 — chop-composition (Stage 2b)

```bash
scripts/regenerate-artifacts.sh   # sync playbook-pillar-up-safe to Hermes hub
scripts/stress.sh chop-composition
scripts/show-arenas.py            # optional: A1–A4 FPV layout
```

**Pass (A4):** sub-play JSONL during ascend; `pillar_up`/`playbook`; **≥8 `oak_log` in chest @ (96,65,53)** via `chest_item_count_at`; bot inventory not holding ≥8 logs at end. Chest sits on standable grass south of tree — use `goto_near` adjacent cell, not `move` onto chest.

| Run | mc calls | sub_playbook in JSONL | chest ≥8 | Notes |
|-----|----------|------------------------|----------|-------|
| 1 | 27 | yes (`pillar_up_safe`) | 5 partial | deposited 4 |
| 2 | 62 | yes | 0 | over mc budget |
| 3 | 36 | yes | 0 | 9 oak_log left in inv |

Flash n=3: **0/3** full chest pass; sub-play telemetry verified. Not a regression gate for A2/A3.

## Fixture W6-T1 — tower mini pillar

See [`wave-6-granularity-lab.md`](wave-6-granularity-lab.md) § Results (Option C, n=3 Flash).

## Fixture W6-T3 — platform 3×3

```bash
scripts/stress.sh tower-platform-3x3 --arm prose-skilled
```

Medians: `wave-6-granularity-lab.md` § W6-T3 Results (pending).

## Follow-ups (not blocking regression)

- Mineflayer position desync after Multiverse `mvtp` + rcon `tp` — keep `verify_after_prep` off until rcon `data get block` probe exists.
- `mc scene` CLI shape — LLMs guess wrong positional forms; documented in playbook skill.
- Production workers have `kanban_*` tools; agent-test uses `scripts/kanban` only.
