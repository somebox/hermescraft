import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeAutoRetraceOnStall } from '../../lib/actions/movement/_nav-autoretrace.js';

test('maybeAutoRetraceOnStall runs retrace once per nav attempt', async () => {
  const ctx = {
    runtime: {
      lastDugSteps: { steps: [{ x: 1, y: 64, z: 1 }, { x: 1, y: 63, z: 1 }] },
      navAttempt: {},
    },
  };
  let calls = 0;
  const retrace = async () => {
    calls++;
    return { ok: true, result: 'retraced' };
  };
  const config = { behaviors: { navAutoRetraceOnStall: true } };

  const first = await maybeAutoRetraceOnStall({
    ctx,
    config,
    targetY: 80,
    currentY: 64,
    retrace,
  });
  assert.equal(first?.ok, true);
  assert.equal(calls, 1);
  assert.equal(ctx.runtime.navAttempt.retraceTried, true);

  const second = await maybeAutoRetraceOnStall({
    ctx,
    config,
    targetY: 80,
    currentY: 64,
    retrace,
  });
  assert.equal(second, null);
  assert.equal(calls, 1);
});

test('maybeAutoRetraceOnStall skips when target is not above bot', async () => {
  const ctx = { runtime: { lastDugSteps: { steps: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 63, z: 0 }] } } };
  let calls = 0;
  const out = await maybeAutoRetraceOnStall({
    ctx,
    config: { behaviors: { navAutoRetraceOnStall: true } },
    targetY: 60,
    currentY: 64,
    retrace: async () => {
      calls++;
      return { ok: true };
    },
  });
  assert.equal(out, null);
  assert.equal(calls, 0);
});
