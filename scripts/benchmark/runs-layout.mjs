/**
 * Filesystem layout for benchmark artifacts:
 *
 *   runs/<model_slug>/<ISO-stamp>-realistic.json   — main harness (run.mjs), one model per file
 *   runs/two-tier/<pair_slug>/<stamp>-two-tier.json
 *
 * Slugs are derived from OpenRouter model ids (`/` → `__`, `:` → `_colon_`).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const TWO_TIER_ROOT = 'two-tier';

/** @param {string} id OpenRouter model id */
export function slugFromModelId(id) {
  return id.replace(/\//g, '__').replace(/:/g, '_colon_');
}

/** @param {string} slug directory name under runs/ */
export function modelIdFromSlug(slug) {
  return slug.replace(/_colon_/g, ':').replace(/__/g, '/');
}

/** @param {string} runsDir */
export function listMainModelSlugs(runsDir) {
  let names;
  try {
    names = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names.filter((n) => n !== TWO_TIER_ROOT && !n.startsWith('.')).sort();
}

/** Sorted JSON filenames in a directory (basename only). */
export function listJsonBasenames(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

/** @param {string} dir */
export function latestJsonPathInDir(dir) {
  const files = listJsonBasenames(dir);
  if (!files.length) return null;
  return join(dir, files[files.length - 1]);
}

/**
 * Latest main-harness JSON per model directory under runs/.
 * @param {string} runsDir
 * @returns {{ slug: string, path: string, model_id: string }[]}
 */
export function collectLatestPerModelMainRuns(runsDir) {
  const out = [];
  for (const slug of listMainModelSlugs(runsDir)) {
    const dir = join(runsDir, slug);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const p = latestJsonPathInDir(dir);
    if (!p) continue;
    out.push({ slug, path: p, model_id: modelIdFromSlug(slug) });
  }
  return out;
}

/**
 * Resolve --model argument: accepts OpenRouter id or existing slug directory name.
 * @param {string} raw
 * @param {string} runsDir
 */
export function resolveModelSlug(raw, runsDir) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const asSlug = trimmed.includes('/') ? slugFromModelId(trimmed) : trimmed;
  try {
    const st = statSync(join(runsDir, asSlug));
    if (st.isDirectory()) return asSlug;
  } catch {
    /* fall through */
  }
  return slugFromModelId(trimmed);
}
