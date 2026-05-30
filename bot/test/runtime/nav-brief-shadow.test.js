import test from 'node:test';
import assert from 'node:assert/strict';
import { logNavBriefShadow, NAV_BRIEF_SLO_MS } from '../../lib/runtime/nav-brief.js';

test('logNavBriefShadow includes SLO fields for rollout calibration', () => {
  const logs = [];
  const prev = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    logNavBriefShadow(
      {},
      {
        brief: { brief_id: 'nb-1', nav_mode: 'open' },
        mark_count: 3,
        reachable_count: 2,
        total_paths: 4,
        compute_ms: NAV_BRIEF_SLO_MS + 5,
        status: null,
      },
      [{ name: 'a' }],
    );
  } finally {
    console.log = prev;
  }
  const entry = JSON.parse(logs[0]);
  assert.equal(entry.event, 'nav_brief_shadow');
  assert.equal(entry.nav_mode, 'open');
  assert.equal(entry.slo_exceeded, true);
  assert.equal(entry.slo_ms, NAV_BRIEF_SLO_MS);
});
