import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import {
  agentTestGlobalHome,
  defaultHermesHome,
  hermesHomeCandidates,
  resolveHermesHome,
} from '../lib/agent-paths.js';

describe('agent-paths', () => {
  it('defaultHermesHome uses landfolk pattern', () => {
    const p = defaultHermesHome('Flint');
    assert.equal(p, path.join(os.homedir(), '.hermes-landfolk-flint'));
  });

  it('resolveHermesHome uses explicit override', () => {
    const custom = '/tmp/my-hermes';
    assert.equal(resolveHermesHome({ name: 'Steve', hermes_home: custom }), path.resolve(custom));
  });

  it('resolveHermesHome expands tilde', () => {
    const p = resolveHermesHome({ name: 'X', hermes_home: '~/custom-hermes' });
    assert.equal(p, path.join(os.homedir(), 'custom-hermes'));
  });

  it('hermesHomeCandidates includes agent-test global home', () => {
    const homes = hermesHomeCandidates({ name: 'Flint' });
    assert.ok(homes.includes(agentTestGlobalHome()));
  });
});
