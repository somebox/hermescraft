import fs from 'fs';
import path from 'path';
import { fetchWithTimeout } from './poll.js';

const CACHE_MS = 60_000;
let cached = { at: 0, value: null };

function parseYamlKey(text, key) {
  const re = new RegExp(`^${key}:\\s*(.+)\\s*$`, 'm');
  const m = text.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

export function resolveOpenRouterKey(repoRoot) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const p = path.join(repoRoot, 'secrets.yaml');
  if (!fs.existsSync(p)) return null;
  const t = fs.readFileSync(p, 'utf8');
  return (
    parseYamlKey(t, 'openrouter_api_key') ||
    parseYamlKey(t, 'OPENROUTER_API_KEY') ||
    null
  );
}

/**
 * GET /api/v1/key — per-key limit, usage, daily/monthly breakdown.
 * @see https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
 * @param {string} apiKey
 */
export async function fetchOpenRouterKeyInfo(apiKey) {
  if (!apiKey) {
    return {
      balance_usd: null,
      usage_usd: null,
      usage_daily_usd: null,
      usage_monthly_usd: null,
      limit_usd: null,
      label: null,
    };
  }
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15_000,
  }).catch(() => null);
  if (!r || !r.ok) return { balance_usd: null, usage_usd: null };
  const j = await r.json().catch(() => null);
  const d = j?.data;
  if (!d) return { balance_usd: null, usage_usd: null };
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let balance = num(d.limit_remaining);
  if (balance == null && d.limit != null && d.usage != null) {
    const lim = num(d.limit);
    const use = num(d.usage);
    if (lim != null && use != null) balance = lim - use;
  }
  return {
    balance_usd: balance,
    usage_usd: num(d.usage),
    usage_daily_usd: num(d.usage_daily),
    usage_monthly_usd: num(d.usage_monthly),
    limit_usd: num(d.limit),
    label: typeof d.label === 'string' ? d.label : null,
    is_free_tier: Boolean(d.is_free_tier),
  };
}

/** Legacy account credits endpoint (fallback when /key has no limit_remaining). */
export async function fetchOpenRouterCredits(apiKey) {
  if (!apiKey) return { balance_usd: null, usage_usd: null };
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/credits', {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15_000,
  }).catch(() => null);
  if (!r || !r.ok) return { balance_usd: null, usage_usd: null };
  const j = await r.json().catch(() => null);
  const d = j?.data;
  if (!d) return { balance_usd: null, usage_usd: null };
  const balance = Number(d.total_credits);
  const usage = Number(d.total_usage);
  return {
    balance_usd: Number.isFinite(balance) ? balance : null,
    usage_usd: Number.isFinite(usage) ? usage : null,
  };
}

export async function getCachedOpenRouterCredits(repoRoot) {
  const now = Date.now();
  if (cached.value && now - cached.at < CACHE_MS) return cached.value;
  const key = resolveOpenRouterKey(repoRoot);
  const keyInfo = await fetchOpenRouterKeyInfo(key || '');
  let value = keyInfo;
  if (value.balance_usd == null && value.usage_usd == null) {
    const legacy = await fetchOpenRouterCredits(key || '');
    value = { ...legacy, ...keyInfo, balance_usd: legacy.balance_usd, usage_usd: legacy.usage_usd ?? keyInfo.usage_usd };
  } else if (value.balance_usd == null) {
    const legacy = await fetchOpenRouterCredits(key || '');
    if (legacy.balance_usd != null) value = { ...value, balance_usd: legacy.balance_usd };
  }
  cached = { at: now, value };
  return value;
}
