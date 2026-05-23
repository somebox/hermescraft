import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  goalProgressRatio,
  goalBarDisplay,
  sortGoalsByUrgency,
  strategyChipsForDisplay,
  MAX_STRATEGY_CHIPS,
} from '../lib/goals-format.js';

describe('goals-format', () => {
  it('goalProgressRatio clamps between floor and target_ok', () => {
    assert.equal(goalProgressRatio(10, 60, 30), 0);
    assert.equal(goalProgressRatio(60, 60, 30), 1);
    assert.ok(goalProgressRatio(45, 60, 30) > 0.4 && goalProgressRatio(45, 60, 30) < 0.6);
  });

  it('goalBarDisplay uses min→ok span for higher-is-better metrics', () => {
    const d = goalBarDisplay({
      metric: 'food_score',
      current: 45,
      target_min: 30,
      target_ok: 60,
      satisfied: false,
    });
    assert.equal(d.mode, 'higher_better');
    assert.ok(d.label.includes('45 / 60'));
    assert.ok(d.ratio > 0.4 && d.ratio < 0.6);
  });

  it('goalBarDisplay handles threat_score (lower is better)', () => {
    const d = goalBarDisplay({
      metric: 'threat_score',
      current: 4,
      target_min: 0,
      target_ok: 0,
      satisfied: false,
    });
    assert.equal(d.mode, 'lower_better');
    assert.ok(d.label.includes('want ≤0'));
    assert.ok(d.ratio > 0 && d.ratio < 1);
  });

  it('sortGoalsByUrgency orders descending', () => {
    const sorted = sortGoalsByUrgency([
      { id: 'a', urgency: 0.2 },
      { id: 'b', urgency: 0.9 },
      { id: 'c', urgency: 0.5 },
    ]);
    assert.deepEqual(sorted.map((g) => g.id), ['b', 'c', 'a']);
  });

  it('strategyChipsForDisplay caps at MAX_STRATEGY_CHIPS', () => {
    const chips = strategyChipsForDisplay(['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal(chips.length, MAX_STRATEGY_CHIPS);
    assert.deepEqual(chips, ['a', 'b', 'c', 'd']);
  });
});
