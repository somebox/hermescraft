/**
 * Base supply thresholds reader.
 *
 * Loads data/base-goals.yaml once at module init. The file lists resource
 * categories the LANDFOLK BASE collectively needs (food, wood, stone,
 * coal, etc.) with target_min / target_ok thresholds and a default
 * [SUPPLY] assignee. See scripts/base-inventory.py for the aggregator.
 *
 * This helper exposes per-item lookup so primitives (mc withdraw,
 * eventually mc fill) can include a low-stock hint in their response
 * when an action drops a resource below its floor. The hint surfaces
 * in the primitive's output the moment it matters — no agent SOUL
 * lookup, no separate cycle.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYAML } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// bot/lib/runtime → bot/lib → bot → repo root → data/
const BASE_GOALS_PATH = path.resolve(__dirname, '..', '..', '..', 'data', 'base-goals.yaml');

/** @type {Record<string, {items: string[], target_min: number, target_ok: number, assignee?: string, designated_site?: string}>} */
let GOALS = {};
/** @type {Record<string, {resource: string, target_min: number, target_ok: number, assignee?: string, designated_site?: string}>} */
let RESOURCE_BY_ITEM = {};
let LOAD_OK = false;

function loadOnce() {
  if (LOAD_OK) return;
  try {
    const raw = fs.readFileSync(BASE_GOALS_PATH, 'utf8');
    const data = parseYAML(raw);
    if (!data || typeof data !== 'object') return;
    GOALS = {};
    RESOURCE_BY_ITEM = {};
    for (const [resourceName, info] of Object.entries(data)) {
      if (!info || typeof info !== 'object') continue;
      const items = Array.isArray(info.items) ? info.items : [];
      const target_min = Number(info.target_min) || 0;
      const target_ok = Number(info.target_ok) || target_min;
      const assignee = typeof info.assignee === 'string' ? info.assignee : undefined;
      const designated_site = typeof info.designated_site === 'string' ? info.designated_site : undefined;
      GOALS[resourceName] = { items, target_min, target_ok, assignee, designated_site };
      for (const item of items) {
        if (typeof item !== 'string') continue;
        RESOURCE_BY_ITEM[item] = { resource: resourceName, target_min, target_ok, assignee, designated_site };
      }
    }
    LOAD_OK = true;
  } catch {
    // Missing or malformed file → empty maps; helper degrades to no-op.
  }
}

loadOnce();

/**
 * Find the resource group a given item belongs to, with its thresholds.
 * Returns null if the item isn't tracked by base-goals.yaml.
 *
 * @param {string} itemName
 * @returns {{resource: string, target_min: number, target_ok: number, assignee?: string, designated_site?: string} | null}
 */
export function thresholdsFor(itemName) {
  if (!itemName) return null;
  const entry = RESOURCE_BY_ITEM[itemName];
  return entry ? { ...entry } : null;
}

/**
 * Evaluate a current stock count against the resource's thresholds and
 * produce a structured assessment. `currentCount` is the post-action
 * total for the item AT THE SAMPLED LOCATION (e.g. a chest after a
 * withdraw). The hint string is suitable for embedding in a primitive's
 * `result` field so an agent reading the response immediately sees
 * whether a [SUPPLY] follow-up is needed.
 *
 * @param {string} itemName
 * @param {number} currentCount
 * @returns {{
 *   below_min: boolean,
 *   below_ok: boolean,
 *   resource: string | null,
 *   target_min: number | null,
 *   target_ok: number | null,
 *   designated_site: string | null,
 *   hint: string | null,
 * }}
 */
export function evaluateStock(itemName, currentCount) {
  const t = thresholdsFor(itemName);
  if (!t) {
    return {
      below_min: false,
      below_ok: false,
      resource: null,
      target_min: null,
      target_ok: null,
      designated_site: null,
      hint: null,
    };
  }
  const n = Number.isFinite(Number(currentCount)) ? Math.floor(Number(currentCount)) : 0;
  const below_min = n < t.target_min;
  const below_ok = n < t.target_ok;
  let hint = null;
  if (below_min) {
    const siteRef = t.designated_site ? ` from ${t.designated_site}` : '';
    hint = `⚠ ${t.resource} stock low: ${itemName} at ${n}/${t.target_min} (target_ok ${t.target_ok}). Consider [SUPPLY]${siteRef}.`;
  } else if (below_ok) {
    const siteRef = t.designated_site ? ` (${t.designated_site})` : '';
    hint = `${t.resource} stock at ${n}/${t.target_ok}${siteRef} — above floor, watch.`;
  }
  return {
    below_min,
    below_ok,
    resource: t.resource,
    target_min: t.target_min,
    target_ok: t.target_ok,
    designated_site: t.designated_site || null,
    hint,
  };
}

/** Force re-read (for tests). */
export function reloadBaseGoals() {
  LOAD_OK = false;
  GOALS = {};
  RESOURCE_BY_ITEM = {};
  loadOnce();
}

/** All resource names from the loaded file. */
export function resourceNames() {
  return Object.keys(GOALS);
}
