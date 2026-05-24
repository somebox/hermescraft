import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  botMcNameSet,
  discoveryPortList,
  isHermesBotHealth,
  mergePollTargets,
} from '../lib/bot-discovery.js';

describe('isHermesBotHealth', () => {
  it('accepts connected bot health', () => {
    assert.equal(isHermesBotHealth({ ok: true, username: 'Steward' }), true);
  });
  it('rejects dashboard HTML JSON', () => {
    assert.equal(isHermesBotHealth({ ok: false }), false);
  });
});

describe('discoveryPortList', () => {
  it('excludes dashboard port from scan range', () => {
    const registry = { agents: [{ api_port: 3002 }], defaultWorld: 'world' };
    const ports = discoveryPortList(registry, {
      dashboardPort: 3000,
      env: { BOT_DISCOVERY_PORT_MIN: '3000', BOT_DISCOVERY_PORT_MAX: '3002' },
    });
    assert.equal(ports.includes(3000), false);
    assert.equal(ports.includes(3001), true);
    assert.equal(ports.includes(3002), true);
  });
});

describe('mergePollTargets', () => {
  const registry = {
    defaultWorld: 'world',
    agents: [
      { name: 'Flint', api_port: 3002 },
      { name: 'Steve', api_port: 3001 },
      { name: 'Gatherer', api_port: 3001 },
    ],
  };

  it('adds discovered bot on unused port', () => {
    const targets = mergePollTargets(registry, [
      { port: 3005, username: 'Steward', model: 'x', profile: 'steward' },
    ]);
    assert.equal(targets.some((t) => t.name === 'Steward' && t.discovered), true);
    assert.equal(targets.filter((t) => t.name === 'Flint').length, 1);
  });

  it('does not duplicate registry port with new username', () => {
    const targets = mergePollTargets(registry, [
      { port: 3001, username: 'Steward', model: null, profile: null },
    ]);
    assert.equal(targets.some((t) => t.name === 'Steward'), false);
  });
});

describe('botMcNameSet', () => {
  it('includes live mc usernames', () => {
    const registry = { agents: [{ name: 'Flint' }] };
    const set = botMcNameSet(registry, [{ name: 'Flint', mc_username: 'Flint' }]);
    assert.equal(set.has('flint'), true);
  });
});
