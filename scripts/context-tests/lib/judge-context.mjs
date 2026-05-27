const MC_CONVENTIONS = `## HermesCraft \`mc\` CLI (for grading only)

- The agent emits lines like \`mc <verb> ...\`. The harness parses them into **canonical_name** (registry aliases collapsed) and HTTP **body** — trust that parse when \`parse_ok\` is true.
- Verb names are **project-specific**, not generic Minecraft English: examples include \`pillar_down\`, \`place_fill\` (canonical often \`fill\`), \`advise\` (requires \`--reason="..."\`), \`craft_plan\`, \`goto_near\`, \`safe_dig\`, \`defense_class\` build verbs (\`wall\`, \`fence\`), perception (\`map\`, \`scene\`, \`observe\`).
- **Do not** mark down correct parsed verbs because they look odd; grade whether the **choice of verbs and order** meets the expectation statement.
- Prose in the agent reply is optional; fenced \`mc\` blocks are what matter unless the expectation explicitly asks for chat or explanation.
- Tool results in the scenario description may include \`next_action_hint\` strings like \`mc pillar_down 6\` — following those hints is correct even if the judge would not invent that syntax alone.
`;

/**
 * @param {{ judgeCfg?: object, cheatsheet?: string, scenarioJudgeContext?: string }} opts
 */
export function buildJudgeContext(opts = {}) {
  const judgeCfg = opts.judgeCfg || {};
  if (judgeCfg.context === false || judgeCfg.context_mode === 'none') {
    return opts.scenarioJudgeContext || '';
  }

  const parts = [];
  if (opts.scenarioJudgeContext) parts.push(opts.scenarioJudgeContext);

  const includeConventions =
    judgeCfg.context_mode === 'mc_conventions' || judgeCfg.include_mc_conventions === true;
  if (includeConventions && !opts.scenarioJudgeContext?.includes('HermesCraft')) {
    parts.push(MC_CONVENTIONS);
  }

  if (judgeCfg.include_cheatsheet && opts.cheatsheet) {
    const max = judgeCfg.cheatsheet_max_chars ?? 10000;
    const sheet =
      opts.cheatsheet.length > max
        ? opts.cheatsheet.slice(0, max) + '\n\n…(cheatsheet truncated)…'
        : opts.cheatsheet;
    parts.push('## mc command cheatsheet (reference)\n\n' + sheet);
  }

  return parts.filter(Boolean).join('\n\n');
}
