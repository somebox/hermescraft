import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKnownNames,
  parseMessageRouting,
  isMessageForMe,
  broadcastMentionsMe,
  stripMentionPrefix,
  stripInlineNameMention,
  applySocialEvent,
  summarizeSocialGraph,
  selectRecentChat,
} from '../lib/shared/chat.js';

test('known names include current cast and nearby names', () => {
  const known = buildKnownNames('HermesBot', ['Alex', 'Flint']);
  assert.ok(known.includes('flint'));
  assert.ok(known.includes('steve'));
  assert.ok(known.includes('alex'));
  assert.ok(known.includes('hermesbot'));
});

test('parseMessageRouting handles direct and group messages', () => {
  const known = buildKnownNames('HermesBot', ['Alex']);
  assert.deepEqual(parseMessageRouting('Flint: come here', { knownNames: known }), {
    targets: ['flint'],
    body: 'come here',
    isBroadcast: false,
    channel: 'direct',
  });

  assert.deepEqual(parseMessageRouting('@Flint: come here', { knownNames: known }), {
    targets: ['flint'],
    body: 'come here',
    isBroadcast: false,
    channel: 'direct',
  });

  assert.deepEqual(parseMessageRouting('Steve,Flint: regroup', { knownNames: known }), {
    targets: ['steve', 'flint'],
    body: 'regroup',
    isBroadcast: false,
    channel: 'group_dm',
  });

  assert.deepEqual(parseMessageRouting('@Steve, @Flint: regroup', { knownNames: known }), {
    targets: ['steve', 'flint'],
    body: 'regroup',
    isBroadcast: false,
    channel: 'group_dm',
  });
});

test('parseMessageRouting falls back to public when prefix is not a valid name', () => {
  const known = buildKnownNames('HermesBot');
  const routed = parseMessageRouting('Hello: world', { knownNames: known });
  assert.equal(routed.isBroadcast, true);
  assert.equal(routed.channel, 'public');
  assert.equal(routed.body, 'Hello: world');

  const mixed = parseMessageRouting('Hello,Flint: regroup', { knownNames: known });
  assert.equal(mixed.isBroadcast, true);
  assert.equal(mixed.channel, 'public');
  assert.equal(mixed.body, 'Hello,Flint: regroup');
});

test('mention parsing strips prefix cleanly', () => {
  assert.equal(broadcastMentionsMe('Hermes, build a house', 'HermesBot'), 'Hermes');
  assert.equal(stripMentionPrefix('Hermes, build a house', 'Hermes'), 'build a house');

  assert.equal(broadcastMentionsMe('@HermesBot dig west', 'HermesBot'), '@HermesBot');
  assert.equal(stripMentionPrefix('@HermesBot dig west', '@HermesBot'), 'dig west');

  assert.equal(broadcastMentionsMe('@hermes status', 'Gatherer'), '@hermes');
  assert.equal(stripMentionPrefix('@hermes status', '@hermes'), 'status');
});

test('stripInlineNameMention catches mid-sentence Flint / @Flint', () => {
  assert.equal(stripInlineNameMention('hey Flint can you mine coal', 'Flint'), 'hey can you mine coal');
  assert.equal(stripInlineNameMention('Flint: wait — actually mine west', 'flint'), 'wait — actually mine west');
  assert.equal(stripInlineNameMention('deflint is not a mention', 'flint'), null);
  assert.equal(stripInlineNameMention('hello everyone', 'flint'), null);
});

test('isMessageForMe respects direct targets and bot aliases', () => {
  const direct = { targets: ['flint'], isBroadcast: false };
  const alias = { targets: ['hermes'], isBroadcast: false };
  assert.equal(isMessageForMe(direct, 'Flint'), true);
  assert.equal(isMessageForMe(alias, 'Flint'), true);
});

test('social graph tracks heard, sent, and completed command events', () => {
  const graph = {};
  applySocialEvent(graph, { actor: 'alex', kind: 'heard', channel: 'public', command: true, time: Date.now(), message: 'hermes follow me' });
  applySocialEvent(graph, { actor: 'alex', kind: 'sent', channel: 'direct', time: Date.now(), message: 'on my way' });
  applySocialEvent(graph, { actor: 'alex', kind: 'completed_command', channel: 'direct', time: Date.now() });

  const summary = summarizeSocialGraph(graph, { limit: 1 })[0];
  assert.equal(summary.name, 'alex');
  assert.equal(summary.heard_public, 1);
  assert.equal(summary.sent_private, 1);
  assert.equal(summary.commands_given, 1);
  assert.equal(summary.commands_completed, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// selectRecentChat — backs the briefState.new_chat cursor. Patterns drawn
// from the round-1 in-game transcript where every action response within
// 120s of a chat re-emitted the same chat lines, bloating context across
// dozens of tool calls.
// ─────────────────────────────────────────────────────────────────────────

test('selectRecentChat: returns all qualifying chat when cursor is 0', () => {
  const now = 1_000_000;
  const chatLog = [
    { time: now - 30_000, from: 're44', message: 'hi steve' },
    { time: now - 10_000, from: 'Mason', message: 'go east', private: true },
  ];
  const out = selectRecentChat(chatLog, now, 0, 'Steve');
  assert.equal(out.length, 2);
  // Direct/whisper carries the `direct` marker; plain broadcasts don't.
  const direct = out.find((m) => m.from === 'Mason');
  assert.equal(direct?.direct, true);
  const broadcast = out.find((m) => m.from === 're44');
  assert.equal(broadcast?.direct, undefined);
});

test('selectRecentChat: cursor advance suppresses already-seen chat', () => {
  const now = 1_000_000;
  const chatLog = [
    { time: now - 30_000, from: 're44', message: 'hi steve' },
    { time: now - 10_000, from: 'Mason', message: 'go east' },
  ];
  // First call: cursor 0, both messages surface.
  const first = selectRecentChat(chatLog, now, 0, 'Steve');
  assert.equal(first.length, 2);
  // Second call: cursor advanced past both messages (now-anchored), nothing
  // new to show. This is the fix for the round-1 repetition bug.
  const second = selectRecentChat(chatLog, now + 1000, now, 'Steve');
  assert.equal(second.length, 0);
});

test('selectRecentChat: new chat after cursor surfaces only the new message', () => {
  const now = 2_000_000;
  const chatLog = [
    { time: now - 30_000, from: 're44', message: 'old message' },
    { time: now - 5_000,  from: 're44', message: 'new message' },
  ];
  // Cursor placed between the two messages — only the second surfaces.
  const cursorBetween = now - 20_000;
  const out = selectRecentChat(chatLog, now, cursorBetween, 'Steve');
  assert.equal(out.length, 1);
  assert.equal(out[0].message, 'new message');
});

test('selectRecentChat: drops bot self-chat and Server lines', () => {
  const now = 1_000_000;
  const chatLog = [
    { time: now - 1000, from: 'Steve', message: 'I said this' },
    { time: now - 1000, from: 'Server', message: '[Server] something' },
    { time: now - 1000, from: 're44', message: 'hi steve' },
  ];
  const out = selectRecentChat(chatLog, now, 0, 'Steve');
  assert.equal(out.length, 1);
  assert.equal(out[0].from, 're44');
});

test('selectRecentChat: 2-min hard window backstops the cursor', () => {
  const now = 1_000_000;
  const chatLog = [
    { time: now - 200_000, from: 're44', message: 'ancient message' }, // outside window
    { time: now - 30_000,  from: 're44', message: 'fresh message' },
  ];
  // Even with cursor=0 (never seen anything), the ancient line stays out.
  const out = selectRecentChat(chatLog, now, 0, 'Steve');
  assert.equal(out.length, 1);
  assert.equal(out[0].message, 'fresh message');
});

test('selectRecentChat: direct messages always pass; broadcasts capped at 3 most recent', () => {
  const now = 1_000_000;
  const chatLog = [
    // 5 broadcasts — only the 3 most recent should survive the cap
    { time: now - 50_000, from: 'a', message: 'b1' },
    { time: now - 40_000, from: 'b', message: 'b2' },
    { time: now - 30_000, from: 'c', message: 'b3' },
    { time: now - 20_000, from: 'd', message: 'b4' },
    { time: now - 10_000, from: 'e', message: 'b5' },
    // a whisper from 60s ago — must survive regardless of the broadcast cap
    { time: now - 60_000, from: 're44', message: 'do X', private: true },
  ];
  const out = selectRecentChat(chatLog, now, 0, 'Steve');
  // 3 broadcasts (b3-b5) + 1 direct = 4 messages.
  assert.equal(out.length, 4);
  const directs = out.filter((m) => m.direct === true);
  assert.equal(directs.length, 1);
  assert.equal(directs[0].message, 'do X');
  const broadcasts = out.filter((m) => !m.direct);
  assert.deepEqual(broadcasts.map((m) => m.message), ['b3', 'b4', 'b5']);
});
