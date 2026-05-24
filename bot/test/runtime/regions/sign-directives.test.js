import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRegionSignText, regionRowFromSign } from '../../../lib/runtime/regions/sign-directives.js';

test('parseRegionSignText reads profile and sites', () => {
  const text = `:base1: main
region=base
r=24
site:tower=10,70,-5`;
  const parsed = parseRegionSignText(text);
  assert.equal(parsed.id, 'base1');
  assert.equal(parsed.directives.region, 'base');
  assert.equal(parsed.directives.r, '24');
  assert.deepEqual(parsed.sites.tower, { x: 10, y: 70, z: -5 });
  const row = regionRowFromSign({ ...parsed, id: 'base1' }, { x: 8, y: 64, z: -5 });
  assert.equal(row.profile, 'base');
  assert.equal(row.shape.radius, 24);
  assert.equal(row.status, 'active');
});
