import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProfile, isProtectedInRegion, isStructuralInRegion, isToleratedBreak, getDefaultIntentForProfile } from '../../../lib/runtime/regions/profiles.js';

test('applyProfile sets mine intent to resource', () => {
  const r = applyProfile({ id: 'm1', profile: 'mine' });
  assert.equal(r.intent, 'resource');
  assert.equal(r.capabilities.overrides_global_denylist, true);
});

test('farm tolerates wheat', () => {
  const r = applyProfile({ id: 'f1', profile: 'farm', intent: 'protect' });
  assert.ok(isToleratedBreak('wheat', r));
  assert.ok(isProtectedInRegion('oak_fence', r));
});

test('getDefaultIntentForProfile', () => {
  assert.equal(getDefaultIntentForProfile('base'), 'protect');
  assert.equal(getDefaultIntentForProfile('mine'), 'resource');
});

// ─────────────────────────────────────────────────────────────────────────
// capability_overrides — operator-level cap edits that survive applyProfile.
//
// 2026-05-27 motivation: user wanted to keep hut1 as intent: protect
// (for perimeter safety) but allow workers to dig/place inside it
// during active build. A manually-edited `capabilities` block in the
// JSON got normalized away by applyProfile on the next load. The
// explicit `capability_overrides` field is the supported override path:
// merged on top of the intent's defaults, preserved across reloads.
// ─────────────────────────────────────────────────────────────────────────

test('capability_overrides merges over intent defaults', () => {
  const r = applyProfile({
    id: 'hut1',
    profile: 'base',
    intent: 'protect',
    capability_overrides: { allow_ad_hoc_dig: true, allow_ad_hoc_place: true },
  });
  // Overrides applied:
  assert.equal(r.capabilities.allow_ad_hoc_dig, true);
  assert.equal(r.capabilities.allow_ad_hoc_place, true);
  // Non-overridden keys keep the protect defaults:
  assert.equal(r.capabilities.allow_guided_edit, true);
  assert.equal(r.capabilities.allow_harvest, false);
});

test('absent capability_overrides → defaults unchanged', () => {
  const r = applyProfile({ id: 'b1', profile: 'base', intent: 'protect' });
  assert.equal(r.capabilities.allow_ad_hoc_dig, false);
  assert.equal(r.capabilities.allow_ad_hoc_place, false);
});

test('capability_overrides on resource intent can lock something down', () => {
  // Inverse use case: a resource region (defaults: everything allowed)
  // that the operator wants to selectively harden.
  const r = applyProfile({
    id: 'mine_special',
    profile: 'mine',
    intent: 'resource',
    capability_overrides: { allow_ad_hoc_place: false },
  });
  assert.equal(r.capabilities.allow_ad_hoc_dig, true);
  assert.equal(r.capabilities.allow_ad_hoc_place, false);
});

test('capability_overrides ignored when not an object', () => {
  // Defensive: malformed JSON shouldn't crash. String or null falls through.
  const r1 = applyProfile({ id: 'x', profile: 'base', intent: 'protect', capability_overrides: 'bogus' });
  assert.equal(r1.capabilities.allow_ad_hoc_dig, false);
  const r2 = applyProfile({ id: 'y', profile: 'base', intent: 'protect', capability_overrides: null });
  assert.equal(r2.capabilities.allow_ad_hoc_dig, false);
});

// ─────────────────────────────────────────────────────────────────────────
// C6 migration: isStructuralInRegion now consults materials.json tier_2+
// alongside the hardcoded STRUCTURAL_BY_PROFILE table. Verify the cross-
// source predicate catches what either alone would catch.
// ─────────────────────────────────────────────────────────────────────────

test('isStructuralInRegion: tier_2+ blocks classify structural via materials.json', () => {
  const baseRegion = applyProfile({ id: 'b1', profile: 'base', intent: 'protect' });
  // tier_3 (already in hardcoded set)
  assert.equal(isStructuralInRegion('oak_log', baseRegion), true);
  // tier_2 (in hardcoded set; also catches via materials)
  assert.equal(isStructuralInRegion('oak_planks', baseRegion), true);
  // tier_2 NOT in hardcoded base set but in materials tier_2 → caught
  // via the materials.json source (stone_bricks).
  assert.equal(isStructuralInRegion('stone_bricks', baseRegion), true);
  // tier_4 (diamond_block) — not in hardcoded set; caught via materials
  assert.equal(isStructuralInRegion('diamond_block', baseRegion), true);
  // tier_1 → not structural (terrain harvestable)
  assert.equal(isStructuralInRegion('dirt', baseRegion), false);
  assert.equal(isStructuralInRegion('cobblestone', baseRegion), false);
});

test('isStructuralInRegion: marker/resource intents always non-structural', () => {
  const marker = applyProfile({ id: 'm1', profile: 'base', intent: 'marker' });
  const resource = applyProfile({ id: 'r1', profile: 'mine', intent: 'resource' });
  // Even structural blocks pass through these intents — they're explicit
  // override gates.
  assert.equal(isStructuralInRegion('oak_planks', marker), false);
  assert.equal(isStructuralInRegion('oak_log', resource), false);
});
