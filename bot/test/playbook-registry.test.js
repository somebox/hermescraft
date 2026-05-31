import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = path.join(ROOT, 'data/playbooks/registry.yaml');

test('registry.yaml lists wood.chop_tall_tree with four phases', () => {
  const text = fs.readFileSync(REGISTRY, 'utf8');
  assert.match(text, /wood\.chop_tall_tree/);
  for (const phase of ['preflight', 'approach', 'chop_loop', 'closeout']) {
    assert.match(text, new RegExp(`id: ${phase}`));
  }
});

test('registry includes scout.resource for worker namespace', () => {
  const text = fs.readFileSync(REGISTRY, 'utf8');
  assert.match(text, /scout\.resource/);
});

test('registry doc copies match skills/playbook-*.md (regenerate-artifacts sync)', () => {
  const text = fs.readFileSync(REGISTRY, 'utf8');
  const docRe = /doc:\s*(docs\/features\/playbooks\/[^\s#]+\.md)/g;
  let m;
  let checked = 0;
  while ((m = docRe.exec(text)) !== null) {
    const docPath = path.join(ROOT, m[1]);
    if (!fs.existsSync(docPath)) continue;
    const slug = path.basename(docPath, '.md');
    const skillPath = path.join(ROOT, 'skills', `playbook-${slug}.md`);
    assert.ok(fs.existsSync(skillPath), `missing skill copy for ${m[1]} — run scripts/regenerate-artifacts.sh`);
    const docBuf = fs.readFileSync(docPath);
    const skillBuf = fs.readFileSync(skillPath);
    assert.equal(
      docBuf.compare(skillBuf),
      0,
      `skills/playbook-${slug}.md drift from ${m[1]}`,
    );
    checked += 1;
  }
  assert.ok(checked >= 1, 'expected at least one registry doc on disk to sync-check');
});
