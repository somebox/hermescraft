import test from 'node:test';
import assert from 'node:assert/strict';

import { createNavigateToTarget } from '../../lib/actions/movement/navigate-to-target.js';
import { navBriefLineKey } from '../../lib/runtime/nav-brief.js';

test('navigateToTarget records negative leg when marked move fails', async () => {
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  const navigateToTarget = createNavigateToTarget({
    ctx,
    config: { behaviors: { navMoveResolve: true } },
    move: async () => ({ ok: false, error: { code: 'NAV_BLOCKED', message: 'blocked' } }),
    goto: async () => ({ ok: true }),
    goto_near: async () => ({ ok: true }),
  });

  const r = await navigateToTarget({ x: 1, y: 64, z: 2, mark: 'chest_food' });
  assert.equal(r.ok, false);
  assert.ok(ctx.runtime.navBriefNegativeLegs[navBriefLineKey({ verb: 'move', args: 'chest_food' })]);
});

test('navigateToTarget does not record negative leg on success', async () => {
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  const navigateToTarget = createNavigateToTarget({
    ctx,
    config: { behaviors: { navMoveResolve: true } },
    move: async () => ({ ok: true, data: {} }),
    goto: async () => ({ ok: true }),
    goto_near: async () => ({ ok: true }),
  });

  await navigateToTarget({ x: 1, y: 64, z: 2, mark: 'chest_food' });
  assert.equal(Object.keys(ctx.runtime.navBriefNegativeLegs).length, 0);
});

test('navigateToTarget raw goto_near failure records negative leg for mark', async () => {
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  const navigateToTarget = createNavigateToTarget({
    ctx,
    config: { behaviors: { navMoveResolve: true } },
    move: async () => ({ ok: true }),
    goto: async () => ({ ok: true }),
    goto_near: async () => ({ ok: false, error: { code: 'NAV_BLOCKED' } }),
  });

  await navigateToTarget({ x: 10, y: 64, z: 5, near: 2, raw: true, mark: 'base_anchor' });
  assert.ok(ctx.runtime.navBriefNegativeLegs[navBriefLineKey({ verb: 'move', args: 'base_anchor' })]);
});

test('navigateToTarget go_mark-shaped call records negative leg on goto_near failure', async () => {
  const ctx = { runtime: { navBriefNegativeLegs: {} } };
  let gotoNearCalls = 0;
  const navigateToTarget = createNavigateToTarget({
    ctx,
    config: { behaviors: { navMoveResolve: true } },
    move: async () => ({ ok: true }),
    goto: async () => ({ ok: true }),
    goto_near: async () => {
      gotoNearCalls++;
      return { ok: false, error: { code: 'NAV_BLOCKED', message: 'no path' } };
    },
  });

  const r = await navigateToTarget({ x: 10, y: 64, z: 5, near: 2, mark: 'base_anchor' });
  assert.equal(r.ok, false);
  assert.equal(gotoNearCalls, 1);
  const keys = Object.keys(ctx.runtime.navBriefNegativeLegs);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], navBriefLineKey({ verb: 'move', args: 'base_anchor' }));
});
