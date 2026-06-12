import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybookActions } from '../lib/actions/playbooks.js';
import { assertContract } from './_helpers/action-harness.js';
import { dispatchAction } from '../lib/server/middleware/task-lifecycle.js';
import { createMockServices } from '../lib/server/mock-services.js';
import { createBotState } from '../lib/server/state.js';

test('playbook_phase_set requires task_context.card_id (refuse before bind)', async () => {
  const ctx = createBotState();
  const services = createMockServices({ state: ctx });
  const { playbook_phase_set } = createPlaybookActions(services);
  const r = await playbook_phase_set({ playbook_id: 'wood.chop_tall_tree', phase: 'preflight' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TASK_CONTEXT_REQUIRED');
});

test('playbook_phase_set + sync action emits JSONL playbook fields', async () => {
  const ctx = createBotState();
  ctx.runtime.taskContext = { card_id: 't_test', worksite_region: null, expires_at: Date.now() + 60_000, source: 'test' };
  const services = createMockServices({ state: ctx, config: { mc: { username: 'Flint' } } });
  const { playbook_phase_set } = createPlaybookActions(services);
  const set = await playbook_phase_set({ playbook_id: 'wood.chop_tall_tree', phase: 'approach' });
  assert.equal(set.ok, true);
  assert.equal(services.state.runtime.playbook_context.playbook_id, 'wood.chop_tall_tree');
  assert.equal(services.state.runtime.playbook_context.card_id, 't_test');

  const actionRegistry = {
    has: (n) => n === 'status',
    get: (n) => (n === 'status' ? async () => ({ ok: true, result: 'ok' }) : null),
    names: () => ['status'],
  };
  await dispatchAction(services, 'status', {}, {
    mode: 'sync',
    actionRegistry,
    briefState: () => ({}),
    createTaskRecord: () => ({}),
    pushTaskHistoryRecord: () => {},
  });
  assert.equal(services.state.runtime.playbook_context.playbook_id, 'wood.chop_tall_tree');
});

test('playbook_phase_set sub_playbook fields propagate to ctx.runtime', async () => {
  const ctx = createBotState();
  ctx.runtime.taskContext = { card_id: 't_test', worksite_region: null, expires_at: Date.now() + 60_000, source: 'test' };
  const services = createMockServices({ state: ctx, config: { mc: { username: 'Flint' } } });
  const { playbook_phase_set } = createPlaybookActions(services);
  const set = await playbook_phase_set({
    playbook_id: 'wood.chop_tall_tree',
    phase: 'ascend',
    sub_playbook_id: 'pillar_up_safe',
    sub_phase: 'place_then_step',
  });
  assert.equal(set.ok, true);
  const pc = services.state.runtime.playbook_context;
  assert.equal(pc.playbook_id, 'wood.chop_tall_tree');
  assert.equal(pc.phase, 'ascend');
  assert.equal(pc.sub_playbook_id, 'pillar_up_safe');
  assert.equal(pc.sub_phase, 'place_then_step');
});

test('playbook_phase_clear clears runtime playbook_context # spec', async () => {
  const services = createMockServices({ state: createBotState() });
  services.state.runtime.playbook_context = { playbook_id: 'wood.chop_tall_tree', phase: 'approach' };
  const { playbook_phase_clear } = createPlaybookActions(services);
  const r = await playbook_phase_clear();
  assertContract(r);
  assert.equal(r.ok, true);
  assert.equal(services.state.runtime.playbook_context, null);
});
