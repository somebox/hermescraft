import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

export function attachDiagnosis(compactRow, manifest) {
  if (compactRow.verdict !== 'fail') return null;
  const emitted = [];
  for (const r of compactRow.runs || []) {
    if (r.outcome === 'matcher_fail') emitted.push('matcher_fail');
  }
  const expectation_low = [];
  if (compactRow.expectations_mean_avg != null && compactRow.expectations_mean_avg < 0.5) {
    expectation_low.push({
      median: compactRow.expectations_mean_avg,
      rationales: ['expectations_mean_avg below 0.5'],
    });
  }
  const prompt_evidence = [];
  const excerpt = compactRow.rendered_excerpt || '';
  if (manifest?.inputs) {
    for (const [key, hash] of Object.entries(manifest.inputs)) {
      if (!key.includes('profile') && !key.endsWith('.md')) continue;
      const pathRel = key.replace(/^profile:/, '');
      const rel = pathRel.includes('/') ? pathRel : findProfilePath(pathRel, manifest);
      if (!rel) continue;
      const abs = resolve(REPO_ROOT, rel);
      if (existsSync(abs)) {
        const lines = readFileSync(abs, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (/find|mining|region|protect/i.test(lines[i]) && excerpt.includes(lines[i].slice(0, 40))) {
            prompt_evidence.push({
              path: pathRel,
              line: i + 1,
              snippet: lines[i].trim().slice(0, 120),
            });
          }
        }
      }
    }
  }
  if (!prompt_evidence.length && excerpt) {
    const m = excerpt.match(/Before mining[^\n]+/i);
    if (m) prompt_evidence.push({ path: '(rendered)', line: 0, snippet: m[0].slice(0, 120) });
  }
  return {
    emitted,
    expectation_low,
    prompt_evidence: prompt_evidence.slice(0, 5),
  };
}

function findProfilePath(_hint, manifest) {
  for (const k of Object.keys(manifest.inputs || {})) {
    if (k.includes('prompts/')) return k;
  }
  return null;
}

export function enrichRunWithDiagnosis(bundle) {
  if (bundle.legacy || !bundle.run) return bundle;
  const manifest = bundle.manifest;
  for (const sc of bundle.run.scenarios || []) {
    sc.diagnosis = attachDiagnosis(sc, manifest);
  }
  return bundle;
}
