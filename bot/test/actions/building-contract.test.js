/**
 * Building action contract tests.
 * ADR: docs/design/action-contract.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuildingActions } from '../../lib/actions/building.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

test('building.place_fill: AREA_TOO_LARGE returns structured failure # spec', async () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
  };
  const services = createMockServices({
    state: { world: { botReady: true, bot } },
    ensureBot: () => bot,
  });
  const actions = createBuildingActions(services);
  const r = await actions.place_fill({
    block: 'cobblestone',
    x1: 0, y1: 0, z1: 0,
    x2: 20, y2: 20, z2: 20,
  });
  assertFailure(r, {
    code: 'AREA_TOO_LARGE',
    messageIncludes: '500',
    observedKeys: ['requested_volume', 'max_volume'],
    retrySafe: false,
  });
  assert.match(r.error.next_action_hint, /place_fill/i);
});
