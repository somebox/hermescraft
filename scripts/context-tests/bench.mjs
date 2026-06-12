#!/usr/bin/env node
import { runDoctor } from './cli/doctor-cmd.mjs';
import { runScenario } from './cli/scenario-cmd.mjs';
import { runVariant } from './cli/variant-cmd.mjs';
import { runSuite } from './cli/suite-cmd.mjs';
import { runRunCmd } from './cli/run-cmd.mjs';
import { runRuns } from './cli/runs-cmd.mjs';
import { runCompare } from './cli/compare-cmd.mjs';
import { runTrend } from './cli/trend-cmd.mjs';

const HELP = `context-tuner — prompt/context signal workbench

Usage:
  context-tuner doctor [--json]
  context-tuner scenario new <id> --template=<error-recovery|policy-rule|stuck-escalation|bare> [--profile=PATH]
  context-tuner scenario list|show|validate [<id>|--all]|archive <id>
  context-tuner variant new <scenario> <label> [--override PATH | --profile -]
  context-tuner variant list <scenario>
  context-tuner suite list|show <name>
  context-tuner run <scenario|suite|config> [--config experiment.yaml] [--runs=N] [--no-judge] [--yes] [-q]
  context-tuner runs list|show|query <id|last|last~N> [--json] [--failing]
  context-tuner compare [<A>] [<B>] [--json] [--append-learnings]
  context-tuner trend <suite-preset> [-n N] [--json]
  context-tuner trend --scenario <id> [-n N] [--json]

Exit codes: 0 ok, 1 usage, 2 validate fail, 3 grading failures, 4 infra abort
Docs: docs/testing/context-tuner/README.md
`;

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
  console.log(HELP);
  process.exit(0);
}

const cmd = argv[0];
const rest = argv.slice(1);

try {
  switch (cmd) {
    case 'doctor':
      runDoctor(rest);
      break;
    case 'scenario':
      runScenario(rest);
      break;
    case 'variant':
      runVariant(rest);
      break;
    case 'suite':
      runSuite(rest);
      break;
    case 'run':
      runRunCmd(rest);
      break;
    case 'runs':
      runRuns(rest);
      break;
    case 'compare':
      runCompare(rest);
      break;
    case 'trend':
      runTrend(rest);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
