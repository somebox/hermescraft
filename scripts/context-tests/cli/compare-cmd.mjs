import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgv, isPiped } from './util.mjs';
import {
  resolveRunRef,
  loadRunBundle,
  defaultComparePartner,
} from '../lib/run-record.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

function scenarioMap(bundle) {
  if (bundle.legacy) {
    return new Map((bundle.data.scenarios || []).map((s) => [s.id, s]));
  }
  return new Map((bundle.run.scenarios || []).map((s) => [s.id, s]));
}

function metrics(s) {
  return {
    pass_rate: s.pass_rate ?? null,
    judge_avg: s.judge_avg ?? s.expectations_mean_avg ?? null,
    expectations_mean_avg: s.expectations_mean_avg ?? null,
    verdict: s.verdict,
  };
}

function manifestWarnings(ma, mb) {
  const w = [];
  if (!ma || !mb) return w;
  if (ma.git_sha !== mb.git_sha) w.push('git_sha differs');
  if (ma.subject_model !== mb.subject_model) w.push('subject_model differs');
  return w;
}

export function runCompare(argv) {
  const { positional, opts, flags } = parseArgv(argv);
  let aRef = positional[0] || 'last';
  let bRef = positional[1];
  const resolveId = (r) => {
    if (r === 'last' || /^last~\d+$/.test(r)) return resolveRunRef(r).id;
    if (r.startsWith('r_')) return r;
    return resolveRunRef(r).id;
  };
  if (!bRef) {
    const cur = resolveRunRef(aRef === 'last' ? 'last' : aRef);
    const partner = defaultComparePartner(cur.id);
    if (!partner) {
      console.error('No prior run to compare; pass two run ids');
      process.exit(1);
    }
    aRef = cur.id;
    bRef = partner.id;
  } else {
    aRef = resolveId(aRef);
    bRef = resolveId(bRef);
  }

  const ba = loadRunBundle(resolveRunRef(aRef));
  const bb = loadRunBundle(resolveRunRef(bRef));
  const mapA = scenarioMap(ba);
  const mapB = scenarioMap(bb);
  const rows = [];
  for (const [id, sb] of mapB) {
    const sa = mapA.get(id);
    const mb = metrics(sb);
    const ma = sa ? metrics(sa) : null;
    rows.push({
      id,
      pass_a: ma?.pass_rate,
      pass_b: mb.pass_rate,
      judge_a: ma?.judge_avg,
      judge_b: mb.judge_avg,
      delta_judge:
        ma?.judge_avg != null && mb.judge_avg != null ? mb.judge_avg - ma.judge_avg : null,
      verdict_a: ma?.verdict,
      verdict_b: mb.verdict,
    });
  }
  const warnings = manifestWarnings(ba.manifest, bb.manifest);

  if (flags.has('json') || opts.json) {
    console.log(JSON.stringify({ a: aRef, b: bRef, warnings, rows }, null, 2));
  } else {
    console.log(`compare\t${aRef}\t${bRef}`);
    for (const w of warnings) console.error(`WARN:\t${w}`);
    console.log('scenario\tpass_a\tpass_b\tjudge_a\tjudge_b\tdelta_judge');
    for (const r of rows) {
      console.log(
        [
          r.id,
          fmt(r.pass_a),
          fmt(r.pass_b),
          fmt(r.judge_a),
          fmt(r.judge_b),
          fmt(r.delta_judge),
        ].join('\t'),
      );
    }
  }

  if (flags.has('append-learnings') || opts['append-learnings']) {
    const path = join(REPO_ROOT, 'docs', 'context-tests', 'learnings.md');
    const block = [
      '',
      `## ${new Date().toISOString().slice(0, 10)} ${ba.manifest?.label || 'run'}`,
      `- A: \`${aRef}\` B: \`${bRef}\``,
      `- git: ${ba.manifest?.git_sha || '?'}`,
      ...rows
        .filter((r) => r.delta_judge != null && Math.abs(r.delta_judge) >= 0.1)
        .map((r) => `- ${r.id}: judge ${fmt(r.judge_a)} → ${fmt(r.judge_b)} (Δ ${fmt(r.delta_judge)})`),
      '- decision: TODO (human)',
      '',
    ].join('\n');
    if (!existsSync(path)) {
      appendFileSync(path, '# Context test learnings\n\nSignal ledger; not ground truth.\n');
    }
    appendFileSync(path, block);
    console.error(`Appended learnings to ${path}`);
  }
}

function fmt(v) {
  if (v == null) return '';
  if (typeof v === 'number') return v.toFixed(2);
  return String(v);
}
