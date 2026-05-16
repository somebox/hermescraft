/**
 * F53.2 — Placement-repeat-failure guard.
 *
 * After 2 consecutive identical failed `mc place <BLOCK> X Y Z`, intercept
 * the 3rd attempt and return a structured diagnostic. Triggers on
 * Flint's G21 v4 door-thrash (20+ identical attempts).
 *
 * Pre-middleware:
 *   check(services, body, actionName, meta)
 *     → { intercept: true, response } | { intercept: false }
 *
 * Post-middleware:
 *   recordOutcome(services, body, actionName, result, meta)
 *     mutates ctx.runtime.recentPlaceFailures based on the outcome.
 *
 * Storage: `ctx.runtime.recentPlaceFailures` is a ring buffer (cap 8) of
 * `{ts, target, block, error_code}` entries. 30s decay is applied
 * on every `check()` call.
 */

import { Vec3 } from 'vec3';
import { fail } from '../../shared/action-contract.js';

const FAILURE_TTL_MS = 30_000;
const REPEAT_THRESHOLD = 2; // intercept the (THRESHOLD+1)th attempt
const RING_CAP = 8;

/**
 * @param {{ state: { runtime: { recentPlaceFailures: any[] } }, ensureBot: () => any }} services
 * @param {Record<string, any>} body
 * @param {string} actionName
 * @returns {{ intercept: true, response: any } | { intercept: false }}
 */
export function check(services, body, actionName) {
  if (actionName !== 'place') return { intercept: false };
  const { state } = services;
  if (!state.runtime.recentPlaceFailures) return { intercept: false };

  const tx = Math.floor(Number(body?.x));
  const ty = Math.floor(Number(body?.y));
  const tz = Math.floor(Number(body?.z));
  const blk = String(body?.block || '?');
  if (!Number.isFinite(tx)) return { intercept: false };

  // 30s decay.
  const cutoff = Date.now() - FAILURE_TTL_MS;
  state.runtime.recentPlaceFailures = state.runtime.recentPlaceFailures.filter((f) => f.ts > cutoff);

  const sameTarget = state.runtime.recentPlaceFailures.filter(
    (f) => f.target.x === tx && f.target.y === ty && f.target.z === tz && f.block === blk,
  );
  if (sameTarget.length < REPEAT_THRESHOLD) return { intercept: false };

  // 3rd attempt incoming — observe the current state and intercept.
  let blockAtTarget = null;
  let distance = null;
  let holding = null;
  try {
    const b = services.ensureBot();
    const blk0 = b.blockAt(new Vec3(tx, ty, tz));
    blockAtTarget = blk0 ? blk0.name : 'unknown';
    distance = Number(b.entity.position.distanceTo(new Vec3(tx, ty, tz)).toFixed(2));
    holding = b.heldItem ? b.heldItem.name : 'empty';
  } catch { /* keep nulls */ }

  let suggested = `Try \`mc inspect ${tx} ${ty} ${tz}\` to confirm what's there.`;
  if (blockAtTarget && blockAtTarget !== 'air' && blockAtTarget !== 'cave_air') {
    if (blockAtTarget === blk) {
      suggested = `Block ${blk} is already at ${tx},${ty},${tz} — placement is complete here. Move on.`;
    } else {
      suggested = `Cell ${tx},${ty},${tz} is occupied by ${blockAtTarget}. mc dig it first, or place ${blk} at a different cell.`;
    }
  } else if (distance !== null && distance > 4.5) {
    suggested = `You're ${distance} blocks from the target — too far for placement. mc move closer (distance <= 4.5) then retry.`;
  } else if (holding && holding !== blk) {
    suggested = `You're holding ${holding}, not ${blk}. mc equip ${blk} first, then retry.`;
  }

  const response = fail(
    'PLACEMENT_REPEATED_FAILURE',
    `mc place ${blk} at ${tx},${ty},${tz} has failed ${sameTarget.length} times consecutively. ${suggested}`,
    {
      observed_state: {
        attempted_block: blk,
        attempted_target: { x: tx, y: ty, z: tz },
        block_currently_at_target: blockAtTarget,
        distance_to_target: distance,
        holding,
        last_attempts: sameTarget,
        suggested_action: suggested,
      },
      retry_safe: false,
    },
  );
  return { intercept: true, response };
}

/**
 * Post-action recording. Pushes failure entries to the ring buffer; clears
 * matching entries on success.
 *
 * @param {{ state: { runtime: { recentPlaceFailures: any[] } } }} services
 * @param {Record<string, any>} body
 * @param {string} actionName
 * @param {any} result
 */
export function recordOutcome(services, body, actionName, result) {
  if (actionName !== 'place') return;
  const { state } = services;
  if (!state.runtime.recentPlaceFailures) return;
  const tx = Math.floor(Number(body?.x));
  const ty = Math.floor(Number(body?.y));
  const tz = Math.floor(Number(body?.z));
  const blk = String(body?.block || '?');
  if (!Number.isFinite(tx)) return;

  const softFailure = result && typeof result === 'object' && result.ok === false;
  if (softFailure) {
    state.runtime.recentPlaceFailures.push({
      ts: Date.now(),
      target: { x: tx, y: ty, z: tz },
      block: blk,
      error_code: result.error?.code || 'unknown',
    });
    if (state.runtime.recentPlaceFailures.length > RING_CAP) {
      state.runtime.recentPlaceFailures.shift();
    }
  } else {
    // Success — clear any pending entries for this exact target+block.
    state.runtime.recentPlaceFailures = state.runtime.recentPlaceFailures.filter(
      (f) => !(f.target.x === tx && f.target.y === ty && f.target.z === tz && f.block === blk),
    );
  }
}
