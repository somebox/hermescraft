import { readHistoryLines } from '../lib/run-record.mjs';
import { loadSuitePreset } from '../lib/suite.mjs';
import { parseArgv } from './util.mjs';

export function runTrend(argv) {
  const { positional, opts, flags } = parseArgv(argv);
  const n = Number(opts.n || 10);
  let history = readHistoryLines();
  const scenarioOnly = opts.scenario;

  if (scenarioOnly) {
    history = history.filter((h) => (h.scenarios || []).some((s) => s.id === scenarioOnly));
    history = history.slice(-n);
    emitTrend(history, new Set([scenarioOnly]), flags, opts);
    return;
  }

  const suiteArg = positional[0];
  if (!suiteArg) {
    console.error('Usage: context-tuner trend <suite-preset> [-n N]  OR  trend --scenario <id>');
    process.exit(1);
  }
  const suiteName = suiteArg.replace(/\.yaml$/, '').split('/').pop();
  let scenarioIds;
  try {
    scenarioIds = new Set(loadSuitePreset(suiteName).scenarios);
  } catch {
    console.error(`Unknown suite preset: ${suiteName}`);
    process.exit(1);
  }
  history = history.filter((h) => h.suite === suiteName);
  history = history.slice(-n);
  emitTrend(history, scenarioIds, flags, opts);
}

function emitTrend(history, scenarioIds, flags, opts) {
  const runIds = history.map((h) => h.run_id);
  const rows = [];
  for (const sid of scenarioIds) {
    const cells = history.map((h) => {
      const sc = (h.scenarios || []).find((s) => s.id === sid);
      if (!sc) return '';
      if (sc.expectations_mean_avg != null) return sc.expectations_mean_avg.toFixed(2);
      if (sc.pass_rate != null) return sc.pass_rate.toFixed(2);
      return sc.verdict || '';
    });
    rows.push({ id: sid, cells });
  }
  if (flags.has('json') || opts.json) {
    console.log(JSON.stringify({ run_ids: runIds, rows }, null, 2));
    return;
  }
  console.log(['scenario', ...runIds].join('\t'));
  for (const r of rows) {
    console.log([r.id, ...r.cells].join('\t'));
  }
}
