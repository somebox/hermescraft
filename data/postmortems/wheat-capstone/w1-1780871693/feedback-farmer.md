# Farmer feedback — w1-1780871693 (bot:mox)

## Problems hit

- **MC_API_URL / MC_USERNAME not in env.** The SOUL says "injected at spawn by the dispatcher" but they were empty. Had to discover the bot port from `data/bots/mox.yaml` (port 3007) and manually `export MC_API_URL` + `MC_USERNAME` in every terminal call. The `env_passthrough` list in config.yaml includes them but they never arrived. About 30% of turn budget burned on discovery and repeated exports.

- **`mc inspect --mark wheat_plot` fails.** The card body instructs "Use `mc inspect --mark wheat_plot` to read the wheat-plot coordinates" but this returns `ERROR: inspect:x:not_number`. The `mc inspect` verb doesn't support `--mark`. Had to fall back to `mc marks` which works fine — but the card instruction sent me down the wrong path first.

- **Stuck warning from prior run.** The bot had `stuck_warning: "STUCK 13min"` on the first `mc status` from a previous builder card iteration. Not a real stuck — the bot was idle at the right position — but the warning is loud and the first read is alarming. The farmer needs to know it can ignore stale stuck_warnings when the position is correct for the card.

- **`mc till_area` failure reporting is subtle.** The water source cell at (-50,64,50) reports as 1 "failed" with `UNCHANGED` code — which is actually correct behaviour (don't till the water). The 80/80+1unplantable is right but the "failed" counter reads like an error. A clear "skipped 1 water source" would remove the double-take.

- **`mc farm_status` uses absolute coords, not marks.** Every call to `mc farm_status` needs explicit corner coords. There's no `mc farm_status --mark wheat_plot`. Manually typed `-54 46 -46 54 64` from reading `mc marks` output — fragile and error-prone.

- **HERMES_HOME path override.** `HERMES_HOME=/Users/foz/.hermes/profiles/farmer` overrides `HOME`, making `~` resolve to `/Users/foz/.hermes/profiles/farmer/home/` instead of `/Users/foz/`. This breaks paths like `~/.hermes/state` in card instructions — had to resolve absolute paths manually.

- **No `mc chat` presence from prior workers.** The builder cards left no `mc chat` trail — the farmer had no in-world awareness of the prior agent's work. Had to re-derive everything from marks and card metadata.

## Tooling improvements

1. **`mc inspect --mark <name>` support.** A single command to get the mark coords and inspect the block at that position. Would replace the current two-step (`mc marks` + manual coord extraction). The agent-farmer bundle lists `mc inspect <pos>` but not `mc inspect --mark` — because the latter doesn't exist.

2. **`mc farm_status --mark <name>`.** A mark-aware farm status that auto-resolves the mark center and inspects the bounding area with known plot size (9×9 default). Would save re-typing corner coords on every diagnostic.

3. **Persistent MC_API_URL injection.** The SOUL says "injected at spawn" but the mechanism isn't working for this profile. Either the dispatcher isn't setting the env vars at spawn time, or `env_passthrough` in the terminal config doesn't propagate to children correctly. A working injection would have saved ~6 tool calls of manual discovery and export.

## Bundle / skill gaps

- **agent-farmer.md** lists `till_area` and `farm_status` correctly as existing verbs (good) but doesn't mention that `mc inspect --mark` doesn't exist. The skill should either warn that mark-param is unsupported, or the `mc` CLI should support it. I'd vote for the CLI fix.

- **agent-farmer.md §4** says "Read the parent handoff" — I did (kanban_show), and the parent metadata had the coords. But if I had skipped the parent read and gone straight to `mc inspect --mark` per the card body, I'd have been stuck at the `not_number` error without a fallback. The card body and the tool surface should agree.

- **card body spec divergence.** The card says "Use `mc inspect --mark wheat_plot`" which doesn't work. Either the card spec should say `mc marks` or inspect needs the flag. The card is the source of truth for the worker but the tool doesn't support the contract the card describes.

- **No minecraft-farming skill was bundled** on this W1 card (skills list was `kanban-worker, agent-farmer, minecraft-farming, minecraft-survival` but for this particular run only `kanban-worker` was actually loaded). Having the farming skill at hand for verb reference would have reduced `mc help` calls.
