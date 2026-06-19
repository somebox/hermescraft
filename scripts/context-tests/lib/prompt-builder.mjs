import { readFileSync } from 'node:fs';

function formatToolResult(tr) {
  return '```json\n' + JSON.stringify(tr, null, 2) + '\n```';
}

/** Pull optional copy-paste hints from observe JSON (fixture lever for terrain-shaping). */
function observeHintsSection(observeJson) {
  if (!observeJson) return '';
  try {
    const o = JSON.parse(observeJson);
    const hints = o.next_action_hints;
    if (!Array.isArray(hints) || hints.length === 0) return '';
    const lines = hints.map((h) => (typeof h === 'string' ? `- ${h}` : `- ${JSON.stringify(h)}`));
    return (
      '\n\n# Suggested next commands (from observe)\n\n' +
      lines.join('\n') +
      '\n\nCopy one line exactly into your code block (no extra punctuation or commentary).'
    );
  } catch {
    return '';
  }
}

export function buildSnapshotMessages({
  persona,
  skills,
  cheatsheet,
  observeJson,
  memoryInline,
  prior,
  userPrompt,
}) {
  const sections = [];
  sections.push('# Persona\n\n' + persona);
  for (const sk of skills) {
    sections.push('# Skill\n\n' + sk);
  }
  if (memoryInline) {
    sections.push('# Agent memory\n\n' + memoryInline);
  }
  sections.push('# Available `mc` commands\n\n' + cheatsheet);
  if (observeJson) {
    let pretty;
    try {
      pretty = JSON.stringify(JSON.parse(observeJson), null, 2);
    } catch {
      pretty = observeJson;
    }
    sections.push('# Current game state (observe)\n\n```json\n' + pretty + '\n```' + observeHintsSection(observeJson));
  }
  if (prior?.length) {
    const lines = [];
    for (const p of prior) {
      lines.push(`Assistant: ${p.assistant}`);
      lines.push(`Tool result:\n${formatToolResult(p.tool_result)}`);
    }
    sections.push('# Recent actions\n\n' + lines.join('\n\n'));
  }
  sections.push(
    `# Output format

Reply with ONLY the mc command(s) inside a fenced code block. No prose unless needed.

\`\`\`
mc some_verb arg1 arg2
\`\`\`

Use ONLY verb names from the cheatsheet.`,
  );
  sections.push('# Task\n\n' + (userPrompt || 'Decide your next action.'));
  const userContent = sections.join('\n\n');
  return [
    { role: 'system', content: 'You are a Minecraft bot agent. Follow persona, skills, and task.' },
    { role: 'user', content: userContent },
  ];
}

export function buildTranscriptMessages({
  persona,
  skills,
  cheatsheet,
  observeJson,
  memoryInline,
  prior,
  priorFormat,
  userPrompt,
}) {
  if (priorFormat === 'tool_calls') {
    return buildTranscriptToolCalls({
      persona,
      skills,
      cheatsheet,
      observeJson,
      memoryInline,
      prior,
      userPrompt,
    });
  }
  return buildSnapshotMessages({
    persona,
    skills,
    cheatsheet,
    observeJson,
    memoryInline,
    prior,
    userPrompt,
  });
}

function buildTranscriptToolCalls(args) {
  const systemParts = ['# Persona\n\n' + args.persona];
  for (const sk of args.skills) systemParts.push('# Skill\n\n' + sk);
  if (args.memoryInline) systemParts.push('# Agent memory\n\n' + args.memoryInline);
  systemParts.push('# Available `mc` commands\n\n' + args.cheatsheet);
  const messages = [{ role: 'system', content: systemParts.join('\n\n') }];
  let observePretty = args.observeJson || '{}';
  try {
    observePretty = JSON.stringify(JSON.parse(args.observeJson), null, 2);
  } catch {
    /* keep */
  }
  messages.push({
    role: 'user',
    content: '# Observe\n\n```json\n' + observePretty + '\n```' + observeHintsSection(args.observeJson) + '\n\n# Task\n\n' + (args.userPrompt || ''),
  });
  let tcId = 0;
  for (const p of args.prior || []) {
    const id = `call_${tcId++}`;
    const cmd = p.assistant.startsWith('mc ') ? p.assistant : `mc ${p.assistant}`;
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id,
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: cmd }),
          },
        },
      ],
    });
    messages.push({
      role: 'tool',
      tool_call_id: id,
      content: JSON.stringify({ output: formatToolResult(p.tool_result) }),
    });
  }
  messages.push({ role: 'user', content: 'Decide your next action.' });
  return messages;
}

export function loadTextFiles(paths) {
  return paths.map((p) => readFileSync(p, 'utf8'));
}
