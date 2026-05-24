import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPlaceholderPlayerName, nearbyPlayerName } from '../lib/nearby-players.js';

describe('nearbyPlayerName', () => {
  it('uses username for player entities', () => {
    assert.equal(nearbyPlayerName({ kind: 'player', type: 'player', username: 're44' }), 're44');
  });

  it('ignores generic player type without username', () => {
    assert.equal(nearbyPlayerName({ kind: 'player', type: 'player' }), null);
  });

  it('ignores mobs', () => {
    assert.equal(nearbyPlayerName({ kind: 'mob', type: 'zombie' }), null);
  });
});

describe('isPlaceholderPlayerName', () => {
  it('flags player and unknown', () => {
    assert.equal(isPlaceholderPlayerName('player'), true);
    assert.equal(isPlaceholderPlayerName('Steward'), false);
  });
});
