import { CHARS_PER_TOKEN_DEFAULT } from './constants.mjs';

export function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN_DEFAULT);
}

export function estimateRunCostUsd({
  promptTokensPerCall,
  outputTokensPerCall,
  calls,
  judgeCalls,
  modelInPer1m,
  modelOutPer1m,
  judgeInPer1m,
  judgeOutPer1m,
}) {
  const inM = (promptTokensPerCall * calls) / 1e6;
  const outM = (outputTokensPerCall * calls) / 1e6;
  let usd = inM * modelInPer1m + outM * modelOutPer1m;
  if (judgeCalls > 0) {
    const jIn = (promptTokensPerCall * 0.5 * judgeCalls) / 1e6;
    const jOut = (200 * judgeCalls) / 1e6;
    usd += jIn * judgeInPer1m + jOut * judgeOutPer1m;
  }
  return usd;
}
