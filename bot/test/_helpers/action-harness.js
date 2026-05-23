/**
 * Minimal shared helpers for action contract tests.
 * ADR: docs/design/action-contract.md
 */

import assert from 'node:assert/strict';
import { validate } from '../../lib/shared/action-contract.js';

/**
 * @param {object} [spec]
 * @returns {object} mineflayer-like bot stub
 */
export function makeMockBot(spec = {}) {
  const position = spec.position || { x: 0, y: 64, z: 0 };
  const inventoryItems = spec.inventory || [];
  const blockAtFn = spec.blockAt || (() => ({ name: 'air', boundingBox: 'empty' }));
  const findBlockFn = spec.findBlock || (() => null);
  const pathfinder = spec.pathfinder || {
    goto: async () => {},
    setGoal: () => {},
  };

  return {
    entity: { position: { ...position }, isInWater: false, yaw: 0, pitch: 0 },
    inventory: { items: () => inventoryItems.map((name) => ({ name, count: 1 })) },
    blockAt: (pos) => blockAtFn(pos),
    findBlock: findBlockFn,
    findBlocks: spec.findBlocks || (() => []),
    entities: spec.entities || {},
    pathfinder,
    ...spec.extra,
  };
}

/**
 * @param {unknown} result
 */
export function assertContract(result) {
  const v = validate(result);
  assert.equal(v.valid, true, `contract invalid: ${(v.issues || []).join('; ')}`);
  if (result && typeof result === 'object' && result.ok === false) {
    assert.ok(result.error.message && String(result.error.message).length > 0,
      'error.message must be non-empty');
  }
}

/**
 * @param {object} result
 * @param {object} opts
 * @param {string} opts.code
 * @param {string|string[]} [opts.messageIncludes]
 * @param {string[]} [opts.observedKeys]
 * @param {boolean} [opts.retrySafe]
 */
export function assertFailure(result, opts) {
  assertContract(result);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, opts.code);
  if (opts.messageIncludes) {
    const parts = Array.isArray(opts.messageIncludes) ? opts.messageIncludes : [opts.messageIncludes];
    for (const p of parts) {
      assert.match(result.error.message, new RegExp(p, 'i'), `message should mention ${p}`);
    }
  }
  if (opts.observedKeys) {
    assert.ok(result.error.observed_state, 'expected observed_state');
    for (const key of opts.observedKeys) {
      assert.ok(key in result.error.observed_state, `observed_state.${key} missing`);
    }
  }
  if (opts.retrySafe !== undefined) {
    assert.equal(result.error.retry_safe, opts.retrySafe);
  }
}
