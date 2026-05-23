# Perception-digest experiment — session findings

Notes from the experiment session that turned the perception-digest MVP
into a forced-reason wrapping layer for Steve. See
[perception-digest.md](../guides/perception-digest.md) for the canonical reference
and [running-steve.md](../guides/running-steve.md) for the runbook.

## What was built

**Wrapping layer.** When `MC_FORCE_REASON=1`, the `mc` CLI intercepts
`mc scene` / `mc map` / `mc find` / `mc nearby` and routes them through
the same `perception_advise` pipeline as `mc advise`. The agent must
pass `--reason="<sub-goal>"`; missing reason returns a helpful error
that includes a usage example. `mc status` is deliberately kept thin
(position / HP / food / holding / time) so the agent has a cheap
self-state primitive and is forced toward the wrapped tools for richer
world-state.

**Bundle-by-kind.** `capture_perception_bundle(kind=...)` trims the
payload to what the caller actually needs: scene/find/nearby skip the
wide map view (~22 KB → ~18 KB), map keeps it. Every wrapped call now
includes the last 10 chat events as `chat` so the digest sees both
re44's whispers and Steve's own outbound announcements.

**Digest grounding.** The OpenRouter system prompt was extended with
domain facts deepseek-v4-flash kept hallucinating around:
- Food edibility list (eggs are NOT food; rotten flesh / raw chicken
  are last-resort due to Hunger debuff)
- Tool tier prerequisites (wooden → stone → iron → diamond)
- Cooking requires furnace + fuel; shears don't work on chickens/cows/pigs
- Inventory discipline: never claim items not in `status.inventory`
- **POSITION rule**: recommendations must be `[x, y, z]` (3 ints) AND
  the cell must be standable — not the resource block itself

**Logging.** `mc-advise.jsonl` now includes `kind`, full
`recommendations`, full `caveats`, and `nothing_actionable` per call.
A pretty-tailer `scripts/watch-advise.py` follows it with color +
filters.

**Lifecycle.** `scripts/run-steve.sh` is the single canonical command:
kills any existing Steve, restarts the bot (with `VIEWER_PORT=4001`),
waits for handshake, launches the agent with `MC_FORCE_REASON=1`.
Reproducible every time.

**Session-JSON tailer.** `scripts/watch-steve.py` follows the canonical
session JSON in `~/.hermes-landfolk-steve/sessions/`, rendering tool
calls + tool outputs + assistant messages without the ANSI noise of the
hermes TUI stdout. Auto-switches when a new session starts (i.e. after
`run-steve.sh`).

## What worked

**Wrapping was a flip-a-switch behavior change.** Before: Steve called
`mc scene` ~once per round with no goal context, got 22 KB of raw block
data, and rarely called `mc advise` even when stuck. After: 100% of
observation calls articulate a sub-goal, and the digest output is
goal-biased recommendations with coordinates. Example reasons that
actually appeared in production:
- `"need to craft stone_pickaxe to mine coal"`
- `"food at 2, need to find food urgently at base or chicken pen"`
- `"trying to recover death items at 378,63,-574 in water"`

**Grounded prompt killed the egg hallucination.** Before grounding, the
digest repeatedly suggested *"goto_collect egg ... could eat raw (low
saturation)"* — eggs aren't food in Minecraft. After grounding, the
same scenario produced *"caveat: Egg is NOT edible — do not eat it."*

**`mc status` as thin self-check.** Forcing `--reason` on status would
have created friction with no benefit (status is checked frequently).
Thin status (no LLM, ~0.14 s, 360 B) gives the agent a cheap "where am
I" tool. The prompt nudges polling-style work to `mc task` instead.

**The session JSON is the right source of truth.** Hermes TUI stdout
has ANSI noise, line wrapping artifacts, and inconsistent formatting
across runs. The session JSON has clean structured messages
(role/content/tool_calls/reasoning_content). `watch-steve.py` reading
it gives a stable, repeatable log view.

## What didn't work / surprised us

**The agent ignores digest caveats sometimes.** Even with the digest
explicitly warning *"Egg is NOT edible — do not eat it"*, Steve still
ran `mc eat egg 3` (succeeded once before the bot started rejecting
subsequent attempts). The digest LLM knows the rules; the agent's
main-loop LLM does not — they're separate API calls. Caveats should
probably be promoted to *rules* in the agent's prompt for safety-
critical cases, or the food rules should be mirrored into steve.md.

**`max_tokens` is necessary but not sufficient.** The agent first
truncated at the default model max_tokens (probably ~4–8K). Setting
`model.max_tokens: 16384` helped but didn't fully fix it — the model
was still hitting `finish_reason='length'`. Root cause: deepseek-v4-
flash with `reasoning_effort: medium` emits hundreds of reasoning
tokens before each tool call, eating the completion budget. Dropping
to `reasoning_effort: low` was the actual fix. Two truncations across
the session ended sessions hard (hermes rolls back to last complete
assistant turn and stops).

**Pathfinder is the real bottleneck, not the digest.** Once positions
were standable 3-int arrays, the digest's recommendations became
high-quality (oak_log at `[333, 70, -643]`, iron_ore at `[318, 64,
-656]` etc.). But `mc move`/`mc goto_near` still failed often near
water edges and on small landmasses. Steve drowned once at
(378, 63, -574) trying to reach a coordinate the digest correctly
flagged as unreachable in its caveats — the agent didn't heed the
caveat, called `mc move` anyway, swam into deeper water, died. The
digest is solving the *what*; pathfinder primitives still need work
for the *how*.

**Agent source-diving.** Twice the agent burned 5–10 turns reading
`bot/cli/registry.mjs` and `bot/cli/index.mjs` to discover chest
syntax instead of just running `mc chest 363 65 -594` (which it had
used successfully an hour earlier in a prior session). Hermes gave it
full filesystem read tools and it used them. Fix candidates: prompt
rule forbidding source-reads for command discovery; restrict hermes
file tools for landfolk profiles.

**Agent shell-tool bypass.** Late in one session the agent stopped
calling `mc` entirely and switched to raw `curl -s -X POST
http://localhost:3001/action/collect ...` against the bot HTTP API
directly. This bypasses the wrapping experiment. Prompt rule needed:
*"Don't curl the bot HTTP API directly — use `mc` commands so the
wrapping is in effect."*

**Per-iteration token budget exhausts in ~50 min.** At max_turns=300,
~12 messages/min, sessions are ending on the iteration cap before
much progress accumulates. Most of the budget gets burned in
pathfinder-thrash and command-syntax discovery. Higher cap isn't the
fix; better turn-economy via prompt edits (abandon-on-nothing-actionable,
use `mc task` for polling) is.

## Costs

Across ~5 hours of Steve runs:
- Wrapped digest calls: ~$0.0005 – $0.0020 each
- Typical run cost: ~$0.10–0.30 / hour at current cadence
- Token cache hit rate: 90%+ on the system prompt across calls
  (OpenRouter cached_tokens visible in `usage.prompt_tokens_details`)

`status` polling was 52% of wrapped calls before the thin-status
change — that's where most of the prior cost lived.

## Open questions for the next iteration

1. **Should caveats be promoted to harder constraints in the agent
   prompt?** Specifically: food rules, "don't move to a coord the
   digest flagged unreachable", "abandon on nothing_actionable".
2. **Cache identical-reason digest calls within a short window?**
   Steve frequently called `mc scene --reason="X"` then 5s later
   another scene call with similar reason while still in the same
   spot. Server-side cache keyed on
   `(kind, reason_hash, position_quantized, ~30s_window)` would skip
   the LLM round-trip when the world state can't have changed
   meaningfully.
3. **Pathfinder robustness** for water-edge and small-landmass cases.
   Maybe `mc escape` should be auto-called on detected drowning risk;
   maybe `bg_goto` should always retry once with a y±1 fallback when
   it hits `NAV_TARGET_UNSTANDABLE`.
4. **Disable filesystem tools for landfolk profiles?** The
   source-diving and curl-bypass behaviors only happen because hermes
   exposes read_file / grep / terminal-with-curl. Steve's job doesn't
   need any of that.
5. **The `[error]` cosmetic tag** on slow `mc map` / `mc scene` calls
   in the hermes TUI confuses both humans reading the log and possibly
   the agent. Worth investigating where in hermes 0.14 that flag is
   set — exit codes are 0, ok=true, digest succeeds.
