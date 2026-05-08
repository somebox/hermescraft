import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RAW_COMMAND_DEFS, buildAliasMap, resolveCommand } from '../../cli/registry.mjs';

describe('cli registry', () => {
  it('buildAliasMap has predictable keys and resolves aliases', () => {
    assert.doesNotThrow(() => buildAliasMap());
    const m = buildAliasMap();
    assert.ok(m.goto);
    assert.equal(m.goto.canonicalName, 'goto');
    assert.equal(m.go?.canonicalName, 'goto');
    assert.ok(m.cmds);
    assert.equal(m.cmds.canonicalName, 'cmds');

    assert.equal(m.dig_area?.canonicalName, 'dig_area');
    assert.equal(m.da?.canonicalName, 'dig_area');
    assert.equal(m.clear_area?.canonicalName, 'dig_area');
    assert.equal(m.terrain_top?.canonicalName, 'terrain_top');
    assert.equal(m.ttop?.canonicalName, 'terrain_top');
    assert.equal(m.surface_y?.canonicalName, 'terrain_top');

    assert.equal(resolveCommand('feed', m)?.canonicalName, 'feed_mob');
    assert.equal(resolveCommand('feed_mob', m)?.canonicalName, 'feed_mob');

    assert.equal(resolveCommand('remind', m)?.canonicalName, 'remind');
    assert.equal(resolveCommand('reminders', m)?.canonicalName, 'reminders');
    assert.equal(resolveCommand('list_reminders', m)?.canonicalName, 'reminders');
    assert.equal(resolveCommand('unremind', m)?.canonicalName, 'unremind');
    assert.equal(resolveCommand('rm_remind', m)?.canonicalName, 'unremind');

    assert.equal(resolveCommand('goto', m)?.canonicalName, 'goto');
    assert.strictEqual(resolveCommand('not-a-real-cmd-ever', m), null);
  });

  it('RAW_COMMAND_DEFS names are unique per command identity', () => {
    const seen = new Set();
    for (const d of RAW_COMMAND_DEFS) {
      assert.equal(seen.has(d.name), false, `duplicate def name ${d.name}`);
      seen.add(d.name);
    }
  });
});
