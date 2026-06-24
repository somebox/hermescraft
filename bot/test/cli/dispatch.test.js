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

  it('mark parses trailing --at X Y Z (canonical form)', () => {
    const def = defOf('mark');
    const built = buildHttpRequest(def, 'mark', ['lt_iron_ne', 'iron vein', '--at', '12', '64', '30']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.name, 'lt_iron_ne');
    assert.equal(body.note, 'iron vein');
    assert.deepEqual(body.at, { x: 12, y: 64, z: 30 });
    assert.equal(body.at_mark, undefined);
  });

  it('mark_update parses trailing --at @MARK and preserves note text', () => {
    const def = defOf('mark_update');
    const built = buildHttpRequest(def, 'mark_update', ['lt_iron_ne', 'refined note', '--at', '@mine_entrance']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.name, 'lt_iron_ne');
    assert.equal(body.note, 'refined note');
    assert.equal(body.at_mark, 'mine_entrance');
    assert.equal(body.at, undefined);
  });

  it('mark still supports leading flags and mixed placement', () => {
    const def = defOf('mark');
    const built = buildHttpRequest(def, 'mark', ['--category', 'resource', 'lt_coal', '--radius', '8', 'coal seam', '--at', '3', '61', '-9']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.name, 'lt_coal');
    assert.equal(body.note, 'coal seam');
    assert.equal(body.category, 'resource');
    assert.equal(body.radius, 8);
    assert.deepEqual(body.at, { x: 3, y: 61, z: -9 });
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

  it('deposit ITEM COUNT MARK X Y Z parses mark before coords', () => {
    const def = defOf('deposit');
    const built = buildHttpRequest(def, 'deposit', ['oak_log', '8', 'chest_wood_test', '96', '65', '53']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.item, 'oak_log');
    assert.equal(body.count, 8);
    assert.equal(body.mark, 'chest_wood_test');
    assert.equal(body.x, 96);
    assert.equal(body.y, 65);
    assert.equal(body.z, 53);
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

  it('task_context set forwards CONSTRUCT plan fields', () => {
    process.env.HERMES_KANBAN_TASK = 't_construct';
    const def = defOf('task_context');
    const built = buildHttpRequest(def, 'task_context', [
      'set',
      'base',
      '--plan',
      'starter_shelter',
      '--level',
      '1',
      '--card-kind',
      'CONSTRUCT',
    ]);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.worksite_region, 'base');
    assert.equal(body.plan, 'starter_shelter');
    assert.equal(body.level, 1);
    assert.equal(body.card_kind, 'CONSTRUCT');
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

  it('checkpoint_respond POST body includes decision and lease_seconds', () => {
    const def = defOf('checkpoint_respond');
    const built = buildHttpRequest(def, 'checkpoint_respond', ['continue', '90']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.decision, 'continue');
    assert.equal(body.lease_seconds, 90);
  });

  it('retrace --trail sets use_trail in POST body', () => {
    const def = defOf('retrace');
    const built = buildHttpRequest(def, 'retrace', ['--trail']);
    assert.equal(built.path, '/action/retrace');
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.use_trail, true);
  });

  // ── verify kinds (Session 5b prep gap 2) ─────────────────────────────

  it('verify at_mark with --near sets mark + near in POST body', () => {
    const def = defOf('verify');
    const built = buildHttpRequest(def, 'verify', ['at_mark', 'field_south', '--near', '3']);
    assert.equal(built.path, '/action/verify');
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.kind, 'at_mark');
    assert.equal(body.mark, 'field_south');
    assert.equal(body.near, 3);
  });

  it('verify at_mark with --block sets mark + block in POST body', () => {
    const def = defOf('verify');
    const built = buildHttpRequest(def, 'verify', ['at_mark', 'water_source', '--block', 'water']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.kind, 'at_mark');
    assert.equal(body.mark, 'water_source');
    assert.equal(body.block, 'water');
  });

  it('verify at_mark from=X,Y,Z sets from in POST body (remote proximity)', () => {
    const def = defOf('verify');
    const built = buildHttpRequest(def, 'verify', ['at_mark', 'field_south', 'from=365,65,-575', '--near', '5']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.kind, 'at_mark');
    assert.equal(body.from, '365,65,-575');
    assert.equal(body.near, 5);
  });

  it('verify at_mark --from X,Y,Z (space form) also sets from', () => {
    const def = defOf('verify');
    const built = buildHttpRequest(def, 'verify', ['at_mark', 'field_south', '--from', '0,64,0']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.from, '0,64,0');
  });

  it('verify at_mark near=N (kw form) sets near', () => {
    const def = defOf('verify');
    const built = buildHttpRequest(def, 'verify', ['at_mark', 'field_south', 'near=4']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.near, 4);
  });

  it('verify at_mark strips colons from mark', () => {
    // Workers often pass `:field_south:` directly from card bodies.
    const def = defOf('verify');
    const built = buildHttpRequest(def, 'verify', ['at_mark', ':field_south:']);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.mark, 'field_south');
  });

  it('verify region_blocks parses six coords + block + min_count', () => {
    const def = defOf('verify');
    const built = buildHttpRequest(def, 'verify', [
      'region_blocks',
      '0', '65', '0',  // corner1
      '8', '65', '8',  // corner2
      'farmland',
      '81',
    ]);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.kind, 'region_blocks');
    assert.deepEqual(body.corner1, { x: 0, y: 65, z: 0 });
    assert.deepEqual(body.corner2, { x: 8, y: 65, z: 8 });
    assert.equal(body.block, 'farmland');
    assert.equal(body.min_count, 81);
  });

  it('verify region_blocks min_count optional', () => {
    const def = defOf('verify');
    const built = buildHttpRequest(def, 'verify', [
      'region_blocks',
      '0', '65', '0',
      '8', '65', '8',
      'farmland',
    ]);
    const body = JSON.parse(built.body || '{}');
    assert.equal(body.block, 'farmland');
    assert.equal(body.min_count, undefined);
  });
});
