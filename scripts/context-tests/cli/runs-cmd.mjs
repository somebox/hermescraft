import { parseArgv, isPiped } from './util.mjs';
import { loadIndex, resolveRunRef, loadRunBundle } from '../lib/run-record.mjs';
import { enrichRunWithDiagnosis } from '../lib/diagnosis.mjs';

export function runRuns(argv) {
  const { positional, flags, opts } = parseArgv(argv);
  const sub = positional[0];
  if (sub === 'list') {
    const index = loadIndex();
    if (flags.has('json') || opts.json) {
      console.log(JSON.stringify(index.entries, null, 2));
      return;
    }
    if (isPiped()) {
      for (const e of index.entries) console.log(e.id);
      return;
    }
    console.log('id\tstamp\tlabel\tsuite\tsubject_model');
    for (const e of index.entries) {
      console.log([e.id, e.stamp, e.label || '', e.suite || '', e.subject_model || ''].join('\t'));
    }
    return;
  }
  if (sub === 'show' || sub === 'query') {
    const ref = positional[1] || 'last';
    const entry = resolveRunRef(ref);
    let bundle = loadRunBundle(entry);
    bundle = enrichRunWithDiagnosis(bundle);
    const failingOnly = flags.has('failing');
    if (sub === 'query') {
      let scenarios = bundle.legacy
        ? bundle.data.scenarios
        : bundle.run?.scenarios || [];
      if (failingOnly) {
        scenarios = scenarios.filter((s) => s.verdict === 'fail' || s.stable_pass === false);
      }
      if (flags.has('json') || opts.json) {
        console.log(JSON.stringify(scenarios, null, 2));
        return;
      }
      for (const s of scenarios) {
        console.log([s.id, s.verdict, s.pass_rate, s.judge_avg].join('\t'));
      }
      return;
    }
    if (flags.has('json') || opts.json) {
      console.log(JSON.stringify({ entry, bundle }, null, 2));
      return;
    }
    console.error(JSON.stringify(bundle.manifest || { legacy: bundle.legacy }, null, 2));
    return;
  }
  console.error('Usage: context-tuner runs list|show|query <id|last>');
  process.exit(1);
}
