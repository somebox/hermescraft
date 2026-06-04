import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ensureWithinReach } from './_helpers.js';
import { ok, fail } from '../shared/action-contract.js';
import { canSeeBlockFaces } from './_los.js';

const { goals } = pathfinderPkg;

/**
 * Read the 4 lines of text from a sign block. Mineflayer exposes the
 * data via different shapes across protocol versions:
 *   - `block.signText`  — array of 4 line strings (1.20+ packet path)
 *   - `block.signEntity.text` / `block._signEntity.text` — legacy NBT
 *     parsed by older paths; may be a string (JSON-stringified) or array.
 * Returns a length-4 array (padding with '' when needed) for diff'ing.
 */
/** Decode one MC 1.20.5+ sign-line value — Mineflayer surfaces these as
 *  JSON-component objects (e.g. {text:"smoke"}) OR JSON strings
 *  (e.g. '"smoke"') OR plain strings, depending on the parser path. */
function _decodeSignLine(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') {
    // Often '"smoke"' — JSON-encoded string. Strip the quotes if present.
    if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
      try { return String(JSON.parse(raw) ?? ''); } catch { /* fall through */ }
    }
    return raw;
  }
  if (typeof raw === 'object') {
    if (typeof raw.text === 'string') return raw.text;
    if (Array.isArray(raw.extra)) {
      return raw.extra.map(_decodeSignLine).join('');
    }
  }
  return String(raw);
}

export function readSignTextLines(block) {
  if (!block) return ['', '', '', ''];
  // Modern Mineflayer path (MC 1.20.5+): front_text/back_text containers
  // each holding a `messages` array of JSON components. Workers always
  // write to the front by default; back path is for `--back`.
  const front = block.frontText || block.front_text;
  if (front?.messages && Array.isArray(front.messages)) {
    return [0, 1, 2, 3].map((i) => _decodeSignLine(front.messages[i]));
  }
  // Older Mineflayer path: block.signText array of plain strings.
  if (Array.isArray(block.signText)) {
    return [0, 1, 2, 3].map((i) => String(block.signText[i] ?? ''));
  }
  // Oldest path: tile-entity blob with `text` (string or array).
  const signEntity = block._signEntity || block.signEntity;
  if (signEntity?.text != null) {
    if (Array.isArray(signEntity.text)) {
      return [0, 1, 2, 3].map((i) => _decodeSignLine(signEntity.text[i]));
    }
    const split = String(signEntity.text).split('\n');
    return [0, 1, 2, 3].map((i) => split[i] ?? '');
  }
  return ['', '', '', ''];
}

/**
 * Strict line-by-line compare for sign read-back verification. Pads the
 * shorter array with '' so a 2-line write against a freshly-placed
 * sign (4 lines of '') still matches.
 */
export function linesMatch(observed, expected) {
  const o = Array.isArray(observed) ? observed : [];
  const e = Array.isArray(expected) ? expected : [];
  const max = Math.max(o.length, e.length, 4);
  for (let i = 0; i < max; i += 1) {
    if (String(o[i] ?? '') !== String(e[i] ?? '')) return false;
  }
  return true;
}

/**
 * createInteractionActions — extracted from former lib/actions/world.js (Phase 4 split).
 */
export function createInteractionActions(services) {
  const { state: ctx, config, ensureBot, utils, social, resolver, fairPlay, getActions } = services;
  const { fmt, posObj, sleep, log } = utils;
  const { resolveInventoryItem } = resolver;
  const { rememberSocialEvent, getMyName } = social;
  const { hasLineOfSight, eyePosition } = fairPlay;

  return {
  async interact({ x, y, z }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) {
      return {
        ok: false,
        error: {
          code: 'NO_BLOCK_AT_COORD',
          message: `No block at ${x}, ${y}, ${z}`,
          observed_state: { requested_coord: { x, y, z } },
          retry_safe: false,
        },
      };
    }
    // F55.3: uniform reach precheck.
    const reach = await ensureWithinReach({ bot: b, goals }, { x, y, z }, {
      range: 4.5,
      observed: { block_at_target: block.name },
    });
    if (!reach.ok) return reach;
    // F65: line-of-sight guard. Mirrors F45.3 (mc place) and F64 (chest
    // open). Bot must be able to see the target block to interact with
    // it — no opening doors through walls.
    if (!canSeeBlockFaces(b, x, y, z, { hasLineOfSight, eyePosition })) {
      return fail(
        'NO_LINE_OF_SIGHT',
        `Cannot see ${block.name} at ${x},${y},${z} — a block is between you and the target.`,
        {
          observed_state: {
            target: { x, y, z },
            block_at_target: block.name,
            bot_position: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
          },
          next_action_hint: `Navigate around the obstruction; try mc goto_near ${x} ${y} ${z} range=2`,
          retry_safe: false,
        },
      );
    }
    await b.activateBlock(block);
    return ok({ result: `Interacted with ${block.name} at ${x}, ${y}, ${z}` });
  },

  /**
   * Traverse a gate/door: open it, walk to the far side, close it behind.
   * Args:
   *   gx, gy, gz — gate position.
   *   dx, dy, dz — destination on the far side (optional; auto-inferred if absent).
   * Returns action contract: { ok, data:{ gate_block, opened, traversed_to, closed }, result }.
   */
  async through({ gx, gy, gz, dx, dy, dz }) {
    const b = ensureBot();
    const gateVec = new Vec3(Number(gx), Number(gy), Number(gz));
    if (![gx, gy, gz].every((v) => Number.isFinite(Number(v)))) {
      return { ok: false, error: { code: 'INVALID_COORD', message: 'mc through requires numeric gate coords', retry_safe: false } };
    }

    let gate = b.blockAt(gateVec);
    // F55.4: when the first blockAt returns air, the door may have just
    // been placed by a partner (G21 v6 case: Mason called through right
    // after Flint placed). Mineflayer's block snapshot occasionally lags
    // a tick or two behind the server. Re-fetch once after a short delay
    // before deciding it's truly absent.
    if (gate && /^(?:air|cave_air|void_air)$/.test(gate.name)) {
      await sleep(150);
      gate = b.blockAt(gateVec);
    }
    if (!gate) {
      return { ok: false, error: { code: 'GATE_NOT_FOUND', message: `No block at gate position ${gx}, ${gy}, ${gz}`, retry_safe: false } };
    }
    const isPassable = /(_fence_gate|_door|_trapdoor)$/.test(gate.name);
    if (!isPassable) {
      // F54.5: when the target isn't a door, give the brain a concrete
      // next-step. The G21 v5 case was "I dug the door's support block,
      // door fell out, now mc through fails on air" — bots looped on the
      // command instead of placing a new door. If we hold a door in
      // inventory AND the target is air, suggest the exact place call.
      // For a wall-block, suggest dig or pick a real door coord.
      const isAir = /^(?:air|cave_air|void_air)$/.test(gate.name);
      let nextActionHint = `Block is "${gate.name}", not a door. Find a real door/gate coord, or mc dig to clear an obstacle.`;
      let inventoryDoor = null;
      if (isAir) {
        const doorItem = b.inventory.items().find((it) =>
          /(_door|_fence_gate|_trapdoor)$/.test(it.name),
        );
        if (doorItem) {
          inventoryDoor = doorItem.name;
          nextActionHint = `No door at (${gx}, ${gy}, ${gz}) — block is air. You have ${doorItem.name} in inventory. Try: mc place ${doorItem.name} ${gx} ${gy} ${gz}`;
        } else {
          nextActionHint = `No door at (${gx}, ${gy}, ${gz}) — block is air. Either pick a different door/gate coord, or craft a door (mc craft oak_door) and mc place it here.`;
        }
      }
      return {
        ok: false,
        error: {
          code: 'NOT_A_DOOR',
          message: `Block at ${gx}, ${gy}, ${gz} is "${gate.name}", not a fence_gate/door/trapdoor. ${nextActionHint}`,
          observed_state: {
            block_at_target: gate.name,
            requested_coord: { x: Number(gx), y: Number(gy), z: Number(gz) },
            inventory_door: inventoryDoor,
            is_air: isAir,
          },
          next_action_hint: nextActionHint,
          retry_safe: false,
        },
      };
    }

    // Infer destination if not provided: 2 blocks past the gate, opposite side from bot.
    let destX = Number(dx), destY = Number(dy), destZ = Number(dz);
    if (![destX, destY, destZ].every(Number.isFinite)) {
      const me = b.entity.position;
      const vx = gate.position.x + 0.5 - me.x;
      const vz = gate.position.z + 0.5 - me.z;
      // Pick dominant axis; step 2 blocks past the gate in that direction.
      const stepX = Math.abs(vx) >= Math.abs(vz) ? Math.sign(vx) : 0;
      const stepZ = stepX === 0 ? Math.sign(vz) : 0;
      destX = gate.position.x + stepX * 2;
      destY = gate.position.y;
      destZ = gate.position.z + stepZ * 2;
    }

    // Approach the gate so it's reachable.
    // F55.3 + F55.4: uniform reach precheck with wallclock cap. On
    // failure, surface door_state and gate distance so the brain has
    // structured signal (not just "could not approach").
    //
    // #96: scale the wallclock cap by gate distance. Default 8s covers
    // close-by doors (typical case) but is too tight for the door
    // distances surfaced by #91's 64m fallback. Allow ~1s per block,
    // clamped to [8s, 30s].
    const gateDistance = b.entity.position.distanceTo(gate.position);
    const reachCapMs = Math.min(30000, Math.max(8000, Math.floor(gateDistance * 1000)));
    const reach = await ensureWithinReach({ bot: b, goals }, { x: gate.position.x, y: gate.position.y, z: gate.position.z }, {
      range: 4.5,
      capMs: reachCapMs,
      observed: {
        gate_pos: { x: gate.position.x, y: gate.position.y, z: gate.position.z },
        gate_block: gate.name,
        gate_distance: Math.round(gateDistance * 10) / 10,
        approach_cap_ms: reachCapMs,
        door_state: (typeof gate.getProperties === 'function') ? (gate.getProperties().open === 'true' || gate.getProperties().open === true ? 'open' : 'closed') : null,
      },
    });
    if (!reach.ok) {
      // Re-frame OUT_OF_RANGE from the reach helper as TRAVERSAL_FAILED so
      // it stays in the `mc through` contract that callers already handle.
      const inner = reach.error || {};
      return {
        ok: false,
        error: {
          code: 'TRAVERSAL_FAILED',
          message: `Could not approach gate at (${gx}, ${gy}, ${gz}): ${inner.message || 'unreachable'}`,
          observed_state: inner.observed_state || {},
          next_action_hint: inner.next_action_hint || null,
          retry_safe: true,
        },
      };
    }

    // F68: line-of-sight guard. Reach is only euclidean distance, so the
    // bot can be 4.5 blocks away with a solid wall between it and the
    // gate and still pass reach. Require LOS to at least one face of the
    // gate before activating — no opening doors/gates through walls.
    if (!canSeeBlockFaces(b, gate.position.x, gate.position.y, gate.position.z, { hasLineOfSight, eyePosition })) {
      return fail(
        'NO_LINE_OF_SIGHT',
        `Cannot see ${gate.name} at ${gx},${gy},${gz} — a block is between you and the gate.`,
        {
          observed_state: {
            gate: { x: gate.position.x, y: gate.position.y, z: gate.position.z },
            gate_block: gate.name,
            bot_position: { x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z },
          },
          next_action_hint: `Navigate to a cell with direct sight to the gate first; mc goto_near ${gx} ${gy} ${gz} range=2`,
          retry_safe: false,
        },
      );
    }

    // Safety: before opening the gate, check for passive animals adjacent
    // to it. If any are within 1.5 blocks of the gate centerline, opening
    // exposes a window for them to escape through. Return ANIMAL_AT_GATE
    // and let the caller decide what to do (push them back, hunt them,
    // wait and retry).
    const passiveSpecies = new Set([
      'chicken', 'cow', 'sheep', 'pig', 'rabbit', 'horse', 'donkey',
      'mule', 'mooshroom', 'llama', 'goat',
    ]);
    const gateCenter = gate.position.offset(0.5, 0.5, 0.5);
    const blockingAnimals = Object.values(b.entities)
      .filter((e) => e && e !== b.entity && e.position && passiveSpecies.has((e.name || '').toLowerCase()))
      .filter((e) => e.position.distanceTo(gateCenter) <= 1.5);
    if (blockingAnimals.length > 0) {
      return {
        ok: false,
        error: {
          code: 'ANIMAL_AT_GATE',
          message: `Cannot open ${gate.name}: ${blockingAnimals.length} animal(s) within 1.5 blocks of the gate would escape.`,
          observed_state: {
            gate: { x: gate.position.x, y: gate.position.y, z: gate.position.z },
            blocking: blockingAnimals.map((e) => ({
              species: e.name,
              pos: [Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)],
              distance: Number(e.position.distanceTo(gateCenter).toFixed(2)),
            })),
          },
          next_action_hint: 'Wait for animals to wander away, or push them back, then retry.',
          retry_safe: true,
        },
      };
    }

    // Defense in depth against the "open door + pathfinder re-eval lag"
    // family of races (cf. test_door_pathfind.py's xfail'd N/S closed-door
    // cases). Clear any in-flight pathfinder goal BEFORE flipping the
    // door state, so a stale goal can't react to the world change with
    // outdated passability data. Then activate. Then clear again — the
    // first clear racing against a tick that's already started a path
    // computation can leave that computation finishing with stale data;
    // the second clear cancels its eventual goal-pursuit.
    try { b.pathfinder.setGoal(null); } catch {}

    // Open. activateBlock toggles, so check shape state first via _properties when available.
    let opened = false;
    try {
      const props = (typeof gate.getProperties === 'function') ? gate.getProperties() : {};
      const wasOpen = props.open === 'true' || props.open === true;
      if (!wasOpen) {
        await b.activateBlock(gate);
        opened = true;
        // Immediately re-clear pathfinder state — closes the microsecond
        // window between activateBlock returning and the next-statement
        // setGoal(null) below. mineflayer-pathfinder's tick loop runs at
        // ~50ms; without this, a tick that fires between activate-resolve
        // and the standard clear can pursue a stale path.
        try { b.pathfinder.setGoal(null); } catch {}
      }
    } catch (e) {
      return { ok: false, error: { code: 'TRAVERSAL_FAILED', message: `Failed to open ${gate.name}: ${e?.message || e}`, retry_safe: true } };
    }

    // Walk through the gate using direct movement, NOT pathfinder.
    // Pathfinder treats closed doors as impassable and (with canDig=true) will
    // tunnel through walls/floor to bypass them — destructive and wrong here.
    // The door is right in front of us; just hold "forward" toward dest.
    try { b.pathfinder.setGoal(null); } catch {}
    const destPos = new Vec3(destX + 0.5, destY, destZ + 0.5);
    await b.lookAt(destPos);

    const traverseStart = Date.now();
    // Slightly longer than 2.5s so a step-up + walk + step-down has time.
    // F56: doors sit on raised platforms in real builds; the bot often
    // needs to jump up 1 block to enter the doorway. Detection-based
    // jump nudges handle this without flailing.
    const TRAVERSAL_TIMEOUT_MS = 3500;
    let crossedGate = false;
    let reached = false;
    b.setControlState('forward', true);
    let lastPos = { x: b.entity.position.x, z: b.entity.position.z };
    let stallStart = 0;
    let jumpUntil = 0;
    try {
      while (Date.now() - traverseStart < TRAVERSAL_TIMEOUT_MS) {
        await sleep(100);
        const now = Date.now();
        const me = b.entity.position;
        const dist = me.distanceTo(destPos);
        // Detect when we've crossed the gate plane (so we can close it after).
        if (!crossedGate) {
          const sx = Math.sign(destX - me.x);
          const sz = Math.sign(destZ - me.z);
          const passedX = Math.abs(sx) > 0.01 ? (sx > 0 ? me.x > gate.position.x + 0.5 : me.x < gate.position.x + 0.5) : true;
          const passedZ = Math.abs(sz) > 0.01 ? (sz > 0 ? me.z > gate.position.z + 0.5 : me.z < gate.position.z + 0.5) : true;
          if (passedX && passedZ) crossedGate = true;
        }
        if (dist < 1.0) { reached = true; break; }

        // F56: stall + jump-nudge. If bot's XZ has barely changed over
        // 250ms, it's collided with the doorframe / platform edge.
        // Trigger a 400ms jump pulse to step up 1 block. Repeat at most
        // every 600ms to avoid jump-spam.
        const dx = me.x - lastPos.x;
        const dz = me.z - lastPos.z;
        const moved = Math.hypot(dx, dz);
        if (moved < 0.05) {
          if (stallStart === 0) stallStart = now;
          else if (now - stallStart >= 250 && now >= jumpUntil) {
            b.setControlState('jump', true);
            jumpUntil = now + 600;
            stallStart = 0;
          }
        } else {
          stallStart = 0;
        }
        if (now >= jumpUntil) {
          try { b.setControlState('jump', false); } catch { /* ignore */ }
        }
        lastPos = { x: me.x, z: me.z };
      }
    } finally {
      b.setControlState('forward', false);
      try { b.setControlState('jump', false); } catch { /* ignore */ }
    }

    if (!reached) {
      // Try to close gate before returning the failure (best-effort).
      try { const g2 = b.blockAt(gateVec); if (g2) await b.activateBlock(g2); } catch {}
      const me = b.entity.position;
      return {
        ok: false,
        error: {
          code: 'TRAVERSAL_FAILED',
          message: `Opened ${gate.name} but bot stalled at ${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)} (target ${destX},${destY},${destZ}). The doorway may be obstructed or the destination wrong.`,
          observed_state: { gate_block: gate.name, opened, crossed_gate: crossedGate, current: { x: me.x, y: me.y, z: me.z }, dest: { x: destX, y: destY, z: destZ } },
          retry_safe: true,
        },
      };
    }

    // Close behind. Re-fetch the block (state may have changed).
    let closed = false;
    try {
      const after = b.blockAt(gateVec);
      if (after) {
        const props = (typeof after.getProperties === 'function') ? after.getProperties() : {};
        const isOpen = props.open === 'true' || props.open === true;
        if (isOpen) {
          // We may be slightly out of activate range; turn back briefly if so.
          if (b.entity.position.distanceTo(after.position) > 4.5) {
            await b.lookAt(after.position.offset(0.5, 0.5, 0.5));
          }
          await b.activateBlock(after);
          closed = true;
        }
      }
    } catch {
      // Non-fatal: traversal succeeded; closing is best-effort.
    }

    return {
      ok: true,
      data: {
        gate_block: gate.name,
        gate_position: { x: gate.position.x, y: gate.position.y, z: gate.position.z },
        opened,
        traversed_to: { x: destX, y: destY, z: destZ },
        closed,
      },
      result: `Through ${gate.name} at ${gate.position.x},${gate.position.y},${gate.position.z}: ${opened ? 'opened' : 'already open'}, walked to ${destX},${destY},${destZ}, ${closed ? 'closed' : 'left open'}`,
    };
  },

  async close_screen() {
    const b = ensureBot();
    if (b.currentWindow) b.closeWindow(b.currentWindow);
    return ok({ result: 'Closed screen.' });
  },

  // ── Utility ──────────────────────────────────────
  async use() {
    const b = ensureBot();
    await b.activateItem();
    return ok({ result: `Used ${b.heldItem?.name || 'hand'}` });
  },

  /**
   * Write or edit text on a sign at X,Y,Z. Uses Mineflayer's bot.updateSign
   * (the underlying `update_sign` packet that the server accepts for both new
   * and existing signs). 4 lines × 45 chars max per the protocol. Vanilla
   * MC 1.21 supports editing signs in-game, so this works on existing signs
   * — workers can author placemark text for the region sign-watcher pipeline.
   *
   * Args:
   *   x, y, z  — sign block coords
   *   text     — full text; lines separated by \n (max 4 lines, 45 chars each)
   *   back     — optional bool; write to back side of the sign (default false)
   */
  async edit_sign({ x, y, z, text, back = false }) {
    if (typeof text !== 'string' || text.length === 0) {
      return fail('MISSING_ARGS', 'edit_sign requires non-empty `text` (newline-separated up to 4 lines)', {
        observed_state: { received_text_type: typeof text },
        retry_safe: false,
      });
    }
    const lines = text.split('\n');
    if (lines.length > 4) {
      return fail('TOO_MANY_LINES', `Got ${lines.length} lines; signs have max 4 lines. Strip newlines or split into multiple signs.`, {
        observed_state: { line_count: lines.length, max: 4 },
        retry_safe: false,
      });
    }
    const over = lines.findIndex((l) => l.length > 45);
    if (over >= 0) {
      return fail('LINE_TOO_LONG', `Line ${over + 1} has ${lines[over].length} chars; sign lines cap at 45.`, {
        observed_state: { offending_line: over + 1, length: lines[over].length, max: 45, content_preview: lines[over].slice(0, 50) },
        retry_safe: false,
      });
    }
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) {
      return fail('NO_BLOCK_AT_COORD', `No block loaded at ${x},${y},${z}`, {
        observed_state: { requested_coord: { x, y, z } },
        retry_safe: false,
      });
    }
    if (!String(block.name || '').includes('sign')) {
      return fail('NOT_A_SIGN', `Block at ${x},${y},${z} is ${block.name}, not a sign. mc place <sign_item> ${x} ${y} ${z} first, then mc edit_sign.`, {
        observed_state: { block_name: block.name, requested_coord: { x, y, z } },
        retry_safe: false,
      });
    }
    // F55.3: uniform reach precheck (same as mc interact).
    const reach = await ensureWithinReach({ bot: b, goals }, { x, y, z }, {
      range: 4.5,
      observed: { block_at_target: block.name },
    });
    if (!reach.ok) return reach;
    try {
      await b.updateSign(block, text, !!back);
    } catch (e) {
      return fail('UPDATE_SIGN_FAILED', `bot.updateSign rejected: ${e?.message || String(e)}`, {
        observed_state: { block_name: block.name, requested_coord: { x, y, z }, back: !!back },
        retry_safe: false,
      });
    }
    return ok({
      result: `Wrote sign at ${x},${y},${z} (${back ? 'back' : 'front'}) — ${lines.length} line(s)`,
      data: {
        coord: { x, y, z },
        side: back ? 'back' : 'front',
        line_count: lines.length,
        lines,
      },
    });
  },

  /**
   * place_named_sign — place a sign and write its text in one call.
   *
   * Single-shot wrapper over `mc place` + `mc edit_sign` with a server-
   * side read-back verification. Pair with `mc poi_add --sign X Y Z` so
   * the resulting POI knows where its anchor sign lives.
   *
   * Read-back is the wax detection mechanism: Mineflayer's `updateSign`
   * sends the packet whether the sign is waxed or not, and the server
   * silently drops the update on waxed signs. We sleep ~200ms
   * (env `SIGN_READBACK_MS`, default 200) then re-read
   * `block.signText` / `block.signEntity.text`. If the lines don't
   * match what we sent, we return `SIGN_WAX_PROTECTED` with the
   * observed text so the agent can chat-escalate or relocate.
   *
   * Phase A2.
   *
   * Args:
   *   x, y, z  — target cell
   *   text     — full text; newline-separated up to 4 lines, max 45
   *              chars per line (mirrors edit_sign limits)
   *   variant  — sign item id ('oak_sign' default; any *_sign works)
   *   back     — write to back face on 1.20+ (default false)
   */
  async place_named_sign({ x, y, z, text, variant = 'oak_sign', back = false }) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return fail('MISSING_ARGS', 'place_named_sign requires finite x,y,z', {
        observed_state: { received: { x, y, z } },
        retry_safe: false,
      });
    }
    if (typeof text !== 'string' || text.length === 0) {
      return fail('MISSING_ARGS', 'place_named_sign requires non-empty `text` (newline-separated up to 4 lines)', {
        observed_state: { received_text_type: typeof text },
        retry_safe: false,
      });
    }
    const lines = text.split('\n');
    if (lines.length > 4) {
      return fail('TOO_MANY_LINES', `Got ${lines.length} lines; signs have max 4 lines.`, {
        observed_state: { line_count: lines.length, max: 4 },
        retry_safe: false,
      });
    }
    const over = lines.findIndex((l) => l.length > 45);
    if (over >= 0) {
      return fail('LINE_TOO_LONG', `Line ${over + 1} has ${lines[over].length} chars; sign lines cap at 45.`, {
        observed_state: {
          offending_line: over + 1,
          length: lines[over].length,
          max: 45,
          content_preview: lines[over].slice(0, 50),
        },
        retry_safe: false,
      });
    }
    if (typeof variant !== 'string' || !variant.endsWith('_sign')) {
      return fail('MISSING_ARGS', `variant must be a *_sign item id (got "${variant}").`, {
        observed_state: { received_variant: variant },
        retry_safe: false,
      });
    }

    const b = ensureBot();

    // ── Delegate placement to mc place ──
    // `place` validates inventory, reach, region policy, entity blocking,
    // and post-place verification — all the failure modes we'd otherwise
    // have to duplicate.
    const place = getActions?.()?.place;
    if (typeof place !== 'function') {
      return fail('PLACE_NOT_AVAILABLE', 'mc place action is not registered; cannot delegate.', {
        retry_safe: true,
      });
    }
    const placeResult = await place({ block: variant, x, y, z });
    if (!placeResult.ok) return placeResult;

    // ── Wait for the sign block to register ──
    // mineflayer's blockAt cache updates lazily on blockUpdate packets.
    // Poll briefly so the subsequent updateSign hits a real sign block.
    let signBlock = null;
    for (let i = 0; i < 10; i += 1) {
      const blk = b.blockAt(new Vec3(x, y, z));
      if (blk && String(blk.name || '').includes('sign')) {
        signBlock = blk;
        break;
      }
      await sleep(50);
    }
    if (!signBlock) {
      const observed = b.blockAt(new Vec3(x, y, z));
      return fail('SIGN_BLOCK_NOT_FOUND', `Placed ${variant} at ${x},${y},${z} but blockAt didn't return a sign within 500ms. Observed: ${observed?.name ?? 'null'}.`, {
        observed_state: { observed_block: observed?.name ?? null, requested_variant: variant },
        retry_safe: true,
      });
    }

    // ── Reach precheck (mirror edit_sign) ──
    const reach = await ensureWithinReach({ bot: b, goals }, { x, y, z }, {
      range: 4.5,
      observed: { block_at_target: signBlock.name },
    });
    if (!reach.ok) return reach;

    // ── Write the text ──
    try {
      await b.updateSign(signBlock, text, !!back);
    } catch (e) {
      return fail('UPDATE_SIGN_FAILED', `bot.updateSign rejected: ${e?.message || String(e)}`, {
        observed_state: { block_name: signBlock.name, requested_coord: { x, y, z }, back: !!back },
        retry_safe: false,
      });
    }

    // ── Read-back verification (wax detection) ──
    // Phase E evidence (2026-06-04): Mineflayer's local block cache
    // doesn't reliably pick up sign text after `bot.updateSign`. The
    // server stores the text correctly (verified via RCON `data get
    // block`), but `bot.blockAt(pos)` returns a Block whose
    // `signText` / `frontText.messages` / `signEntity.text` paths all
    // come back empty for the polled duration. This produces a 100%
    // false-positive SIGN_WAX_PROTECTED rate on this MC version.
    //
    // Until we figure out the right Mineflayer accessor for 1.20.5+
    // sign data, the read-back check is opt-in. Default: skip.
    //
    //   SIGN_READBACK_VERIFY=1   re-enable the readback poll
    //   SIGN_READBACK_MS         poll budget in ms (default 1500)
    //
    // Workers trust `bot.updateSign` succeeded if no exception was
    // thrown. They lose automatic wax detection — a waxed sign will
    // appear to succeed even though the world rejected the write. That
    // trade is worth it to unblock the mapping mission.
    const verifyEnabled = process.env.SIGN_READBACK_VERIFY === '1';
    if (verifyEnabled) {
      const readbackMaxMs = Number(process.env.SIGN_READBACK_MS) || 1500;
      const pollMs = 50;
      let observed = ['', '', '', ''];
      let verifyBlock = null;
      let elapsed = 0;
      let matched = false;
      while (elapsed < readbackMaxMs) {
        await sleep(pollMs);
        elapsed += pollMs;
        verifyBlock = b.blockAt(new Vec3(x, y, z));
        observed = readSignTextLines(verifyBlock);
        if (linesMatch(observed, lines)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        return fail('SIGN_WAX_PROTECTED', `Sign at ${x},${y},${z} did not accept the new text (likely waxed or server-side rejection).`, {
          observed_state: {
            requested_lines: lines,
            observed_lines: observed,
            block_name: verifyBlock?.name ?? null,
            readback_ms: elapsed,
          },
          next_action_hint: `mc chat "<bot>: sign at ${x},${y},${z} is waxed — naming '${lines[0]}' rejected"`,
          retry_safe: false,
        });
      }
    }

    return ok({
      result: `Placed ${variant} at ${x},${y},${z} and wrote ${lines.length} line(s) on ${back ? 'back' : 'front'}.`,
      data: {
        coord: { x, y, z },
        variant,
        side: back ? 'back' : 'front',
        line_count: lines.length,
        lines,
      },
    });
  },

  /**
   * place_torch — place a torch at (x,y,z), auto-picking floor vs wall
   * variant based on adjacent solid faces.
   *
   * Minecraft has only one torch item ID (`minecraft:torch`); the server
   * decides whether to place a floor torch (`torch` block) or a wall
   * torch (`wall_torch` block) based on the placement face. We classify
   * adjacency client-side so we can return a precise NO_SOLID_FACE
   * error before mineflayer's 5s placeBlock timeout fires.
   *
   * Delegates to the existing `place` action for the heavy lifting
   * (equip, reach, pathfind, region policy, entity-blocking, post-place
   * verify), then reads back the placed block to confirm the variant.
   *
   * Phase A1.
   *
   * Args:
   *   x, y, z  — target cell
   *   prefer   — 'auto' (default) | 'floor' | 'wall'. 'auto' picks floor
   *              when block below is solid, else wall.
   */
  async place_torch({ x, y, z, prefer = 'auto' }) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return fail('MISSING_ARGS', 'place_torch requires finite x,y,z', {
        observed_state: { received: { x, y, z } },
        retry_safe: false,
      });
    }

    const b = ensureBot();

    // ── NO_TORCH_IN_INVENTORY ──
    const torchItem = b.inventory.items().find((i) => i.name === 'torch');
    if (!torchItem) {
      return fail('NO_TORCH_IN_INVENTORY', `No torch in inventory. Pick up or craft torches (mc craft torch) first.`, {
        observed_state: {
          requested_coord: { x, y, z },
          inventory_summary: b.inventory.items().reduce((acc, it) => {
            acc[it.name] = (acc[it.name] || 0) + it.count;
            return acc;
          }, /** @type {Record<string, number>} */ ({})),
        },
        retry_safe: false,
      });
    }

    // ── Adjacency probe — what surfaces support a torch here? ──
    const isSolid = (blk) => blk && blk.boundingBox === 'block';
    const belowBlock = b.blockAt(new Vec3(x, y - 1, z));
    const hasFloorSupport = isSolid(belowBlock);
    const sides = [
      { dir: 'east',  d: [1, 0, 0] },
      { dir: 'west',  d: [-1, 0, 0] },
      { dir: 'south', d: [0, 0, 1] },
      { dir: 'north', d: [0, 0, -1] },
    ];
    const wallSides = sides.filter(({ d }) => isSolid(b.blockAt(new Vec3(x + d[0], y, z + d[2]))));
    const hasWallSupport = wallSides.length > 0;

    // ── Pick variant per prefer flag ──
    let useFloor;
    const preferStr = String(prefer || 'auto').toLowerCase();
    if (preferStr === 'floor') useFloor = true;
    else if (preferStr === 'wall') useFloor = false;
    else useFloor = hasFloorSupport;  // auto: floor first, fall back to wall

    if (useFloor && !hasFloorSupport && hasWallSupport) {
      // Auto downgrade — caller said 'auto' but floor isn't supported.
      useFloor = false;
    }

    if (useFloor && !hasFloorSupport) {
      return fail('NO_SOLID_FACE', `Cannot place floor torch at ${x},${y},${z}: block below is not solid (got ${belowBlock?.name ?? 'air/null'}). Try --prefer wall or move to a cell with solid ground beneath.`, {
        observed_state: {
          block_below: belowBlock?.name ?? null,
          wall_sides_available: wallSides.map((s) => s.dir),
          prefer: preferStr,
        },
        retry_safe: false,
      });
    }
    if (!useFloor && !hasWallSupport) {
      return fail('NO_SOLID_FACE', `Cannot place wall torch at ${x},${y},${z}: no adjacent solid wall face found. Try --prefer floor or move to a cell next to a wall.`, {
        observed_state: {
          block_below: belowBlock?.name ?? null,
          prefer: preferStr,
        },
        retry_safe: false,
      });
    }

    // ── Look at the target so the placeBlock face direction is sane ──
    // Server resolves which face the torch attaches to based on the
    // line-of-sight crosshair; without lookAt, mineflayer can pick the
    // wrong face and place a wall torch where the caller wanted floor.
    try {
      await b.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true);
    } catch {
      /* lookAt is best-effort; if it throws, place may still succeed. */
    }

    // ── Delegate to mc place ──
    // The existing place action handles equip, reach, pathfind, region
    // policy, entity blocking, and post-place verification. We just
    // call it and re-shape the response.
    const place = getActions?.()?.place;
    if (typeof place !== 'function') {
      return fail('PLACE_NOT_AVAILABLE', 'mc place action is not registered; cannot delegate.', {
        retry_safe: true,
      });
    }
    const result = await place({ block: 'torch', x, y, z });
    if (!result.ok) return result;

    // ── Read back the placed block to report the actual variant ──
    const placed = b.blockAt(new Vec3(x, y, z));
    const variant = placed?.name === 'wall_torch' ? 'wall_torch' : 'torch';
    return ok({
      result: `Placed ${variant} at ${x},${y},${z}`,
      data: {
        coord: { x, y, z },
        variant,
        prefer: preferStr,
        floor_supported: hasFloorSupport,
        wall_sides_available: wallSides.map((s) => s.dir),
      },
    });
  },

  };
}
