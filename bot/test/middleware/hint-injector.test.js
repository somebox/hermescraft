import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, _resetHintDedupForTests } from '../../lib/server/middleware/hint-injector.js';
import { createMockServices } from '../../lib/server/mock-services.js';

function makeOpenBot() {
  const AIR = new Set(['air', 'cave_air', 'void_air']);
  return {
    entity: { position: { x: 5.5, y: 65, z: 5.5 } },
    blockAt(pos) {
      if (pos.y === 64 && pos.x === 5 && pos.z === 5) return { name: 'grass_block', boundingBox: 'block' };
      if (pos.y === 63) return { name: 'grass_block', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
}

test('hint-injector: leaves result unchanged when next_action_hint already set', () => {
  _resetHintDedupForTests();
  const services = createMockServices({ config: { mc: { username: 'Flint' } } });
  const fail = {
    ok: false,
    error: { code: 'NAV_BLOCKED', message: 'blocked', retry_safe: true, next_action_hint: 'mc goto_near 1 2 3 2' },
  };
  assert.equal(apply(services, {}, 'move', fail), undefined);
});

test('hint-injector: skips non-allowlisted codes', () => {
  _resetHintDedupForTests();
  const services = createMockServices();
  const fail = { ok: false, error: { code: 'OUT_OF_RANGE', message: 'far', retry_safe: false } };
  assert.equal(apply(services, {}, 'move', fail), undefined);
});

test('hint-injector: injects suggested_hint on NAV_BLOCKED move when bot present', () => {
  _resetHintDedupForTests();
  const services = createMockServices({ config: { mc: { username: 'Flint' } } });
  services.state.world.bot = makeOpenBot();
  services.state.world.botReady = true;
  services.locations.load = () => ({ camp: { x: 10, y: 64, z: 10, note: 'camp' } });
  const fail = { ok: false, error: { code: 'NAV_BLOCKED', message: 'no path', retry_safe: true } };
  const out = apply(services, {}, 'move', fail);
  assert.ok(out, 'expected injection');
  assert.ok(typeof out.error.next_action_hint === 'string' && out.error.next_action_hint.length > 0);
});

test('hint-injector: dedups same (profile, action, code) within 60s', () => {
  _resetHintDedupForTests();
  const services = createMockServices({ config: { mc: { username: 'Flint' } } });
  services.state.world.bot = makeOpenBot();
  services.state.world.botReady = true;
  services.locations.load = () => ({ camp: { x: 10, y: 64, z: 10, note: 'camp' } });
  const fail = { ok: false, error: { code: 'NAV_BLOCKED', message: 'no path', retry_safe: true } };
  const first = apply(services, {}, 'move', fail);
  assert.ok(first?.error?.next_action_hint);
  const second = apply(services, {}, 'move', fail);
  assert.equal(second, undefined, 'dedup should suppress second injection');
});

test('hint-injector: playbook_context extends dedup key (phase change is new bucket)', () => {
  _resetHintDedupForTests();
  const services = createMockServices({ config: { mc: { username: 'Flint' } } });
  services.state.world.bot = makeOpenBot();
  services.state.world.botReady = true;
  services.locations.load = () => ({ camp: { x: 10, y: 64, z: 10, note: 'camp' } });
  services.state.runtime.playbook_context = { playbook_id: 'wood.chop_tall_tree', phase: 'approach', card_id: 't1' };
  const fail = { ok: false, error: { code: 'NAV_BLOCKED', message: 'no path', retry_safe: true } };
  assert.ok(apply(services, {}, 'move', fail)?.error?.next_action_hint);
  assert.equal(apply(services, {}, 'move', fail), undefined, 'same phase deduped');
  services.state.runtime.playbook_context.phase = 'chop_loop';
  assert.ok(
    apply(services, {}, 'move', fail)?.error?.next_action_hint,
    'different phase → new dedup bucket',
  );
});

test('hint-injector: dedup is per profile (two bots same failure both get hints)', () => {
  _resetHintDedupForTests();
  const fail = { ok: false, error: { code: 'NAV_BLOCKED', message: 'no path', retry_safe: true } };
  const setup = (username) => {
    const services = createMockServices({ config: { mc: { username } } });
    services.state.world.bot = makeOpenBot();
    services.state.world.botReady = true;
    services.locations.load = () => ({ camp: { x: 10, y: 64, z: 10, note: 'camp' } });
    return services;
  };
  const flint = setup('Flint');
  const mason = setup('Mason');
  assert.ok(apply(flint, {}, 'move', fail)?.error?.next_action_hint, 'Flint first');
  assert.equal(apply(flint, {}, 'move', fail), undefined, 'Flint deduped on repeat');
  assert.ok(apply(mason, {}, 'move', fail)?.error?.next_action_hint, 'Mason not deduped by Flint');
});
