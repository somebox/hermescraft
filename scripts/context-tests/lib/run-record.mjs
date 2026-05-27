import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RUNS_DIR } from './paths.mjs';

const INDEX_PATH = join(RUNS_DIR, '_index.json');
const HISTORY_PATH = join(RUNS_DIR, 'history.jsonl');
const MAX_INDEX = 100;
const EXCERPT_MAX = 2000;

function hashConfig(obj) {
  const h = createHash('sha256');
  h.update(JSON.stringify(obj));
  return 'sha256:' + h.digest('hex').slice(0, 16);
}

function excerptFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const m of messages) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    parts.push(c);
  }
  const s = parts.join('\n---\n');
  return s.length > EXCERPT_MAX ? s.slice(0, EXCERPT_MAX) + '\n…[truncated]' : s;
}

export function compactScenarioRow(sc) {
  const runs = (sc.runs || []).map((r) => ({
    n: r.n,
    outcome: r.outcome,
    matchers_pass: r.outcome === 'pass',
    patterns_pass: r.patterns_pass,
    expectations_weighted_mean: r.expectations_weighted_mean,
    judge_score: r.judge_score,
  }));
  return {
    id: sc.id,
    category: sc.category,
    contract_level: sc.contract_level,
    pass_rate: sc.pass_rate,
    stable_pass: sc.stable_pass,
    judge_avg: sc.judge_avg,
    expectations_mean_avg: sc.expectations_mean_avg,
    patterns_pass_rate: sc.patterns_pass_rate,
    fixture_hashes: sc.fixture_hashes,
    rendered_excerpt: excerptFromMessages(sc.rendered_prompt),
    runs,
    verdict: (() => {
      const allMatchersPass = (sc.runs || []).every((r) => r.matchers_pass !== false && r.outcome !== 'matcher_fail');
      if (sc.stable_pass === true) return 'pass';
      if (sc.stable_pass === false && (sc.runs?.length || 0) >= 3) return 'fail';
      if ((sc.pass_rate ?? 0) >= 1 && allMatchersPass) return 'pass';
      if (sc.stable_pass === false) return 'fail';
      return (sc.pass_rate ?? 0) >= 0.5 ? 'pass' : 'fail';
    })(),
  };
}

export function writeRunRecord(opts) {
  const {
    runId,
    slug,
    stamp,
    gitSha,
    configPath,
    label,
    suiteName,
    resolvedConfig,
    subjectModel,
    judgeModel,
    temperature,
    runsPerScenario,
    judgeSamples,
    inputHashes,
    scenariosCompact,
  } = opts;
  const dir = join(RUNS_DIR, slug, stamp);
  mkdirSync(dir, { recursive: true });

  const manifest = {
    schema_version: 1,
    run_id: runId,
    git_sha: gitSha,
    config_path: configPath,
    label: label || null,
    resolved_config_hash: hashConfig(resolvedConfig),
    subject_model: subjectModel,
    judge_model: judgeModel,
    temperature,
    runs_per_scenario: runsPerScenario,
    judge_samples: judgeSamples,
    suite: suiteName || null,
    inputs: inputHashes,
    timestamp: new Date().toISOString(),
  };

  const runJson = { schema_version: 1, run_id: runId, scenarios: scenariosCompact };

  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'run.json'), JSON.stringify(runJson, null, 2));

  const entry = {
    id: runId,
    path: dir,
    stamp,
    slug,
    label: label || null,
    suite: suiteName || null,
    config_path: configPath,
    subject_model: subjectModel,
    timestamp: manifest.timestamp,
  };

  let index = { last: runId, entries: [] };
  if (existsSync(INDEX_PATH)) {
    try {
      index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
    } catch {
      index = { last: runId, entries: [] };
    }
  }
  index.last = runId;
  index.entries = [entry, ...(index.entries || []).filter((e) => e.id !== runId)].slice(0, MAX_INDEX);
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));

  const historyLine = {
    run_id: runId,
    stamp,
    label: label || null,
    suite: suiteName || null,
    git_sha: gitSha,
    subject_model: subjectModel,
    config_path: configPath,
    scenarios: scenariosCompact.map((s) => ({
      id: s.id,
      pass_rate: s.pass_rate,
      expectations_mean_avg: s.expectations_mean_avg,
      judge_avg: s.judge_avg,
      verdict: s.verdict,
    })),
  };
  appendFileSync(HISTORY_PATH, JSON.stringify(historyLine) + '\n');

  return { dir, runId, manifest, runJson };
}

export function loadIndex() {
  if (!existsSync(INDEX_PATH)) return { last: null, entries: [] };
  return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
}

export function resolveRunRef(ref) {
  const index = loadIndex();
  if (!ref || ref === 'last') {
    const id = index.last;
    if (!id) throw new Error('No runs in index');
    const e = index.entries.find((x) => x.id === id);
    return e || { id, path: null };
  }
  const m = /^last~(\d+)$/.exec(ref);
  if (m) {
    const n = Number(m[1]);
    const e = index.entries[n];
    if (!e) throw new Error(`No run at last~${n}`);
    return e;
  }
  const byId = index.entries.find((e) => e.id === ref);
  if (byId) return byId;
  if (existsSync(ref)) return { id: ref, path: ref };
  return { id: ref, path: ref };
}

export function loadRunBundle(entry) {
  const base = entry.path || entry;
  const runPath = join(base, 'run.json');
  const manPath = join(base, 'manifest.json');
  if (!existsSync(runPath)) {
    const legacy = JSON.parse(readFileSync(base, 'utf8'));
    return { legacy: true, path: base, data: legacy, manifest: null, run: null };
  }
  return {
    legacy: false,
    path: base,
    run: JSON.parse(readFileSync(runPath, 'utf8')),
    manifest: JSON.parse(readFileSync(manPath, 'utf8')),
  };
}

export function defaultComparePartner(runId) {
  const index = loadIndex();
  const pos = index.entries.findIndex((e) => e.id === runId);
  if (pos < 0) return null;
  const cur = index.entries[pos];
  for (let i = pos + 1; i < index.entries.length; i++) {
    const e = index.entries[i];
    if (cur.label && e.label === cur.label) return e;
    if (!cur.label && cur.suite && e.suite === cur.suite) return e;
  }
  if (pos + 1 < index.entries.length) return index.entries[pos + 1];
  return null;
}

export function readHistoryLines() {
  if (!existsSync(HISTORY_PATH)) return [];
  return readFileSync(HISTORY_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
