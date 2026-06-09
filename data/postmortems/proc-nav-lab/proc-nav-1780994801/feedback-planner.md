# FEEDBACK: planner @ proc-nav-1780994801

Three planner cards across this run: `t_720518cc` (initial road_plan.json, catalog Y),
`t_1e15c674` (road_plan.json v2 with corridor_profile Y), `t_a84bdbaf` (finalization).

## Problems hit

1. **Catalog Y vs live Y drift (W2-NAV-008)**
   The biggest friction across the whole trial. The initial plan used Y=67/68 from
   `last-scenario-map.json` (seed 1001, catalog coords). The scout's `corridor_profile`
   reported `elevation_median=78` — an 11-block delta. This meant the first planner card
   produced a plan at the wrong Y, which would have failed silently if the builder
   hadn't caught it via the scout pipeline. The fix (adding `corridor_profile` as a
   parent dependency) worked, but it cost one full planner re-spin.

2. **Three planner cards for one road plan**
   The pipeline needed: (a) first plan with catalog coords \u2192 (b) second plan with
   scout-live elevation \u2192 (c) final plan reading verify results from the navigator.
   That's 3 spawns for what should be 2 at most. The root cause is that the planner's
   initial card body didn't *know* it needed the scout's profile; that dependency was
   discovered at pipeline-assembly time.

3. **return_post reachability was baked into the plan but unreachable in world**
   The final verification (t_a84bdbaf) confirmed 3/3 road_bound_* marks and all 4
   segments cleared, yet `return_post` was 11 blocks away across a cliff gap. The
   planner had no way to detect this — the plan assumes the start and end are
   reachable from the corridor. A terrain-check step between plan generation and
   segment dispatch would save a builder from walking a dead-end route.

4. **Card body ambiguity on coordinate source**
   `t_720518cc`'s body said "use last-scenario-map.json" but didn't say "if a scout
   has run, prefer its live corridor_profile over catalog coords." The rule emerged
   mid-trial (W2-NAV-008). The card body should say: `coordinate_source: catalog
   (last-scenario-map.json) OR live (corridor_profile from parent scout) — prefer live
   when available`.

## Tooling improvements

1. **`mc terrain_profile` or `mc heightmap` verb**
   If the planner could cheaply query the terrain profile between two coords (e.g.,
   `mc terrain_profile overlook 0,67,0 return_post 0,68,48`), the Y-drift problem is
   solved at the planning stage without a scout dependency. The scout's
   `corridor_profile` is effectively a manual version of this. An `mc` verb would
   make any planner self-sufficient for Y.

2. **Kanban card body should carry a `coordinate_source` field**
   Structured metadata (YAML frontmatter or a body trailer) saying whether coords
   come from `catalog`, `live_scout`, `terrain_scan`, or `estimation`. Without it,
   the planner has to guess which coordinate set is authoritative. The usual symptom
   is a plan at the wrong Y that wastes a builder's run.

3. **Pipeline validation: planner plan \u2192 terrain quick-check before dispatch**
   A lightweight pre-dispatch step that answers: "are the planner's assumed start/end
   Y values within 2 blocks of the actual world surface?" This would catch the
   catalog-vs-live drift before any builder spins. Could be a `mc inspect` or
   surface-check at two waypoints.

## Bundle / profile / skill issues

4. **The `proc-nav-scout-runbook.md` was updated mid-trial** and the version in the
   skill directory didn't match what the scout executed. The planner reads the
   runbook to understand segment structure. If the runbook and scout diverge, the
   planner's assumptions break. Recommendation: freeze the runbook revision at trial
   start (include a `runbook_commit` or `runbook_version` in the manifest).

5. **No stale-profile warning.** When `t_1e15c674` ran, it correctly used the scout's
   corridor_profile, but there was no mechanism to say "this previous planner card
   (`t_720518cc`) produced a stale plan — discard it." The pipeline relied on the
   newest planner card overwriting the file. An explicit `kanban_comment` with
   `[SUPERSEDES t_720518cc]` tag would make the chain of trust clearer.

6. **Missing `--workspace-path` awareness in kanban body.** The feedback body says
   "write to data/postmortems/..." but doesn't resolve whether that's relative to
   `$HERMES_KANBAN_WORKSPACE` or `$HOME/hermescraft/data/...`. I used the absolute
   path because the workspace is scratch (empty). The card should either give the
   absolute path or state `paths resolve under $HOME/hermescraft/data/`.