# Fleet notes

## mc command registry

After changing `bot/cli/registry.mjs`, run `npm run cheatsheet` from `bot/` (or `node scripts/gen-mc-cheatsheet.mjs`) and commit `docs/reference/mc-cheatsheet.md` — `test/cheatsheet-sync.test.js` fails on drift.

**Kanban worker routing:** `mc` resolves the bot URL in `bot/cli/api-url.mjs`. The phase-16 leak was mainly **`BASH_ENV`** pointing at Steward's `agent-bashenv.sh` (re-exports `MC_API_URL=:3005` in every terminal subshell), not the three MC vars the phase-12 spawn scrub already cleared. Fixes: unset `BASH_ENV` at gateway/dispatcher start (`scripts/landfolk`), drop it in `_default_spawn`, profile `.env` pins lock+URL, `api-url.mjs` prefers `MC_API_URL` when `HERMES_KANBAN_TASK` is set. Spawn audit: `/tmp/worker-env-debug.log` (rotates at 2MB to `.log.1`). For a broader surface check, see `docs/reference/audits/audit-mc-commands-2026-05-29.md` and re-run its grep-based coverage steps when adding verbs.

**Navigation / perception docs:** agent-facing movement doctrine lives in `skills/minecraft-navigation.md` (synced to profiles via `scripts/sync-skills.sh`). Canonical intent tables: `docs/reference/mc-command-reference.md`; design depth: `docs/specs/nav/route-precompute-context.md`. CLI category for world reads is **`perceive`**, not `observe`.

## Memory

"Groundhog day" effect: the agent is stuck in a loop because it's not learning from its mistakes. The memory is important as agents can disconnect or handoff and need context, otherwise they will have to start over to assess the situation, tools, goals, etc.

## Familiar Workflow Challenges

- ticket handoff 
- blocked tasks
- dependencies between tasks
- agents taking too long without explanation

## Depth traversal

Going from the leaf up - only working on something if it's "parent" is done. 
Dependencies work backwards from how we think about projects. Imagine a parent-child graph and now flip it upside down.

## Too much context

But wait... the user also mentioned... before I do that, I need to...

1000k tokens (~1500 A4 pages of size 12 Arial font) - imagine trying to formulate questions about such an amount of context. Like humans, llms do better with 10-50 pages, that's like 5-30k in tokens. Add on top of that the context you need before you even read the document, and you're looking at a sweet spot of 40-60k tokens.

Context can be cached - useful for repeated requests, but doesn't work well with highly dynamic context. It's important to keep things consistent to benefit from caching. But this still doesn't solve the problem of too much context - breaking things down into smaller chunks does.

## Decomposition

- Challenging tasks have to be broken down, just like in real life. Agents can do this but need guidance - that means thinking through the steps and suggesting an approach. This is actually a great iterative case for chatting with a strong model about the prompt you need for decomposition.

Tasks can be run in parallel. It really depends on the task, but its worth looking for an opportunity to design a process that can scale. This can speed up workflows and also simplify complex processes.

## Tools

Understand a bit about unix, no really. Pipes and arguments, exit codes. It's a 3 minute boot camp - but important to realize because it's how AI agents get things done. It underscores the need to have simple tools that can be used in a pipeline.

## How to guide

Sometimes its better to specify the steps and rituals and agent should follow to approach a problem. If you leave it open, there are too many possibilities to hallucinate.

## Dont lead the witness

It's easy to promt the agent to do the thing you want to do and convince it that you're right. It will most certainly agree with you. If you want to get the most out of an intelligent tool, you need to be objective. Ask questions like you were in court, cross-examining the witness or defending the accused. The jury is the LLM's judgement. It defends what it already did, naturally. It will be honest when it thinks doing so will be the right answer. 

Don't ask it to "this worked before, fix the last change", instead ask "given the errors that we see now, what do you think could be causing it?" The agent will naturally start to work through the symptoms instead of digging through the lastest changes, which might not actually be responsible. Once you have more evidence, you can lead it toward the next action - it will be more educated and prepared to write good code.


## Bus Factor

How would we maintain our AI-built apps if the AI went away? Documentation and repeatable tooling are so important (AI or without)

## Playbook improvement pass (closed 2026-05-31)

Summary: [`improvement-pass-closure.md`](../testing/playbooks/improvement-pass-closure.md).

- Prose-skilled and structured playbooks are both valid; pick by task shape (preflight, resume, closeout complexity), not a single global default.
- Mechanism shipped (honest verbs, JSONL, agent-test). Broad playbook catalog and bot-side engine deferred.
- Successor bench: procedural test worlds + skills, primitives, and Steward/worker collaboration patterns.
