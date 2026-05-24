import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickAgentKanbanTask } from '../static/kanban-agent.js';

describe('pickAgentKanbanTask', () => {
  const tasks = [
    { id: 't_a', title: 'Old todo', assignee: 'flint', status: 'todo' },
    { id: 't_b', title: 'Iron scout', assignee: 'flint', status: 'running' },
    { id: 't_c', title: 'Steward epic', assignee: 'steward', status: 'todo' },
  ];

  it('prefers running over todo for same assignee', () => {
    assert.equal(pickAgentKanbanTask(tasks, 'Flint')?.id, 't_b');
  });

  it('returns null when no assignee match', () => {
    assert.equal(pickAgentKanbanTask(tasks, 'Mason'), null);
  });
});
