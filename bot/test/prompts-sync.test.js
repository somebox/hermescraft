/**
 * Guards `prompts/landfolk/<role>.starter.txt` and `<role>.wake-*.md`
 * against drift from the canonical surface:
 *
 *   - Every `mc <verb>` they reference must be a name or alias in
 *     bot/cli/registry.mjs.
 *   - Every `scripts/<name>` they reference must resolve to an existing
 *     file under <repo>/scripts/.
 *
 * These two checks would have caught the 2026-05-30 Steward bug: the
 * dispatcher was telling Steward to run `scripts/board` (deprecated) and
 * `board-recent.py --ticks 5` (path missing), both invisible to CI.
 *
 * The big role SOULs (flint.md, mason.md, steward.md, …) contain prose
 * mentions of `mc <verb>` and aren't validated here yet — extend with a
 * backtick-only extractor when we want to widen the net.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAW_COMMAND_DEFS } from '../cli/registry.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts', 'landfolk');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

/** Files where any `mc <verb>` token is treated as a real command (not prose). */
function gatedPromptFiles() {
  const entries = fs.readdirSync(PROMPTS_DIR);
  return entries
    .filter((f) => f.endsWith('.starter.txt') || /\.wake-(full|minimal)\.md$/.test(f))
    .map((f) => path.join(PROMPTS_DIR, f));
}

function knownMcVerbs() {
  const names = new Set();
  for (const def of RAW_COMMAND_DEFS) {
    names.add(def.name);
    for (const a of def.aliases || []) names.add(a);
  }
  return names;
}

/** Extract `mc <verb>` and `scripts/<name>` tokens from a string. */
function extractTokens(text) {
  const mcVerbs = new Set();
  const scriptRefs = new Set();
  for (const m of text.matchAll(/\bmc\s+([a-z_][a-z_0-9]*)/g)) mcVerbs.add(m[1]);
  // scripts/<name> — name can be a plain word, end in .py/.sh/.mjs, or be hyphenated.
  // We capture only the first path component (before any further /).
  for (const m of text.matchAll(/\bscripts\/([a-zA-Z0-9_.-]+)/g)) scriptRefs.add(m[1]);
  return { mcVerbs, scriptRefs };
}

test('prompts/landfolk/*.starter.txt + *.wake-*.md reference only real mc verbs', () => {
  const verbs = knownMcVerbs();
  const failures = [];
  for (const f of gatedPromptFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    const { mcVerbs } = extractTokens(text);
    for (const v of mcVerbs) {
      if (!verbs.has(v)) failures.push(`${path.relative(REPO_ROOT, f)}: unknown mc verb "mc ${v}"`);
    }
  }
  if (failures.length) {
    assert.fail(`Stale mc verbs in prompts (cross-check bot/cli/registry.mjs):\n  ${failures.join('\n  ')}`);
  }
});

/**
 * Tools that still exist on disk but have been explicitly retired by the
 * canonical SOULs (see prompts/landfolk/steward.md). Prompts that route
 * agents to these will get the agent to mis-tool itself even though `ls`
 * would find the file. The replacement column lets the failure message
 * point the editor at the right verb.
 */
const DEPRECATED_SCRIPTS = {
  board: 'scripts/kanban board',
};

test('prompts/landfolk/*.starter.txt + *.wake-*.md reference only real scripts/<name>', () => {
  const failures = [];
  for (const f of gatedPromptFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    const { scriptRefs } = extractTokens(text);
    for (const s of scriptRefs) {
      if (DEPRECATED_SCRIPTS[s]) {
        failures.push(`${path.relative(REPO_ROOT, f)}: "scripts/${s}" is deprecated — use ${DEPRECATED_SCRIPTS[s]}`);
        continue;
      }
      const full = path.join(SCRIPTS_DIR, s);
      if (!fs.existsSync(full)) {
        failures.push(`${path.relative(REPO_ROOT, f)}: missing script "scripts/${s}"`);
      }
    }
  }
  if (failures.length) {
    assert.fail(`Stale script references in prompts:\n  ${failures.join('\n  ')}`);
  }
});
