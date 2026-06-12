/**
 * Blueprint action + construct/repair NOT_IMPLEMENTED contracts.
 * ADR: docs/reference/bot/handler-contract-adr.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlueprintActions } from '../../lib/actions/blueprints/index.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function blueprintDeps() {
  const services = createMockServices({
    ensureBot: () => ({
      entity: { position: { x: 0, y: 64, z: 0 } },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    }),
  });
  return {
    ctx: services.state,
    config: services.config,
    ensureBot: services.ensureBot,
  };
}

test('blueprint: unknown subcommand → INVALID_ARGS # spec', async () => {
  const actions = createBlueprintActions(blueprintDeps());
  const r = await actions.blueprint({ subcommand: 'nope' });
  assertFailure(r, { code: 'INVALID_ARGS', messageIncludes: 'subcommand', retrySafe: false });
});

test('construct: NOT_IMPLEMENTED with next_action_hint', async () => {
  const actions = createBlueprintActions(blueprintDeps());
  const r = await actions.construct({});
  assertFailure(r, {
    code: 'NOT_IMPLEMENTED',
    messageIncludes: 'construct',
    retrySafe: false,
  });
  assert.match(r.error.next_action_hint, /blueprint verify/i);
});

test('repair: NOT_IMPLEMENTED without target', async () => {
  const actions = createBlueprintActions(blueprintDeps());
  const r = await actions.repair({});
  assertFailure(r, { code: 'NOT_IMPLEMENTED', retrySafe: false });
});
