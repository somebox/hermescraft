/**
 * Goal engine: persistence, metric evaluation, urgency scoring.
 * Bot-agnostic helpers; server passes bot + mcData + extra context.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo data/ directory (hermescraft/data/) */
export function getDataDir() {
  return path.join(__dirname, '..', '..', '..', 'data');
}

export function goalsFileForUser(username) {
  const u = String(username || 'HermesBot').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return path.join(getDataDir(), `goals-${u}.json`);
}

export function presetsDir() {
  return path.join(getDataDir(), 'goal-presets');
}

export function loadGoalsStore(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const d = JSON.parse(raw);
    if (!Array.isArray(d.goals)) d.goals = [];
    if (!d.deficitSince || typeof d.deficitSince !== 'object') d.deficitSince = {};
    return d;
  } catch {
    return { goals: [], deficitSince: {} };
  }
}

export function saveGoalsStore(filePath, store) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
}

export function chestSnapshotsFileForUser(username) {
  const u = String(username || 'HermesBot').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return path.join(getDataDir(), `chest-snapshots-${u}.json`);
}

/**
 * Load persisted chest snapshots. Returns `{}` on any failure
 * (missing file, parse error, wrong shape) — never throws.
 * @param {string} filePath
 * @returns {Record<string, {at:string, position:{x:number,y:number,z:number}, total:number, items:Array<{name:string,count:number}>}>}
 */
export function loadChestSnapshots(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (!val || typeof val !== 'object') continue;
      const items = Array.isArray(val.items) ? val.items.filter((i) => i && typeof i === 'object') : [];
      const total = typeof val.total === 'number' ? val.total : items.reduce((s, i) => s + (i.count || 0), 0);
      const position =
        val.position && typeof val.position === 'object'
          ? { x: Number(val.position.x) || 0, y: Number(val.position.y) || 0, z: Number(val.position.z) || 0 }
          : { x: 0, y: 0, z: 0 };
      out[key] = {
        at: typeof val.at === 'string' ? val.at : new Date(0).toISOString(),
        position,
        total,
        items,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Atomically persist chest snapshots: write to <file>.tmp then rename.
 * Creates the parent directory if it does not exist.
 * @param {string} filePath
 * @param {Record<string, any>} snapshots
 */
export function saveChestSnapshots(filePath, snapshots) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshots || {}, null, 2));
  fs.renameSync(tmp, filePath);
}

const LOG_NAMES = (itemName) =>
  itemName.endsWith('_log') || itemName.endsWith('_wood') || itemName === 'crimson_stem' || itemName === 'warped_stem';

function invCount(inv, pred) {
  return inv.filter(pred).reduce((s, i) => s + i.count, 0);
}

function toolDurabilityMinPercent(inv) {
  const tools = inv.filter((i) => {
    const n = i.name;
    return (
      n.endsWith('_pickaxe') ||
      n.endsWith('_axe') ||
      n.endsWith('_shovel') ||
      n.endsWith('_sword')
    );
  });
  const pcts = tools
    .map((i) => {
      const max = i.maxDurability;
      if (!max || max <= 0) return 100;
      const cur = i.durability == null ? max : max - i.durability;
      return Math.min(100, Math.round((cur / max) * 100));
    })
    .filter((x) => x != null);
  if (pcts.length === 0) return 0;
  return Math.min(...pcts);
}

function foodScore(inv, mcData) {
  const foods = mcData?.foodsByName || {};
  let score = 0;
  for (const i of inv) {
    const f = foods[i.name];
    if (f) score += (f.foodPoints || 0) * i.count;
  }
  return Math.round(score);
}

function stoneTotal(inv) {
  return invCount(inv, (i) => i.name === 'cobblestone' || i.name === 'stone' || i.name === 'deepslate' || i.name === 'cobbled_deepslate');
}

function ironTotal(inv) {
  return invCount(inv, (i) => i.name === 'iron_ingot' || i.name === 'raw_iron');
}

function coalTotal(inv) {
  return invCount(inv, (i) => i.name === 'coal' || i.name === 'charcoal');
}

function diamondTotal(inv) {
  return invCount(inv, (i) => i.name === 'diamond');
}

function pickaxeDurabilityMinPercent(inv) {
  const picks = inv.filter((i) => i.name.endsWith('_pickaxe'));
  const pcts = picks
    .map((i) => {
      const max = i.maxDurability;
      if (!max || max <= 0) return 100;
      const cur = i.durability == null ? max : max - i.durability;
      return Math.min(100, Math.round((cur / max) * 100));
    })
    .filter((x) => x != null);
  if (pcts.length === 0) return 0;
  return Math.min(...pcts);
}

/**
 * Nearest hostile distance -> threat 0..1 (higher = worse)
 */
export function computeThreatScore(bot, filterFn) {
  if (!bot?.entity) return 0;
  const pos = bot.entity.position;
  const hostiles = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned', 'phantom', 'husk', 'stray'];
  let best = Infinity;
  for (const e of Object.values(bot.entities || {})) {
    if (e === bot.entity || !e.position) continue;
    if (e.type !== 'mob') continue;
    const name = (e.name || '').toLowerCase();
    if (!hostiles.some((h) => name.includes(h))) continue;
    if (filterFn && !filterFn(e)) continue;
    const d = e.position.distanceTo(pos);
    if (d < best) best = d;
  }
  if (!isFinite(best)) return 0;
  if (best > 48) return 0;
  return Math.max(0, Math.min(1, 1 - best / 48));
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {object} mcData
 * @param {object} [opts]
 * @param {object} [opts.chestSnapshots] map markName -> { total, at, items }
 */
export function buildMetricContext(bot, mcData, opts = {}) {
  const inv = bot?.inventory?.items() || [];
  const logs_total = invCount(inv, (i) => LOG_NAMES(i.name));
  const food_score = foodScore(inv, mcData);
  const stone_total = stoneTotal(inv);
  const iron_total = ironTotal(inv);
  const coal_total = coalTotal(inv);
  const diamond_total = diamondTotal(inv);
  const tool_durability_pct = toolDurabilityMinPercent(inv);
  const pickaxe_durability_pct = pickaxeDurabilityMinPercent(inv);
  const arrow_total = invCount(inv, (i) => i.name === 'arrow');
  const health = bot?.health ?? 20;
  const foodLevel = bot?.food ?? 20;
  const survive_score = Math.round((health / 20) * 50 + (foodLevel / 20) * 50);
  const threat_score = computeThreatScore(bot);

  return {
    logs_total,
    food_score,
    stone_total,
    iron_total,
    coal_total,
    diamond_total,
    tool_durability_pct,
    pickaxe_durability_pct,
    arrow_total,
    health,
    food_level: foodLevel,
    survive_score,
    threat_score,
    chestSnapshots: opts.chestSnapshots || {},
  };
}

export function readCurrentForMetric(metricKey, goal, ctx) {
  const params = goal.params || {};
  switch (metricKey) {
    case 'logs_total':
      return ctx.logs_total;
    case 'food_score':
      return ctx.food_score;
    case 'stone_total':
      return ctx.stone_total;
    case 'iron_total':
      return ctx.iron_total;
    case 'coal_total':
      return ctx.coal_total;
    case 'diamond_total':
      return ctx.diamond_total;
    case 'tool_durability_pct':
      return ctx.tool_durability_pct;
    case 'pickaxe_durability_pct':
      return ctx.pickaxe_durability_pct;
    case 'arrow_total':
      return ctx.arrow_total;
    case 'survive_score':
      return ctx.survive_score;
    case 'threat_score':
      return ctx.threat_score;
    case 'chest_mark_total': {
      const mark = params.chest_mark;
      if (!mark || !ctx.chestSnapshots[mark]) return null;
      return ctx.chestSnapshots[mark].total ?? 0;
    }
    default:
      return null;
  }
}

/**
 * Higher = more urgent (needs attention).
 */
export function computeUrgency(goal, current, targetMin, targetOk, now, deficitSinceMap) {
  const constraints = goal.constraints || {};
  const p = goal.priority ?? 50;
  const preempt = constraints.preempt_class || 'normal';
  const preemptBoost = preempt === 'critical' ? 1.5 : preempt === 'high' ? 1.2 : 1;

  if (current == null && goal.metric !== 'chest_mark_total') {
    return { urgency: 0.1 * preemptBoost, gap: null, satisfied: false, note: 'unknown_metric' };
  }
  if (current == null && goal.metric === 'chest_mark_total') {
    return { urgency: 0.15, gap: null, satisfied: false, note: 'chest_not_scanned' };
  }

  const minOk = targetMin ?? 0;
  const fullOk = targetOk ?? minOk;

  // For threat_score: lower current is better; urgency when high
  if (goal.metric === 'threat_score') {
    const sat = current <= minOk;
    const gap = sat ? 0 : current;
    const u = sat ? 0 : Math.min(1, gap * (p / 100) * preemptBoost);
    return { urgency: u, gap, satisfied: sat };
  }

  const gap = Math.max(0, fullOk - current);
  const depth = Math.max(0, minOk - current); // below minimum floor
  let urgency = depth > 0 ? 0.5 + Math.min(0.5, depth / Math.max(1, fullOk)) : Math.min(0.5, gap / Math.max(1, fullOk));
  urgency *= (p / 100) * preemptBoost;

  const id = goal.id;
  const since = deficitSinceMap[id];
  if (!since && current < fullOk) deficitSinceMap[id] = now;
  else if (current >= fullOk) delete deficitSinceMap[id];
  const inDeficit = since ? (now - since) / 1000 : 0;
  if (inDeficit > 30) urgency += Math.min(0.3, inDeficit / 300);

  const satisfied = current >= fullOk;
  return { urgency: Math.min(1.5, urgency), gap, satisfied, time_in_deficit_s: inDeficit || undefined };
}

export function scoreGoals(bot, mcData, store, chestSnapshots = {}) {
  const ctx = buildMetricContext(bot, mcData, { chestSnapshots });
  const now = Date.now();
  const out = [];
  const deficitSince = { ...store.deficitSince };

  for (const g of store.goals) {
    if (!g.enabled) continue;
    const targetMin = g.target_min ?? 0;
    const targetOk = g.target_ok ?? targetMin;
    const current = readCurrentForMetric(g.metric, g, ctx);
    const { urgency, gap, satisfied, time_in_deficit_s, note } = computeUrgency(
      g,
      current,
      targetMin,
      targetOk,
      now,
      deficitSince
    );
    out.push({
      ...g,
      current,
      target_min: targetMin,
      target_ok: targetOk,
      gap,
      urgency: Math.round(urgency * 1000) / 1000,
      satisfied: satisfied ?? false,
      time_in_deficit_s,
      note,
    });
  }

  out.sort((a, b) => b.urgency - a.urgency);
  return { scored: out, context: ctx, deficitSince };
}

export function loadPreset(presetName) {
  const file = path.join(presetsDir(), `${presetName}.json`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function listPresets() {
  const dir = presetsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

export function mergePresetIntoStore(store, preset) {
  const goals = Array.isArray(preset.goals) ? preset.goals : preset;
  if (!Array.isArray(goals)) return store;
  const byId = new Map(store.goals.map((g, i) => [g.id, i]));
  for (const g of goals) {
    if (!g.id) continue;
    if (byId.has(g.id)) {
      const idx = byId.get(g.id);
      store.goals[idx] = { ...store.goals[idx], ...g };
    } else {
      store.goals.push({
        enabled: true,
        strategies_available: [],
        constraints: { preempt_class: 'normal' },
        ...g,
      });
      byId.set(g.id, store.goals.length - 1);
    }
  }
  return store;
}
