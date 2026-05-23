/** Browser copy of dashboard/lib/goals-format.js — keep in sync. */

const MAX_STRATEGY_CHIPS = 4;

export function goalProgressRatio(current, targetOk, targetMin) {
  const cur = Number(current);
  const ok = Number(targetOk);
  const min = Number(targetMin);
  if (!Number.isFinite(cur) || !Number.isFinite(ok)) return 0;
  const floor = Number.isFinite(min) ? min : 0;
  if (ok <= floor) {
    if (ok <= 0 && floor <= 0) return cur <= 0 ? 1 : Math.min(1, 1 / (1 + cur));
    return Math.min(1, Math.max(0, cur / Math.max(1, floor)));
  }
  const span = ok - floor;
  const clamped = Math.max(floor, Math.min(ok, cur));
  return Math.min(1, Math.max(0, (clamped - floor) / span));
}

export function goalBarDisplay(goal) {
  const metric = goal.metric || '';
  const raw = goal.current;
  if (raw == null || (typeof raw === 'number' && !Number.isFinite(raw))) {
    return { ratio: 0, label: '—', mode: 'none', showBar: false };
  }
  const cur = Number(raw);
  const min = Number(goal.target_min ?? 0);
  const ok = Number(goal.target_ok ?? min);
  const satisfied = Boolean(goal.satisfied);

  if (metric === 'threat_score') {
    const scale = Math.max(6, min + 4, cur + 2);
    const ratio = satisfied ? 1 : Math.min(1, cur / scale);
    return {
      ratio,
      label: satisfied ? `threat ${cur} · ok` : `threat ${cur} · want ≤${min}`,
      mode: 'lower_better',
      showBar: true,
    };
  }

  const ratio = goalProgressRatio(cur, ok, min);
  const label = ok > min ? `${cur} / ${ok} (min ${min})` : `${cur} (min ${min})`;
  return {
    ratio: satisfied ? Math.max(ratio, 1) : ratio,
    label,
    mode: 'higher_better',
    showBar: true,
  };
}

export function sortGoalsByUrgency(goals) {
  return [...(goals || [])].sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0));
}

export function strategyChipsForDisplay(strategies) {
  if (!Array.isArray(strategies)) return [];
  return strategies.slice(0, MAX_STRATEGY_CHIPS);
}

export { MAX_STRATEGY_CHIPS };
