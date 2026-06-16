# mineflayer patches

Custom patches to vendored mineflayer packages, applied automatically by
**patch-package** on `npm install` (see `bot/package.json` → `"postinstall":
"patch-package"`, devDep `patch-package@^8`). Each `.js` change also carries an
inline comment with its rationale; this file is the index.

Verify applied / re-apply:  `cd bot && npx patch-package`  → expect both `✔`.
Regenerate after editing node_modules:  `cd bot && npx patch-package <pkg>`.

> History: `mineflayer-pathfinder+2.4.5.patch` was regenerated 2026-06-16 — the
> prior file was git-`diff`-formatted and `patch-package` could not parse it, so a
> fresh `npm install` would have **silently dropped every pathfinder fix below**
> (door traversal included). Always create/edit patches via `npx patch-package`,
> never hand-write the diff.

---

## `mineflayer+4.37.1.patch` — `lib/plugins/entities.js`
- **`use_entity` packet gains a `hand` field** (default `0`). The 1.21.4 protocol
  requires `hand` when `mouse=0` (interact) or `mouse=2` (interact_at); without it
  Paper silently rejects the packet. This was why **native mounting didn't stick**
  and every mount fell back to the PaperMCP ride path.

## `mineflayer-pathfinder+2.4.5.patch` — `index.js` + `lib/movements.js`
Mostly door/corner traversal hardening. Fix labels (`Fnn`) match the inline comments.

**`index.js`**
- **F68 — door/gate LOS + range guard.** Before toggling an openable block, require
  it within ~3.5 of eye and raycast-visible on ≥1 of 7 face candidates; else
  `resetPath`. Prevents toggling a block the bot can't actually reach/see.
- **F58 — arrival XZ tolerance 0.35 → 0.25.** Stock 0.35 + the 0.6-wide hitbox =
  ~0.7-block tolerance square → corner-scrape stucks (G21–G23). Bisected to 0.25
  on 2026-05-25: tight enough to avoid scrape, loose enough to avoid sub-tick
  micro-movements that triggered Paper anti-cheat "moved-wrongly" kicks.
- **F69b — sneak through openable cells.** An open door's 0.1875 slab + 0.6 hitbox
  leaves ~0.0125 clearance/side; without sneak the bot clips the slab and stalls.
  Sneak when the current/next cell is openable.

**`lib/movements.js`**
- **F66 — plain doors are openable.** Stock pathfinder only marks `fence_gate` as
  openable, so `canOpenDoors=true` was a no-op for `*_door`. Now any non-iron block
  whose name ends `_door` or contains `gate` joins the openable set.
- **F66/F69 — don't break door halves; toggle only when closed.** When walking into
  an openable cell, skip `safeOrBreak` on both door halves (stock tried to "break"
  the upper half → fails when `canDig=false` → move rejected). Fire on `openable`
  alone (some open-door states report empty `shapes`). Only push the `useOne`
  interact when the door is actually *closed* (reads blockstate `open`) — else a
  blanket toggle would shut an open door into the bot's path.
- **F63 — corner-cut prevention.** Refuse a diagonal step when EITHER perpendicular
  intermediate cell at body height is physical; the 0.6 hitbox clips that corner
  even though the center traces air → off-grid snag + pathfinder oscillation. Force
  cardinal (two axis-aligned) steps instead.

## Door / gate traversal contract (reliability)

Mapped by the functional matrix `tests/functional/test_door_pathfind.py`
(type × facing × hinge × open × method) + `test_shelter_egress.py`:

- **Reliable (guaranteed, hard-asserted): E/W-facing doors + ALL fence gates
  (every facing)** — via both pathfinder (`mc goto_near`/`mc move`) and the robust
  `mc through` (open + direct-walk + jump/strafe/sneak nudges + retreat-pathfinder
  fallback). Shelter egress through the E/W door is reliable.
- **Known framework limitation: N/S-facing DOORS.** mineflayer-pathfinder's N/S
  open-and-cross races, and the `through` direct-walk wedges on a south-facing
  closed→opened door (N/S handedness in pathfinder + door swing/collision, below
  our action layer). These cells are `xfail` in the matrix.

**Contract:** build doors **E/W-facing** (the shelter/build spec mandates this;
`scripts/genesis2_lib.shelter_setblock_commands` renders `facing=east`). Fence
gates work in any facing. For crossing a door on a route, prefer `mc through` /
`mc move` (door-aware) over raw `mc goto_near`. True any-facing door traversal is
deferred (needs a pathfinder-level N/S fix). See the genesis-v2 devlog
(2026-06-16 door entry).
