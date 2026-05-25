---
name: kanban-worker
description: Pitfalls, examples, and edge cases for Hermes Kanban workers. The lifecycle itself is auto-injected into every worker's system prompt as KANBAN_GUIDANCE (from agent/prompt_builder.py); this skill is what you load when you want deeper detail on specific scenarios.
version: 2.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [kanban, multi-agent, collaboration, workflow, pitfalls]
    related_skills: [kanban-orchestrator]
---

# Kanban Worker — Pitfalls and Examples

> You're seeing this skill because the Hermes Kanban dispatcher spawned you as a worker with `--skills kanban-worker` — it's loaded automatically for every dispatched worker. The **lifecycle** (6 steps: orient → work → heartbeat → block/complete) also lives in the `KANBAN_GUIDANCE` block that's auto-injected into your system prompt. This skill is the deeper detail: good handoff shapes, retry diagnostics, edge cases.

## State continuity — write memory often

**Your session is ephemeral. Memory is the only thing that survives to your next incarnation.** Workers spawn, run for a bounded time (max-turns or max-runtime, whichever fires first), then exit. The next worker on the same task — or a different task that depends on what you learned — gets a fresh process with no in-memory state. Its only continuity link to you is the `MEMORY.md` you leave behind. Treat memory like committing code: do it often, do it explicitly, do it before you might be interrupted.

**Three rules:**

1. **Before any `kanban_complete` or `kanban_block`, write a state snapshot.** The pre-exit moment is when you have the most context. Don't lose it.

2. **Every ~5 tool-use rounds, checkpoint.** You will sometimes be killed by the runtime budget mid-action — no chance for a pre-exit step. The periodic checkpoint is your insurance.

3. **After any significant state change, checkpoint.** Successful `mc dig` / `mc place` / `mc deposit` / `mc rescue_request` / `mc craft` / `mc move` to a new region — all earn an immediate memory write. Anything that meaningfully changes "where am I, what do I have, what's blocking me" should be persisted.

**Use the `memory` tool** (available to every Hermes session) with action `add`:

```python
memory(
    action="add",
    content="Worker flint on t_abc123 @ 14:32: pos=(418,48,-621) holding=stone_pickaxe hp=18; context: digging shaft for iron at base mine; last_action: mc dig 418,47,-621=ok (10 cobble now); next: continue digging downward to y=40 OR pillar up if cave dries up.",
)
```

**Schema** — one entry per checkpoint, terse but parseable:

```
Worker <profile> on <tid> @ <HH:MM>: pos=(X,Y,Z) holding=<item> hp=<n>;
context: <one-line of what we're trying to do>;
last_action: <tool>=<result>;
next: <one-line of what to do next or what's blocking>.
```

Hermes delimits memory entries with `§` automatically. Don't manually format separators.

**What the next worker will do with your memory**: they read it as a frozen snapshot at the start of their session. If your last entry says `pos=(418,48,-621) ... next: pillar up out of shaft`, the next worker boots already knowing the situation and can act in turn 1 instead of burning 5 turns on `mc status` / `mc nearby` / `mc inventory` rediscovery. **The iteration budget you save by writing memory is worth multiples of itself in the next worker's life.**

If the task spans multiple workers (long-running collect, multi-layer build, etc.), prefer **replacing** older state entries rather than accumulating — `memory(action="replace", name="state-snapshot", content=...)` keeps memory clean. Keep one canonical "current state" entry plus a few discrete fact entries (e.g., "discovered iron vein at 410,42,-615") rather than a sprawl of timestamps.

## Your task source is the kanban card — `top_goal` is advisory only

If your tool results include a `top_goal: {id, urgency, satisfied}` field (e.g. from `mc observe` or `mc status`), **ignore it for task selection**. The goal engine is a legacy task scheduler from before kanban; we keep it active only for survival signals (eat / flee) that the watchdog handles independently anyway.

**Your task is the kanban card you were dispatched with.** Re-read its body when in doubt; don't pivot to whatever `top_goal` says is "urgent". If the goal-engine signal contradicts the card (card says "till plot," goal says "maintain_food u=1.26"), the card wins. Hunger only matters if your HP / food shows you're actually starving — and even then the watchdog's danger-react will catch low-HP cases before you do.

If you genuinely need to break from the card to handle a survival emergency (HP < 8, no food in inventory, hostile mob in your face), narrate it in chat (`mc chat "<bot>: breaking from t_xxx — HP critical, eating then resuming"`) and resume the card afterward. Do NOT silently switch tasks based on goal-engine urgency.

## Validate the task before starting

**Before any domain action, confirm the spec is doable.** Validation is 1-3 tool calls; execution on a bad spec burns the whole budget. Runs after `kanban_show` + memory-read.

1. **Read body + ALL comments.** The body you were dispatched with may be stale; clarifications live in the latest comments.
2. **Verify named inputs exist:** coords (`mc regions --at X Y Z`), marks (`mc go_mark <name>` or `mc marks`), chest contents (`mc chest_search`), parent task done (`kanban_show <parent>`).
3. **Check assumptions vs reality.** "Wall at (X,Y,Z)" → run `mc scene` at the spot. Comments are claims, not facts.
4. **Check primitive surface.** If the body needs a verb that doesn't exist, that's a planning miss — flag it.
5. **Check ambiguity.** Words like "appropriate / good enough / as needed" without numbers = a question, not work.

**On failure, choose lightest escalation:**

| Failure | Action |
|---|---|
| Fixable in <3 turns (chest name typo, mark variant) | Fix inline; comment what you did; proceed. |
| Ambiguous single decision | `kanban_comment` with numbered options + `kanban_block(reason="clarification-needed: <one-line>")`. |
| Missing critical data, parent has it | Fetch from parent; comment where you got it; proceed. |
| Missing critical data, parent doesn't either | `clarification-needed:` block naming what's missing. |
| Spec conflicts with reality | Comment what you observed; `clarification-needed: <reality>` block. Your observation is the value-add. |

Template:

```python
kanban_comment(body=(
    "Validation failed at start.\n"
    "Spec says: <one-line claim>\n"
    "I observed: <one-line via mc/check>\n"
    "Options:\n"
    "  1. <option A>\n"
    "  2. <option B>\n"
    "  3. Archive — task no longer relevant because <one-line>."
))
kanban_block(reason="clarification-needed: <one-line>")
```

**Do not** silently rewrite the spec in your head. Surface ambiguity to the author.

If you fixed something inline, write memory so the next worker doesn't rediscover:

```python
memory(action="add", content="Worker <profile>: chest_food empty; food is in chest_food_2 (mark exists).")
```

## Workspace handling

Your workspace kind determines how you should behave inside `$HERMES_KANBAN_WORKSPACE`:

| Kind | What it is | How to work |
|---|---|---|
| `scratch` | Fresh tmp dir, yours alone | Read/write freely; it gets GC'd when the task is archived. |
| `dir:<path>` | Shared persistent directory | Other runs will read what you write. Treat it like long-lived state. Path is guaranteed absolute (the kernel rejects relative paths). |
| `worktree` | Git worktree at the resolved path | If `.git` doesn't exist, run `git worktree add <path> <branch>` from the main repo first, then cd and work normally. Commit work here. |

## Tenant isolation

If `$HERMES_TENANT` is set, the task belongs to a tenant namespace. When reading or writing persistent memory, prefix memory entries with the tenant so context doesn't leak across tenants:

- Good: `business-a: Acme is our biggest customer`
- Bad (leaks): `Acme is our biggest customer`

## Good summary + metadata shapes

The `kanban_complete(summary=..., metadata=...)` handoff is how downstream workers read what you did. Patterns that work:

**Coding task:**
```python
kanban_complete(
    summary="shipped rate limiter — token bucket, keys on user_id with IP fallback, 14 tests pass",
    metadata={
        "changed_files": ["rate_limiter.py", "tests/test_rate_limiter.py"],
        "tests_run": 14,
        "tests_passed": 14,
        "decisions": ["user_id primary, IP fallback for unauthenticated requests"],
    },
)
```

**Coding task that needs human review (review-required):**

For most code-changing tasks, the work isn't truly *done* until a human reviewer has eyes on it. Block instead of complete, with `reason` prefixed `review-required: ` so the dashboard surfaces the row as needing review. Drop the structured metadata (changed files, test counts, diff/PR url) into a comment first, since `kanban_block` only carries the human-readable reason — comments are the durable annotation channel. Reviewer either approves and runs `hermes kanban unblock <id>` (which re-spawns you with the comment thread for any follow-ups) or asks for changes via another comment.

```python
import json

kanban_comment(
    body="review-required handoff:\n" + json.dumps({
        "changed_files": ["rate_limiter.py", "tests/test_rate_limiter.py"],
        "tests_run": 14,
        "tests_passed": 14,
        "diff_path": "/path/to/worktree",  # or PR url if pushed
        "decisions": ["user_id primary, IP fallback for unauthenticated requests"],
    }, indent=2),
)
kanban_block(
    reason="review-required: rate limiter shipped, 14/14 tests pass — needs eyes on the user_id/IP fallback choice before merging",
)
```

Use `kanban_complete` only when the task is genuinely terminal — e.g. a one-line typo fix, a docs change with no functional consequences, or a research task where the artifact IS the writeup itself.

**Research task:**
```python
kanban_complete(
    summary="3 competing libraries reviewed; vLLM wins on throughput, SGLang on latency, Tensorrt-LLM on memory efficiency",
    metadata={
        "sources_read": 12,
        "recommendation": "vLLM",
        "benchmarks": {"vllm": 1.0, "sglang": 0.87, "trtllm": 0.72},
    },
)
```

**Review task:**
```python
kanban_complete(
    summary="reviewed PR #123; 2 blocking issues found (SQL injection in /search, missing CSRF on /settings)",
    metadata={
        "pr_number": 123,
        "findings": [
            {"severity": "critical", "file": "api/search.py", "line": 42, "issue": "raw SQL concat"},
            {"severity": "high", "file": "api/settings.py", "issue": "missing CSRF middleware"},
        ],
        "approved": False,
    },
)
```

Shape `metadata` so downstream parsers (reviewers, aggregators, schedulers) can use it without re-reading your prose.

## Claiming cards you actually created

If your run produced new kanban tasks (via `kanban_create`), pass the ids in `created_cards` on `kanban_complete`. The kernel verifies each id exists and was created by your profile; any phantom id blocks the completion with an error listing what went wrong, and the rejected attempt is permanently recorded on the task's event log. **Only list ids you captured from a successful `kanban_create` return value — never invent ids from prose, never paste ids from earlier runs, never claim cards another worker created.**

```python
# GOOD — capture return values, then claim them.
c1 = kanban_create(title="remediate SQL injection", assignee="security-worker")
c2 = kanban_create(title="fix CSRF middleware", assignee="web-worker")

kanban_complete(
    summary="Review done; spawned remediations for both findings.",
    metadata={"pr_number": 123, "approved": False},
    created_cards=[c1["task_id"], c2["task_id"]],
)
```

```python
# BAD — claiming ids you don't have captured return values for.
kanban_complete(
    summary="Created remediation cards t_a1b2c3d4, t_deadbeef",  # hallucinated
    created_cards=["t_a1b2c3d4", "t_deadbeef"],                   # → gate rejects
)
```

If a `kanban_create` call fails (exception, tool_error), the card was NOT created — do not include a phantom id for it. Retry the create, or omit the id and mention the failure in your summary. The prose-scan pass also catches `t_<hex>` references in your free-form summary that don't resolve; these don't block the completion but show up as advisory warnings on the task in the dashboard.

## Block reasons that get answered fast

Bad: `"stuck"` — the human has no context.

Good: one sentence naming the specific decision you need. Leave longer context as a comment instead.

```python
kanban_comment(
    task_id=os.environ["HERMES_KANBAN_TASK"],
    body="Full context: I have user IPs from Cloudflare headers but some users are behind NATs with thousands of peers. Keying on IP alone causes false positives.",
)
kanban_block(reason="Rate limit key choice: IP (simple, NAT-unsafe) or user_id (requires auth, skips anonymous endpoints)?")
```

The block message is what appears in the dashboard / gateway notifier. The comment is the deeper context a human reads when they open the task.

## Heartbeats worth sending

Good heartbeats name progress: `"epoch 12/50, loss 0.31"`, `"scanned 1.2M/2.4M rows"`, `"uploaded 47/120 videos"`.

Bad heartbeats: `"still working"`, empty notes, sub-second intervals. Every few minutes max; skip entirely for tasks under ~2 minutes.

## Retry scenarios

If you open the task and `kanban_show` returns `runs: [...]` with one or more closed runs, you're a retry. The prior runs' `outcome` / `summary` / `error` tell you what didn't work. Don't repeat that path. Typical retry diagnostics:

- `outcome: "timed_out"` — the previous attempt hit `max_runtime_seconds`. You may need to chunk the work or shorten it.
- `outcome: "crashed"` — OOM or segfault. Reduce memory footprint.
- `outcome: "spawn_failed"` + `error: "..."` — usually a profile config issue (missing credential, bad PATH). Ask the human via `kanban_block` instead of retrying blindly.
- `outcome: "reclaimed"` + `summary: "task archived..."` — operator archived the task out from under the previous run; you probably shouldn't be running at all, check status carefully.
- `outcome: "blocked"` — a previous attempt blocked; the unblock comment should be in the thread by now.

## Stuck in the world? Try escape primitives BEFORE escalating

If you're a Minecraft-domain worker (flint/mason/gatherer/barley/steward profiles) and your symptoms look physical-stuckness (NOT spec confusion or missing materials), there are dedicated `mc` verbs that resolve most cases without `kanban_block`. Try them FIRST — they often work and they're cheap.

**Symptoms that mean "you're physically stuck":**

- 3 failed `mc dig` / `mc move` / `mc goto_near` at the same spot.
- `pathfinder_error` or "no path found" responses.
- Position unchanged after 5+ navigation attempts.
- 4 walls + ceiling around you (a 1×1 shaft you dug into).
- `mc nearby` shows you boxed in by solid blocks.
- Standing on top of a 1-wide column you can't safely jump from.

**First-touch escape verbs (in order):**

1. **`mc pillar_step <N>`** — climb up N blocks (max 64). With NO block argument the primitive bare-hand-digs the cell overhead, captures the drop, and pillars with it. This is the canonical 1×1-shaft self-rescue.
   - `mc pillar_step 8` — climb 8, use captured drops (works for dirt/sand/gravel ceilings).
   - `mc pillar_step 8 --force` — same, but bypasses region/global denylists for the escape dig **only when the 4-walls+ceiling stuck-predicate is verified**. Use when the ceiling is stone and you're bare-handed, OR you're inside a protected region.
   - Drop-timing race: if you get `PILLAR_FAILED` with "capture-from-ceiling failed: cell above head is air", the drop arrived AFTER the call returned. **Call `mc pillar_step` a second time** — it'll use the captured block. Two-call pattern is reliable.

2. **`mc escape`** — last-resort general unstuck (classifies your situation: sidestep / pillar / wait / break-out by surrounding terrain).

3. **`mc pillar_down`** — if you're on top of a 1×1 column you climbed, this mines underfoot and drops you safely.

4. **`mc advise --reason="stuck at (X,Y,Z): <one-line symptom>"`** — perception bundle + LLM digest. Often spots an air opening you missed or a navigation angle you haven't tried.

**Don't:**
- Don't `mc dig` straight up in a 1×1 shaft (you'll be in the same shaft, one block higher).
- Don't hand-roll `mc place + mc jump + mc place` loops to climb. That's what `mc pillar_step` does, faster and correctly.
- Don't immediately `kanban_block(reason="stuck")`. Try the four verbs above first.

**Deeper playbook:** `skill_view minecraft-mining` → "Underground pillar escape" + "Escape protocol" sections. Load it on demand if the above doesn't resolve.

**Only after the escape verbs fail** (and you've tried the two-call pillar pattern + `--force` if appropriate + `mc advise`), proceed to Failure escalation below. A worker who blocks "stuck" without trying `mc pillar_step` is the anti-pattern this section exists to prevent.

## Failure escalation — when to ask for help instead of trying harder

**The expensive failure mode is "try harder, the same way, more times."** Read `runs[]`, classify same-class failures, switch modes at threshold.

| Same-class failures | Action |
|---|---|
| 0 | Normal work. |
| 1–2 | Vary the approach (adjacent coord, smaller chunk, different prerequisite). |
| **3rd** | **MANDATORY** `mc advise --reason="<one-line>"` before the 4th attempt. The framework prints `hint=mc advise ...` after consecutive failures — *don't ignore it*. |
| **4+** | Stop. `kanban_block(reason="help-needed: <one-line>")` + comment with full failure pattern. Exit. |
| **4+ AND you have an unblock idea** | `kanban_reassign <id> steward` with a comment naming what would unblock the task (precondition card, spec change, [BUG]). See *Pass-back* below. |

**Same-class** = same primitive + same target class. `mc dig (x,y,z)` → `mc dig (x,y,z+1)` → `mc dig (x,y+1,z)` is 3 same-class (same worksite). `mc till × 81` in a loop is 81 same-class — should have stopped at 3.

**Anti-pattern — bypass via shell-out.** If you think "I'll write a Python script to batch this" or "I'll call the REST API myself" — that's help-needed, not a new plan. Workarounds don't fix the bug (next worker hits the same wall), touch files outside `$HERMES_KANBAN_WORKSPACE`, and waste your budget on disposable infrastructure.

### Workspace data-analysis scripts ARE sanctioned

The anti-pattern is specifically **shelling out to `mc` in a loop to fake a missing primitive**. Python and shell are fine for:

- **Data parsing:** `data/ops/plans/<plan>.json` → world coords; chest snapshots → "missing: 12 iron_ingot"; `runs[]` → failure stats.
- **Planning:** sort dig coords by distance; filter `find_blocks` by region; route across chests.
- **Investigation:** grep prior session logs; diff `mc inspect` outputs.
- **Demonstrating a gap:** writing `pillar_to_surface.py` because `mc pillar_step` didn't exist is *useful evidence* — it's how `mc pillar_step --force` got added.

| Script | Verdict |
|---|---|
| Reads JSON, prints coord plan; you then call `mc place` | ✓ Planning |
| Reads chest snapshot, prints "missing N items" | ✓ Data analysis |
| `for x; for z; do mc till $x $z; done` | ✗ Missing primitive — file `help-needed:` instead |
| Custom pillar loop using `mc dig` + `mc place` when no verb exists | ✗ Edge case. If `help-needed:` already filed, fine, but comment on the card flagging it as a primitive candidate. |

**Rule of thumb:** if your script ends with `print(plan)` and YOU still call `mc` to execute, that's planning. If it ends with `subprocess.run(['mc', 'dig', x])` in a loop, that's the anti-pattern.

**Promotion:** workspace scripts using ONLY `mc` primitives that solve a recurring problem → leave a comment `"workspace has <script>.py — primitive candidate"`. That's how patterns graduate.

### Soft-help chat (optional at 2-failure mark)

```
mc chat "@steward <bot>: 2× fail on <primitive> at <target> — <error>. Trying <variant>."
```

Invites Steward attention without blocking. She may comment / unblock / reassign before you hit the hard threshold.

### Reading `runs[]`

```python
show = kanban_show(task_id=os.environ["HERMES_KANBAN_TASK"])
fails = [r for r in show.get("runs", [])
         if r.get("outcome") in ("crashed", "timed_out", "blocked", "failed")]
if len(fails) >= 4:
    # Framework should have circuit-broken. Treat as help-needed turn 1.
    kanban_block(reason=f"help-needed: {len(fails)} prior failures, needs review")
    return
```

`--max-retries` is the hard backstop; the rule above is the soft escalation engaging before it.

### Pass-back to Steward — when you have an unblock idea but can't act on it yourself

`kanban_block(reason="help-needed: ...")` parks a card and waits. **Pass-back is the active alternative**: you `kanban_reassign <id> steward` after leaving a comment that names *specifically what would unblock the task*. Steward sees a card in her queue (she has Per-bot mutex exemption for orchestrator-class cards, so it lands fast), reads your comment, and acts on the suggestion — typically by creating a precondition card, amending the spec, or freeing a needed resource — then reassigns back to you (or a more appropriate worker).

**Use pass-back when** you can fill in the blank in this sentence: *"If only `___` existed/were true, I could complete this task."* That blank is something Steward can produce: a SUPPLY card for missing materials, a SCOUT card for a missing coord, a region edit, a spec amendment. If you can't name the blank, use plain `help-needed:` block instead — that's a "please research" not "please do."

**Examples that warrant pass-back:**

```python
# Worker can't build because they're missing iron — and they know what's needed.
kanban_comment(body=(
    "Tried to start construction at (370, 65, -608); inventory has 0 iron. "
    "Chest_iron has 4 (need 16). What would unblock this:\n"
    "  1. Create [SUPPLY] iron (12 ingots) assigned to flint, parent=<this_id>\n"
    "  2. After that completes, reassign this back to me; chest_iron will hold the stock.\n"
    "  3. Alternative: shrink the build to its iron-free pieces and add a follow-up CONSTRUCT for the iron parts."
))
kanban_reassign(task_id, "steward")
```

```python
# Worker can't navigate because the anchor mark doesn't exist.
kanban_comment(body=(
    "Body references mark `:wheatfield:/anchor` but `mc go_mark wheatfield_anchor` returns NOT_FOUND. "
    "What would unblock this:\n"
    "  1. SCOUT card: find a suitable wheat-farm site near base, place a `:wheatfield:` placemark sign, mark `wheatfield_anchor`.\n"
    "  2. Reassign this card back to me once the anchor is in-world."
))
kanban_reassign(task_id, "steward")
```

```python
# Worker realizes the framework primitive needed doesn't exist.
kanban_comment(body=(
    "Body needs `mc till_area <x1,z1>-<x2,z2>` for an 81-tile farm. No batch verb exists; one-by-one `mc till` is "
    "burning iteration budget (3+ failures from interleaved hostiles). What would unblock this:\n"
    "  1. File [BUG] to re44: add `mc till_area` (parent=this), block this card on it.\n"
    "  2. Alternatively: reduce farm to 16 tiles for the manual path; rest waits on the bug fix.\n"
    "  3. Reassign back to me once option 1 or 2 is chosen."
))
kanban_reassign(task_id, "steward")
```

**Don't pass back when:**

- You just need *advice* and would still do the work yourself (use `help-needed:` block).
- You're stumped without a hypothesis (use `help-needed:` block).
- The task is fine as-written and you just failed at it (this is the bare `mc advise` mandatory tier or `help-needed:` block, not pass-back).
- The needed action is operator-only (rcon, server config) — escalate directly to `re44`, not Steward.

**Format of the comment matters.** Steward acts on what's *concrete*. List 2–3 numbered options for how the unblock could work, including "alternative: shrink scope" or "alternative: defer" when applicable. Steward's research toolkit is built around acting on specific suggestions, not freeform "please figure this out." A vague pass-back wastes her iteration budget; a structured one converts to action in one cycle.

After reassign, **exit cleanly** with no further action on the card. Don't `kanban_complete` and don't keep retrying — the card is no longer yours. Write your final memory checkpoint summarizing the pass-back, then return.

## Do NOT

- Call `delegate_task` as a substitute for `kanban_create`. `delegate_task` is for short reasoning subtasks inside YOUR run; `kanban_create` is for cross-agent handoffs that outlive one API loop.
- Modify files outside `$HERMES_KANBAN_WORKSPACE` unless the task body says to.
- Create follow-up tasks assigned to yourself — assign to the right specialist.
- Complete a task you didn't actually finish. Block it instead.

## Pitfalls

**Task state can change between dispatch and your startup.** Between when the dispatcher claimed and when your process actually booted, the task may have been blocked, reassigned, or archived. Always `kanban_show` first. If it reports `blocked` or `archived`, stop — you shouldn't be running.

**Workspace may have stale artifacts.** Especially `dir:` and `worktree` workspaces can have files from previous runs. Read the comment thread — it usually explains why you're running again and what state the workspace is in.

**Don't rely on the CLI when the guidance is available.** The `kanban_*` tools work across all terminal backends (Docker, Modal, SSH). `hermes kanban <verb>` from your terminal tool will fail in containerized backends because the CLI isn't installed there. When in doubt, use the tool.

## CLI fallback (for scripting)

Every tool has a CLI equivalent for human operators and scripts:
- `kanban_show` ↔ `hermes kanban show <id> --json`
- `kanban_complete` ↔ `hermes kanban complete <id> --summary "..." --metadata '{...}'`
- `kanban_block` ↔ `hermes kanban block <id> "reason"`
- `kanban_create` ↔ `hermes kanban create "title" --assignee <profile> [--parent <id>]`
- etc.

Use the tools from inside an agent; the CLI exists for the human at the terminal.
