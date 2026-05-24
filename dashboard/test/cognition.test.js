import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  truncate,
  renderToolCallArgs,
  renderToolResult,
  loadSessionMessages,
  extractTurns,
  extractTurnsTail,
  newestSessionFile,
} from '../lib/cognition.js';

describe('cognition', () => {
  it('truncate adds ellipsis', () => {
    assert.equal(truncate('hello', 10), 'hello');
    assert.ok(truncate('x'.repeat(50), 10).endsWith('…'));
  });

  it('renderToolCallArgs extracts mc command', () => {
    const cmd = renderToolCallArgs(JSON.stringify({ command: 'mc status' }));
    assert.equal(cmd, 'mc status');
  });

  it('renderToolResult detects ERROR output', () => {
    const { text, isError } = renderToolResult(
      JSON.stringify({ output: 'ERROR: something failed' }),
    );
    assert.equal(isError, true);
    assert.ok(text.includes('ERROR'));
  });

  it('extractTurns yields think, say, and tool from assistant message', () => {
    const messages = [
      {
        role: 'assistant',
        reasoning_content: 'I should check inventory',
        content: 'Checking now.',
        tool_calls: [
          {
            function: { name: 'run_terminal_cmd', arguments: '{"command":"mc status"}' },
          },
        ],
      },
      { role: 'tool', content: '{"output":"ok"}' },
    ];
    const { turns, nextIndex } = extractTurns(messages, { limit: 10, sinceIndex: 0 });
    assert.equal(nextIndex, 2);
    assert.ok(turns.some((t) => t.kind === 'think' && t.text.includes('inventory')));
    assert.ok(turns.some((t) => t.kind === 'say'));
    assert.ok(turns.some((t) => t.kind === 'tool' && t.text === 'mc status'));
    assert.ok(turns.some((t) => t.kind === 'tool_result'));
  });

  it('loadSessionMessages handles messages wrapper', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cog-'));
    const fp = path.join(dir, 's.json');
    fs.writeFileSync(fp, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(loadSessionMessages(fp).length, 1);
    fs.rmSync(dir, { recursive: true });
  });

  it('extractTurns includes user prompts', () => {
    const messages = [{ role: 'user', content: 'go mine iron' }];
    const { turns } = extractTurns(messages, { limit: 5, sinceIndex: 0 });
    assert.equal(turns.length, 1);
    assert.equal(turns[0].kind, 'user');
  });

  it('extractTurnsTail returns last turns only', () => {
    const messages = [
      { role: 'assistant', reasoning_content: 'first thought', content: '' },
      { role: 'assistant', reasoning_content: 'second thought', content: '' },
      { role: 'assistant', reasoning_content: 'third thought', content: '' },
    ];
    const tail = extractTurnsTail(messages, { limit: 2, kinds: ['think'] });
    assert.equal(tail.length, 2);
    assert.ok(tail[0].text.includes('second'));
    assert.ok(tail[1].text.includes('third'));
  });

  it('newestSessionFile picks latest mtime', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-sess-'));
    const old = path.join(dir, 'session_old.json');
    const neu = path.join(dir, 'session_new.json');
    fs.writeFileSync(old, '[]');
    fs.writeFileSync(neu, '[]');
    const t = Date.now();
    fs.utimesSync(old, t / 1000 - 100, t / 1000 - 100);
    fs.utimesSync(neu, t / 1000, t / 1000);
    assert.equal(path.basename(newestSessionFile(dir)), 'session_new.json');
    fs.rmSync(dir, { recursive: true });
  });
});
