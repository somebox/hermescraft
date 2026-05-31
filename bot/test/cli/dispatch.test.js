import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildHttpRequest } from '../../cli/dispatch.mjs';
import { RAW_COMMAND_DEFS } from '../../cli/registry.mjs';

function defOf(name) {
  const d = RAW_COMMAND_DEFS.find((x) => x.name === name);
  assert.ok(d, `missing ${name}`);
  return d;
}

describe('cli dispatch', () => {
  it('discover POST body includes category and radius (not {})', () => {
    const def = defOf('discover');
    const built = buildHttpRequest(def, 'discover', ['logs', '80']);
    assert.equal(built.method, 'POST');
    assert.equal(built.path, '/action/discover');
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.category, 'logs');
    assert.equal(body.radius, 80);
  });

  it('craft_plan POST body includes item and count', () => {
    const def = defOf('craft_plan');
    const built = buildHttpRequest(def, 'craft_plan', ['oak_planks', '4']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.item, 'oak_planks');
    assert.equal(body.count, 4);
  });

  it('dig_area POST body includes bbox and flags', () => {
    const def = defOf('dig_area');
    const built = buildHttpRequest(def, 'dig_area', ['10', '70', '0', '10', '67', '0', 'false', 'true', 'true']);
    assert.equal(built.method, 'POST');
    assert.equal(built.path, '/action/dig_area');
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.x1, 10);
    assert.equal(body.y1, 70);
    assert.equal(body.z1, 0);
    assert.equal(body.x2, 10);
    assert.equal(body.y2, 67);
    assert.equal(body.z2, 0);
    assert.equal(body.pickup, false);
    assert.equal(body.abort_on_fail, true);
    assert.equal(body.clear_stand, true);
  });

  it('terrain_top POST body includes x, z, radius', () => {
    const def = defOf('terrain_top');
    const built = buildHttpRequest(def, 'terrain_top', ['-12', '48', '8']);
    assert.equal(built.method, 'POST');
    assert.equal(built.path, '/action/terrain_top');
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.x, -12);
    assert.equal(body.z, 48);
    assert.equal(body.radius, 8);
  });

  it('feed_mob --item then target', () => {
    const def = defOf('feed_mob');
    const built = buildHttpRequest(def, 'feed_mob', ['--item', 'wheat', 'cow']);
    assert.equal(built.path, '/action/feed_mob');
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.target, 'cow');
    assert.equal(body.item, 'wheat');
  });

  it('feed_mob target + item as second positional', () => {
    const def = defOf('feed_mob');
    const built = buildHttpRequest(def, 'feed_mob', ['chicken', 'wheat_seeds']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.target, 'chicken');
    assert.equal(body.item, 'wheat_seeds');
  });

  it('feed_mob target only omits item in body', () => {
    const def = defOf('feed_mob');
    const built = buildHttpRequest(def, 'feed_mob', ['chicken']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.target, 'chicken');
    assert.equal('item' in body, false);
  });

  it('terrain_top defaults radius to 0 when omitted', () => {
    const def = defOf('terrain_top');
    const built = buildHttpRequest(def, 'terrain_top', ['1', '2']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.radius, 0);
  });

  it('remind parses note and interval', () => {
    const def = defOf('remind');
    const built = buildHttpRequest(def, 'remind', ['check wheat farm', '15']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.note, 'check wheat farm');
    assert.equal(body.interval_minutes, '15');
  });

  it('remind with --mark flag', () => {
    const def = defOf('remind');
    const built = buildHttpRequest(def, 'remind', ['restock food', '20', '--mark', 'wheat_farm']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.note, 'restock food');
    assert.equal(body.interval_minutes, '20');
    assert.equal(body.mark, 'wheat_farm');
  });

  it('unremind parses id', () => {
    const def = defOf('unremind');
    const built = buildHttpRequest(def, 'unremind', ['3']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.id, '3');
  });

  it('deposit ITEM COUNT X Y Z parses correctly', () => {
    const def = defOf('deposit');
    const built = buildHttpRequest(def, 'deposit', ['oak_log', '27', '364', '65', '-597']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.item, 'oak_log');
    assert.equal(body.count, 27);
    assert.equal(body.x, 364);
    assert.equal(body.y, 65);
    assert.equal(body.z, -597);
  });

  it('deposit ITEM COUNT MARK (no @) parses correctly', () => {
    const def = defOf('deposit');
    const built = buildHttpRequest(def, 'deposit', ['oak_log', '27', 'materials_chest']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.item, 'oak_log');
    assert.equal(body.count, 27);
    assert.equal(body.mark, 'materials_chest');
  });

  it('deposit ITEM @MARK parses correctly', () => {
    const def = defOf('deposit');
    const built = buildHttpRequest(def, 'deposit', ['oak_log', '@materials_chest']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.item, 'oak_log');
    assert.equal(body.count, 0);
    assert.equal(body.mark, 'materials_chest');
  });

  it('deposit ITEM COUNT (no location) parses correctly', () => {
    const def = defOf('deposit');
    const built = buildHttpRequest(def, 'deposit', ['oak_log', '16']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.item, 'oak_log');
    assert.equal(body.count, 16);
    assert.equal(body.x, undefined);
    assert.equal(body.mark, undefined);
  });

  it('withdraw ITEM COUNT X Y Z parses correctly', () => {
    const def = defOf('withdraw');
    const built = buildHttpRequest(def, 'withdraw', ['iron_ingot', '5', '100', '64', '-200']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.item, 'iron_ingot');
    assert.equal(body.count, 5);
    assert.equal(body.x, 100);
    assert.equal(body.y, 64);
    assert.equal(body.z, -200);
  });

  it('regions --at comma form', () => {
    const def = defOf('regions');
    const built = buildHttpRequest(def, 'regions', ['--at', '350,64,-540']);
    assert.equal(built.method, 'GET');
    assert.equal(built.path, '/regions?at=350%2C64%2C-540');
  });

  it('regions --at space-separated form', () => {
    const def = defOf('regions');
    const built = buildHttpRequest(def, 'regions', ['--at', '1', '2', '3']);
    assert.equal(built.path, '/regions?at=1%2C2%2C3');
  });

  it('mc goto :base1:/tower routes to go_site', () => {
    const def = defOf('goto');
    const built = buildHttpRequest(def, 'goto', [':base1:/tower']);
    assert.equal(built.method, 'POST');
    assert.equal(built.path, '/action/go_site');
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.ref, ':base1:/tower');
  });

  it('task_context show → GET /task-context', () => {
    const def = defOf('task_context');
    const built = buildHttpRequest(def, 'task_context', ['show']);
    assert.equal(built.method, 'GET');
    assert.equal(built.path, '/task-context');
    assert.equal(built.body, null);
  });

  it('task_context clear → DELETE /task-context', () => {
    const def = defOf('task_context');
    const built = buildHttpRequest(def, 'task_context', ['clear']);
    assert.equal(built.method, 'DELETE');
    assert.equal(built.path, '/task-context');
  });

  it('task_context set posts body with card and worksite', () => {
    const prev = process.env.HERMES_KANBAN_TASK;
    process.env.HERMES_KANBAN_TASK = 't_card1';
    try {
      const def = defOf('task_context');
      const built = buildHttpRequest(def, 'task_context', ['set', 'hut3', '--expires-min', '10']);
      assert.equal(built.method, 'POST');
      assert.equal(built.path, '/task-context');
      const body = JSON.parse(built.body || '{}');
      assert.equal(body.card_id, 't_card1');
      assert.equal(body.worksite_region, 'hut3');
      assert.equal(body.source, 'cli');
      assert.ok(Number.isFinite(body.expires_at_ms));
    } finally {
      if (prev === undefined) delete process.env.HERMES_KANBAN_TASK;
      else process.env.HERMES_KANBAN_TASK = prev;
    }
  });

  it('task_context set: worksite before --card (registry example order)', () => {
    const prev = process.env.HERMES_KANBAN_TASK;
    delete process.env.HERMES_KANBAN_TASK;
    try {
      const def = defOf('task_context');
      const built = buildHttpRequest(def, 'task_context', ['set', 'hut1', '--card', 't_test']);
      const body = JSON.parse(built.body || '{}');
      assert.equal(body.card_id, 't_test');
      assert.equal(body.worksite_region, 'hut1');
    } finally {
      if (prev === undefined) delete process.env.HERMES_KANBAN_TASK;
      else process.env.HERMES_KANBAN_TASK = prev;
    }
  });

  it('task_context set: flags before worksite still works', () => {
    delete process.env.HERMES_KANBAN_TASK;
    const def = defOf('task_context');
    const built = buildHttpRequest(def, 'task_context', ['set', '--card', 't_test', 'hut1']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.card_id, 't_test');
    assert.equal(body.worksite_region, 'hut1');
  });

  it('task_context set: card only (--card without worksite)', () => {
    delete process.env.HERMES_KANBAN_TASK;
    const def = defOf('task_context');
    const built = buildHttpRequest(def, 'task_context', ['set', '--card', 't_test']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.card_id, 't_test');
    assert.equal(body.worksite_region, undefined);
  });

  it('task_context set fails without card id', () => {
    const prev = process.env.HERMES_KANBAN_TASK;
    delete process.env.HERMES_KANBAN_TASK;
    try {
      const def = defOf('task_context');
      assert.throws(
        () => buildHttpRequest(def, 'task_context', ['set', 'hut3']),
        /missing_card_id/,
      );
    } finally {
      if (prev === undefined) delete process.env.HERMES_KANBAN_TASK;
      else process.env.HERMES_KANBAN_TASK = prev;
    }
  });

  it('playbook phase set with --sub-playbook and --sub-phase', () => {
    const def = defOf('playbook');
    const built = buildHttpRequest(def, 'playbook', [
      'phase',
      'set',
      '--sub-playbook',
      'pillar_up_safe',
      '--sub-phase',
      'place_then_step',
      'wood.chop_tall_tree',
      'ascend',
    ]);
    assert.equal(built.method, 'POST');
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.playbook_id, 'wood.chop_tall_tree');
    assert.equal(body.phase, 'ascend');
    assert.equal(body.sub_playbook_id, 'pillar_up_safe');
    assert.equal(body.sub_phase, 'place_then_step');
  });

  it('verify_plot parses rect, worksite, expect-y', () => {
    const def = defOf('verify_plot');
    const built = buildHttpRequest(def, 'verify_plot', [
      '365', '-575', '373', '-567', '--worksite', 'wheat1', '--expect-y', '65',
    ]);
    assert.equal(built.method, 'POST');
    assert.equal(built.path, '/action/verify_plot');
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.x1, 365);
    assert.equal(body.worksite, 'wheat1');
    assert.equal(body.expect_y, 65);
  });

  it('retrace --trail sets use_trail in POST body', () => {
    const def = defOf('retrace');
    const built = buildHttpRequest(def, 'retrace', ['--trail']);
    assert.equal(built.path, '/action/retrace');
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.use_trail, true);
  });
});
