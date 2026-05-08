import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ACTION_DEADLINE_MS,
  classifyPathDeadline,
  LONG_ACTION_DEADLINE_MS,
  READ_DEADLINE_MS,
} from '../../cli/http.mjs';

describe('cli http deadlines', () => {
  it('GET uses read deadline', () => {
    assert.strictEqual(classifyPathDeadline('GET', '/anything'), READ_DEADLINE_MS);
  });

  it('short POST keeps default action deadline', () => {
    assert.strictEqual(classifyPathDeadline('POST', '/action/stop'), ACTION_DEADLINE_MS);
  });

  it('collect, dig, dig_area, and pillar_step use long action deadline', () => {
    assert.strictEqual(classifyPathDeadline('POST', '/action/collect'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/dig'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/dig_area'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/action/pillar_step'), LONG_ACTION_DEADLINE_MS);
    assert.strictEqual(classifyPathDeadline('POST', '/task/start'), LONG_ACTION_DEADLINE_MS);
  });

  it('ignores query string when classifying path', () => {
    assert.strictEqual(
      classifyPathDeadline('POST', '/action/collect?x=1'),
      LONG_ACTION_DEADLINE_MS,
    );
  });
});
