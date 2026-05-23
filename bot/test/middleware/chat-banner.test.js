/**
 * F53.5 — chat-banner middleware tests.
 *
 * Post-action middleware that prepends `[!] N unread chat...` to result.result
 * when there are unread messages, mentions, or direct messages.
 *
 * Skips itself for read_chat / chat / whisper verbs to avoid recursion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as chatBanner from '../../lib/server/middleware/chat-banner.js';
import { ok } from '../../lib/shared/action-contract.js';

function fixture(botName = 'Steve') {
  return {
    services: {
      state: { world: { bot: { username: botName } } },
    },
  };
}

function metaWithChat(messages) {
  return {
    briefState: () => ({ new_chat: messages }),
  };
}

test('returns undefined when result is falsy', () => {
  const { services } = fixture();
  const r = chatBanner.apply(services, {}, 'inventory', null, metaWithChat([]));
  assert.equal(r, undefined);
});

test('returns undefined when no new_chat messages', () => {
  const { services } = fixture();
  const r = chatBanner.apply(services, {}, 'inventory', ok({ result: 'have x' }), metaWithChat([]));
  assert.equal(r, undefined);
});

test('skips banner on read_chat / chat / whisper verbs (avoid recursion)', () => {
  const { services } = fixture();
  const chats = [
    { from: 'a', message: 'hi steve', direct: false },
    { from: 'b', message: 'yo', direct: true },
  ];
  for (const verb of ['read_chat', 'chat', 'whisper']) {
    const r = chatBanner.apply(services, {}, verb, ok({ result: 'x' }), metaWithChat(chats));
    assert.equal(r, undefined, `${verb} should be skipped`);
  }
});

test('prepends banner when a message mentions the bot by name', () => {
  const { services } = fixture('Mason');
  const meta = metaWithChat([
    { from: 'Flint', message: '@mason can you help?', direct: false },
  ]);
  const r = chatBanner.apply(services, {}, 'inventory', ok({ result: 'have x' }), meta);
  assert.ok(r);
  assert.match(r.result, /\[!\] 1 unread chat, 1 mention you/);
  assert.match(r.result, /have x/);
});

test('prepends banner when there are direct messages', () => {
  const { services } = fixture();
  const meta = metaWithChat([
    { from: 'Flint', message: 'private msg', direct: true },
  ]);
  const r = chatBanner.apply(services, {}, 'inventory', ok({ result: 'have x' }), meta);
  assert.ok(r);
  assert.match(r.result, /1 direct/);
});

test('prepends banner when N >= 3 unread chats even without mentions or directs', () => {
  const { services } = fixture();
  const meta = metaWithChat([
    { from: 'a', message: 'noise 1', direct: false },
    { from: 'b', message: 'noise 2', direct: false },
    { from: 'c', message: 'noise 3', direct: false },
  ]);
  const r = chatBanner.apply(services, {}, 'inventory', ok({ result: 'have x' }), meta);
  assert.ok(r);
  assert.match(r.result, /\[!\] 3 unread chat/);
});

test('returns undefined when chats present but none meet threshold', () => {
  const { services } = fixture();
  const meta = metaWithChat([
    { from: 'a', message: 'noise', direct: false },
    { from: 'b', message: 'noise', direct: false },
  ]);
  const r = chatBanner.apply(services, {}, 'inventory', ok({ result: 'have x' }), meta);
  assert.equal(r, undefined);
});

test('replaces non-string result with just the banner', () => {
  const { services } = fixture();
  const meta = metaWithChat([
    { from: 'a', message: 'm1', direct: true },
  ]);
  const r = chatBanner.apply(services, {}, 'inventory', ok(), meta);
  assert.ok(r);
  assert.match(r.result, /^\[!\] 1 unread chat/);
});
