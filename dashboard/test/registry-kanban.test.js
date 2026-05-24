import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boardIdForWorld } from '../lib/registry.js';

describe('registry kanban', () => {
  const registry = {
    defaultWorld: 'world',
    defaultKanbanBoardId: 'landfolk-ops',
    kanbanBoardIdsByWorld: { world: 'landfolk-ops', 'landfolk-test': 'default' },
  };

  it('boardIdForWorld uses per-world map', () => {
    assert.equal(boardIdForWorld(registry, 'landfolk-test'), 'default');
  });

  it('boardIdForWorld falls back to defaultKanbanBoardId', () => {
    assert.equal(boardIdForWorld(registry, 'testflat'), 'landfolk-ops');
  });
});
