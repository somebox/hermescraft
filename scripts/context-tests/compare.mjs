#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('Usage: node scripts/context-tests/compare.mjs <baseline.json> <variant.json>');
  process.exit(1);
}

function load(p) {
  return JSON.parse(readFileSync(resolve(p), 'utf8'));
}

const a = load(argv[0]);
const b = load(argv[1]);

const mapA = new Map((a.scenarios || []).map((s) => [s.id, s]));
const rows = [];
for (const sb of b.scenarios || []) {
  const sa = mapA.get(sb.id);
  if (!sa) {
    rows.push({ id: sb.id, note: 'new in variant' });
    continue;
  }
  const prA = sa.pass_rate ?? 0;
  const prB = sb.pass_rate ?? 0;
  const delta = prB - prA;
  const flipped =
    (sa.stable_pass && !sb.stable_pass) || (!sa.stable_pass && sb.stable_pass)
      ? `${sa.stable_pass ? 'stable→unstable' : 'unstable→stable'}`
      : '';
  rows.push({
    id: sb.id,
    pass_rate_a: prA,
    pass_rate_b: prB,
    delta_pp: (delta * 100).toFixed(0),
    flipped,
    judge_a: sa.judge_avg,
    judge_b: sb.judge_avg,
  });
}

const md = [
  '# Context test compare',
  '',
  `Baseline: ${argv[0]}`,
  `Variant:  ${argv[1]}`,
  '',
  '| scenario | pass A | pass B | Δ pp | flip | judge A | judge B |',
  '|----------|--------|--------|------|------|---------|---------|',
  ...rows.map(
    (r) =>
      `| ${r.id} | ${(r.pass_rate_a * 100).toFixed(0)}% | ${(r.pass_rate_b * 100).toFixed(0)}% | ${r.delta_pp} | ${r.flipped || ''} | ${r.judge_a ?? ''} | ${r.judge_b ?? ''} |`,
  ),
].join('\n');

console.log(md);
const outJson = { baseline: argv[0], variant: argv[1], rows };
console.error(JSON.stringify(outJson, null, 2));
