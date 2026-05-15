/**
 * Normalize OpenRouter / OpenAI-style usage objects for benchmark run JSON.
 */

/**
 * @param {unknown} usage
 */
export function extractReportedBilling(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      tokens_reported: {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
      },
      cost_reported_usd: null,
      upstream_inference_cost_usd: null,
    };
  }
  const u = /** @type {Record<string, unknown>} */ (usage);
  const pt = u.prompt_tokens;
  const ct = u.completion_tokens;
  const tt = u.total_tokens;
  const costRep =
    typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null;
  const cd = /** @type {Record<string, unknown>|undefined} */ (u.cost_details);
  const upstream =
    cd &&
    typeof cd.upstream_inference_cost === 'number' &&
    Number.isFinite(cd.upstream_inference_cost)
      ? cd.upstream_inference_cost
      : null;
  return {
    tokens_reported: {
      prompt_tokens: typeof pt === 'number' ? pt : null,
      completion_tokens: typeof ct === 'number' ? ct : null,
      total_tokens: typeof tt === 'number' ? tt : null,
    },
    cost_reported_usd: costRep,
    upstream_inference_cost_usd: upstream,
  };
}

/**
 * Sum billing across multiple completion responses (e.g. two-tier decomposer + executor calls).
 * @param {(unknown|null|undefined)[]} usages
 */
export function rollupUsages(usages) {
  let calls = 0;
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let costRep = 0;
  let upstream = 0;
  for (const usage of usages) {
    if (!usage) continue;
    calls++;
    const b = extractReportedBilling(usage);
    const tr = b.tokens_reported;
    if (tr.prompt_tokens != null) prompt += tr.prompt_tokens;
    if (tr.completion_tokens != null) completion += tr.completion_tokens;
    if (tr.total_tokens != null) total += tr.total_tokens;
    if (b.cost_reported_usd != null) costRep += b.cost_reported_usd;
    if (b.upstream_inference_cost_usd != null) upstream += b.upstream_inference_cost_usd;
  }
  return {
    llm_calls: calls,
    prompt_tokens_sum: prompt,
    completion_tokens_sum: completion,
    total_tokens_sum: total,
    cost_reported_usd_sum: costRep,
    upstream_inference_cost_usd_sum: upstream,
  };
}

/**
 * Aggregate one-shot benchmark rows (run.mjs).
 * @param {Record<string, unknown>[]} results
 */
export function summarizeRunBilling(results) {
  let calls = 0;
  let withUsage = 0;
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let costRep = 0;
  let upstream = 0;
  let costUsd = 0;
  for (const r of results) {
    calls++;
    if (r.usage) withUsage++;
    const tr = /** @type {{ prompt_tokens?: unknown, completion_tokens?: unknown, total_tokens?: unknown }|undefined} */ (
      r.tokens_reported
    );
    if (tr?.prompt_tokens != null && typeof tr.prompt_tokens === 'number') prompt += tr.prompt_tokens;
    if (tr?.completion_tokens != null && typeof tr.completion_tokens === 'number')
      completion += tr.completion_tokens;
    if (tr?.total_tokens != null && typeof tr.total_tokens === 'number') total += tr.total_tokens;
    if (typeof r.cost_reported_usd === 'number') costRep += r.cost_reported_usd;
    if (typeof r.upstream_inference_cost_usd === 'number') upstream += r.upstream_inference_cost_usd;
    if (typeof r.cost_usd === 'number') costUsd += r.cost_usd;
  }
  return {
    calls,
    calls_with_usage: withUsage,
    prompt_tokens_sum: prompt,
    completion_tokens_sum: completion,
    total_tokens_sum: total,
    cost_reported_usd_sum: costRep,
    upstream_inference_cost_usd_sum: upstream,
    cost_usd_sum: costUsd,
  };
}

/**
 * Aggregate two-tier benchmark rows (run-two-tier.mjs).
 * @param {Record<string, unknown>[]} results
 */
export function summarizeTwoTierBilling(results) {
  const acc = {
    composition_tasks: results.length,
    llm_calls: 0,
    prompt_tokens_sum: 0,
    completion_tokens_sum: 0,
    total_tokens_sum: 0,
    cost_reported_usd_sum: 0,
    upstream_inference_cost_usd_sum: 0,
    cost_usd_sum: 0,
  };
  for (const r of results) {
    const roll = /** @type {Record<string, number>|undefined} */ (r.api_rollups);
    if (roll) {
      acc.llm_calls += roll.llm_calls ?? 0;
      acc.prompt_tokens_sum += roll.prompt_tokens_sum ?? 0;
      acc.completion_tokens_sum += roll.completion_tokens_sum ?? 0;
      acc.total_tokens_sum += roll.total_tokens_sum ?? 0;
      acc.cost_reported_usd_sum += roll.cost_reported_usd_sum ?? 0;
      acc.upstream_inference_cost_usd_sum += roll.upstream_inference_cost_usd_sum ?? 0;
    }
    if (typeof r.cost_usd === 'number') acc.cost_usd_sum += r.cost_usd;
  }
  return acc;
}
