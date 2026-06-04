/**
 * place_named_sign — single-shot place + write + read-back verify.
 *
 * Wraps `mc place` (delegated) + `bot.updateSign` (in-process) with a
 * server-side read-back check. The wax detection path is what makes
 * this verb useful over a manual two-step: a waxed sign accepts the
 * `updateSign` packet silently, so we sleep ~200ms then re-read
 * `block.signText` / `block.signEntity.text`. Mismatch → returns
 * `SIGN_WAX_PROTECTED` so the agent knows the world rejected it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInteractionActions, readSignTextLines, linesMatch } from '../../lib/actions/interaction.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

/**
 * Build a bot stub that can transition the target block from air → sign
 * after the place delegate fires, and lets the test poke the "post-write"
 * sign text via `setSignTextAfterUpdate`.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.afterWriteLines]  what `block.signText` looks
 *   like after `updateSign` returns (defaults to the requested text)
 * @param {boolean} [opts.simulateWax]  if true, `updateSign` succeeds
 *   but the readback returns the original empty lines (wax behavior)
 */
function makeStubBot({ afterWriteLines = null, simulateWax = false } = {}) {
  const state = {
    placed: false,
    written: false,
    currentLines: ['', '', '', ''],  // pre-place; sign has no text yet
  };
  return {
    state,
    bot: {
      entity: { position: { x: 0.5, y: 64, z: 0.5 } },
      inventory: { items: () => [{ name: 'oak_sign', count: 1, slot: 36 }] },
      blockAt: (vec) => {
        const k = `${Math.floor(vec.x)},${Math.floor(vec.y)},${Math.floor(vec.z)}`;
        if (k === '0,64,0') {
          if (!state.placed) return { name: 'air', boundingBox: 'empty' };
          return {
            name: 'oak_sign',
            boundingBox: 'empty',
            signText: state.currentLines.slice(),
          };
        }
        // Support cell so place doesn't choke on missing solid neighbor.
        if (k === '0,63,0') return { name: 'stone', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
      },
      lookAt: async () => {},
      updateSign: async (_block, text) => {
        state.written = true;
        // Wax case: server silently drops update; readback lines stay ''.
        if (simulateWax) return;
        state.currentLines = afterWriteLines ?? text.split('\n').concat(['', '', '', '']).slice(0, 4);
      },
      pathfinder: { goto: async () => {}, setGoal: () => {} },
    },
    markPlaced: () => { state.placed = true; },
  };
}

function servicesWith(bot, placeImpl) {
  const services = createMockServices({
    state: { world: { botReady: true } },
    fairPlay: { hasLineOfSight: () => true, eyePosition: () => ({ x: 0, y: 64, z: 0 }) },
    getActions: () => ({ place: placeImpl }),
  });
  services.ensureBot = () => bot;
  // Speed the test up — drop sleep to a no-op.
  services.utils.sleep = async () => {};
  return services;
}

// ───── readSignTextLines helper

test('readSignTextLines: handles modern block.signText array', () => {
  const block = { signText: ['line1', 'line2', '', ''] };
  assert.deepEqual(readSignTextLines(block), ['line1', 'line2', '', '']);
});

test('readSignTextLines: handles legacy signEntity.text array', () => {
  const block = { signEntity: { text: ['a', 'b'] } };
  assert.deepEqual(readSignTextLines(block), ['a', 'b', '', '']);
});

test('readSignTextLines: handles signEntity.text as newline-joined string', () => {
  const block = { _signEntity: { text: 'one\ntwo' } };
  assert.deepEqual(readSignTextLines(block), ['one', 'two', '', '']);
});

test('readSignTextLines: missing block → 4 empty lines', () => {
  assert.deepEqual(readSignTextLines(null), ['', '', '', '']);
  assert.deepEqual(readSignTextLines({}), ['', '', '', '']);
});

test('linesMatch: same lines (with padding) match', () => {
  assert.equal(linesMatch(['a', 'b', '', ''], ['a', 'b']), true);
});

test('linesMatch: divergent line at index 0 fails', () => {
  assert.equal(linesMatch(['x', '', '', ''], ['a', 'b']), false);
});

// ───── place_named_sign action

test('place_named_sign: missing coords → MISSING_ARGS', async () => {
  const { bot } = makeStubBot();
  const services = servicesWith(bot, async () => ({ ok: true }));
  const actions = createInteractionActions(services);
  const r = await actions.place_named_sign({ text: 'hi' });
  assertFailure(r, { code: 'MISSING_ARGS', retrySafe: false });
});

test('place_named_sign: empty text → MISSING_ARGS', async () => {
  const { bot } = makeStubBot();
  const services = servicesWith(bot, async () => ({ ok: true }));
  const actions = createInteractionActions(services);
  const r = await actions.place_named_sign({ x: 0, y: 64, z: 0, text: '' });
  assertFailure(r, { code: 'MISSING_ARGS', messageIncludes: 'non-empty `text`', retrySafe: false });
});

test('place_named_sign: 5 lines → TOO_MANY_LINES', async () => {
  const { bot } = makeStubBot();
  const services = servicesWith(bot, async () => ({ ok: true }));
  const actions = createInteractionActions(services);
  const r = await actions.place_named_sign({
    x: 0, y: 64, z: 0,
    text: 'a\nb\nc\nd\ne',
  });
  assertFailure(r, { code: 'TOO_MANY_LINES', retrySafe: false });
});

test('place_named_sign: 46-char line → LINE_TOO_LONG', async () => {
  const { bot } = makeStubBot();
  const services = servicesWith(bot, async () => ({ ok: true }));
  const actions = createInteractionActions(services);
  const longLine = 'x'.repeat(46);
  const r = await actions.place_named_sign({ x: 0, y: 64, z: 0, text: longLine });
  assertFailure(r, { code: 'LINE_TOO_LONG', retrySafe: false });
});

test('place_named_sign: bogus variant → MISSING_ARGS', async () => {
  const { bot } = makeStubBot();
  const services = servicesWith(bot, async () => ({ ok: true }));
  const actions = createInteractionActions(services);
  const r = await actions.place_named_sign({
    x: 0, y: 64, z: 0,
    text: 'hi',
    variant: 'cobblestone',
  });
  assertFailure(r, { code: 'MISSING_ARGS', messageIncludes: '_sign', retrySafe: false });
});

test('place_named_sign: place delegation failure propagates', async () => {
  const { bot } = makeStubBot();
  const services = servicesWith(bot, async () => ({
    ok: false,
    error: { code: 'TARGET_OCCUPIED', message: 'occupied', retry_safe: false },
  }));
  const actions = createInteractionActions(services);
  const r = await actions.place_named_sign({ x: 0, y: 64, z: 0, text: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TARGET_OCCUPIED');
});

test('place_named_sign: happy path — write succeeds, readback matches', async () => {
  const harness = makeStubBot();
  const services = servicesWith(harness.bot, async () => {
    harness.markPlaced();
    return { ok: true };
  });
  const actions = createInteractionActions(services);
  const r = await actions.place_named_sign({
    x: 0, y: 64, z: 0,
    text: 'spider hill\ngreat view',
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.variant, 'oak_sign');
  assert.equal(r.data.side, 'front');
  assert.deepEqual(r.data.lines, ['spider hill', 'great view']);
  assert.equal(harness.bot.inventory.items().length >= 0, true);  // sanity
});

test('place_named_sign: waxed sign — readback verify is opt-in via SIGN_READBACK_VERIFY=1', async () => {
  // Phase E (2026-06-04): the readback path is now opt-in because
  // Mineflayer's local block cache doesn't reliably update with the
  // server's sign text on the homelab MC instance — producing a 100%
  // false-positive rate. The verify path still works when the env var
  // is set; this test exercises that branch explicitly.
  const prev = process.env.SIGN_READBACK_VERIFY;
  process.env.SIGN_READBACK_VERIFY = '1';
  try {
    const harness = makeStubBot({ simulateWax: true });
    const services = servicesWith(harness.bot, async () => {
      harness.markPlaced();
      return { ok: true };
    });
    const actions = createInteractionActions(services);
    const r = await actions.place_named_sign({
      x: 0, y: 64, z: 0,
      text: 'spider hill\ngreat view',
    });
    assertFailure(r, {
      code: 'SIGN_WAX_PROTECTED',
      observedKeys: ['requested_lines', 'observed_lines', 'block_name', 'readback_ms'],
      retrySafe: false,
    });
    assert.deepEqual(r.error.observed_state.observed_lines, ['', '', '', '']);
    assert.deepEqual(r.error.observed_state.requested_lines, ['spider hill', 'great view']);
  } finally {
    if (prev === undefined) delete process.env.SIGN_READBACK_VERIFY;
    else process.env.SIGN_READBACK_VERIFY = prev;
  }
});

test('place_named_sign: by default, waxed-style readback failure does NOT block placement (verify is opt-in)', async () => {
  const prev = process.env.SIGN_READBACK_VERIFY;
  delete process.env.SIGN_READBACK_VERIFY;
  try {
    const harness = makeStubBot({ simulateWax: true });
    const services = servicesWith(harness.bot, async () => {
      harness.markPlaced();
      return { ok: true };
    });
    const actions = createInteractionActions(services);
    const r = await actions.place_named_sign({
      x: 0, y: 64, z: 0,
      text: 'spider hill\ngreat view',
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.data.lines, ['spider hill', 'great view']);
  } finally {
    if (prev !== undefined) process.env.SIGN_READBACK_VERIFY = prev;
  }
});

test('place_named_sign: sign block never registers → SIGN_BLOCK_NOT_FOUND', async () => {
  // place returns ok but markPlaced() is never called — blockAt(target)
  // stays at air for the full poll window.
  const { bot } = makeStubBot();
  const services = servicesWith(bot, async () => ({ ok: true }));
  const actions = createInteractionActions(services);
  const r = await actions.place_named_sign({ x: 0, y: 64, z: 0, text: 'hi' });
  assertFailure(r, {
    code: 'SIGN_BLOCK_NOT_FOUND',
    observedKeys: ['observed_block', 'requested_variant'],
    retrySafe: true,
  });
});

test('place_named_sign: getActions().place missing → PLACE_NOT_AVAILABLE', async () => {
  const { bot } = makeStubBot();
  const services = createMockServices({
    state: { world: { botReady: true } },
    ensureBot: () => bot,
    getActions: () => ({}),
  });
  services.utils.sleep = async () => {};
  const actions = createInteractionActions(services);
  const r = await actions.place_named_sign({ x: 0, y: 64, z: 0, text: 'hi' });
  assertFailure(r, { code: 'PLACE_NOT_AVAILABLE', retrySafe: true });
});
