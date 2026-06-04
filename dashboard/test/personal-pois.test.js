/**
 * Personal POI aggregator — cross-bot dedupe semantics.
 *
 * The dashboard route `/api/personal-pois` fans out `GET /personal-pois`
 * to every assignable bot, tags each entry with the observing agent,
 * and collapses duplicates (same world + name) to a single row, keeping
 * whichever observation has the freshest `last_seen`. This test pins
 * that aggregation logic via the exported `dedupePersonalPois` helper.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { dedupePersonalPois } from '../lib/personal-pois.js';

test('dedupePersonalPois: collapses by (world, name); newest last_seen wins', () => {
  const rows = [
    {
      world: 'proc-lab', name: 'spider_hill',
      x: 100, y: 70, z: 50,
      last_seen: '2026-06-04T01:00:00Z',
      observed_by: 'flint', agent_owner: 'flint',
    },
    {
      world: 'proc-lab', name: 'spider_hill',
      x: 101, y: 71, z: 51,
      last_seen: '2026-06-04T02:30:00Z',  // fresher
      observed_by: 'mason', agent_owner: 'mason',
    },
    {
      world: 'proc-lab', name: 'balder_ruins',
      x: -40, y: 68, z: 80,
      last_seen: '2026-06-04T00:15:00Z',
      observed_by: 'gatherer', agent_owner: 'gatherer',
    },
  ];
  const out = dedupePersonalPois(rows);
  // 2 distinct (world, name) keys
  assert.equal(out.length, 2);
  const hill = out.find((p) => p.name === 'spider_hill');
  assert.equal(hill.observed_by, 'mason');  // fresher row wins
  assert.equal(hill.x, 101);
  const ruins = out.find((p) => p.name === 'balder_ruins');
  assert.equal(ruins.observed_by, 'gatherer');
});

test('dedupePersonalPois: same name in different worlds is NOT collapsed', () => {
  const rows = [
    { world: 'proc-lab', name: 'shrine', x: 0, y: 64, z: 0, last_seen: '2026-06-04T01:00:00Z' },
    { world: 'campaign', name: 'shrine', x: 0, y: 64, z: 0, last_seen: '2026-06-04T01:00:00Z' },
  ];
  const out = dedupePersonalPois(rows);
  assert.equal(out.length, 2);
});

test('dedupePersonalPois: missing last_seen falls back to added_at', () => {
  const rows = [
    {
      world: 'proc-lab', name: 'hilltop_w',
      x: 50, y: 80, z: 0,
      added_at: '2026-06-04T03:00:00Z',
      observed_by: 'flint',
      // no last_seen
    },
    {
      world: 'proc-lab', name: 'hilltop_w',
      x: 51, y: 80, z: 0,
      added_at: '2026-06-04T01:00:00Z',
      observed_by: 'mason',
    },
  ];
  const out = dedupePersonalPois(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].observed_by, 'flint');  // newest added_at wins
});

test('dedupePersonalPois: tolerates undefined timestamps (deterministic fallback)', () => {
  // When both rows lack timestamps, the comparison is 0 vs 0; the
  // earlier-arriving row wins (Map.set semantics). This isn't a
  // documented contract — just confirm the dedupe doesn't throw.
  const rows = [
    { world: 'proc-lab', name: 'mystery', x: 0, y: 64, z: 0, observed_by: 'flint' },
    { world: 'proc-lab', name: 'mystery', x: 1, y: 64, z: 1, observed_by: 'mason' },
  ];
  const out = dedupePersonalPois(rows);
  assert.equal(out.length, 1);
  // Both candidates have ts=0, so neither replaces the first — flint wins.
  assert.equal(out[0].observed_by, 'flint');
});

test('dedupePersonalPois: empty input returns empty array', () => {
  assert.deepEqual(dedupePersonalPois([]), []);
});
