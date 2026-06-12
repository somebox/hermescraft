/**
 * screenshot_meta is CLI-only (no bot HTTP route on this build).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('screenshot_meta: registry entry for perceive GET # spec', async () => {
  const { RAW_COMMAND_DEFS } = await import('../../cli/registry.mjs');
  const def = RAW_COMMAND_DEFS.find((d) => d.name === 'screenshot_meta');
  assert.ok(def);
  assert.equal(def.category, 'perceive');
});
