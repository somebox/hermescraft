import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { REPO_ROOT } from './paths.mjs';

const ALLOW_PREFIXES = [
  'prompts/experiments/',
  'skills/experiments/',
  'docs/experiments/',
  'data/context-tests/_drafts/',
  'data/context-tests/_shared/',
];

export function isAllowedOverridePath(repoRel) {
  const n = repoRel.replace(/\\/g, '/');
  return ALLOW_PREFIXES.some((p) => n.startsWith(p));
}

export function assertOverridePath(repoRel, context) {
  if (!isAllowedOverridePath(repoRel)) {
    throw new Error(`${context}: override path not allowed: ${repoRel}`);
  }
}

/** Build Maps for runner: profile paths, skill paths, cheatsheet path */
export function resolveAllOverrides(overrides, repoRoot = REPO_ROOT) {
  const prompts = new Map();
  if (overrides?.prompts) {
    for (const [from, to] of Object.entries(overrides.prompts)) {
      assertOverridePath(to, 'prompts override');
      prompts.set(from, resolve(repoRoot, to));
    }
  }
  const skills = new Map();
  if (overrides?.skills) {
    for (const [from, to] of Object.entries(overrides.skills)) {
      assertOverridePath(to, 'skills override');
      skills.set(from, resolve(repoRoot, to));
    }
  }
  let cheatsheetPath = null;
  if (overrides?.cheatsheet) {
    assertOverridePath(overrides.cheatsheet, 'cheatsheet override');
    cheatsheetPath = resolve(repoRoot, overrides.cheatsheet);
  }
  return { prompts, skills, cheatsheetPath, scenarioPatches: overrides?.scenarios || {} };
}

export function applyScenarioPatches(raw, patches) {
  if (!patches || !patches[raw.id]) return raw;
  const p = patches[raw.id];
  const out = { ...raw };
  if (p.user_prompt != null) out.user_prompt = p.user_prompt;
  if (p.observe != null) out.observe = p.observe;
  if (p.prior_patch?.length && Array.isArray(out.prior)) {
    out.prior = out.prior.map((item, i) => {
      const patch = p.prior_patch.find((x) => x.index === i);
      if (!patch?.merge) return item;
      if (item.tool_result && typeof item.tool_result === 'object') {
        return {
          ...item,
          tool_result: deepMergeObjects(item.tool_result, patch.merge),
        };
      }
      return item;
    });
  }
  return out;
}

function deepMergeObjects(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = deepMergeObjects(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function validateOverridePathsInConfig(cfg) {
  const o = cfg.overrides;
  if (!o) return [];
  const errs = [];
  for (const to of Object.values(o.prompts || {})) {
    if (!isAllowedOverridePath(to)) errs.push(`prompts override: ${to}`);
  }
  for (const to of Object.values(o.skills || {})) {
    if (!isAllowedOverridePath(to)) errs.push(`skills override: ${to}`);
  }
  if (o.cheatsheet && !isAllowedOverridePath(o.cheatsheet)) errs.push(`cheatsheet: ${o.cheatsheet}`);
  return errs;
}
