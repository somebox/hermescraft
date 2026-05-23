import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ensureWithinReach } from './_helpers.js';
import { ok, fail } from '../shared/action-contract.js';
import { canSeeBlockFaces } from './_los.js';

const { goals } = pathfinderPkg;

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

    // Open. activateBlock toggles, so check shape state first via _properties when available.
    let opened = false;
    try {
      const props = (typeof gate.getProperties === 'function') ? gate.getProperties() : {};
      const wasOpen = props.open === 'true' || props.open === true;
      if (!wasOpen) {
        await b.activateBlock(gate);
        opened = true;
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
   * Swim up to the water surface. Holds jump (swim-up while submerged) until
   * the bot's head is in air or 30s elapse. Used to escape water columns the
   * bot pours on itself (G9 scenario). No-op if the bot isn't in water.
   */
  };
}
