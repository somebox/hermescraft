#!/usr/bin/env node
/**
 * Batch driver for terrain-shaping context tests — run, summarize, compare, fix-backlog.
 *
 * Usage:
 *   node scripts/context-tests/terrain-shaping-batch.mjs baseline [--runs 3] [--yes]
 *   node scripts/context-tests/terrain-shaping-batch.mjs ab [--runs 3] [--yes]
 *   node scripts/context-tests/terrain-shaping-batch.mjs summary [--run last]
 *   node scripts/context-tests/terrain-shaping-batch.mjs gate [--runs 1] [--yes]
 *   node scripts/context-tests/terrain-shaping-batch.mjs doctor
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/paths.mjs';
import { resolveRunRef, loadRunBundle } from './lib/run-record.mjs';
import { contextJsonPathForRunDir, writeFixBacklogArtifacts, buildPromotionBacklog } from './lib/fix-backlog.mjs';

const BASELINE_CFG = join(REPO_ROOT, 'scripts/context-tests/configs/experiments/terrain-shaping-baseline.yaml');
const HINT_CFG = join(REPO_ROOT, 'scripts/context-tests/configs/experiments/terrain-shaping-hint-promote.yaml');
const RUN_MJS = join(REPO_ROOT, 'scripts/context-tests/run.mjs');
const VERIFY_MJS = join(REPO_ROOT, 'scripts/context-tests/verify-fixtures.mjs');

function parseArgs(argv) {
  const cmd = argv[0] || 'help';
  const rest = argv.slice(1);
  const flags = { runs: 3, yes: false, run: 'last', skipVerify: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--runs' && rest[i + 1]) {
      flags.runs = Number(rest[++i]);
    } else if (rest[i] === '--yes') flags.yes = true;
    else if (rest[i] === '--run' && rest[i + 1]) flags.run = rest[++i];
    else if (rest[i] === '--skip-verify') flags.skipVerify = true;
  }
  return { cmd, flags };
}

function spawnNode(args, { quiet = false } = {}) {
  const r = spawnSync('node', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: quiet ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function runContextConfig(configPath, { runs, yes }) {
  const args = [
    RUN_MJS,
    '--config',
    configPath,
    '--runs-override',
    String(runs),
    '--no-judge',
  ];
  if (yes) args.push('--yes');
  else {
    console.error('Pass --yes to confirm OpenRouter spend (or run estimate first).');
    const est = spawnNode([...args, '--estimate-only'], { quiet: false });
    if (est.status !== 0) process.exit(est.status);
    console.error('Re-run with --yes to execute.');
    process.exit(0);
  }
  args.push('-q');
  console.error(`\n▶ Running ${configPath.replace(REPO_ROOT + '/', '')} (n=${runs})…\n`);
  const r = spawnNode(args, { quiet: true });
  const runId = r.stdout.trim().split(/\s+/).filter(Boolean).pop();
  if (r.stderr) process.stderr.write(r.stderr);
  if (!runId?.startsWith('r_')) {
    console.error('Could not parse run id from runner output.');
    process.exit(r.status || 1);
  }
  return { runId, status: r.status };
}

function topFailureReason(scenarioId, contextPayload) {
  const sc = contextPayload?.scenarios?.find((s) => s.id === scenarioId);
  if (!sc) return '—';
  for (const row of sc.runs || []) {
    if (row.outcome === 'pass') continue;
    const fails = (row.matchers || []).filter((t) => t.status === 'fail');
    if (fails.length) {
      const f = fails[0];
      if (f.matcher === 'required_canonical_any') {
        return `need ${(f.evidence?.required || []).join('|')}, got ${(f.evidence?.emitted || []).join(',') || '∅'}`;
      }
      if (f.matcher === 'forbidden_canonical') {
        return `forbid ${f.evidence?.forbidden}, got ${(f.evidence?.emitted || []).join(',')}`;
      }
      return f.matcher;
    }
    if (!row.mc_lines?.length && !row.raw_output?.trim()) return 'empty output';
    return row.outcome;
  }
  return '—';
}

function printSummary(runId) {
  const entry = resolveRunRef(runId);
  const bundle = loadRunBundle(entry);
  const ctxPath = contextJsonPathForRunDir(bundle.path);
  const ctx = existsSync(ctxPath) ? JSON.parse(readFileSync(ctxPath, 'utf8')) : null;
  const scenarios = bundle.run?.scenarios || [];
  const passN = scenarios.filter((s) => s.verdict === 'pass').length;
  const stableN = scenarios.filter((s) => s.stable_pass === true).length;

  console.log('\n── Terrain-shaping summary ──');
  console.log(`Run: ${runId}  scenarios: ${passN}/${scenarios.length} pass  stable: ${stableN}/${scenarios.length}`);
  console.log('');
  console.log('scenario'.padEnd(36) + 'pass'.padEnd(8) + 'verdict'.padEnd(8) + 'notes');
  console.log('-'.repeat(90));
  for (const s of scenarios) {
    const pr = s.pass_rate != null ? `${Math.round(s.pass_rate * 100)}%` : '?';
    const notes =
      s.verdict === 'fail' ? topFailureReason(s.id, ctx) : s.stable_pass ? 'stable' : 'pass';
    console.log(`${s.id.padEnd(36)}${pr.padEnd(8)}${s.verdict.padEnd(8)}${notes.slice(0, 42)}`);
  }

  const fbPath = join(bundle.path, 'fix-backlog.json');
  if (existsSync(fbPath)) {
    const fb = JSON.parse(readFileSync(fbPath, 'utf8'));
    if (fb.items?.length) {
      console.log('\n── Fix backlog (open) ──');
      for (const item of fb.items) {
        console.log(`• [${item.lever}] ${item.scenario_id} — ${item.recommended_action.proposal.slice(0, 72)}…`);
      }
      console.log(`\nFull: ${fbPath.replace(REPO_ROOT + '/', '')}`);
    } else {
      console.log('\nFix backlog: no open items.');
    }
  }
  console.log('');
}

function writeBacklogForRun(runId) {
  const entry = resolveRunRef(runId);
  const bundle = loadRunBundle(entry);
  const ctxPath = contextJsonPathForRunDir(bundle.path);
  if (!existsSync(ctxPath)) {
    console.error(`Missing ${ctxPath}`);
    return;
  }
  const out = writeFixBacklogArtifacts(ctxPath, { runId, runDir: bundle.path });
  console.error(`Fix backlog → ${out.jsonPath.replace(REPO_ROOT + '/', '')}`);
}

function cmdBaseline(flags) {
  if (!flags.skipVerify) {
    const v = spawnNode([VERIFY_MJS]);
    if (v.status !== 0) process.exit(v.status);
  }
  const { runId, status } = runContextConfig(BASELINE_CFG, flags);
  writeBacklogForRun(runId);
  printSummary(runId);
  process.exit(status ?? 0);
}

function cmdVariantHint(flags) {
  const { runId, status } = runContextConfig(HINT_CFG, flags);
  writeBacklogForRun(runId);
  printSummary(runId);
  process.exit(status ?? 0);
}

function cmdAb(flags) {
  if (!flags.skipVerify) spawnNode([VERIFY_MJS]);
  console.error('\n══ Batch A/B: baseline ══\n');
  const a = runContextConfig(BASELINE_CFG, flags);
  writeBacklogForRun(a.runId);
  printSummary(a.runId);

  console.error('\n══ Batch A/B: hint-promote variant ══\n');
  const b = runContextConfig(HINT_CFG, flags);
  writeBacklogForRun(b.runId);
  printSummary(b.runId);

  const ba = loadRunBundle(resolveRunRef(a.runId));
  const bb = loadRunBundle(resolveRunRef(b.runId));
  const ctxA = JSON.parse(readFileSync(contextJsonPathForRunDir(ba.path), 'utf8'));
  const ctxB = JSON.parse(readFileSync(contextJsonPathForRunDir(bb.path), 'utf8'));
  const promotion = buildPromotionBacklog(ba, bb, ctxA, ctxB);

  console.log('\n── Promotion candidates (Δ pass ≥ 20%) ──');
  if (!promotion.items.length) {
    console.log('None — variant did not beat baseline by ≥20% on any scenario.\n');
  } else {
    for (const item of promotion.items) {
      console.log(
        `• ${item.scenario_id}: ${((item.pass_rate_before ?? 0) * 100).toFixed(0)}% → ${((item.pass_rate_after ?? 0) * 100).toFixed(0)}% (${item.lever})`,
      );
      if (item.recommended_action?.winning_experiment_hint) {
        console.log(`  hint: ${item.recommended_action.winning_experiment_hint.slice(0, 100)}`);
      }
    }
    console.log('');
  }

  console.error(`Compare: ./context-tuner compare ${a.runId} ${b.runId}`);
  const exitCode = b.status !== 0 || a.status !== 0 ? 3 : 0;
  process.exit(exitCode);
}

function cmdSummary(flags) {
  printSummary(flags.run === 'last' ? resolveRunRef('last').id : flags.run);
}

function cmdGate(flags) {
  console.error('Safety smoke: region-protect suite + examples (n=1)…\n');
  const args = [
    RUN_MJS,
    '--suite-file',
    join(REPO_ROOT, 'data/context-tests/suites/region-protect.yaml'),
    '--runs-override',
    String(flags.runs),
    '--no-judge',
  ];
  if (flags.yes) args.push('--yes');
  else {
    spawnNode([...args, '--estimate-only']);
    console.error('Add --yes to run.');
    process.exit(0);
  }
  const r = spawnNode(args);
  process.exit(r.status ?? 0);
}

function cmdDoctor() {
  spawnNode([join(REPO_ROOT, 'scripts/context-tests/bench.mjs'), 'doctor']);
  spawnNode([VERIFY_MJS]);
}

function help() {
  console.log(`terrain-shaping-batch — run terrain context suite without one-off commands

Commands:
  doctor              verify fixtures + context-tuner doctor
  baseline [--runs N] [--yes] [--skip-verify]
                      full terrain-shaping baseline + summary + fix-backlog
  variant-hint        hint-promote experiment config only
  ab [--runs N]       baseline → variant-hint → promotion summary
  summary [--run ID]  re-print table for a past run (default: last)
  gate [--runs N]     region-protect safety smoke (before promoting doctrine)

Examples:
  ./scripts/terrain-shaping-batch.sh baseline --runs 3 --yes
  ./scripts/terrain-shaping-batch.sh ab --runs 3 --yes
  ./scripts/terrain-shaping-batch.sh summary --run r_2026-06-17T12-34-04-920Z

Requires OPENROUTER_API_KEY (or secrets.yaml). Exit 3 = grading failures (signal).
`);
}

const { cmd, flags } = parseArgs(process.argv.slice(2));
switch (cmd) {
  case 'baseline':
    cmdBaseline(flags);
    break;
  case 'variant-hint':
  case 'hint':
    cmdVariantHint(flags);
    break;
  case 'ab':
  case 'batch':
    cmdAb(flags);
    break;
  case 'summary':
    cmdSummary(flags);
    break;
  case 'gate':
    cmdGate(flags);
    break;
  case 'doctor':
    cmdDoctor();
    break;
  case 'help':
  default:
    help();
    process.exit(cmd === 'help' ? 0 : 1);
}
