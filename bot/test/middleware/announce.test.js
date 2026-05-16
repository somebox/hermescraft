/**
 * F53.6 — reason= auto-announce middleware tests.
 *
 * Pre `check()` fires a "starting" chat line when:
 *   - body.reason is a non-empty string, AND
 *   - actionName is in LONG_VERBS
 * It records meta.announceStart=true so the post phase can fire completion.
 *
 * Post `apply()` fires a completion line when meta.announceStart=true AND
 * elapsed > 3s. Returns undefined (does not mutate result).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as announce from '../../lib/server/middleware/announce.js';
import { ok, fail } from '../../lib/shared/action-contract.js';

function fixture(botName = 'Steve') {
  const chats = [];
  const mockBot = {
    username: botName,
    chat: (msg) => chats.push(msg),
  };
  return {
    chats,
    services: {
      state: { world: { bot: mockBot } },
      ensureBot: () => mockBot,
    },
  };
}

test('check fires start chat when reason= AND verb in LONG_VERBS', () => {
  const { chats, services } = fixture('Mason');
  const meta = {};
  const r = announce.check(services, { reason: 'building shelter' }, 'fill', meta);
  assert.equal(r.intercept, false);
  assert.equal(meta.announceStart, true);
  assert.equal(meta.announceReason, 'building shelter');
  assert.equal(chats.length, 1);
  assert.match(chats[0], /Mason: starting fill — building shelter/);
});

test('check pass-through when verb is not in LONG_VERBS', () => {
  const { chats, services } = fixture();
  const meta = {};
  const r = announce.check(services, { reason: 'reading the room' }, 'chat', meta);
  assert.equal(r.intercept, false);
  assert.equal(meta.announceStart, undefined);
  assert.equal(chats.length, 0);
});

test('check pass-through when body has no reason', () => {
  const { chats, services } = fixture();
  const meta = {};
  const r = announce.check(services, {}, 'fill', meta);
  assert.equal(r.intercept, false);
  assert.equal(meta.announceStart, undefined);
  assert.equal(chats.length, 0);
});

test('check ignores empty/whitespace reason', () => {
  const { chats, services } = fixture();
  const meta = {};
  announce.check(services, { reason: '   ' }, 'fill', meta);
  assert.equal(meta.announceStart, undefined);
  assert.equal(chats.length, 0);
});

test('check truncates reason to 120 chars', () => {
  const { chats, services } = fixture();
  const meta = {};
  const longReason = 'a'.repeat(200);
  announce.check(services, { reason: longReason }, 'fill', meta);
  assert.equal(meta.announceReason.length, 120);
  assert.ok(chats[0].includes(meta.announceReason));
});

test('apply fires completion chat when elapsed > 3s', () => {
  const { chats, services } = fixture('Mason');
  const meta = {
    announceStart: true,
    announceStartedAt: Date.now() - 5000, // 5s ago
  };
  const result = ok({ result: 'done' });
  announce.apply(services, { reason: 'x' }, 'fill', result, meta);
  assert.equal(chats.length, 1);
  assert.match(chats[0], /Mason: done fill \(/);
});

test('apply skips completion when elapsed <= 3s', () => {
  const { chats, services } = fixture();
  const meta = {
    announceStart: true,
    announceStartedAt: Date.now() - 1000, // 1s ago
  };
  announce.apply(services, { reason: 'x' }, 'fill', ok(), meta);
  assert.equal(chats.length, 0);
});

test('apply skips entirely when announceStart was never set', () => {
  const { chats, services } = fixture();
  announce.apply(services, {}, 'fill', ok(), {});
  assert.equal(chats.length, 0);
});

test('apply reports softFailure in the completion chat', () => {
  const { chats, services } = fixture();
  const meta = {
    announceStart: true,
    announceStartedAt: Date.now() - 5000,
  };
  const r = fail('OUT_OF_RANGE', 'too far');
  announce.apply(services, { reason: 'x' }, 'fill', r, meta);
  assert.equal(chats.length, 1);
  assert.match(chats[0], /fill failed \(OUT_OF_RANGE\) after/i);
});

test('LONG_VERBS exports the documented set', () => {
  const got = [...announce.LONG_VERBS].sort();
  const want = [
    'collect', 'craft', 'dig', 'fill', 'go_mark',
    'goto', 'goto_near', 'move', 'place_fill', 'smelt',
    'stair_down', 'stair_up', 'tunnel', 'wall',
  ].sort();
  assert.deepEqual(got, want);
});
