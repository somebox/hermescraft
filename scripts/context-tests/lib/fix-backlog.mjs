/**
 * Turn context-test run output into actionable fix items (lever → write-back target).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { listScenarioFiles, loadScenario } from './scenario.mjs';

const PERCEPTION = new Set(['status', 'observe', 'read_chat', 'scene', 'map', 'standing', 'reachable', 'terrain_top']);

export const WRITEBACK_BY_LEVER = {
  hint: {
    change_type: 'hint_text',
    primary_files: ['bot/lib/actions/movement/nav-hints.js', 'bot/lib/actions/movement/route-sculpt-hint.js'],
    function_hints: ['navBlockedNextActionHint', 'resolveRouteSculptHint'],
  },
  skill: {
    change_type: 'doctrine',
    primary_files: ['skills/minecraft-navigation.md', 'skills/minecraft-roadbuilding.md', 'skills/kanban-worker.md'],
  },
  soul: { change_type: 'profile', primary_files: ['prompts/landfolk/flint.md'] },
  observation: {
    change_type: 'observed_state_field',
    primary_files: ['bot/lib/actions/movement/_preflight.js', 'bot/lib/actions/_nav-helpers.js'],
  },
  verb_affordance: { change_type: 'followup', primary_files: ['bot/cli/registry.mjs'] },
  unknown: { change_type: 'investigate', primary_files: [] },
};

function loadScenarioRaw(id) {
  for (const f of listScenarioFiles({ includeDrafts: true })) {
    const { raw } = loadScenario(f);
    if (raw.id === id) return { raw, filePath: f.replace(REPO_ROOT + '/', '') };
  }
  return { raw: null, filePath: null };
}

function collectFailureEvidence(runRows) {
  const forbiddenHits = new Map();
  let matcherFails = 0;
  const sampleOutputs = [];
  for (const row of runRows || []) {
    if (row.outcome !== 'matcher_fail') continue;
    matcherFails++;
    if (row.raw_output) sampleOutputs.push(String(row.raw_output).slice(0, 800));
    for (const t of row.matchers || []) {
      if (t.status === 'fail' && t.matcher === 'forbidden_canonical' && t.evidence?.forbidden) {
        forbiddenHits.set(t.evidence.forbidden, (forbiddenHits.get(t.evidence.forbidden) || 0) + 1);
      }
    }
  }
  return { matcherFails, forbiddenHits: [...forbiddenHits.entries()], sampleOutputs: sampleOutputs.slice(0, 3) };
}

export function activeExperimentLevers(resolvedConfig, scenarioId) {
  const o = resolvedConfig?.overrides || {};
  const levers = [];
  if (o.prompts && Object.keys(o.prompts).length) levers.push('soul');
  if (o.skills && Object.keys(o.skills).length) levers.push('skill');
  if (o.scenarios?.[scenarioId]?.prior_patch?.length) levers.push('hint');
  return levers;
}

export function inferPrimaryLever(evidence, scenarioRaw, experimentLevers = []) {
  if (experimentLevers.length === 1) return experimentLevers[0];
  const top = evidence.forbiddenHits[0]?.[0];
  if (top === 'dig_area' || top === 'tunnel' || top === 'build_stairs') return 'hint';
  if (top === 'goto') return 'skill';
  return experimentLevers[0] || 'unknown';
}

export function buildFixItemForScenario(sc, resolvedConfig, meta) {
  const { raw: scenarioRaw, filePath: scenarioFile } = loadScenarioRaw(sc.id);
  const evidence = collectFailureEvidence(sc.runs);
  const lever = inferPrimaryLever(evidence, scenarioRaw, activeExperimentLevers(resolvedConfig, sc.id));
  const writeback = WRITEBACK_BY_LEVER[lever] || WRITEBACK_BY_LEVER.unknown;
  const stable = sc.stable_pass;
  const verdict =
    stable === true ? 'pass' : stable === false ? 'fail' : (sc.pass_rate ?? 0) >= 0.5 ? 'pass' : 'fail';
  if (verdict === 'pass') return null;
  const rel = meta.config_path?.replace(REPO_ROOT + '/', '') || null;
  return {
    id: `${sc.id}#${lever}`,
    scenario_id: sc.id,
    scenario_file: scenarioFile,
    lever,
    verdict,
    pass_rate: sc.pass_rate,
    recommended_action: {
      change_type: writeback.change_type,
      target_files: writeback.primary_files,
      proposal: scenarioRaw?.primitive_mapping?.trim() || 'See scenario mechanics_claim and matcher trace.',
      winning_experiment_hint:
        resolvedConfig?.overrides?.scenarios?.[sc.id]?.prior_patch?.[0]?.merge?.error?.next_action_hint || null,
    },
    verification: {
      rerun_command: rel
        ? `node scripts/context-tests/run.mjs --config ${rel} --runs-override 5 --no-judge --yes`
        : `node scripts/context-tests/run.mjs --scenario-id ${sc.id} --runs-override 5 --no-judge --yes`,
    },
    status: 'open',
  };
}

export function buildFixBacklog(contextPayload, meta = {}) {
  const cfg = contextPayload.config_resolved || {};
  const items = [];
  for (const sc of contextPayload.scenarios || []) {
    const item = buildFixItemForScenario(sc, cfg, meta);
    if (item) items.push(item);
  }
  return {
    schema_version: 1,
    kind: 'terrain_shaping_fix_backlog',
    generated_at: new Date().toISOString(),
    generated_from: {
      run_id: meta.run_id,
      git_sha: meta.git_sha || contextPayload.git_sha,
      config_path: meta.config_path || contextPayload.config_path,
      experiment_id: cfg.experiment_id || cfg.label,
    },
    items,
  };
}

export function renderFixBacklogMarkdown(backlog) {
  const lines = ['# Fix backlog', ''];
  for (const item of backlog.items) {
    lines.push(`## ${item.scenario_id} (${item.lever})`);
    lines.push(`- Write-back: ${item.recommended_action.target_files.join(', ')}`);
    lines.push(`- Proposal: ${item.recommended_action.proposal}`);
    lines.push(`- Verify: \`${item.verification.rerun_command}\``);
    lines.push('');
  }
  return lines.join('\n');
}

export function writeFixBacklogArtifacts(contextJsonAbs, opts = {}) {
  const payload = JSON.parse(readFileSync(contextJsonAbs, 'utf8'));
  const backlog = buildFixBacklog(payload, {
    run_id: opts.runId,
    config_path: payload.config_path,
    git_sha: payload.git_sha,
  });
  const jsonPath = opts.runDir ? join(opts.runDir, 'fix-backlog.json') : contextJsonAbs.replace(/-context\.json$/, '-fix-backlog.json');
  const mdPath = jsonPath.replace(/\.json$/, '.md');
  writeFileSync(jsonPath, JSON.stringify(backlog, null, 2));
  writeFileSync(mdPath, renderFixBacklogMarkdown(backlog));
  return { jsonPath, mdPath, backlog };
}

export function contextJsonPathForRunDir(runDir) {
  return join(dirname(runDir), `${basename(runDir)}-context.json`);
}

export function buildPromotionBacklog(bundleA, bundleB, contextA, contextB) {
  const mapA = new Map((contextA?.scenarios || []).map((s) => [s.id, s]));
  const cfgB = contextB?.config_resolved || {};
  const items = [];
  for (const sb of contextB?.scenarios || []) {
    const sa = mapA.get(sb.id);
    if ((sb.pass_rate ?? 0) <= (sa?.pass_rate ?? 0) + 0.2) continue;
    const levers = activeExperimentLevers(cfgB, sb.id);
    items.push({
      id: `${sb.id}#promote-${levers[0] || 'hint'}`,
      scenario_id: sb.id,
      lever: levers[0] || 'hint',
      pass_rate_before: sa?.pass_rate,
      pass_rate_after: sb.pass_rate,
      recommended_action: {
        winning_experiment_hint:
          cfgB?.overrides?.scenarios?.[sb.id]?.prior_patch?.[0]?.merge?.error?.next_action_hint || null,
      },
      status: 'ready_to_promote',
    });
  }
  return { schema_version: 1, kind: 'terrain_shaping_promotion', items };
}
