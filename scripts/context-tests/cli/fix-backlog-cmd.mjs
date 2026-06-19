import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgv } from './util.mjs';
import { resolveRunRef, loadRunBundle } from '../lib/run-record.mjs';
import { contextJsonPathForRunDir, writeFixBacklogArtifacts, buildPromotionBacklog } from '../lib/fix-backlog.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

export function runFixBacklog(argv) {
  const { positional, flags } = parseArgv(argv);
  const sub = positional[0] || 'from-run';
  if (sub === 'from-run') {
    const entry = resolveRunRef(positional[1] || 'last');
    const bundle = loadRunBundle(entry);
    const ctxPath = contextJsonPathForRunDir(bundle.path);
    const out = writeFixBacklogArtifacts(ctxPath, { runId: entry.id, runDir: bundle.path });
    console.log(`Wrote ${out.jsonPath}`);
    if (flags.has('json')) console.log(JSON.stringify(out.backlog, null, 2));
    return;
  }
  if (sub === 'promote-compare') {
    const ba = loadRunBundle(resolveRunRef(positional[1] || 'last~1'));
    const bb = loadRunBundle(resolveRunRef(positional[2] || 'last'));
    const ctxA = JSON.parse(readFileSync(contextJsonPathForRunDir(ba.path), 'utf8'));
    const ctxB = JSON.parse(readFileSync(contextJsonPathForRunDir(bb.path), 'utf8'));
    const promotion = buildPromotionBacklog(ba, bb, ctxA, ctxB);
    const outJson = join(bb.path, 'promotion-backlog.json');
    writeFileSync(outJson, JSON.stringify(promotion, null, 2));
    console.log(`Wrote ${outJson}`);
    return;
  }
  console.error('Usage: fix-backlog from-run [id] | promote-compare [A] [B]');
  process.exit(1);
}
