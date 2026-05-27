#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeExpect, runPatterns } from '../grading.mjs';
import { judgeExpectations } from '../judge.mjs';
import { simulateMcLine } from '../../benchmark/cli-simulate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

const cases = [
  {
    name: 'forbidden_canonical',
    content: '```\nmc move 1 2 3\n```',
    expect: { tool_calls: { forbidden_canonical: ['move'], required_canonical_any: ['pillar_down'] } },
    shouldPass: false,
  },
  {
    name: 'required_canonical_any',
    content: '```\nmc pillar_down 6\n```',
    expect: { tool_calls: { required_canonical_any: ['pillar_down'] } },
    shouldPass: true,
  },
  {
    name: 'required_body',
    content: '```\nmc pillar_down 6\n```',
    expect: {
      tool_calls: {
        required_body: [{ verb: 'pillar_down', where: { count: { type: 'integer', min: 1 } } }],
      },
    },
    shouldPass: true,
  },
  {
    name: 'order',
    content: '```\nmc craft oak_planks\nmc craft sticks\n```',
    expect: {
      tool_calls: {
        order: { sequence: ['craft', 'craft'], horizon: 6, ignore: [] },
      },
    },
    shouldPass: true,
  },
  {
    name: 'shell_forbidden_parent',
    content: '```\nhermes kanban create [SCOUT] task --parent t_e7547df1\n```',
    expect: {
      shell_commands: {
        forbidden_substrings: ['--parent t_'],
      },
    },
    shouldPass: false,
    surface: 'shell',
  },
  {
    name: 'shell_required_complete',
    content: '```\nhermes kanban complete t_abc123\n```',
    expect: {
      shell_commands: {
        required_substrings_any: ['hermes kanban complete'],
      },
    },
    shouldPass: true,
    surface: 'shell',
  },
];

function simRows(content) {
  const lines = content.match(/^mc .+$/gm) || [];
  return lines.map((ln) => {
    const sim = simulateMcLine(ln);
    return { canonical_name: sim.canonical_name, parse_ok: sim.parse_ok, simulated_request: sim.simulated_request, raw: ln };
  });
}

const patternCases = [
  {
    name: 'pattern_defense_map_ok',
    content: '```\nmc map 16\n```',
    patterns: [
      {
        id: 'prioritizes_defense_action',
        type: 'defense_class_action_first',
        args: {
          allowed: ['wall', 'place', 'fence', 'fill'],
          perception_allowed: ['map', 'scene', 'observe'],
          max_perception: 1,
        },
      },
    ],
    shouldPass: true,
  },
  {
    name: 'pattern_defense_attack_fail',
    content: '```\nmc attack chicken\n```',
    patterns: [
      {
        id: 'prioritizes_defense_action',
        type: 'defense_class_action_first',
        args: {
          allowed: ['wall', 'place', 'fence', 'fill'],
          perception_allowed: ['map', 'scene', 'observe'],
          max_perception: 1,
        },
      },
    ],
    shouldPass: false,
  },
  {
    name: 'pattern_hint_followed',
    content: '```\nmc pillar_down 6\n```',
    patterns: [{ id: 'hint', type: 'next_action_hint_followed', args: {} }],
    prior: [
      {
        assistant: 'mc move 12 64 12',
        tool_result: { ok: false, error: { next_action_hint: 'mc pillar_down 6' } },
      },
    ],
    shouldPass: true,
  },
];

let failed = 0;
for (const c of cases) {
  const g = gradeExpect(c.content, c.expect, { surface: c.surface || 'mc' });
  const ok = g.pass === c.shouldPass;
  if (!ok) {
    failed++;
    console.error(`FAIL canary ${c.name}: expected pass=${c.shouldPass} got ${g.pass}`);
  }
}

for (const c of patternCases) {
  const rows = simRows(c.content.replace(/```/g, '').trim());
  const pr = runPatterns(rows, c.patterns, { prior: c.prior });
  if (pr.pass !== c.shouldPass) {
    failed++;
    console.error(`FAIL canary ${c.name}: expected pass=${c.shouldPass} got ${pr.pass}`, pr.trace);
  }
}

const calDir = join(REPO, 'data/context-tests/_calibration');
let apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  const sec = join(REPO, 'secrets.yaml');
  if (existsSync(sec)) {
    const m = readFileSync(sec, 'utf8').match(/openrouter_api_key:\s*(\S+)/);
    if (m) apiKey = m[1].trim();
  }
}

if (apiKey) {
  const gamingOut = readFileSync(join(calDir, 'gaming_verbose_wrong.txt'), 'utf8');
  const gamingExp = JSON.parse(readFileSync(join(calDir, 'gaming_expectation.json'), 'utf8'));
  const g = await judgeExpectations({
    apiKey,
    modelId: 'google/gemini-2.5-flash-lite',
    scenarioDescription: 'Mason base defense',
    agentOutput: gamingOut,
    simulatedRequests: simRows(gamingOut),
    expectations: [gamingExp],
    samples: 1,
    concurrency: 1,
  });
  const med = g.expectations[0]?.median;
  if (med == null || med > 0.3) {
    failed++;
    console.error(`FAIL canary gaming_verbose_wrong: median=${med} expected <=0.3`);
  } else {
    console.error(`canary gaming_verbose_wrong: median=${med?.toFixed(2)} OK`);
  }

  const goodOut = readFileSync(join(calDir, 'pillar_good.txt'), 'utf8');
  const pillarExp = JSON.parse(readFileSync(join(calDir, 'pillar_expectation.json'), 'utf8'));
  const pg = await judgeExpectations({
    apiKey,
    modelId: 'google/gemini-2.5-flash-lite',
    scenarioDescription: 'pillar down hint',
    agentOutput: goodOut,
    simulatedRequests: simRows(goodOut),
    expectations: [pillarExp],
    samples: 1,
    concurrency: 1,
  });
  const pmed = pg.expectations[0]?.median;
  if (pmed == null || pmed < 0.85) {
    failed++;
    console.error(`FAIL canary pillar_good: median=${pmed} expected >=0.85`);
  } else {
    console.error(`canary pillar_good: median=${pmed?.toFixed(2)} OK`);
  }
} else {
  console.error('canary: skip judge calibration (no OPENROUTER_API_KEY)');
}

if (failed) process.exit(1);
console.error(`canary: matcher + pattern cases OK`);
