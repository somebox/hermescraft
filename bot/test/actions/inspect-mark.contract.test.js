/**
 * mc inspect --mark contract (W1 remediation).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { createInspectQueries } from '../../lib/actions/queries/inspect.js';
import { createFarmingActions } from '../../lib/actions/farming.js';
import { buildHttpRequest } from '../../cli/dispatch.mjs';
import { resolveCommand, buildAliasMap } from '../../cli/registry.mjs';

const ALIAS = buildAliasMap();

function inspectServices(locs) {
  const bot = {
    entity: { position: new Vec3(0, 65, 0) },
    entities: [],
    blockAt: () => ({ name: 'dirt', hardness: 0.5, boundingBox: 'block' }),
  };
  return {
    ctx: {},
    ensureBot: () => bot,
    locations: { load: () => locs },
  };
}

test('inspect --mark resolves coords from locations', async () => {
  const { inspect } = createInspectQueries(
    inspectServices({ wheat_plot: { x: -50, y: 64, z: 50 } }),
  );
  const r = await inspect({ mark: 'wheat_plot' });
  assert.equal(r.ok, true);
  assert.equal(r.data.mark, 'wheat_plot');
  assert.deepEqual(r.data.coord, { x: -50, y: 64, z: 50 });
});

test('inspect unknown mark → UNKNOWN_MARK', async () => {
  const { inspect } = createInspectQueries(inspectServices({}));
  const r = await inspect({ mark: 'missing' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNKNOWN_MARK');
});

test('farm_status --mark builds 9×9 rect', async () => {
  const bot = {
    entity: { position: new Vec3(0, 65, 0) },
    blockAt: () => ({ name: 'dirt' }),
  };
  const actions = createFarmingActions({
    ctx: {},
    ensureBot: () => bot,
    loadLocations: () => ({ wheat_plot: { x: -50, y: 64, z: 50 } }),
    goals: {},
    sleep: async () => {},
    posObj: () => ({}),
    log: () => {},
    getMyName: () => 'Mox',
    ACTIONS: {},
  });
  const r = await actions.farm_status({ mark: 'wheat_plot', size: 9 });
  assert.equal(r.ok, true);
  assert.equal(r.data.column_count, 81);
});

test('CLI dispatch: inspect --mark', () => {
  const { def } = resolveCommand('inspect', ALIAS);
  const built = buildHttpRequest(def, 'inspect', ['--mark', 'wheat_plot']);
  const body = JSON.parse(built.body || '{}');
  assert.equal(body.mark, 'wheat_plot');
});

test('CLI dispatch: farm_status --mark', () => {
  const { def } = resolveCommand('farm_status', ALIAS);
  const built = buildHttpRequest(def, 'farm_status', ['--mark', 'wheat_plot', '--size', '9']);
  const body = JSON.parse(built.body || '{}');
  assert.equal(body.mark, 'wheat_plot');
  assert.equal(body.size, 9);
});
