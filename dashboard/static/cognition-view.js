/**
 * Mind panel rendering (aligned with scripts/watch-agent.py).
 */
import { el } from './detail-view.js';

function appendCogText(container, className, tag, text) {
  const block = el('div', className, null);
  block.appendChild(el('span', 'cog-tag', tag));
  const body = el('div', 'cog-text');
  for (const line of String(text || '').split('\n')) {
    const t = line.trimEnd();
    if (!t && !body.childNodes.length) continue;
    body.appendChild(el('div', 'cog-text-line', t || '\u00a0'));
  }
  block.appendChild(body);
  container.appendChild(block);
}

export function appendMindTurn(container, turn) {
  const key = turn.turnKey || `${turn.index}:${turn.kind}`;
  if (container.querySelector(`[data-turn-key="${CSS.escape(key)}"]`)) return;

  if (turn.kind === 'user') {
    const line = el('div', 'cog-line cog-user');
    line.dataset.turnKey = key;
    appendCogText(line, 'cog-line-inner', 'USER', turn.text);
    container.appendChild(line);
    return;
  }
  if (turn.kind === 'think') {
    const line = el('div', 'cog-line cog-think');
    line.dataset.turnKey = key;
    appendCogText(line, 'cog-line-inner cog-think-inner', '·', turn.text);
    container.appendChild(line);
    return;
  }
  if (turn.kind === 'say') {
    const line = el('div', 'cog-line cog-say');
    line.dataset.turnKey = key;
    appendCogText(line, 'cog-line-inner', 'AGENT', turn.text);
    container.appendChild(line);
    return;
  }
  if (turn.kind === 'tool') {
    const line = el('div', 'cog-line cog-tool');
    line.dataset.turnKey = key;
    line.appendChild(el('span', 'cog-tag', '⚙'));
    line.appendChild(el('span', 'cog-tool-name', turn.toolName || 'tool'));
    line.appendChild(el('span', 'cog-tool-args', turn.text || ''));
    container.appendChild(line);
    return;
  }
  if (turn.kind === 'tool_result') {
    const line = el('div', `cog-line cog-out ${turn.isError ? 'cog-err' : ''}`);
    line.dataset.turnKey = key;
    line.appendChild(el('span', 'cog-tag', turn.isError ? '✗' : '←'));
    line.appendChild(el('span', 'cog-out-text', turn.text || ''));
    container.appendChild(line);
    return;
  }
  const line = el('div', 'cog-line', turn.text || '');
  line.dataset.turnKey = key;
  container.appendChild(line);
}

export function ensureMindSessionHeader(mind, agentName, sessionFile, homeLabel) {
  let head = mind.querySelector('.mind-session-head');
  if (!head) {
    head = el('div', 'mind-session-head muted', '');
    mind.prepend(head);
  }
  const src = homeLabel ? `${homeLabel}` : agentName;
  head.textContent = sessionFile ? `${src} · ${sessionFile}` : `${src} · (no session)`;
}

export function renderMindEmpty(mind, message) {
  mind.replaceChildren();
  mind.dataset.mindKey = '';
  mind.appendChild(el('p', 'mind-empty muted', message));
}
