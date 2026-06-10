/**
 * mc feedback contract tests — tooling-friction capture
 * (proc-nav-1781014144 cross-cutting mechanism).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Vec3 } from 'vec3';

import { createFeedbackActions } from '../../lib/actions/feedback.js';
import { createMockServices } from '../../lib/server/mock-services.js';
import { assertFailure } from '../_helpers/action-harness.js';

function makeFeedbackActions({ dataDir }) {
  const bot = { entity: { position: new Vec3(10.5, 64, -20.5) }, username: 'MockBot' };
  const services = createMockServices({
    state: { world: { botReady: true, bot }, runtime: { dataDir } },
    ensureBot: () => bot,
  });
  return createFeedbackActions(services);
}

test('feedback: missing note → INVALID_ARGS', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
  const actions = makeFeedbackActions({ dataDir });
  const r = await actions.feedback({});
  assertFailure(r, { code: 'INVALID_ARGS', messageIncludes: 'note', retrySafe: false });
  assert.equal(fs.existsSync(path.join(dataDir, 'runtime')), false, 'no file written on validation failure');
});

test('feedback: appends a parseable JSONL line with bot, run_id, position', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
  const prevRunId = process.env.RUN_ID;
  process.env.RUN_ID = 'test-run-42';
  t.after(() => {
    if (prevRunId === undefined) delete process.env.RUN_ID;
    else process.env.RUN_ID = prevRunId;
  });

  const actions = makeFeedbackActions({ dataDir });
  const r1 = await actions.feedback({ note: 'reachable said yes but goto found no path', tag: 'nav' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = await actions.feedback({ note: 'second line, no tag' });
  assert.equal(r2.ok, true);

  const file = path.join(dataDir, 'runtime', 'feedback-mockbot.jsonl');
  assert.ok(fs.existsSync(file), `expected ${file}`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'one JSONL line per call');

  const e1 = JSON.parse(lines[0]);
  assert.equal(e1.bot, 'MockBot');
  assert.equal(e1.note, 'reachable said yes but goto found no path');
  assert.equal(e1.tag, 'nav');
  assert.equal(e1.run_id, 'test-run-42');
  assert.deepEqual(e1.position, { x: 11, y: 64, z: -20 });
  assert.ok(!Number.isNaN(Date.parse(e1.ts)), 'ts is a valid ISO timestamp');

  const e2 = JSON.parse(lines[1]);
  assert.equal(e2.tag, null);
});

test('feedback: no data dir configured → NOT_READY (retry-safe)', async () => {
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) } };
  const services = createMockServices({
    state: { world: { botReady: true, bot }, runtime: { dataDir: null } },
    ensureBot: () => bot,
  });
  const actions = createFeedbackActions(services);
  const r = await actions.feedback({ note: 'anything' });
  assertFailure(r, { code: 'NOT_READY', retrySafe: true });
});
