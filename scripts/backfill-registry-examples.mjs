#!/usr/bin/env node
/**
 * One-shot: add minimal examples: [...] to registry entries that lack them.
 * Run from repo root: node scripts/backfill-registry-examples.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'bot/cli/registry.mjs');

const { RAW_COMMAND_DEFS } = await import(join(ROOT, 'bot/cli/registry.mjs'));

let src = readFileSync(REGISTRY, 'utf8');
let changed = 0;

for (const cmd of RAW_COMMAND_DEFS) {
  if (cmd.examples?.length) continue;
  const name = cmd.name;
  const exampleLine = cmd.usage
    ? `    examples: [${JSON.stringify(cmd.usage)}],\n`
    : `    examples: [${JSON.stringify(`mc ${name}`)}],\n`;

  const marker = `g('${name}',`;
  const idx = src.indexOf(marker);
  if (idx < 0) {
    console.warn('skip (no marker):', name);
    continue;
  }
  const braceStart = src.indexOf('{', idx);
  if (braceStart < 0) continue;
  const slice = src.slice(braceStart, braceStart + 8000);
  const blockHead = slice.split('}),')[0];
  if (/\bexamples\s*:/.test(blockHead)) continue;

  // Insert after description or usage line if present, else right after `{`
  const descMatch = blockHead.match(/(\n    description: [^\n]+\n)/);
  const usageMatch = blockHead.match(/(\n    usage: [^\n]+\n)/);
  const insertAfter = descMatch || usageMatch;
  if (insertAfter) {
    const insertAt = braceStart + insertAfter.index + insertAfter[0].length;
    src = src.slice(0, insertAt) + exampleLine + src.slice(insertAt);
    changed++;
    continue;
  }
  src = src.slice(0, braceStart + 1) + '\n' + exampleLine + src.slice(braceStart + 1);
  changed++;
}

writeFileSync(REGISTRY, src);
console.log(`backfill-registry-examples: inserted examples for ${changed} commands`);
