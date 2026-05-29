import test from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors anchorsEnvelope chest filter in bot/cli/index.mjs */
function chestAnchorsFromMarks(marksList) {
  return marksList.filter((m) => m.chest_snapshot != null);
}

test('anchors list includes only marks with chest_snapshot', () => {
  const marks = [
    { name: 'home', chest_snapshot: null },
    { name: 'chest_food', chest_snapshot: { items: [] } },
    { name: 'waypoint', chest_snapshot: undefined },
    { name: 'chest_ore', chest_snapshot: { stale: false } },
  ];
  const anchors = chestAnchorsFromMarks(marks);
  assert.equal(anchors.length, 2);
  assert.ok(anchors.every((m) => m.chest_snapshot != null));
  assert.deepEqual(anchors.map((m) => m.name).sort(), ['chest_food', 'chest_ore']);
});
