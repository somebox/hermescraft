#!/usr/bin/env node
/**
 * List OpenRouter models whose prompt + completion price (USD per 1M tokens)
 * are both <= --max-usd-per-1m (default 0.2). Matches the spirit of the UI filter
 * https://openrouter.ai/models?order=top-weekly&max_price=0.2
 *
 * Pricing comes from the public GET https://openrouter.ai/api/v1/models API
 * (prompt/completion fields are USD per token — we multiply by 1e6).
 *
 * Usage:
 *   node scripts/benchmark/list-openrouter-models.mjs
 *   node scripts/benchmark/list-openrouter-models.mjs --max-usd-per-1m 0.2 --limit 40
 *   node scripts/benchmark/list-openrouter-models.mjs --free-only --limit 50
 */
import process from 'node:process';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

const MAX_PROMPT = Number(arg('--max-usd-per-1m', '0.2'));
const LIMIT = Number(arg('--limit', '80'));
const FREE_ONLY = has('--free-only');

function per1m(tokenPriceStr) {
  const n = Number(tokenPriceStr);
  if (!Number.isFinite(n) || n < 0) return Infinity;
  return n * 1e6;
}

const res = await fetch('https://openrouter.ai/api/v1/models');
if (!res.ok) {
  console.error(`OpenRouter models HTTP ${res.status}`);
  process.exit(1);
}
const { data } = await res.json();
if (!Array.isArray(data)) {
  console.error('Unexpected API shape');
  process.exit(1);
}

/** @type {{ id: string, cost_per_1m_in: number, cost_per_1m_out: number, free: boolean }[]} */
const rows = [];
for (const m of data) {
  const p = m.pricing?.prompt ?? '0';
  const c = m.pricing?.completion ?? '0';
  const in1m = per1m(p);
  const out1m = per1m(c);
  const free = in1m === 0 && out1m === 0;
  if (FREE_ONLY && !free) continue;
  if (!FREE_ONLY && (in1m > MAX_PROMPT || out1m > MAX_PROMPT)) continue;
  rows.push({
    id: m.id,
    cost_per_1m_in: free ? 0 : in1m,
    cost_per_1m_out: free ? 0 : out1m,
    free,
  });
}

rows.sort((a, b) => a.cost_per_1m_in + a.cost_per_1m_out - (b.cost_per_1m_in + b.cost_per_1m_out));

const slice = rows.slice(0, LIMIT);

console.log(
  JSON.stringify(
    {
      comment: `OpenRouter models with prompt/completion <= $${MAX_PROMPT}/1M tokens${FREE_ONLY ? ' (free only)' : ''}. Paste ids into models.json — verify names/pricing before production runs.`,
      source: 'https://openrouter.ai/api/v1/models',
      ui_filter_like: 'https://openrouter.ai/models?order=top-weekly&max_price=0.2',
      count_listed: slice.length,
      count_matched: rows.length,
      models: slice.map((r) => ({
        id: r.id,
        label: r.id.split('/').pop()?.replace(/:free$/, '') || r.id,
        cost_per_1m_in: r.cost_per_1m_in,
        cost_per_1m_out: r.cost_per_1m_out,
        tier: r.free ? 'free' : 'cheap-openrouter',
      })),
    },
    null,
    2,
  ),
);
