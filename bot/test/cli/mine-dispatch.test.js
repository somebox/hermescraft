import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildHttpRequest } from '../../cli/dispatch.mjs';
import { RAW_COMMAND_DEFS } from '../../cli/registry.mjs';

function defOf(name) {
  const d = RAW_COMMAND_DEFS.find((x) => x.name === name);
  assert.ok(d, `missing ${name}`);
  return d;
}
function bodyOf(name, positional) {
  const built = buildHttpRequest(defOf(name), name, positional);
  return { built, body: JSON.parse(built.body || '{}') };
}

describe('mine verb dispatch', () => {
  it('mine_open parses order-tolerant DIR / TARGET_Y / RESOURCE', () => {
    const { built, body } = bodyOf('mine_open', ['iron_north', 'north', '12', 'iron_ore']);
    assert.equal(built.path, '/action/mine_open');
    assert.equal(body.id, 'iron_north');
    assert.equal(body.dir, 'north');
    assert.equal(body.target_y, 12);
    assert.equal(body.resource, 'iron_ore');
  });

  it('mine_open accepts --at X Y Z for a second surface route', () => {
    const { body } = bodyOf('mine_open', ['iron_north', '--at', '368', '57', '-590']);
    assert.equal(body.id, 'iron_north');
    assert.equal(body.x, 368);
    assert.equal(body.y, 57);
    assert.equal(body.z, -590);
  });

  it('mine_note frontier carries dir + target-y', () => {
    const { body } = bodyOf('mine_note', ['iron_north', 'frontier', '--dir', 'north', '--target-y', '12']);
    assert.equal(body.id, 'iron_north');
    assert.equal(body.kind, 'frontier');
    assert.equal(body.dir, 'north');
    assert.equal(body.target_y, 12);
  });

  it('mine_note ore carries resource + qty', () => {
    const { body } = bodyOf('mine_note', ['iron_north', 'ore', '--resource', 'iron_ore', '--qty', '8']);
    assert.equal(body.kind, 'ore');
    assert.equal(body.resource, 'iron_ore');
    assert.equal(body.qty, 8);
  });

  it('mine_note danger carries hazard + sealed flag and --at', () => {
    const { body } = bodyOf('mine_note', ['iron_north', 'danger', '--hazard', 'lava', '--sealed', '--at', '6', '11', '8']);
    assert.equal(body.kind, 'danger');
    assert.equal(body.hazard, 'lava');
    assert.equal(body.sealed, true);
    assert.deepEqual([body.x, body.y, body.z], [6, 11, 8]);
  });

  it('mine_note station collects repeated --tag', () => {
    const { body } = bodyOf('mine_note', ['iron_north', 'station', '--tag', 'furnace', '--tag', 'chest']);
    assert.deepEqual(body.tags, ['furnace', 'chest']);
  });

  it('mine_status parses id + status', () => {
    const { body } = bodyOf('mine_status', ['iron_north', 'exhausted']);
    assert.equal(body.id, 'iron_north');
    assert.equal(body.status, 'exhausted');
  });

  it('mine_list sends an empty body', () => {
    const built = buildHttpRequest(defOf('mine_list'), 'mine_list', []);
    assert.equal(built.path, '/action/mine_list');
    assert.deepEqual(JSON.parse(built.body || '{}'), {});
  });

  it('mine_resume parses the id', () => {
    const { built, body } = bodyOf('mine_resume', ['iron_north']);
    assert.equal(built.path, '/action/mine_resume');
    assert.equal(body.id, 'iron_north');
  });

  it('mine_remove parses id + --confirm', () => {
    const { body } = bodyOf('mine_remove', ['test_mine', '--confirm']);
    assert.equal(body.id, 'test_mine');
    assert.equal(body.confirm, true);
    const { body: b2 } = bodyOf('mine_remove', ['test_mine']);
    assert.equal(b2.confirm, false);
  });

  it('mine_remove without an id throws', () => {
    assert.throws(() => buildHttpRequest(defOf('mine_remove'), 'mine_remove', ['--confirm']), /missing_id/);
  });

  it('mine_reload sends an empty body', () => {
    const built = buildHttpRequest(defOf('mine_reload'), 'mine_reload', []);
    assert.equal(built.path, '/action/mine_reload');
    assert.deepEqual(JSON.parse(built.body || '{}'), {});
  });

  it('mine_open without an id throws a helpful error', () => {
    assert.throws(() => buildHttpRequest(defOf('mine_open'), 'mine_open', []), /missing_id/);
  });

  it('mine_note without a kind throws', () => {
    assert.throws(() => buildHttpRequest(defOf('mine_note'), 'mine_note', ['iron_north']), /missing_args/);
  });
});
