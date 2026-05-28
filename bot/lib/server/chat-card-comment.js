// Chat->kanban-comment bridge. handleChat() scans messages for `t_xxxxxxxx`
// card ids; matching lines are recorded as comments via a fire-and-forget
// Python helper so chat handling never blocks on sqlite.

import { spawn as defaultSpawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'lib', 'kanban_chat_comment.py');

const CARD_ID_RE = /\bt_[a-f0-9]{8}\b/g;
const MIN_WORDS = 5;
const VIA_PREFIX = '[via:chat] ';

export function scanCardIds(message) {
  if (!message || typeof message !== 'string') return [];
  const seen = new Set();
  const out = [];
  let m;
  CARD_ID_RE.lastIndex = 0;
  while ((m = CARD_ID_RE.exec(message)) !== null) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

export function passesFilter(message) {
  if (!message || typeof message !== 'string') return false;
  return message.trim().split(/\s+/).filter(Boolean).length >= MIN_WORDS;
}

// argv array (not a shell string) -> no injection vector from chat text.
export function maybeRecordChatComment(
  { author, message },
  { spawn = defaultSpawn, helperPath = HELPER_PATH } = {}
) {
  if (!passesFilter(message)) return [];
  const ids = scanCardIds(message);
  if (ids.length === 0) return [];
  const body = `${VIA_PREFIX}${message}`;
  for (const id of ids) {
    const child = spawn(
      'python3',
      [helperPath, '--task-id', id, '--author', author, '--body', body],
      { stdio: 'ignore', detached: true }
    );
    if (child && typeof child.unref === 'function') child.unref();
    if (child && typeof child.on === 'function') child.on('error', () => {});
  }
  return ids;
}
