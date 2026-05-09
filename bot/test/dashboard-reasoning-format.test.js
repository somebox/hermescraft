import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardPath = path.resolve(__dirname, '../dashboard.html');
const dashboardSrc = fs.readFileSync(dashboardPath, 'utf8');

test('dashboard defines reason-line formatter', () => {
  assert.match(dashboardSrc, /function formatReasonLine\(v\)/);
  assert.match(dashboardSrc, /JSON\.stringify\(v\)/);
});

test('reasoning and hints use reason-line formatter', () => {
  assert.match(dashboardSrc, /const line = formatReasonLine\(h\);/);
  assert.match(dashboardSrc, /row\.appendChild\(textN\(formatReasonLine\(h\)\)\);/);
  assert.match(dashboardSrc, /formatReasonLine\(a\.error\)\.slice\(0, 220\)/);
});
