#!/usr/bin/env node
/**
 * Inject min/max on audited numeric argSchema fields (mc-command-audit §D).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'bot/cli/registry.mjs');

/** command name → param key → { min?, max? } */
const CAPS = [
  ['wait', 'seconds', { min: 0.1, max: 300 }],
  ['fight', 'duration', { min: 1, max: 600 }],
  ['bg_fight', 'duration', { min: 1, max: 600 }],
  ['fish', 'timeout_seconds', { min: 1, max: 300 }],
  ['sail_to', 'timeout_seconds', { min: 1, max: 600 }],
  ['task_resume', 'lease_seconds', { min: 1, max: 3600 }],
  ['map', 'radius', { min: 1, max: 16 }],
  ['nearby', 'radius', { min: 1, max: 64 }],
  ['scene', 'range', { min: 1, max: 32 }],
  ['scout', 'radius', { min: 1, max: 64 }],
  ['find', 'scan_range', { min: 1, max: 64 }],
  ['is_sheltered', 'radius', { min: 1, max: 32 }],
  ['reachable', 'range', { min: 1, max: 32 }],
  ['complete_command', 'index', { min: 0, max: 100 }],
  ['acknowledge_command', 'index', { min: 0, max: 100 }],
  ['cancel_command', 'index', { min: 0, max: 100 }],
  ['hunt', 'count', { min: 1, max: 64 }],
  ['bg_collect', 'count', { min: 1, max: 256 }],
  ['pillar_up', 'count', { min: 1, max: 32 }],
  ['pillar_down', 'count', { min: 1, max: 32 }],
  ['toss', 'count', { min: 1, max: 64 }],
  ['deposit', 'count', { min: 1, max: 64 }],
  ['withdraw', 'count', { min: 1, max: 64 }],
  ['find_blocks', 'count', { min: 1, max: 256 }],
  ['chest_search', 'max_results', { min: 1, max: 50 }],
  ['dig_pit', 'w', { min: 1, max: 64 }],
  ['dig_pit', 'l', { min: 1, max: 64 }],
  ['dig_pit', 'd', { min: 1, max: 16 }],
  ['tunnel', 'length', { min: 1, max: 128 }],
  ['tunnel', 'width', { min: 1, max: 5 }],
  ['tunnel', 'height', { min: 1, max: 5 }],
  ['stair_up', 'length', { min: 1, max: 64 }],
  ['stair_down', 'length', { min: 1, max: 64 }],
  ['build_stairs', 'length', { min: 1, max: 64 }],
];

let src = readFileSync(REGISTRY, 'utf8');
let changed = 0;

function patchInBlock(block, key, limits) {
  const re = new RegExp(
    `(\\{ key: '${key}', type: 'number'[^}]*)(\\})`,
    'g',
  );
  return block.replace(re, (full, head, close) => {
    if (/\bmin\s*:/.test(head) && /\bmax\s*:/.test(head)) return full;
    let h = head;
    if (limits.min != null && !/\bmin\s*:/.test(h)) h += `, min: ${limits.min}`;
    if (limits.max != null && !/\bmax\s*:/.test(h)) h += `, max: ${limits.max}`;
    if (h === head) return full;
    changed++;
    return `${h}${close}`;
  });
}

for (const [name, key, limits] of CAPS) {
  const marker = `g('${name}',`;
  const idx = src.indexOf(marker);
  if (idx < 0) {
    console.warn('no g() for', name);
    continue;
  }
  const braceStart = src.indexOf('{', idx);
  const end = src.indexOf('\n  }),', braceStart);
  if (end < 0) continue;
  const block = src.slice(braceStart, end);
  const patched = patchInBlock(block, key, limits);
  if (patched !== block) {
    src = src.slice(0, braceStart) + patched + src.slice(end);
  }
}

writeFileSync(REGISTRY, src);
console.log(`apply-registry-schema-caps: patched ${changed} argSchema fields`);
