#!/usr/bin/env node
/**
 * Lint repo conventions documented in docs/patterns.md.
 *
 * Run:    node scripts/check-conventions.mjs
 * Exit:   0 if all checks pass, 1 otherwise.
 *
 * Each check returns an array of violations { file, line, message }.
 * Add new checks at the bottom of the file as new patterns become
 * detectable.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, predicate) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, predicate));
    else if (predicate(full)) out.push(full);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// P3: every registry command has a description.
// ─────────────────────────────────────────────────────────────────────
async function checkRegistryDescriptions() {
  const violations = [];
  const m = await import(join(ROOT, 'bot/cli/registry.mjs'));
  for (const cmd of m.RAW_COMMAND_DEFS) {
    if (!cmd.description) {
      violations.push({
        file: 'bot/cli/registry.mjs',
        line: null,
        message: `command "${cmd.name}" has no description (P3 — discoverability)`,
      });
    }
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────
// P4 / P5: fixtures cleanup uses safe-home tp, not mvtp to world.
// ─────────────────────────────────────────────────────────────────────
function checkFixtureSafeHome() {
  const violations = [];
  const fixtures = walk(join(ROOT, 'data/test-fixtures'), (f) => f.endsWith('.yaml'));
  for (const path of fixtures) {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    // Look for `mvtp Flint world` in cleanup section.
    let inCleanup = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^cleanup:\s*$/.test(line.trim())) inCleanup = true;
      else if (/^\w+:\s*$/.test(line.trim())) inCleanup = false;
      if (inCleanup && /mvtp Flint world\b/.test(line)) {
        violations.push({
          file: relative(ROOT, path),
          line: i + 1,
          message: `cleanup uses 'mvtp Flint world' — should be 'execute in landfolk-test run tp Flint 52 65 52' (P4 — safe-home)`,
        });
      }
    }
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────
// P4: every fixture declares world as landfolk-test (or has a clear reason
// not to). Allow fixtures whose world is not "production" overworld.
// ─────────────────────────────────────────────────────────────────────
function checkFixtureWorld() {
  const violations = [];
  const fixtures = walk(join(ROOT, 'data/test-fixtures'), (f) => f.endsWith('.yaml'));
  for (const path of fixtures) {
    const text = readFileSync(path, 'utf8');
    const m = text.match(/^world:\s*(\S+)/m);
    if (!m) {
      violations.push({
        file: relative(ROOT, path),
        line: null,
        message: `no 'world:' declared (P4 — fixtures should run in landfolk-test)`,
      });
    } else if (m[1] !== 'landfolk-test') {
      // Allow alternates only if the comment block above explains why.
      // Soft warning, not hard fail.
      violations.push({
        file: relative(ROOT, path),
        line: null,
        message: `world is '${m[1]}', not 'landfolk-test' (P4 — verify this is intentional)`,
        soft: true,
      });
    }
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────
// P4: combat fixtures tag spawned mobs with Tags:["target"] so suite
// runners can count them.
// ─────────────────────────────────────────────────────────────────────
function checkCombatTargetTags() {
  const violations = [];
  // Combat fixtures: L3.6x, L3.7x. Excluding agent-driven ones the suite skips.
  const AGENT_DRIVEN = ['L3.63', 'L3.65', 'L3.68'];
  const dir = join(ROOT, 'data/test-fixtures/L3');
  if (!statSync(dir, { throwIfNoEntry: false })) return violations;
  for (const name of readdirSync(dir)) {
    if (!/^L3\.(6|7)\d/.test(name)) continue;
    if (AGENT_DRIVEN.some((a) => name.startsWith(a))) continue;
    const path = join(dir, name);
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Lines that summon mobs but lack target tag
      if (/summon minecraft:(zombie|skeleton|creeper|spider|witch|drowned|husk|stray|pillager|enderman|cow|chicken|pig|sheep|villager)/.test(line)) {
        if (!/Tags:\[[^\]]*"target"/.test(line)) {
          violations.push({
            file: relative(ROOT, path),
            line: i + 1,
            message: `summon lacks Tags:["target"] (P4 — suite runners count by tag)`,
          });
        }
      }
    }
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────
// Run all checks.
// ─────────────────────────────────────────────────────────────────────
const CHECKS = [
  { name: 'P3: registry descriptions', fn: checkRegistryDescriptions },
  { name: 'P4: fixture safe-home cleanup', fn: checkFixtureSafeHome },
  { name: 'P4: fixture world declaration', fn: checkFixtureWorld },
  { name: 'P4: combat fixture target tags', fn: checkCombatTargetTags },
];

let total = 0;
let hardFails = 0;
for (const check of CHECKS) {
  const violations = await check.fn();
  if (!violations.length) {
    console.log(`✓ ${check.name}  — pass`);
    continue;
  }
  total += violations.length;
  const hard = violations.filter((v) => !v.soft);
  hardFails += hard.length;
  console.log(`✗ ${check.name}  — ${violations.length} violation(s)`);
  for (const v of violations) {
    const tag = v.soft ? '  (soft)' : '';
    const loc = v.line ? `${v.file}:${v.line}` : v.file;
    console.log(`    ${loc}${tag}\n      ${v.message}`);
  }
}

console.log('');
if (hardFails > 0) {
  console.log(`FAIL — ${hardFails} hard violation(s) (${total} total including soft)`);
  process.exit(1);
}
if (total > 0) {
  console.log(`OK with warnings — ${total} soft violation(s)`);
} else {
  console.log('OK — all checks pass');
}
