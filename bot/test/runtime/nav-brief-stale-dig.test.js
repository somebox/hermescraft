import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNavBrief, reconcileNavBriefPaths } from '../../lib/runtime/nav-brief.js';

test('reconcile marks move rows stale when refresh cells cross mark coords', () => {
  const ctx = {
    runtime: {
      briefRefreshRequired: { cells: [{ x: 298, y: 64, z: -48 }] },
    },
  };
  const paths = [
    {
      label: 'chest_food',
      verb: 'move',
      args: 'chest_food',
      reachable: true,
      blocked: false,
      suggested: true,
    },
    { label: 'back', verb: 'retrace', args: '--trail', reachable: true, local: true },
  ];
  const out = reconcileNavBriefPaths(ctx, paths, {
    loadLocations: () => ({ chest_food: { x: 298, y: 64, z: -48 } }),
  });
  const chest = out.find((p) => p.label === 'chest_food');
  assert.equal(chest.stale_after_mutation, true);
  assert.equal(chest.blocked, true);
  assert.equal(chest.suggested, false);
});

test('computeNavBrief applies stale crossing before rank', () => {
  const bot = { entity: { position: { x: 276.5, y: 64, z: 78.5 } } };
  const ctx = {
    world: { bot, botReady: true },
    runtime: {
      briefRefreshRequired: { cells: [{ x: 298, y: 64, z: -48 }] },
      navTrail: { crumbs: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 2 }] },
    },
  };
  const result = computeNavBrief(ctx, {
    loadLocations: () => ({
      chest_food: { x: 298, y: 64, z: -48 },
      base_anchor: { x: 305, y: 64, z: -52 },
    }),
    getStandingState: () => ({ classification: 'open', open_dirs: ['n', 's', 'e', 'w'] }),
    getPathTo: () => ({ status: 'success', path: [] }),
    now: () => 4_000_000,
    budgetMs: 500,
  });
  const chest = result.brief.paths.find((p) => p.label === 'chest_food');
  assert.equal(chest?.stale_after_mutation, true);
});
