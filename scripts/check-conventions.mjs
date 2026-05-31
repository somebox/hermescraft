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
// Functional pytest: prefer canonical harness fixtures over legacy arena helpers.
// ─────────────────────────────────────────────────────────────────────
function checkFunctionalPytestLegacy() {
  const violations = [];
  const dir = join(ROOT, 'tests/functional');
  if (!statSync(dir, { throwIfNoEntry: false })) return violations;
  const files = walk(dir, (f) => f.endsWith('.py'));
  const patterns = [
    { re: /arena\.flat_arena\(/, msg: 'use props on canonical grass + functional_world' },
    { re: /arena\.rescue_tester\(/, msg: 'harness rescue_tester already ran' },
    { re: /wait_until_ready\(/, msg: 'prefer bot.ensure_connected()' },
  ];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { re, msg } of patterns) {
        if (re.test(lines[i])) {
          violations.push({
            file: relative(ROOT, path),
            line: i + 1,
            message: msg,
            soft: true,
          });
        }
      }
    }
  }
  const combatDir = join(ROOT, 'tests/functional/combat');
  if (statSync(combatDir, { throwIfNoEntry: false })) {
    const combatFiles = walk(combatDir, (f) => f.endsWith('.py') && !f.endsWith('scenarios.py'));
    for (const path of combatFiles) {
      const text = readFileSync(path, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/setblock .* cobblestone/.test(line) || /summon .*Tags:.*target/.test(line)) {
          violations.push({
            file: relative(ROOT, path),
            line: i + 1,
            message: 'use tests/_lib/combat_fixtures helpers',
            soft: true,
          });
        }
      }
    }
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────
// P16: module size budget ≤500 LOC.
// Files in bot/lib/**/*.js over 500 LOC must carry a top-of-file
// `// @size-exempt: <reason>` annotation.
// ─────────────────────────────────────────────────────────────────────
const SIZE_BUDGET = 500;

function checkModuleSizeBudget() {
  const violations = [];
  const libRoot = join(ROOT, 'bot/lib');
  if (!statSync(libRoot, { throwIfNoEntry: false })) return violations;
  const files = walk(libRoot, (f) => f.endsWith('.js'));
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const lineCount = text.split('\n').length;
    if (lineCount <= SIZE_BUDGET) continue;
    // Annotation must appear in the first 20 lines (above first declaration).
    const head = text.split('\n').slice(0, 20).join('\n');
    const exempt = /@size-exempt:\s*\S/.test(head);
    if (exempt) continue;
    violations.push({
      file: relative(ROOT, path),
      line: 1,
      message: `${lineCount} LOC exceeds ${SIZE_BUDGET}-line budget (P16). Split the module or add a top-of-file '// @size-exempt: <reason>' annotation.`,
    });
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────
// P20: createMockServices key parity with createServices.
// Bidirectional Object.keys check — top-level + per-bundle.
// ─────────────────────────────────────────────────────────────────────
async function checkMockServicesParity() {
  const violations = [];
  let services, mockServices;
  try {
    services = await import(join(ROOT, 'bot/lib/server/services.js'));
    mockServices = await import(join(ROOT, 'bot/lib/server/mock-services.js'));
  } catch (err) {
    violations.push({
      file: 'bot/lib/server/mock-services.js',
      line: null,
      message: `unable to import services module(s): ${err.message} (P20)`,
    });
    return violations;
  }
  const mock = mockServices.createMockServices();
  const mockTopKeys = Object.keys(mock).sort();
  const realTopKeys = [...services.SERVICES_KEYS].sort();
  if (JSON.stringify(mockTopKeys) !== JSON.stringify(realTopKeys)) {
    violations.push({
      file: 'bot/lib/server/mock-services.js',
      line: null,
      message: `top-level keys drift from SERVICES_KEYS (P20). mock=${JSON.stringify(mockTopKeys)} real=${JSON.stringify(realTopKeys)}`,
    });
  }
  for (const [bundle, expected] of Object.entries(services.SERVICE_BUNDLE_KEYS)) {
    const actual = Object.keys(mock[bundle] || {}).sort();
    const want = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(want)) {
      violations.push({
        file: 'bot/lib/server/mock-services.js',
        line: null,
        message: `bundle '${bundle}' keys drift from SERVICE_BUNDLE_KEYS (P20). mock=${JSON.stringify(actual)} real=${JSON.stringify(want)}`,
      });
    }
  }
  return violations;
}

function checkFixtureStressYaml() {
  const violations = [];
  const stressDir = join(ROOT, 'data/test-fixtures/stress');
  try {
    for (const name of readdirSync(stressDir)) {
      if (!name.endsWith('.yaml')) continue;
      const text = readFileSync(join(stressDir, name), 'utf8');
      if (!/^world:\s/m.test(text)) {
        violations.push({ file: `data/test-fixtures/stress/${name}`, line: null, message: 'stress fixture must declare world:' });
      }
    }
  } catch {
    /* no stress dir yet */
  }
  const agentDir = join(ROOT, 'data/agent-tests/playbooks');
  try {
    for (const name of readdirSync(agentDir)) {
      if (!name.endsWith('.yaml')) continue;
      const text = readFileSync(join(agentDir, name), 'utf8');
      if (!/world:\s/.test(text)) {
        violations.push({ file: `data/agent-tests/playbooks/${name}`, line: null, message: 'agent-test playbook scenario should declare world:' });
      }
    }
  } catch {
    /* optional until scenarios land */
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
  { name: 'stress/agent-test playbook YAML world', fn: checkFixtureStressYaml },
  { name: 'P4: combat fixture target tags', fn: checkCombatTargetTags },
  { name: 'functional pytest legacy arena patterns', fn: checkFunctionalPytestLegacy },
  { name: 'P16: module size budget ≤500 LOC', fn: checkModuleSizeBudget },
  { name: 'P20: mock-services key parity', fn: checkMockServicesParity },
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
