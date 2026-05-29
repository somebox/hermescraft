import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeRecordChatComment, scanCardIds, passesFilter } from '../../lib/server/chat-card-comment.js';

function makeSpawnRecorder() {
  const calls = [];
  function spawn(cmd, args, opts) {
    calls.push({ cmd, args, opts });
    return { unref() {}, on() {} };
  }
  return { spawn, calls };
}

function argMap(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--task-id') out.taskId = args[i + 1];
    else if (args[i] === '--author') out.author = args[i + 1];
    else if (args[i] === '--body') out.body = args[i + 1];
  }
  return out;
}

test('scanCardIds returns unique ids in order', () => {
  assert.deepEqual(scanCardIds('hey t_abc12345 and t_def67890 also t_abc12345'),
    ['t_abc12345', 't_def67890']);
  assert.deepEqual(scanCardIds('no ids here at all'), []);
  assert.deepEqual(scanCardIds(''), []);
});

test('passesFilter requires >= 5 whitespace-separated words', () => {
  assert.equal(passesFilter('one two three four five'), true);
  assert.equal(passesFilter('one two three four'), false);
  assert.equal(passesFilter('   one   two   three   four   five  '), true);
  assert.equal(passesFilter(''), false);
});

test('valid id + >=5 word message spawns one helper with right args', () => {
  const rec = makeSpawnRecorder();
  const ids = maybeRecordChatComment(
    { author: 'flint', message: 'flint going to chest t_abc12345 now please' },
    { spawn: rec.spawn, helperPath: '/tmp/helper.py' },
  );
  assert.deepEqual(ids, ['t_abc12345']);
  assert.equal(rec.calls.length, 1);
  const call = rec.calls[0];
  assert.equal(call.cmd, 'python3');
  assert.equal(call.args[0], '/tmp/helper.py');
  const a = argMap(call.args);
  assert.equal(a.taskId, 't_abc12345');
  assert.equal(a.author, 'flint');
  assert.equal(a.body, '[via:chat] flint going to chest t_abc12345 now please');
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.stdio, 'ignore');
});

test('valid id + 3-word message does NOT spawn (filter rejects)', () => {
  const rec = makeSpawnRecorder();
  const ids = maybeRecordChatComment(
    { author: 'flint', message: 'see t_abc12345 now' },
    { spawn: rec.spawn, helperPath: '/tmp/helper.py' },
  );
  assert.deepEqual(ids, []);
  assert.equal(rec.calls.length, 0);
});

test('multiple unique ids in one >=5-word message spawn N helpers (dedup)', () => {
  const rec = makeSpawnRecorder();
  const msg = 'mason taking t_abc12345 plus t_def67890 and also t_abc12345 again';
  const ids = maybeRecordChatComment(
    { author: 'mason', message: msg },
    { spawn: rec.spawn, helperPath: '/tmp/helper.py' },
  );
  assert.deepEqual(ids, ['t_abc12345', 't_def67890']);
  assert.equal(rec.calls.length, 2);
  const taskIds = rec.calls.map(c => argMap(c.args).taskId);
  assert.deepEqual(taskIds, ['t_abc12345', 't_def67890']);
  for (const c of rec.calls) {
    const a = argMap(c.args);
    assert.equal(a.author, 'mason');
    assert.equal(a.body, `[via:chat] ${msg}`);
  }
});

test('message with no card refs does not spawn', () => {
  const rec = makeSpawnRecorder();
  const ids = maybeRecordChatComment(
    { author: 'flint', message: 'just chatting about the weather today' },
    { spawn: rec.spawn, helperPath: '/tmp/helper.py' },
  );
  assert.deepEqual(ids, []);
  assert.equal(rec.calls.length, 0);
});

test('error-log-style short line with id does not spawn (filter rejects)', () => {
  const rec = makeSpawnRecorder();
  const ids = maybeRecordChatComment(
    { author: 'flint', message: 'err t_abc12345 fail' },
    { spawn: rec.spawn, helperPath: '/tmp/helper.py' },
  );
  assert.deepEqual(ids, []);
  assert.equal(rec.calls.length, 0);
});

test('bridge writes once per call regardless of channel', () => {
  // The dedup-across-channels constraint lives at the call site
  // (bot/server.js own-chat path only — see the NOTE comment there).
  // This test verifies the bridge itself is purely per-call: same
  // (author, message) yields exactly one helper spawn per invocation.
  const rec = makeSpawnRecorder();
  const ids = maybeRecordChatComment(
    { author: 'mason', message: 'flint i am at chest for t_abc12345 handover' },
    { spawn: rec.spawn, helperPath: '/tmp/helper.py' },
  );
  assert.deepEqual(ids, ['t_abc12345']);
  assert.equal(rec.calls.length, 1);
  const a = argMap(rec.calls[0].args);
  assert.equal(a.author, 'mason');
  assert.equal(a.taskId, 't_abc12345');
});

test('uppercase or wrong-length tokens are ignored', () => {
  const rec = makeSpawnRecorder();
  const ids = maybeRecordChatComment(
    { author: 'flint', message: 'wrong ones t_ABC12345 and t_abc1234 plus t_abc123456 here' },
    { spawn: rec.spawn, helperPath: '/tmp/helper.py' },
  );
  assert.deepEqual(ids, []);
  assert.equal(rec.calls.length, 0);
});
