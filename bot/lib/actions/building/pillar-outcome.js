/**
 * Pure messaging + sky-exposure helpers for pillar_up (a.k.a. pillar_step).
 *
 * The pillar handler is mineflayer-heavy (jump physics, placeBlock, ground
 * polling) and covered by functional tests against a real body. The string
 * that comes back to the agent — and the decision of whether a lateral
 * opening is the real surface — is pure logic, extracted here so it can be
 * unit-tested cheaply.
 *
 * Why this exists (2026-05-29): live evidence showed the bot pillaring 1
 * block, hitting a stone ceiling it couldn't dig bare-handed, breaking out
 * of the loop, and then returning a *success* envelope ("climbed 1 block")
 * that hid the real reason. The agent invented a wrong theory ("lateral
 * exits at each level") and burned several rounds. describePillarOutcome
 * makes an early stop loud: it reports placed/requested, classifies the
 * blocker, and points at the concrete next action (often `--force`).
 */

import { Vec3 } from 'vec3';

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/**
 * True when the column above a standing cell is clear all the way up — i.e.
 * the cell is open to the sky and is therefore the real surface, not just a
 * lateral opening into another cave/tunnel.
 *
 * Scans from the head cell (feetY + 1) upward. Any solid block (boundingBox
 * 'block') means there's a ceiling above → not the surface. Plants, air, and
 * unknown/unloaded cells (blockAt → null) are treated as passable.
 *
 * @param {(pos: import('vec3').Vec3) => { boundingBox?: string, name?: string } | null} blockAt
 * @param {number} x
 * @param {number} feetY  Y of the standing (feet) cell of the candidate exit.
 * @param {number} z
 * @param {number} [worldTop=319]  Highest Y to probe (vanilla 1.21 build limit).
 * @returns {boolean}
 */
export function isCellSkyExposed(blockAt, x, feetY, z, worldTop = 319) {
  for (let y = feetY + 1; y <= worldTop; y++) {
    const blk = blockAt(new Vec3(x, y, z));
    if (blk && blk.boundingBox === 'block' && !AIR_NAMES.has(blk.name)) return false;
  }
  return true;
}

/**
 * Classify why a pillar climb stalled, from the accumulated fail reasons.
 * Returns one of:
 *   'no_tool'    — bare-handed against stone (slow-dig refusal / empty hand)
 *   'protected'  — region/global denylist refused the escape dig
 *   'obstructed' — overhead block present but the place/dig didn't register
 *   null         — no fail reasons (clean stop)
 *
 * @param {string[]} failReasons
 */
export function classifyPillarBlocker(failReasons) {
  const j = (failReasons || []).join(' | ');
  if (!j) return null;
  if (/Refusing to dig|empty hand|no pickaxe|Tool tier|drops? nothing|bare-hand stone/i.test(j)) return 'no_tool';
  if (/POLICY_DENY|denylist|protected/i.test(j)) return 'protected';
  return 'obstructed';
}

function plural(n) { return n === 1 ? '' : 's'; }

/**
 * Build the agent-facing message + structured fields for a finished pillar
 * climb. Pure: no bot/IO. The handler wires the returned pieces into either
 * a success envelope or a fail() envelope (placed === 0).
 *
 * @param {object} o
 * @param {string} [o.verb='pillar_up']
 * @param {number} o.placed       blocks actually placed this call
 * @param {number} o.requested    blocks the caller asked for (maxSteps)
 * @param {number} o.startY
 * @param {number} o.endY
 * @param {number} o.x
 * @param {number} o.z
 * @param {'surface'|'count'|'obstruction'|'failed'} o.stopReason
 * @param {string[]} [o.failReasons]
 * @param {{x:number,y:number,z:number,floor?:string}|null} [o.lateralExit]
 *        sky-exposed surface exit the climb stopped on
 * @param {{x:number,y:number,z:number,floor?:string}|null} [o.sideExit]
 *        best non-surface walkable side cell seen (offered as an alternative)
 * @param {{walls:any[],can_pillar_further:boolean}|null} [o.shaftTrap]
 * @param {boolean} [o.onPillar]   climbed but ended on a 1×1 column (no exit)
 * @param {boolean} [o.forced]     --force was passed
 * @param {number}  [o.forceBypassCount]
 * @returns {{ message:string, nextHint:string|null, blocker:string|null, stoppedEarly:boolean, remaining:number }}
 */
export function describePillarOutcome(o) {
  const {
    verb = 'pillar_up',
    placed, requested, startY, endY, x, z,
    stopReason,
    failReasons = [],
    lateralExit = null,
    sideExit = null,
    shaftTrap = null,
    onPillar = false,
    forced = false,
    forceBypassCount = 0,
  } = o;

  const remaining = Math.max(0, requested - placed);
  const stoppedEarly = stopReason === 'obstruction' || stopReason === 'failed';
  const blocker = stoppedEarly ? classifyPillarBlocker(failReasons) : null;
  const pos = `${x},${endY},${z}`;

  const sideExitHint = (cell) =>
    `step out sideways: mc goto_near ${cell.x} ${cell.y} ${cell.z} 1`;

  const forceTail = forceBypassCount > 0
    ? ` force=true bypassed ${forceBypassCount} protected dig${plural(forceBypassCount)}.`
    : '';

  // ── placed === 0: total failure ───────────────────────────────────────
  if (stopReason === 'failed') {
    const why = blocker === 'no_tool'
      ? 'the overhead block is stone and you have no pickaxe'
      : blocker === 'protected'
        ? 'a protected/region block is overhead'
        : 'headroom is blocked or there was nothing to place';
    let nextHint;
    if (blocker === 'no_tool') {
      nextHint = forced
        ? `craft/equip a pickaxe (mc craft wooden_pickaxe), then mc ${verb} ${requested}`
        : `mc ${verb} ${requested} --force  (slow bare-hand digs through stone), or craft/equip a pickaxe first`;
    } else if (blocker === 'protected') {
      nextHint = `mc ${verb} ${requested} --force only if you must break a protected block to escape`;
    } else {
      nextHint = `mc dig the block overhead, then mc ${verb} ${requested}`;
    }
    if (sideExit) nextHint = `${sideExitHint(sideExit)} — or ${nextHint}`;
    const reasons = failReasons.length ? ` Reasons: ${failReasons.slice(0, 3).join(' | ')}.` : '';
    return {
      message: `${verb} could not place any blocks (Y=${startY}, pos=${pos}) — ${why}.${reasons}`,
      nextHint,
      blocker,
      stoppedEarly: true,
      remaining,
    };
  }

  const base = stoppedEarly
    ? `${verb} climbed ${placed}/${requested} block${plural(requested)}: Y ${startY} → ${endY} (pos ${pos})`
    : `${verb} climbed ${placed} block${plural(placed)}: Y ${startY} → ${endY} (pos ${pos})`;

  // ── stopped early (placed > 0 but short of the requested count) ────────
  if (stoppedEarly) {
    const why = blocker === 'no_tool'
      ? "the ceiling is solid (stone/ore) and you're bare-handed"
      : blocker === 'protected'
        ? 'a protected/region block is overhead'
        : "couldn't clear the overhead block";
    let nextHint;
    if (blocker === 'no_tool') {
      nextHint = forced
        ? `craft/equip a pickaxe (mc craft wooden_pickaxe), then mc ${verb} ${remaining}`
        : `mc ${verb} ${remaining} --force  (slow bare-hand digs through stone), or craft/equip a pickaxe first`;
    } else if (blocker === 'protected') {
      nextHint = `mc ${verb} ${remaining} --force only if you must break a protected block to escape`;
    } else {
      nextHint = `mc dig the block overhead, then mc ${verb} ${remaining}`;
    }
    if (sideExit) nextHint = `${sideExitHint(sideExit)} — or ${nextHint}`;
    return {
      message: `${base} — stopped early: ${why}. Next: ${nextHint}.${forceTail}`,
      nextHint,
      blocker,
      stoppedEarly: true,
      remaining,
    };
  }

  // ── reached a sky-exposed surface via a lateral exit ───────────────────
  if (stopReason === 'surface' && lateralExit) {
    const nextHint = `mc goto_near ${lateralExit.x} ${lateralExit.y} ${lateralExit.z} 1`;
    return {
      message: `${base}. Reached the surface — a walkable, sky-open cell is beside you at ${lateralExit.x},${lateralExit.y},${lateralExit.z}` +
        `${lateralExit.floor ? ` (floor ${lateralExit.floor})` : ''}. Step out: ${nextHint}.${forceTail}`,
      nextHint,
      blocker: null,
      stoppedEarly: false,
      remaining,
    };
  }

  // ── climbed the full count but ended on a 1×1 column ───────────────────
  if (onPillar) {
    const canFurther = shaftTrap ? shaftTrap.can_pillar_further : true;
    const climbMore = canFurther
      ? `mc ${verb} ${Math.max(requested, 4)} to keep climbing (it will dig the ceiling and pillar with the drop`
      : `mc ${verb} ${Math.max(requested, 4)} (it will try to dig the ceiling`;
    const forceNote = (blocker === 'no_tool' || !forced)
      ? '; pass --force if the ceiling is stone and you are bare-handed)'
      : ')';
    const nextHint = sideExit
      ? sideExitHint(sideExit)
      : `${climbMore}${forceNote}, OR mc pillar_down ${placed} to come back down`;
    return {
      message: `${base}. ⚠ On a 1×1 column — pathfinding will refuse with BOT_ON_PILLAR. ` +
        `Get off it: ${sideExit ? `${nextHint}, or mc dig an adjacent wall block.` : `${nextHint}, or mc dig an adjacent wall block to step off sideways.`}${forceTail}`,
      nextHint,
      blocker: null,
      stoppedEarly: false,
      remaining,
    };
  }

  // ── plain full climb, room to walk off ─────────────────────────────────
  return {
    message: `${base}.${forceTail}`,
    nextHint: null,
    blocker: null,
    stoppedEarly: false,
    remaining,
  };
}
