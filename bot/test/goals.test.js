import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  computeUrgency,
  readCurrentForMetric,
  mergePresetIntoStore,
  loadGoalsStore,
} from '../lib/goals/engine.js';

describe('goals lib', () => {
  it('threat metric: high threat = urgent', () => {
    const goal = { id: 't', metric: 'threat_score', priority: 100, constraints: { preempt_class: 'critical' } };
    const d = {};
    const r = computeUrgency(goal, 0.8, 0, 0, Date.now(), d);
    assert.ok(r.urgency > 0.5);
    assert.equal(r.satisfied, false);
  });

  it('supply metric: gap increases urgency', () => {
    const goal = { id: 'w', metric: 'logs_total', priority: 50, constraints: {} };
    const d = {};
    const low = computeUrgency(goal, 10, 64, 128, Date.now(), d);
    const high = computeUrgency(goal, 120, 64, 128, Date.now(), d);
    assert.ok(low.urgency > high.urgency);
  });

  it('readCurrentForMetric uses context', () => {
    const ctx = {
      logs_total: 5,
      food_score: 20,
      stone_total: 0,
      tool_durability_pct: 80,
      survive_score: 85,
      threat_score: 0,
      chestSnapshots: {},
    };
    assert.equal(readCurrentForMetric('logs_total', { metric: 'logs_total' }, ctx), 5);
  });

  it('mergePresetIntoStore adds new goals and updates existing ones', () => {
    const store = { goals: [{ id: 'a', metric: 'logs_total', priority: 50 }], deficitSince: {} };
    const preset = { goals: [{ id: 'a', priority: 80 }, { id: 'b', metric: 'food_score' }] };
    mergePresetIntoStore(store, preset);
    assert.equal(store.goals.length, 2);
    assert.ok(store.goals.some((g) => g.id === 'b'));
    assert.equal(store.goals.find((g) => g.id === 'a').priority, 80);
    assert.equal(store.goals.find((g) => g.id === 'a').metric, 'logs_total');
  });

  it('loadGoalsStore returns defaults for missing file', () => {
    const s = loadGoalsStore('/nonexistent/path/goals-x.json');
    assert.deepEqual(s.goals, []);
  });
});
