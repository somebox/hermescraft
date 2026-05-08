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
});
