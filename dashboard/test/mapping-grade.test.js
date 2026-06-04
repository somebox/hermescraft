import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadLastMappingGrade } from '../lib/mapping-grade.js';

describe('loadLastMappingGrade', () => {
  it('returns null when file missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-grade-'));
    assert.equal(loadLastMappingGrade(dir), null);
  });

  it('parses grade JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-grade-'));
    const runtime = path.join(dir, 'data', 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(
      path.join(runtime, 'last-mapping-grade.json'),
      JSON.stringify({ ok: true, poi_count: 8 }),
    );
    const g = loadLastMappingGrade(dir);
    assert.equal(g?.ok, true);
    assert.equal(g?.poi_count, 8);
  });
});
