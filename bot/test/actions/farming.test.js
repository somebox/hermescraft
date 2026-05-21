import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHarvestY, isTillableAt, isFarmlandAt } from '../../lib/actions/farming.js';

// ─────────────────────────────────────────────────────────────────────────
// resolveHarvestY — pure function, probes 3 Y levels around the bot's
// foot Y and returns whichever has the most crop blocks in the rect.
//
// Round-A hyd2 trace context: bot at entity.position.y = 63.999...
// just settled on farmland at y=63, wheat at y=64. The old default
// `Math.floor(y)` returned 63 (farmland row) → 0 crops found →
// NOTHING_TO_HARVEST → bot wasted 2 minutes guessing arg forms.
// These tests lock the new auto-detect behaviour.
// ─────────────────────────────────────────────────────────────────────────

function makeBlockMap(crops) {
  // crops: array of {x, y, z, name}. Returns a blockAt probe function.
  const key = (x, y, z) => `${x},${y},${z}`;
  const lookup = new Map();
  for (const c of crops) lookup.set(key(c.x, c.y, c.z), { name: c.name });
  return (p) => lookup.get(key(p.x, p.y, p.z)) || null;
}

test('resolveHarvestY: picks foot Y when wheat is at foot Y exactly', () => {
  // Bot's foot Y is correctly Math.floor'd as 64; wheat is at y=64.
  const blockAt = makeBlockMap([
    { x: 1, y: 64, z: 1, name: 'wheat' },
    { x: 2, y: 64, z: 1, name: 'wheat' },
    { x: 1, y: 64, z: 2, name: 'wheat' },
  ]);
  const r = resolveHarvestY({ minX: 1, maxX: 2, minZ: 1, maxZ: 2, footY: 64, blockAt });
  assert.equal(r.y, 64);
  assert.equal(r.count, 3);
});

test('resolveHarvestY: recovers when float-noise floors footY to one below crop row', () => {
  // hyd2 exact failure: entity.position.y = 63.999..., footY = 63,
  // but wheat is at y=64. Old impl returned 63 → 0 crops.
  // New impl probes 62/63/64 and picks 64.
  const blockAt = makeBlockMap([
    { x: 388, y: 64, z: -568, name: 'wheat' },
    { x: 389, y: 64, z: -568, name: 'wheat' },
    { x: 390, y: 64, z: -568, name: 'wheat' },
    { x: 388, y: 64, z: -567, name: 'wheat' },
    { x: 389, y: 64, z: -567, name: 'wheat' },
  ]);
  const r = resolveHarvestY({
    minX: 388, maxX: 390, minZ: -568, maxZ: -566, footY: 63, blockAt,
  });
  assert.equal(r.y, 64, 'must climb one Y to find the wheat row');
  assert.equal(r.count, 5);
});

test('resolveHarvestY: picks footY-1 when bot pillared one block above the crops', () => {
  // Bot at y=65 looking down at wheat at y=64.
  const blockAt = makeBlockMap([
    { x: 0, y: 64, z: 0, name: 'wheat' },
    { x: 1, y: 64, z: 0, name: 'wheat' },
  ]);
  const r = resolveHarvestY({ minX: 0, maxX: 1, minZ: 0, maxZ: 0, footY: 65, blockAt });
  assert.equal(r.y, 64);
});

test('resolveHarvestY: returns footY with count=0 when no crops anywhere in window', () => {
  // No crops at all — function should return footY, count=0 (so the
  // handler can decide to report NOTHING_TO_HARVEST).
  const blockAt = makeBlockMap([]);
  const r = resolveHarvestY({ minX: 0, maxX: 5, minZ: 0, maxZ: 5, footY: 64, blockAt });
  assert.equal(r.y, 64);
  assert.equal(r.count, 0);
});

test('resolveHarvestY: ignores non-crop blocks (farmland, dirt)', () => {
  // The farmland row at y=63 has 9 dirt/farmland blocks, but those
  // are not in MATURE_AGE. Only the y=64 wheat row counts.
  const blockAt = makeBlockMap([
    { x: 0, y: 63, z: 0, name: 'farmland' },
    { x: 0, y: 63, z: 1, name: 'farmland' },
    { x: 0, y: 64, z: 0, name: 'wheat' },
  ]);
  const r = resolveHarvestY({ minX: 0, maxX: 0, minZ: 0, maxZ: 1, footY: 63, blockAt });
  assert.equal(r.y, 64, 'must pick the wheat row, not the farmland row');
  assert.equal(r.count, 1);
});

test('resolveHarvestY: counts mature AND immature crops the same (age handled later)', () => {
  // resolveHarvestY is purely about WHICH Y the crops are on — the
  // dig pass filters mature vs. immature. So any crop block counts.
  const blockAt = makeBlockMap([
    { x: 0, y: 64, z: 0, name: 'wheat' },     // could be age 0 or 7 — both count
    { x: 0, y: 64, z: 1, name: 'carrots' },
    { x: 0, y: 64, z: 2, name: 'potatoes' },
    { x: 0, y: 64, z: 3, name: 'beetroots' },
  ]);
  const r = resolveHarvestY({ minX: 0, maxX: 0, minZ: 0, maxZ: 3, footY: 64, blockAt });
  assert.equal(r.y, 64);
  assert.equal(r.count, 4);
});

test('resolveHarvestY: ties prefer the first-seen Y (deterministic)', () => {
  // Two Y rows have equal crop counts — implementation uses strict >
  // so the earlier candidate (footY-1) wins. Locks deterministic
  // behaviour so test runs don't flip.
  const blockAt = makeBlockMap([
    { x: 0, y: 63, z: 0, name: 'wheat' },
    { x: 0, y: 64, z: 0, name: 'wheat' },
  ]);
  const r = resolveHarvestY({ minX: 0, maxX: 0, minZ: 0, maxZ: 0, footY: 64, blockAt });
  // footY-1 = 63 evaluated first, count=1; footY=64 count=1 (not >). 63 wins.
  assert.equal(r.y, 63);
});

// ─────────────────────────────────────────────────────────────────────────
// isTillableAt / isFarmlandAt — pure predicate helpers used by
// `mc till` and `mc plant`'s task-#7 self-adjust step. Each just wraps
// a Set/string check + blockAt; defensive tests cover the basics.
// ─────────────────────────────────────────────────────────────────────────

function botFor(blocks) {
  // blocks: { 'x,y,z': { name: 'dirt' } }
  return {
    blockAt(pos) {
      return blocks[`${pos.x},${pos.y},${pos.z}`] || null;
    },
  };
}

test('isTillableAt: dirt / grass_block / coarse_dirt / rooted_dirt / dirt_path return true', () => {
  for (const name of ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'dirt_path']) {
    const b = botFor({ '0,64,0': { name } });
    assert.equal(isTillableAt(b, 0, 64, 0), true, `${name} should be tillable`);
  }
});

test('isTillableAt: stone / farmland / water / null return false', () => {
  const b = botFor({
    '0,64,0': { name: 'stone' },
    '1,64,0': { name: 'farmland' }, // already tilled → not tillable
    '2,64,0': { name: 'water' },
    // 3,64,0 missing → null
  });
  assert.equal(isTillableAt(b, 0, 64, 0), false);
  assert.equal(isTillableAt(b, 1, 64, 0), false);
  assert.equal(isTillableAt(b, 2, 64, 0), false);
  assert.equal(isTillableAt(b, 3, 64, 0), false);
});

test('isTillableAt: defensive on null/undefined bot', () => {
  assert.equal(isTillableAt(null, 0, 64, 0), false);
  assert.equal(isTillableAt(undefined, 0, 64, 0), false);
  assert.equal(isTillableAt({}, 0, 64, 0), false); // missing blockAt
});

test('isFarmlandAt: only farmland returns true', () => {
  const b = botFor({
    '0,64,0': { name: 'farmland' },
    '1,64,0': { name: 'dirt' },
    '2,64,0': { name: 'grass_block' },
  });
  assert.equal(isFarmlandAt(b, 0, 64, 0), true);
  assert.equal(isFarmlandAt(b, 1, 64, 0), false);
  assert.equal(isFarmlandAt(b, 2, 64, 0), false);
  assert.equal(isFarmlandAt(b, 99, 99, 99), false); // null block
});
