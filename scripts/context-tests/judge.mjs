import { extractReportedBilling } from '../benchmark/billing-extract.mjs';
import { mapPool } from './lib/pool.mjs';
import { median, stddev } from './lib/stats.mjs';

export async function runJudge({ apiKey, modelId, rubric, description, agentOutput, timeoutMs = 60000 }) {
  const prompt = `You are grading a Minecraft agent's response to a scenario.

Scenario:
${description || ''}

Rubric:
${rubric}

Agent response:
${agentOutput}

Return strict JSON only: {"score": 0.0 to 1.0, "rationale": "..."}`;

  return callJudgeApi({ apiKey, modelId, prompt, timeoutMs, temperature: 0 });
}

async function callJudgeApi({ apiKey, modelId, prompt, timeoutMs = 60000, temperature = 0.3 }) {
  const t0 = Date.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/foz/hermescraft',
        'X-Title': 'context-tests judge',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 350,
        temperature,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed_ms = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text();
      return { error: `${res.status}: ${text.slice(0, 200)}`, elapsed_ms };
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    let parsed = { score: null, rationale: content };
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        /* keep */
      }
    }
    const reported = extractReportedBilling(data.usage);
    return {
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : null,
      rationale: parsed.rationale || '',
      elapsed_ms,
      usage: data.usage,
      cost_reported_usd: reported.cost_reported_usd,
    };
  } catch (e) {
    return { error: String(e.message || e), elapsed_ms: Date.now() - t0 };
  }
}

/**
 * Grade NL expectations with N samples per expectation (median score).
 */
export async function judgeExpectations({
  apiKey,
  modelId,
  scenarioDescription,
  agentOutput,
  simulatedRequests,
  expectations,
  judgeContext = '',
  samples = 3,
  concurrency = 4,
  timeoutMs = 60000,
  temperature = 0.3,
}) {
  const simJson = JSON.stringify(
    (simulatedRequests || []).map((s) => ({
      canonical_name: s.canonical_name,
      parse_ok: s.parse_ok,
      path: s.simulated_request?.path,
      body: s.simulated_request?.body,
    })),
    null,
    2,
  );

  const tasks = [];
  for (const exp of expectations || []) {
    for (let s = 0; s < samples; s++) {
      tasks.push({ exp, sample: s });
    }
  }

  const results = await mapPool(tasks, concurrency, async ({ exp }) => {
    const ctxBlock = judgeContext
      ? `\nGrading reference (mc conventions — use when interpreting parsed verbs):\n${judgeContext}\n`
      : '';

    const prompt = `You grade one expectation about a Minecraft bot agent's reply.

Scenario context:
${scenarioDescription || ''}
${ctxBlock}
Expectation id: ${exp.id}
Statement:
${exp.statement}

Parsed mc commands (canonical names and bodies):
${simJson}

Agent full response:
${agentOutput}

Score how well the agent satisfies ONLY this expectation. 0.0 = not at all, 1.0 = fully.
Return strict JSON: {"score": number, "rationale": "one short paragraph"}`;

    const r = await callJudgeApi({ apiKey, modelId, prompt, timeoutMs, temperature });
    return { expId: exp.id, threshold: exp.threshold ?? 0.7, weight: exp.weight ?? 1, result: r };
  });

  /** @type {Record<string, { id: string, scores: number[], rationales: string[], median: number|null, spread: number, threshold: number, weight: number, pass_advisory: boolean, cost_usd: number }>} */
  const byId = {};
  let totalCost = 0;
  for (const row of results) {
    const id = row.expId;
    if (!byId[id]) {
      byId[id] = {
        id,
        scores: [],
        rationales: [],
        median: null,
        spread: 0,
        threshold: row.threshold,
        weight: row.weight,
        pass_advisory: false,
        cost_usd: 0,
        errors: [],
      };
    }
    const b = byId[id];
    if (row.result.error) {
      b.errors.push(row.result.error);
      continue;
    }
    if (row.result.score != null) b.scores.push(row.result.score);
    if (row.result.rationale) b.rationales.push(row.result.rationale);
    totalCost += row.result.cost_reported_usd || 0;
    b.cost_usd += row.result.cost_reported_usd || 0;
  }

  const graded = Object.values(byId).map((b) => {
    b.median = median(b.scores);
    b.spread = stddev(b.scores);
    b.pass_advisory = b.median != null && b.median >= b.threshold;
    return b;
  });

  const weightSum = graded.reduce((s, g) => s + (g.weight || 1), 0);
  const weightedMean =
    weightSum && graded.every((g) => g.median != null)
      ? graded.reduce((s, g) => s + g.median * g.weight, 0) / weightSum
      : null;

  return {
    expectations: graded,
    weighted_mean: weightedMean,
    total_cost_usd: totalCost,
  };
}
