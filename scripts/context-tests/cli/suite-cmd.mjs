import { readFileSync } from 'node:fs';
import { parseArgv } from './util.mjs';
import { listSuiteFiles, loadSuiteFile } from '../lib/suite.mjs';

export function runSuite(argv) {
  const { positional, flags, opts } = parseArgv(argv);
  const sub = positional[0];
  if (sub === 'list') {
    for (const f of listSuiteFiles()) {
      const { id } = loadSuiteFile(f);
      console.log(id);
    }
    return;
  }
  if (sub === 'show') {
    const name = positional[1];
    const f = listSuiteFiles().find((p) => p.includes(`${name}.yaml`));
    if (!f) {
      console.error(`Suite not found: ${name}`);
      process.exit(1);
    }
    process.stdout.write(readFileSync(f, 'utf8'));
    return;
  }
  console.error('Usage: context-tuner suite list|show <name>');
  process.exit(1);
}
