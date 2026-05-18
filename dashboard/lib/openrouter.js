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
 * @param {string} apiKey
 */
export async function fetchOpenRouterCredits(apiKey) {
  if (!apiKey) return { balance_usd: null, usage_usd: null };
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/credits', {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15_000,
  }).catch(() => null);
  if (!r || !r.ok) return { balance_usd: null, usage_usd: null };
  const j = await r.json().catch(() => null);
  const d = j?.data;
  if (!d) return { balance_usd: null, usage_usd: null, raw: j };
  const balance = Number(d.total_credits);
  const usage = Number(d.total_usage);
  return {
    balance_usd: Number.isFinite(balance) ? balance : null,
    usage_usd: Number.isFinite(usage) ? usage : null,
    raw: j,
  };
}

export async function getCachedOpenRouterCredits(repoRoot) {
  const now = Date.now();
  if (cached.value && now - cached.at < CACHE_MS) return cached.value;
  const key = resolveOpenRouterKey(repoRoot);
  const value = await fetchOpenRouterCredits(key || '');
  cached = { at: now, value };
  return value;
}
