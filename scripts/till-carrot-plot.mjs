#!/usr/bin/env node
/**
 * One-shot carrot plot prep: verify → till_area (Mason bot).
 *
 * Usage (from repo root, MC profile mason):
 *   node scripts/till-carrot-plot.mjs
 *
 * Env: MC_API_URL / landfolk profile wiring same as `mc` CLI.
 */
import { spawnSync } from 'node:child_process';

const X1 = 365;
const Z1 = -575;
const X2 = 373;
const Z2 = -567;
const WORKSITE = 'wheat1';
const EXPECT_Y = 65;

function mc(args, { json = true } = {}) {
  const cmd = ['mc', ...args, ...(json ? ['--json'] : [])];
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', env: process.env });
  const out = (r.stdout || '') + (r.stderr || '');
  let parsed = null;
  if (json) {
    try {
      parsed = JSON.parse(r.stdout || '{}');
    } catch {
      parsed = { parse_error: true, raw: out.slice(0, 2000) };
    }
  }
  return { exit: r.status ?? 1, out, parsed };
}

console.log('=== till-carrot-plot: verify ===');
const verify = mc([
  'verify_plot', String(X1), String(Z1), String(X2), String(Z2),
  '--worksite', WORKSITE,
  '--expect-y', String(EXPECT_Y),
]);
console.log(verify.out.slice(0, 4000));

if (!verify.parsed?.ok) {
  console.error('\nVerify failed — fix card/region or prep terrain before tilling.');
  console.error('Steward: see task_spec_invalid block reasons in skills/minecraft-steward-survey.md');
  process.exit(verify.exit || 1);
}

console.log('\n=== till-carrot-plot: till_area ===');
const till = mc(['till_area', String(X1), String(Z1), String(X2), String(Z2)]);
console.log(till.out.slice(0, 4000));

const data = till.parsed?.data || till.parsed?.error?.observed_state;
const tilled = data?.tilled ?? 0;
const failed = data?.failed ?? 0;

if (!till.parsed?.ok && tilled === 0) {
  console.error('\ntill_area produced no successes.');
  process.exit(till.exit || 1);
}

console.log(`\nDone: ${tilled} tilled, ${failed} failed (skipped farmland not counted as fail).`);
process.exit(failed > 0 && tilled === 0 ? 1 : 0);
