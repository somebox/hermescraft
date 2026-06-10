import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RAW_COMMAND_DEFS, buildAliasMap, resolveCommand, suggestCommands } from '../../cli/registry.mjs';

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

  // proc-nav-1781014144: agents discovered verbs by failure — `mc reachabl`
  // and `mc chest_search` exited 2 with no pointer to the real verb. The
  // suggestions below feed resolveToken's "did you mean" tail.
  describe('suggestCommands (unknown-verb suggestions)', () => {
    const m = buildAliasMap();

    it('typo within edit distance → canonical name suggested', () => {
      const sugg = suggestCommands('reachabl', m);
      assert.ok(sugg.includes('reachable'), `expected reachable in ${JSON.stringify(sugg)}`);
    });

    it('shared prefix → family suggested (chest_search → chest_*)', () => {
      const sugg = suggestCommands('chest_search', m);
      assert.ok(sugg.length > 0, 'expected at least one suggestion');
      assert.ok(sugg.some((s) => s.startsWith('chest')), `expected a chest_* verb in ${JSON.stringify(sugg)}`);
    });

    it('suggestions are deduped canonical names, max 3', () => {
      const sugg = suggestCommands('got', m);
      assert.ok(sugg.length <= 3);
      assert.equal(new Set(sugg).size, sugg.length, 'duplicates leaked');
      for (const s of sugg) {
        assert.equal(m[s]?.canonicalName, s, `${s} is not a canonical name`);
      }
    });

    it('gibberish → no suggestions', () => {
      assert.deepEqual(suggestCommands('zzqxywv_kkjj', m), []);
    });
  });

  // Cap text must match code constants (terrain.js caps 16 columns for
  // level/level_ground since 2026-05-27; dig_pit caps 32 blocks). Stale
  // "256 columns" help text sent agents into guaranteed-failure calls.
  describe('cap text in descriptions matches code caps', () => {
    function def(name) {
      const d = RAW_COMMAND_DEFS.find((x) => x.name === name);
      assert.ok(d, `${name} must be registered`);
      return d;
    }

    it('level mentions the 16-column cap and splitting', () => {
      assert.match(def('level').description, /16 columns/);
      assert.match(def('level').description, /split/i);
    });

    it('level_ground mentions the 16-column cap and splitting', () => {
      assert.match(def('level_ground').description, /16 columns/);
      assert.match(def('level_ground').description, /split/i);
    });

    it('dig_pit mentions the 32-block cap', () => {
      assert.match(def('dig_pit').description, /32 blocks/);
    });

    it('no description still claims 256 columns', () => {
      for (const d of RAW_COMMAND_DEFS) {
        assert.ok(!/256 columns/.test(d.description || ''), `${d.name} still says 256 columns`);
      }
    });
  });

  // mc feedback — tooling-friction capture (proc-nav-1781014144). Fast
  // append-only verb; must never be a long-action path.
  describe('feedback command', () => {
    it('is registered as POST /action/feedback with required note', () => {
      const d = RAW_COMMAND_DEFS.find((x) => x.name === 'feedback');
      assert.ok(d, 'feedback must be registered');
      assert.equal(d.method, 'POST');
      assert.equal(d.path, '/action/feedback');
      const note = (d.argSchema || []).find((a) => a.key === 'note');
      assert.ok(note?.required, 'note arg must be required');
      assert.ok((d.argSchema || []).some((a) => a.key === 'tag'), 'tag arg must exist');
      const body = JSON.parse(d.bodyFn({ note: 'n', tag: 't' }));
      assert.deepEqual(body, { note: 'n', tag: 't' });
    });
  });
});
