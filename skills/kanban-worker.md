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

## Validate the task before starting

**First-touch rule: before you run a single domain action, confirm the task as-written is actually doable. Cards drift; specs lie; prerequisites move.** A worker who jumps straight into execution on a malformed card spends their entire iteration budget discovering the card was malformed. Validation is cheap (1–3 tool calls), execution after a bad spec is expensive (full budget, no progress, then a forced retry).

Validation pass — runs after `kanban_show` and memory-read, before any first domain action:

1. **Read body + recent comments completely.** Don't skim. Specs sit at the bottom of the body; clarifications sit in the most recent comments. The body you got dispatched with may be **stale** relative to the comment thread.
2. **Check required inputs against what's actually present.** If the body names coords, marks, chests, files, or prior-task ids, verify each one exists:
   - Named coord — does it fall in a region you can reach? (`mc regions --at X Y Z`, or a quick `mc scene 4` if you're nearby)
   - Mark name (`chest_food`, `:base:/anchor`) — does the mark resolve? (`mc go_mark` will tell you immediately; `mc marks` lists them all)
   - Materials/items — are they actually in the named chest? (`mc chest_search <item>` or `mc list_container` after `mc go_mark <chest>`)
   - Parent / prior-task id — is it `done`? (`kanban_show <parent_id>`)
3. **Check assumptions named in the body match observable reality.** "Worksite has a partial wall at Y=66" → run `mc scene` at the worksite to confirm. "Chest_food has 256 cooked_beef" → run `mc list_container`. Worker reports in comments are claims, not facts.
4. **Check the primitive surface matches the work.** If the body says "till these 81 blocks and plant wheat" and your `mc` toolbelt has `mc till` and `mc place` but no batch verb — that's an in-scope decomposition you can handle (one primitive per block). If the body says "design and lay out a 3-room building" and the only verbs available are dig/place/collect — that may be in-scope but it's a long task that needs an inline plan; flag it.
5. **Check for ambiguity.** If a body uses words like "appropriate," "good enough," "as needed" without numbers, OR has multiple plausible interpretations of the same instruction, OR contradicts a prior comment — that's a question, not work.

**If validation passes**, proceed normally; the rest of your iteration budget is yours.

**If validation fails**, do NOT start work. Choose the lightest escalation that fits the failure:

- **Missing input is fixable by you in <3 turns** (e.g., the mark exists under a slightly different name, the chest is in `chest_food_2` not `chest_food`): fix in place, narrate the fix in a comment (`"used chest_food_2 since chest_food is empty"`), and proceed.
- **Spec is ambiguous, single-decision** (one named coord vs another, which of two anchors): post a comment asking the specific question with the options, then `kanban_block(reason="clarification-needed: <one-line>")`. Steward / re44 reads the comment, replies, unblocks.
- **Spec is missing critical data** (no coords at all, no materials list, no anchor): if the parent card has the data, fetch it from the parent and proceed with a comment noting where you got it. If the parent doesn't either, block with `clarification-needed:` and name what's missing.
- **Spec is unreachable / impossible** (worksite is in unloaded chunks, required mark refers to a region that doesn't exist, parent task isn't done yet): block with `clarification-needed: <reason>`. Don't try to be clever — the operator can decide whether to fix the spec, reschedule the parent, or archive.
- **Spec conflicts with reality** (body says "destroy the partial wall at A" but the wall isn't there, OR body says "use the iron pickaxe in chest_tools" but the chest holds none): comment with what you observed, block `clarification-needed: <reality>`. Your observation IS the value-add — Steward needs it to update the spec.

**Comment + block template for validation failures:**

```python
kanban_comment(
    body=(
        f"Validation failed at start.\n\n"
        f"Spec says: <one-line of what the body claims>\n"
        f"I observed: <one-line of what I saw via mc/check>\n"
        f"Specific question: <one-line>\n\n"
        f"Options I see:\n"
        f"  1. <option A — what would change in the spec>\n"
        f"  2. <option B>\n"
        f"  3. Archive — task is no longer relevant because <one-line>."
    ),
)
kanban_block(reason="clarification-needed: <one-line question>")
```

**Do not** silently rewrite the task in your head and execute on the rewritten version. The whole point of validation is to surface ambiguity TO the spec author, not to absorb it.

**Self-resolving validations are a memory write.** If you fixed something inline (chest name, mark variant), checkpoint that fact so the next worker on the same task — or a related task — doesn't have to rediscover it:

```python
memory(action="add", content="Worker <profile>: chest_food currently empty; food is in chest_food_2 (mark exists in steward's locations).")
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

## Failure escalation — when to ask for help instead of trying harder

**The single most expensive failure mode is "try harder, in the same way, more times."** Workers in environments with rich domain primitives (Minecraft `mc` verbs, robotics actions, simulator steps) burn entire iteration budgets retrying a primitive that is failing for a *structural* reason (wrong target, missing prerequisite, framework bug, environment desync). The runs[] log captures that pattern — read it, classify it, and switch modes when a threshold trips. **Do not pivot to writing Python scripts, shell-outs, or other workarounds to bypass framework primitives.** If the primitive is broken, that's a `[BUG]` against the framework, not your decision to escape it.

**Tiered escalation by failure count of the same-class operation:**

| Same-class failures | Action |
|---|---|
| 0 (fresh attempt) | Normal work. |
| 1–2 | Vary your approach: try an adjacent coord, a different prerequisite, a smaller chunk. Narrate one chat line if it feels worth peer attention. |
| **3rd same-class failure** | **MANDATORY `mc advise --reason="<one-line: what you're trying, what's failing, what you've tried">"`** before the 4th attempt. This is a perception bundle + LLM digest of your current situation; it often spots the structural reason you missed (wrong tool, missing nav target, terrain mismatch). The framework actively suggests this in tool-error `hint=` fields — *do not ignore those hints.* |
| **4+ same-class failures** | Stop. `kanban_block(reason="help-needed: <one-line>")`. Drop a comment with the full failure pattern: which primitive, which inputs, which errors, what `mc advise` said, what assumptions you tested. Then exit. The Steward (or operator) will research and unblock with guidance. **The card is no longer yours to retry until someone replies.** |
| **4+ failures AND you have a concrete unblock idea** | Pass the card BACK to Steward with a suggestion rather than just blocking. Use `kanban_reassign <id> steward` after dropping a comment that names specific things that would make the task possible: a needed primitive, a missing prerequisite, a coord change, a different toolkit. This is a more active escalation than `help-needed:` — you're asking Steward to *act* (often by creating a precondition card or amending the spec), not just *answer*. See "Pass-back to Steward" below. |

**Same-class** means *same primitive + same target class*, not literal byte-for-byte identity. Examples:

- `mc dig (x1,y,z1)` failing → `mc dig (x1,y,z1+1)` failing → `mc dig (x1,y+1,z1)` failing = **3 same-class** (dig at the same worksite, three coords; the worksite is the structural issue).
- `mc bg_goto A` failing → `mc collect B` failing → `mc craft C` failing = **3 different-class** (different primitives, unrelated targets).
- `mc till (a)` failing 81 times in a loop = **81 same-class**. That is precisely the situation that should have stopped at attempt 3.

**The anti-pattern to avoid: silent pivot to a "general-purpose escape hatch."** If you find yourself thinking *"I'll just write a Python script to batch this"* or *"I'll shell out to the server to do it directly"* or *"let me call the REST API myself"* — that is the signal that you have already passed the help-needed threshold and are now trying to escape the primitive instead of asking why it's failing. Switch to `kanban_block(reason="help-needed: ...")` immediately. Writing a workaround:

1. Doesn't fix the underlying bug (next worker hits the same wall),
2. Often touches code/files outside `$HERMES_KANBAN_WORKSPACE` (which you must not modify),
3. Burns the rest of your iteration budget on infrastructure that will be discarded,
4. Hides the real problem from the operator who could fix it in 30s.

**One legitimate exception:** if the runs[] history shows that a *previous worker on this same task* already tried `mc advise` + chat + block and the operator replied "yes, write a one-off script for this specific case" via comment, then the workaround is sanctioned. Even then, the script lives inside `$HERMES_KANBAN_WORKSPACE` and ships with the card, not as a permanent change to the framework.

**Soft-help chat narration (optional but encouraged at the 2-failure mark):**

```
mc chat "@steward <bot>: 2× fail on <primitive> at <target> — <error>. Trying <variant> next."
```

This invites real-time peer attention from Steward without blocking the card. Steward's continuous loop will see the mention and may comment / unblock / reassign before you reach the hard-help threshold.

**Reading runs[] correctly:**

```python
show = kanban_show(task_id=os.environ["HERMES_KANBAN_TASK"])
prior = show.get("runs", [])
fails = [r for r in prior if r.get("outcome") in ("crashed", "timed_out", "blocked", "failed")]
if len(fails) >= 4:
    # You should not be here — the framework should have circuit-broken.
    # If you got dispatched anyway, treat it as help-needed from turn 1.
    kanban_block(reason=f"help-needed: {len(fails)} prior failures, needs review")
    return
```

The framework's `--max-retries` is the hard backstop; the SOUL rule above is the soft escalation that engages BEFORE the hard cap. If the soft rule is doing its job, the hard cap rarely fires.

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
