import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMineStore } from '../../lib/runtime/mines/index.js';
import { createMinesActions } from '../../lib/actions/mines/index.js';

function harness(botPos = { x: 0, y: 64, z: 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-mine-act-'));
  const store = createMineStore({ dataDir: dir, world: 'w' });
  const ctx = {
    runtime: { mines: store },
    world: { bot: { entity: { position: { ...botPos } } } },
    config: { mc: { username: 'Tester' } },
  };
  const deps = {
    ctx,
    ensureBot: () => {},
    posObj: (p) => ({ x: p.x, y: p.y, z: p.z }),
  };
  return { actions: createMinesActions(deps), store, ctx };
}

describe('mine verb handlers', () => {
  it('mine_open registers a mine at the bot position', async () => {
    const { actions, store } = harness({ x: 368, y: 57, z: -590 });
    const res = await actions.mine_open({ id: 'iron_north', dir: 'north', target_y: 12, resource: 'iron_ore' });
    assert.equal(res.ok, true);
    const m = store.get('iron_north');
    assert.deepEqual(m.entrances[0].pos, { x: 368, y: 57, z: -590 });
    assert.equal(m.resource, 'iron_ore');
  });

  it('mine_note refuses an unopened mine', async () => {
    const { actions } = harness();
    const res = await actions.mine_note({ id: 'ghost', kind: 'landing' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'MINE_NOT_FOUND');
  });

  it('mine_note drops a frontier at the bot position when no --at given', async () => {
    const { actions, store } = harness({ x: 5, y: 12, z: 30 });
    await actions.mine_open({ id: 'm1' });
    const res = await actions.mine_note({ id: 'm1', kind: 'frontier', dir: 'north', target_y: 12 });
    assert.equal(res.ok, true);
    const p = store.get('m1').points[0];
    assert.equal(p.kind, 'frontier');
    assert.deepEqual(p.pos, { x: 5, y: 12, z: 30 });
    assert.equal(p.dir, 'north');
    assert.equal(p.by, 'Tester');
  });

  it('mine_note rejects an unknown kind', async () => {
    const { actions } = harness();
    await actions.mine_open({ id: 'm1' });
    const res = await actions.mine_note({ id: 'm1', kind: 'wormhole' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_KIND');
  });

  it('mine_show reports open frontiers; mine_status transitions lifecycle', async () => {
    const { actions } = harness();
    await actions.mine_open({ id: 'm1' });
    await actions.mine_note({ id: 'm1', kind: 'frontier', dir: 'east', target_y: 12 });
    const show = await actions.mine_show({ id: 'm1' });
    assert.equal(show.ok, true);
    assert.match(show.result, /1 open frontier/);
    const st = await actions.mine_status({ id: 'm1', status: 'exhausted' });
    assert.equal(st.data.mine.status, 'exhausted');
  });

  it('mine_list sorts nearest-entrance-first with point counts', async () => {
    const { actions } = harness({ x: 0, y: 64, z: 0 });
    await actions.mine_open({ id: 'far', x: 300, y: 60, z: 0 });
    await actions.mine_open({ id: 'near', x: 8, y: 60, z: 0 });
    await actions.mine_note({ id: 'near', kind: 'ore', x: 9, y: 12, z: 0, resource: 'iron_ore' });
    const res = await actions.mine_list({});
    assert.equal(res.data.mines[0].id, 'near');
    assert.equal(res.data.mines[0].point_counts.ore, 1);
  });

  it('mine_resume returns the nearest open frontier with a goto+tunnel', async () => {
    const { actions } = harness({ x: 0, y: 64, z: 0 });
    await actions.mine_open({ id: 'm1' });
    await actions.mine_note({ id: 'm1', kind: 'frontier', x: 40, y: 12, z: 0, dir: 'north', target_y: 12 });
    await actions.mine_note({ id: 'm1', kind: 'frontier', x: 5, y: 12, z: 0, dir: 'east', target_y: 12 });
    const res = await actions.mine_resume({ id: 'm1' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.data.frontier.pos, { x: 5, y: 12, z: 0 }); // nearest by horizontal dist
    assert.equal(res.data.open_frontiers, 2);
    assert.match(res.data.next_actions[0], /goto_near 5 12 0/);
    assert.match(res.data.next_actions[1], /tunnel 5 12 0 east/);
  });

  it('mine_resume fails cleanly when no open frontier exists', async () => {
    const { actions } = harness();
    await actions.mine_open({ id: 'm1' });
    const res = await actions.mine_resume({ id: 'm1' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'NO_OPEN_FRONTIER');
  });

  it('mine_remove requires confirm, then removes', async () => {
    const { actions, store } = harness();
    await actions.mine_open({ id: 'm1' });
    const refused = await actions.mine_remove({ id: 'm1' });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'MISSING_CONFIRM');
    assert.ok(store.get('m1'));
    const done = await actions.mine_remove({ id: 'm1', confirm: true });
    assert.equal(done.ok, true);
    assert.equal(store.get('m1'), null);
  });

  it('mine_reload re-reads the registry from disk', async () => {
    const { actions, store } = harness();
    await actions.mine_open({ id: 'm1' });
    const res = await actions.mine_reload({});
    assert.equal(res.ok, true);
    assert.equal(res.data.count, 1);
  });
});
