# mc command cheatsheet (v2 — proposed categorical grammar)

Two-token grammar: `mc <category> <verb> [args]`

Discovery:
- `mc <category>`               list all verbs in that category
- `mc <command> --help`         full detail for one command
- `mc help`                     this index

## sense — perception (read-only)

- `mc sense nearby [R]` — list blocks/entities within R
- `mc sense scene [R]` — visible entities + landmarks
- `mc sense look` — what's directly ahead
- `mc sense listen` — recent footstep / mob sounds
- `mc sense find blocks TYPE [R]` — locate blocks
- `mc sense find entities TYPE [R]` — locate entities
- `mc sense map [R]` — ASCII overview
- `mc sense observe` — goals + alerts snapshot
- `mc sense status` — full game snapshot
- `mc sense health` — HP / food / effects
- `mc sense alerts` — typed alerts
- `mc sense deaths` — recent deaths
- `mc sense anchors` — known anchor marks
- `mc sense stats` — bot session stats

## go — locomotion

- `mc go to X Y Z` — walk to coords
- `mc go near X Y Z [R]` — walk to within R blocks
- `mc go follow PLAYER` — trail a player
- `mc go stop` — cancel movement
- `mc go look_at X Y Z` — turn body to face

## mine — extract from world (destructive)

- `mc mine block X Y Z` — single block
- `mc mine area X1 Y1 Z1 X2 Y2 Z2` — clear a box
- `mc mine tunnel DIR LEN [W H]` — directional run
- `mc mine stairs DIR LEN [up|down]` — staircase down
- `mc mine pillar UP|DOWN [N]` — single-column climb
- `mc mine collect TYPE [N] [R]` — find + mine N of type

## build — place into world (constructive)

- `mc build block X Y Z TYPE` — single block
- `mc build area X1 Y1 Z1 X2 Y2 Z2 TYPE` — fill a box
- `mc build wall X1 Y1 Z1 X2 Y2 Z2 TYPE` — vertical line/rect
- `mc build fence X1 Z1 X2 Z2 [--gate DIR]` — fence + gate enclosure
- `mc build path X1 Z1 X2 Z2` — shovel dirt → path
- `mc build pit X Z W L D [--stairs]` — dig + line a pit
- `mc build level X1 Z1 X2 Z2 Y` — flatten to target Y
- `mc build stairs DIR LEN [up|down] TYPE` — built staircase

## craft — recipes (craft + smelt)

- `mc craft make ITEM [N]` — craft (uses table if needed)
- `mc craft plan ITEM [N]` — recipe dependency check
- `mc craft recipes` — what's craftable now
- `mc craft smelt INPUT [N]` — foreground smelt
- `mc craft furnace check MARK` — status of one furnace
- `mc craft furnace take MARK` — pull output
- `mc craft furnace list` — known furnaces

## fight — combat + reactive policy

- `mc fight mode normal|guard|hold` — reactive policy
- `mc fight skill 0..1` — per-bot combat skill
- `mc fight attack [TARGET]` — single swing
- `mc fight loop [TARGET] [HP] [DUR]` — fight until dead
- `mc fight flee [DIST] [--to MARK]` — bounded retreat
- `mc fight shoot TARGET` — bow shot
- `mc fight shield [SECONDS]` — raise shield
- `mc fight sprint TARGET` — sprint hit
- `mc fight crit TARGET` — jump-attack
- `mc fight strafe TARGET` — sidestep + hit
- `mc fight combo TARGET` — attack sequence

## farm — plants, animals, fishing

- `mc farm till X Z` — hoe dirt → farmland
- `mc farm plant SEED X Z` — place seed on tilled
- `mc farm harvest CROP` — cut + auto-replant
- `mc farm lure ANIMAL --to MARK` — walk animal to mark
- `mc farm breed PAIR` — feed two adults
- `mc farm feed TARGET [ITEM]` — right-click mob with item
- `mc farm shear SHEEP`
- `mc farm milk COW`
- `mc farm fish start|stop|wait` — cast / listen / reel

## self — body, gear, what's in hand

- `mc self bag` — inventory list
- `mc self equip ITEM [SLOT]` — hand or armor
- `mc self unequip [SLOT]` — remove
- `mc self eat` — best food from bag
- `mc self toss ITEM [N]` — drop from bag
- `mc self pickup` — walk to nearby drop
- `mc self use` — activate held item
- `mc self interact X Y Z` — right-click block
- `mc self bucket fill water|lava` — fill held bucket
- `mc self bucket empty` — place fluid from bucket
- `mc self board ENTITY` — enter boat/minecart
- `mc self disembark` — exit vehicle
- `mc self sleep` — use bed
- `mc self respawn` — after death

## store — external containers

- `mc store open X Y Z | @MARK` — open chest
- `mc store search ITEM [MAX]` — cached chest snapshots
- `mc store deposit ITEM N [@MARK]` — put items in chest
- `mc store withdraw ITEM N [@MARK]` — take from chest
- `mc store close` — close currently-open

## say — communication

- `mc say chat MESSAGE` — public chat
- `mc say to PLAYER MESSAGE` — direct chat
- `mc say whisper PLAYER MESSAGE` — private (/msg)
- `mc say read [N]` — recent public chat
- `mc say overhear [N]` — recent private/team
- `mc say social` — relationships
- `mc say team chat MESSAGE` — team channel
- `mc say team status` — membership/roster
- `mc say team set NAME` — join team
- `mc say team rally` — pull all teammates here
- `mc say cmd ack ID` — acknowledge queued cmd
- `mc say cmd complete ID` — mark queued cmd done
- `mc say cmd cancel ID` — cancel queued cmd
- `mc say cmd list` — list queued

## plan — goals, marks, tasks, reminders

- `mc plan goal add ID METRIC ...` — register a goal
- `mc plan goal list` — active goals
- `mc plan goal set ID FIELD VALUE` — edit a goal field
- `mc plan goal status ID` — detail
- `mc plan goal remove ID`
- `mc plan goal preset list` — built-in presets
- `mc plan goal preset load NAME` — miner/builder/etc.
- `mc plan mark add NAME [POS]` — save location
- `mc plan mark list`
- `mc plan mark update NAME` — move to current pos
- `mc plan mark remove NAME`
- `mc plan mark go NAME` — walk there
- `mc plan mark home [NAME]` — set home anchor
- `mc plan task start TYPE ARGS` — background task
- `mc plan task list`
- `mc plan task pause ID`
- `mc plan task resume ID`
- `mc plan task history`
- `mc plan task cancel ID`
- `mc plan remind add WHEN MSG`
- `mc plan remind list`
- `mc plan remind remove ID`
- `mc plan deathpoint` — walk to last death

## meta — platform

- `mc meta help [CAT|VERB]` — grouped or per-command help
- `mc meta commands [--json]` — full machine-readable index
- `mc meta dashboard` — open web URL
- `mc meta batch FRAGMENTS` — chain multiple mc calls
- `mc meta connect` — reconnect bot
- `mc meta fair_play [on|off]` — toggle reaction-delay preamble
