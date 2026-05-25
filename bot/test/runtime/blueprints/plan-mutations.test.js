import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adoptWorldCell } from '../../../lib/runtime/blueprints/plan-mutations.js';
import { writePlanAtomic } from '../../../lib/runtime/blueprints/verify.js';

test('adoptWorldCell air removes listed cell', () => {
  const plan = {
    cells: [{ local: [0, 0, 0], block: 'stone' }],
  };
  const footprint = { mode: 'tight', local: { x: [0, 0], y: [0, 0], z: [0, 0] } };
  const anchor = [10, 64, 20];
  adoptWorldCell(plan, footprint, anchor, 10, 64, 20, 'air');
  assert.equal(plan.cells.length, 0);
});

test('writePlanAtomic round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-write-'));
  const fp = path.join(dir, 't-plan.json');
  const plan = { plan_id: 't', cells: [] };
  writePlanAtomic(fp, plan);
  const read = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(read.plan_id, 't');
});
