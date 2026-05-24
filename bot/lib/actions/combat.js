/** @size-exempt: all combat verbs share threat-filter helpers */
/**
 * Combat action handlers: attack, eat, feed_mob, fight, flee,
 * sneak, shield_block, shoot, sprint_attack, critical_hit, strafe, combo,
 * plus reactive layer mode selection (mc mode normal|guard|hold).
 */
import { ok, fail } from '../shared/action-contract.js';
import { pathfindGotoNear, ACTION_CAPS_MS } from './_helpers.js';

const VALID_MODES = ['normal', 'guard', 'hold'];

export function createCombatActions(deps) {
  const { ctx, ensureBot, goals, fmt, posObj, sleep, filterEntitiesFairPlay, reactionDelay, loadLocations, rememberSocialEvent, getMyName, ACTIONS, hasLineOfSight, eyePosition } = deps;

  function losBlockedForAttack(entity) {
    if (!hasLineOfSight || !eyePosition) return null;
    const eye = eyePosition();
    if (!eye || !entity?.position) return null;
    const target = entity.position.offset(0, (entity.height || 1.8) * 0.5, 0);
    if (!hasLineOfSight(eye, target)) {
      const name = entity.name || entity.displayName || entity.username || 'target';
      return fail('ATTACK_BLOCKED', `Cannot hit ${name}: line of sight blocked by a wall/block.`, { retry_safe: true });
    }
    return null;
  }

  async function approachEntity(b, entity, range = 2) {
    if (entity.position.distanceTo(b.entity.position) <= range + 0.5) return;
    try {
      await pathfindGotoNear(
        b,
        goals,
        entity.position.x,
        entity.position.y,
        entity.position.z,
        range,
        { opName: 'combat_approach', capMs: ACTION_CAPS_MS.reach },
      );
    } catch { /* partial move ok */ }
  }

  return {

    /**
     * Reactive mode selector — Layer 2 per docs/design/phase-2/reactive-layer.md.
     *   normal: auto-engage if attacked or hostile in melee range; auto-flee creepers.
     *   guard:  auto-engage hostiles in 12-block radius; hold ground.
     *   hold:   no auto-actions (pure observation).
     */
    async mode({ name }) {
      if (!name) {
        return {
          ok: true,
          data: { current: ctx.reactive.mode || 'normal', valid: VALID_MODES },
          result: `Reactive mode: ${ctx.reactive.mode || 'normal'}`,
        };
      }
      const next = String(name).toLowerCase().trim();
      if (!VALID_MODES.includes(next)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_MODE',
            message: `Mode must be one of ${VALID_MODES.join(', ')}.`,
            observed_state: { requested: next, current: ctx.reactive.mode || 'normal' },
            retry_safe: false,
          },
        };
      }
      const previous = ctx.reactive.mode || 'normal';
      ctx.reactive.mode = next;
      return {
        ok: true,
        data: { previous, current: next },
        result: `Reactive mode: ${previous} → ${next}`,
      };
    },

    /**
     * Combat skill setter — clamps to [0, 1]. Reactive layer reads ctx.reactive.combat_skill
     * to decide multi-target probability and tick rate. soldier ≈ 0.9, farmer ≈ 0.2.
     */
    async combat_skill({ value }) {
      if (value === undefined || value === null) {
        return {
          ok: true,
          data: { current: ctx.reactive.combat_skill ?? 0.5 },
          result: `combat_skill = ${(ctx.reactive.combat_skill ?? 0.5).toFixed(2)}`,
        };
      }
      const num = Number(value);
      if (!Number.isFinite(num)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_VALUE',
            message: `combat_skill must be a number 0..1. Got: ${value}`,
            retry_safe: false,
          },
        };
      }
      const clamped = Math.max(0, Math.min(1, num));
      const previous = ctx.reactive.combat_skill ?? 0.5;
      ctx.reactive.combat_skill = clamped;
      return {
        ok: true,
        data: { previous, current: clamped },
        result: `combat_skill: ${previous.toFixed(2)} → ${clamped.toFixed(2)}`,
      };
    },

    async attack({ target }) {
      const b = ensureBot();
      await reactionDelay();
      const hostiles = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'drowned', 'phantom', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'cave_spider'];

      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      let entity;
      if (target) {
        entity = visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()));
      } else {
        entity = visible.find(e => hostiles.includes((e.name || '').toLowerCase()));
      }
      if (!entity) {
        return fail('NO_TARGET', `No ${target || 'hostile mob'} found nearby.`, { retry_safe: false });
      }

      if (entity.position.distanceTo(b.entity.position) > 3) {
        await approachEntity(b, entity, 2);
      }
      const los = losBlockedForAttack(entity);
      if (los) return los;
      await b.lookAt(entity.position.offset(0, (entity.height || 1.8) * 0.8, 0));
      await b.attack(entity);
      return ok({ result: `Attacked ${entity.name || target} (${fmt(entity.position.distanceTo(b.entity.position))}m away)` });
    },

    async eat() {
      const b = ensureBot();
      const foods = b.inventory.items().filter(i => ctx.world.mcData.foodsByName?.[i.name]);
      if (foods.length === 0) {
        return fail('NO_FOOD', 'No food in inventory.', { retry_safe: false });
      }
      foods.sort((a, c) => (ctx.world.mcData.foodsByName[c.name]?.foodPoints || 0) - (ctx.world.mcData.foodsByName[a.name]?.foodPoints || 0));
      const food = foods[0];
      const mounted = !!b.vehicle;
      const heldIsFood = b.heldItem && b.heldItem.name === food.name;

      // Bug t_d696313a (2026-05-24): `b.equip(food, 'hand')` was dropping
      // the previously-held tool. The mineflayer swap is two clicks
      // (pick-up, put-down × 2); under Paper's inventory-click rate caps
      // the second click can silently drop, leaving the previous item
      // nowhere — Flint crafted+lost three stone_pickaxes in a row before
      // we noticed. Fix: pre-empty the hand by moving the current held
      // item to a free inventory slot, so the subsequent equip is a
      // one-click move (food → empty hand) instead of a two-click swap.
      //
      // Three preferred paths in priority order:
      //   1. Food already in hotbar → setQuickBarSlot (no clicks).
      //   2. Held item is non-food → move to free non-hotbar inventory
      //      slot, then equip food.
      //   3. Hand already empty → equip food normally (one-click).
      const previouslyHeld = heldIsFood ? null : b.heldItem;
      const HOTBAR_START = 36, HOTBAR_END = 44;
      const isInHotbar = (slot) => slot >= HOTBAR_START && slot <= HOTBAR_END;
      const findFreeInventorySlot = () => {
        // Mineflayer inventory slot range: 9-35 (main inventory, non-hotbar).
        const used = new Set(b.inventory.items().map((i) => i.slot));
        for (let s = 9; s <= 35; s++) {
          if (!used.has(s)) return s;
        }
        return -1;
      };

      let equipNote = null;
      let preStashed = false;
      if (!heldIsFood) {
        const foodInHotbar = b.inventory.items().find(
          (i) => i.name === food.name && isInHotbar(i.slot),
        );
        if (foodInHotbar) {
          // Path 1: zero-click select.
          try {
            b.setQuickBarSlot(foodInHotbar.slot - HOTBAR_START);
          } catch (err) {
            equipNote = `quickbar select: ${err?.message || String(err)}`;
          }
        } else if (previouslyHeld) {
          // Path 2: pre-empty the hand before equip-swap. Move the held
          // item into a free non-hotbar slot via moveSlotItem (single
          // click), then equip food (also single click).
          const freeSlot = findFreeInventorySlot();
          if (freeSlot >= 0) {
            try {
              const handSlot = b.getEquipmentDestSlot
                ? b.getEquipmentDestSlot('hand')
                : (HOTBAR_START + b.quickBarSlot);
              await b.moveSlotItem(handSlot, freeSlot);
              preStashed = true;
            } catch (err) {
              equipNote = `pre-stash: ${err?.message || String(err)}`;
            }
          }
          try {
            await b.equip(food, 'hand');
          } catch (err) {
            const m = err?.message || String(err);
            equipNote = equipNote ? `${equipNote}; equip: ${m}` : m;
          }
        } else {
          // Path 3: hand empty, normal one-click equip.
          try {
            await b.equip(food, 'hand');
          } catch (err) {
            equipNote = err?.message || String(err);
            try {
              const hotbar = b.inventory.items().find(
                (i) => i.name === food.name && isInHotbar(i.slot),
              );
              if (hotbar) b.setQuickBarSlot(hotbar.slot - HOTBAR_START);
            } catch { /* best-effort */ }
          }
        }
      }
      const beforeFood = b.food;
      const beforeHp = b.health;
      try {
        await b.consume();
      } catch (err) {
        const msg = err?.message || String(err);
        const hint = mounted
          ? 'mc disembark first — current mineflayer build can refuse to eat while in a boat.'
          : 'Check inventory + held item.';
        return fail(
          mounted ? 'EAT_FAILED_MOUNTED' : 'EAT_FAILED',
          `Failed to eat ${food.name}: ${msg}. ${hint}${equipNote ? ` (equip also errored: ${equipNote})` : ''}`,
          { retry_safe: true },
        );
      }

      // Re-equip the previously-held item so the bot is back where it
      // started before eat() was called. Workers expect this: they crafted
      // a stone_pickaxe, equipped it, then called eat — they assume the
      // pickaxe is still in hand for the next mine. If we pre-stashed
      // (Path 2) the item is sitting safely in inventory. If we used
      // Path 1 (quickbar select) or Path 3 (empty-hand equip), the item
      // may also still be there. Either way, find it and re-equip.
      let recoveredNote = '';
      if (previouslyHeld) {
        try {
          const stillHave = b.inventory.items().find((i) => i.name === previouslyHeld.name);
          if (stillHave) {
            await b.equip(stillHave, 'hand').catch(() => { /* best-effort */ });
          } else {
            recoveredNote = ` [WARN: ${previouslyHeld.name} lost during eat — pre-stashed=${preStashed}; file bug if reproducing]`;
          }
        } catch { /* best-effort */ }
      }

      const result = `Ate ${food.name}. Health: ${fmt(b.health)} (was ${fmt(beforeHp)}), Food: ${b.food} (was ${beforeFood})${mounted ? ' (mounted)' : ''}${equipNote ? ` [equip warn: ${equipNote.slice(0, 80)}]` : ''}${recoveredNote}`;
      return ok({ result });
    },

    /**
     * Right-click (use) on a mob — breeding food, empty bucket on cow, etc.
     * Fair-play: same visibility rules as combat; does not target players.
     */
    async feed_mob({ target, item }) {
      const b = ensureBot();
      const t = target != null ? String(target).trim() : '';
      if (!t) {
        return fail('INVALID_ARGS', 'feed_mob needs target (mob name substring, e.g. chicken, cow).', { retry_safe: false });
      }
      await reactionDelay();

      const rawEnts = Object.values(b.entities).filter(
        (e) =>
          e &&
          e !== b.entity &&
          e.position &&
          e.type !== 'player' &&
          (e.name || '').toLowerCase() !== 'item',
      );
      const visible = filterEntitiesFairPlay(rawEnts);
      const needle = t.toLowerCase();
      const entity = visible.find((e) => (e.name || '').toLowerCase().includes(needle));
      if (!entity) {
        return fail('NO_TARGET', `No mob matching "${t}" in range or line-of-sight (players excluded).`, { retry_safe: false });
      }

      if (item != null && String(item).trim()) {
        const name = String(item).trim();
        const invItem = b.inventory.items().find((i) => i.name === name);
        if (!invItem) {
          const available = [...new Set(b.inventory.items().map((i) => i.name))].join(', ');
          return fail('NOT_IN_INVENTORY', `No ${name} in inventory. Have: ${available || 'nothing'}`, { retry_safe: false });
        }
        await b.equip(invItem, 'hand');
      }

      if (entity.position.distanceTo(b.entity.position) > 3.5) {
        await approachEntity(b, entity, 2);
      }
      const hh = Math.min(entity.height || 1, 1.4);
      await b.lookAt(entity.position.offset(0, hh * 0.85, 0));
      b.useOn(entity);
      const held = b.heldItem?.name || 'hand';
      return ok({
        result: `Used ${held} on ${entity.name || t} (~${fmt(entity.position.distanceTo(b.entity.position))}m)`,
      });
    },

    // ── Sustained Combat ──────────────────────────────
    async fight({ target, retreat_health = 6, duration = 30 }) {
      const b = ensureBot();

      const weapons = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword',
                       'netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe'];
      for (const w of weapons) {
        const item = b.inventory.items().find(i => i.name === w);
        if (item) { await b.equip(item, 'hand'); break; }
      }

      const hostiles = ['zombie','skeleton','spider','creeper','enderman','witch',
                        'drowned','husk','stray','phantom','pillager','vindicator','blaze',
                        'wither_skeleton','ghast','piglin_brute','hoglin'];
      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      let entity;
      if (target) {
        entity = visible.find(e => e.name?.includes(target) || e.displayName?.includes(target));
      } else {
        entity = visible.find(e => hostiles.some(h => e.name?.includes(h)) && e.position?.distanceTo(b.entity.position) < 16);
      }
      if (!entity) return ok({ result: `No ${target || 'hostile'} found nearby` });

      const startHealth = b.health;
      let hits = 0, targetName = entity.name || entity.displayName || 'entity';
      const endTime = Date.now() + duration * 1000;

      while (Date.now() < endTime) {
        if (b.health <= retreat_health) {
          const fleePos = b.entity.position.offset(
            -(entity.position.x - b.entity.position.x) * 2, 0,
            -(entity.position.z - b.entity.position.z) * 2
          );
          try { await pathfindGotoNear(b, goals, fleePos.x, fleePos.y, fleePos.z, 2, { opName: 'combat_flee', capMs: ACTION_CAPS_MS.reach }); } catch {}
          const food = b.inventory.items().find(i => ctx.world.mcData.foodsByName?.[i.name]);
          if (food) { await b.equip(food, 'hand'); try { await b.consume(); } catch {} }
          return ok({ result: `Retreated from ${targetName} at ${b.health} HP. ${hits} hits dealt.` });
        }

        if (!entity.isValid) {
          return ok({ result: `Killed ${targetName}! ${hits} hits. Lost ${Math.round(startHealth - b.health)} HP.` });
        }

        const dist = entity.position.distanceTo(b.entity.position);
        if (dist > 3.5) {
          b.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
          // Short re-check interval — closes the "bot in melee range but still
          // sleeping in the chase branch" gap that lets mobs land free hits.
          await sleep(150);
          continue;
        }

        b.pathfinder.setGoal(null);
        await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
        // Don't swing through walls. If LOS is blocked, try to reposition
        // by re-pathing closer (which usually requires a clear path).
        const los = losBlockedForAttack(entity);
        if (los) {
          b.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
          await sleep(250);
          continue;
        }
        await b.attack(entity);
        hits++;
        // Wooden sword cooldown is ~0.625s for full damage; 500ms is a slight
        // tradeoff (small dmg loss for higher swing rate) that prevents the bot
        // taking 2 hits between its own swings.
        await sleep(500);
      }

      return ok({ result: `Fight timeout. ${hits} hits on ${targetName}. Health: ${b.health}` });
    },

    async flee({ distance = 16, from, to }) {
      const b = ensureBot();

      const locs = loadLocations();

      const markTo = typeof to === 'string' && to.trim() ? to.trim() : '';

      // F47: 'player' removed from the default hostiles list. In G21 v1
      // with Flint+Mason+Re44 all online, calling `mc flee 16` without a
      // `from` argument made the bot flee from its own partner because
      // 'player' matched any visible bot/user entity. Players now count
      // as threats only when (a) explicitly named via `from`, or (b)
      // recently damaged the bot (reactive layer handles damage-driven
      // flee via state.recently_damaged, not via this verb).
      const MOB_HOSTILES = [
        'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch',
        'drowned', 'husk', 'stray', 'phantom', 'blaze', 'wither_skeleton',
        'vindicator', 'pillager', 'ravager', 'vex', 'evoker', 'magma_cube',
        'ghast', 'hoglin', 'zoglin', 'piglin_brute', 'warden',
      ];

      let threat;
      let threatReason;
      if (!markTo) {
        const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
        const visible = filterEntitiesFairPlay(rawEnts);
        if (from) {
          // Explicit target: any entity (mob or player) whose name/username
          // matches `from` is the threat. The brain takes responsibility
          // for the targeting decision.
          threat = visible.find(e =>
            (e.name || '').toLowerCase().includes(from.toLowerCase()) ||
            (e.username || '').toLowerCase().includes(from.toLowerCase())
          );
          if (threat) threatReason = `explicit:${from}`;
        } else {
          // Default: only flee from genuinely hostile MOBS, not players.
          threat = visible.find(e => MOB_HOSTILES.some(h => (e.name || '').toLowerCase().includes(h)));
          if (threat) threatReason = `hostile_mob:${threat.name}`;
        }
        if (!threat) {
          return {
            ok: false,
            error: {
              code: 'NO_THREAT',
              message: from
                ? `No entity matching "${from}" nearby — nothing to flee from.`
                : 'No hostile mobs nearby. mc flee with no args only fires on visible hostile mobs (zombies, skeletons, etc.); to flee from a specific player or named entity, pass from=<name>.',
              observed_state: {
                visible_entities: visible.slice(0, 8).map((e) => ({
                  name: e.name || null,
                  username: e.username || null,
                  type: e.type || null,
                })),
              },
              retry_safe: false,
            },
          };
        }
      }

      if (markTo) {
        const tgt = locs[markTo];
        if (!tgt) {
          return fail('UNKNOWN_MARK', `Unknown mark '${markTo}'. Try mc marks.`, { retry_safe: false });
        }

        if (markTo && threat) {
          const dx = b.entity.position.x - threat.position.x;
          const dz = b.entity.position.z - threat.position.z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          const fleeX = b.entity.position.x + (dx / len) * distance;
          const fleeZ = b.entity.position.z + (dz / len) * distance;
          try {
            await pathfindGotoNear(b, goals, fleeX, b.entity.position.y, fleeZ, 3, { opName: 'combat_flee', capMs: ACTION_CAPS_MS.reach });
          } catch (_) { /* partial move ok */ }
        }

        try {
          await pathfindGotoNear(b, goals, tgt.x, tgt.y, tgt.z, 2, { opName: 'combat_flee_mark', capMs: ACTION_CAPS_MS.go_mark });
        } catch (_) { /* partial move ok */ }
        return ok({
          result: threat
            ? `Fled threats then moved toward mark '${markTo}'`
            : `Moving to mark '${markTo}' (${Math.round(distance)} steps context)`,
          data: {
            to: markTo,
            position: { x: tgt.x, y: tgt.y, z: tgt.z },
            flee_reason: threat ? threatReason : 'mark_only',
            threat: threat ? { name: threat.name || null, username: threat.username || null } : null,
          },
        });
      }

      const dx = b.entity.position.x - threat.position.x;
      const dz = b.entity.position.z - threat.position.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const fleeX = b.entity.position.x + (dx / len) * distance;
      const fleeZ = b.entity.position.z + (dz / len) * distance;

      try {
        await pathfindGotoNear(b, goals, fleeX, b.entity.position.y, fleeZ, 3, { opName: 'combat_flee', capMs: ACTION_CAPS_MS.reach });
        return {
          ok: true,
          data: {
            flee_reason: threatReason,
            threat: { name: threat.name || null, username: threat.username || null, distance: Math.round(threat.position.distanceTo(b.entity.position) * 10) / 10 },
            fled_blocks: distance,
            final_position: posObj(b.entity.position),
          },
          result: `Fled ${distance} blocks from ${threat.name} (${threatReason})`,
        };
      } catch {
        return {
          ok: true,
          data: {
            flee_reason: threatReason,
            threat: { name: threat.name || null, username: threat.username || null },
            partial: true,
            health: b.health,
          },
          result: `Tried to flee from ${threat.name}, moved partially. Health: ${b.health}`,
        };
      }
    },

    // ── Advanced Combat ───────────────────────────────
    async sneak({ enable = true }) {
      const b = ensureBot();
      b.setControlState('sneak', !!enable);
      ctx.team.isSneaking = !!enable;
      return ok({ result: enable ? 'Sneaking — nameplate hidden, reduced detection range' : 'Stopped sneaking' });
    },

    async shield_block({ duration = 3 }) {
      const b = ensureBot();
      const shield = b.inventory.items().find(i => i.name === 'shield');
      if (!shield) {
        return fail('NO_SHIELD', 'No shield in inventory. Craft one first (1 iron + 6 planks).', { retry_safe: false });
      }

      if (!b.inventory.slots[45] || b.inventory.slots[45].name !== 'shield') {
        await b.equip(shield, 'off-hand');
      }

      b.activateItem(true);
      const blockTime = Math.min(duration, 10) * 1000;
      await sleep(blockTime);
      b.deactivateItem();
      return ok({ result: `Blocked with shield for ${duration}s` });
    },

    async shoot({ target, predict = true }) {
      const b = ensureBot();
      await reactionDelay();

      const bow = b.inventory.items().find(i => i.name === 'bow' || i.name === 'crossbow');
      if (!bow) return fail('NO_BOW', 'No bow/crossbow in inventory.', { retry_safe: false });
      const arrows = b.inventory.items().find(i => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow');
      if (!arrows) return fail('NO_ARROWS', 'No arrows in inventory.', { retry_safe: false });
      await b.equip(bow, 'hand');

      let entity;
      if (target) {
        const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
        const visible = filterEntitiesFairPlay(rawEnts);
        entity = visible.find(e =>
          (e.name || '').toLowerCase().includes(target.toLowerCase()) ||
          (e.username || '').toLowerCase().includes(target.toLowerCase())
        );
      } else {
        const hostiles = ['zombie','skeleton','spider','creeper','enderman','witch','drowned','blaze','ghast','wither_skeleton','player'];
        const rawEnts = Object.values(b.entities).filter(e =>
          e !== b.entity && hostiles.some(h => (e.name || '').includes(h)));
        const visible = filterEntitiesFairPlay(rawEnts);
        entity = visible.sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0];
      }
      if (!entity) return fail('NO_TARGET', `No ${target || 'target'} visible.`, { retry_safe: false });

      let aimPoint = entity.position.offset(0, entity.height * 0.6, 0);
      if (predict && entity.velocity) {
        const dist = entity.position.distanceTo(b.entity.position);
        const flightTime = dist / 30;
        aimPoint = aimPoint.offset(
          entity.velocity.x * flightTime * 20,
          entity.velocity.y * flightTime * 20 + 0.05 * dist,
          entity.velocity.z * flightTime * 20
        );
      }

      await b.lookAt(aimPoint);
      b.activateItem();
      await sleep(bow.name === 'crossbow' ? 1250 : 1000);
      b.deactivateItem();

      return ok({ result: `Shot ${bow.name} at ${entity.name || target} (${fmt(entity.position.distanceTo(b.entity.position))}m)` });
    },

    async sprint_attack({ target }) {
      const b = ensureBot();
      await reactionDelay();

      const weapons = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword',
                       'netherite_axe','diamond_axe','iron_axe','stone_axe'];
      for (const w of weapons) {
        const item = b.inventory.items().find(i => i.name === w);
        if (item) { await b.equip(item, 'hand'); break; }
      }

      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      const entity = target
        ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
        : visible.filter(e => ['zombie','skeleton','spider','creeper','player'].some(h => (e.name || '').includes(h)))
                 .sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0];
      if (!entity) return fail('NO_TARGET', `No ${target || 'target'} visible.`, { retry_safe: false });

      b.setControlState('sprint', true);
      if (entity.position.distanceTo(b.entity.position) > 3.5) {
        await approachEntity(b, entity, 2);
      }
      await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
      const losFail = losBlockedForAttack(entity);
      if (losFail) {
        b.setControlState('sprint', false);
        return losFail;
      }
      await b.attack(entity);
      b.setControlState('sprint', false);

      return ok({ result: `Sprint-attacked ${entity.name || target}! (extra knockback)` });
    },

    async critical_hit({ target }) {
      const b = ensureBot();
      await reactionDelay();

      const weapons = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword','netherite_axe','diamond_axe','iron_axe'];
      for (const w of weapons) {
        const item = b.inventory.items().find(i => i.name === w);
        if (item) { await b.equip(item, 'hand'); break; }
      }

      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      const entity = target
        ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
        : visible.filter(e => e.position.distanceTo(b.entity.position) < 6).sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0];
      if (!entity) return fail('NO_TARGET', `No ${target || 'target'} visible within range.`, { retry_safe: false });

      if (entity.position.distanceTo(b.entity.position) > 3.5) {
        await approachEntity(b, entity, 2);
      }

      b.setControlState('jump', true);
      await sleep(200);
      b.setControlState('jump', false);
      await sleep(150);
      await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
      const losFail = losBlockedForAttack(entity);
      if (losFail) return losFail;
      await b.attack(entity);

      return ok({ result: `Critical hit on ${entity.name || target}! (150% damage, star particles)` });
    },

    async strafe({ target, direction = 'random', duration = 5 }) {
      const b = ensureBot();
      await reactionDelay();

      const weapons = ['netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword'];
      for (const w of weapons) {
        const item = b.inventory.items().find(i => i.name === w);
        if (item) { await b.equip(item, 'hand'); break; }
      }

      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      const entity = target
        ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
        : visible.filter(e => e.position.distanceTo(b.entity.position) < 8)[0];
      if (!entity) return fail('NO_TARGET', `No ${target || 'target'} visible.`, { retry_safe: false });

      let hits = 0;
      const endTime = Date.now() + Math.min(duration, 15) * 1000;
      const dir = direction === 'random' ? (Math.random() > 0.5 ? 'left' : 'right') : direction;

      while (Date.now() < endTime && entity.isValid) {
        if (b.health <= 6) return ok({ result: `Strafing stopped — low HP (${b.health}). ${hits} hits.` });

        const dx = entity.position.x - b.entity.position.x;
        const dz = entity.position.z - b.entity.position.z;
        const dist = Math.sqrt(dx*dx + dz*dz);

        const perpX = dir === 'left' ? -dz/dist : dz/dist;
        const perpZ = dir === 'left' ? dx/dist : -dx/dist;

        await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));

        b.setControlState(dir === 'left' ? 'left' : 'right', true);
        b.setControlState(dir === 'left' ? 'right' : 'left', false);

        if (dist < 4 && !losBlockedForAttack(entity)) {
          await b.attack(entity);
          hits++;
        }

        await sleep(500);
      }

      b.setControlState('left', false);
      b.setControlState('right', false);

      return ok({ result: `Strafed ${dir} around ${entity.name || target}. ${hits} hits in ${duration}s.` });
    },

    async combo({ target, style = 'aggressive' }) {
      const b = ensureBot();

      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      const entity = target
        ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
        : visible.filter(e => e.position.distanceTo(b.entity.position) < 16)[0];
      if (!entity) return fail('NO_TARGET', `No ${target || 'target'} visible.`, { retry_safe: false });
      const tName = entity.name || entity.username || target || 'target';

      const subResult = (r) => (r?.ok === false ? r.error?.message : r?.result) ?? String(r);

      const results = [];
      try {
        switch (style) {
          case 'aggressive':
            results.push(subResult(await deps.ACTIONS.sprint_attack({ target: tName })));
            await sleep(600);
            results.push(subResult(await deps.ACTIONS.critical_hit({ target: tName })));
            await sleep(600);
            results.push(subResult(await deps.ACTIONS.critical_hit({ target: tName })));
            if (b.inventory.items().find(i => i.name === 'shield')) {
              await sleep(200);
              results.push(subResult(await deps.ACTIONS.shield_block({ duration: 1 })));
            }
            break;
          case 'defensive':
            if (b.inventory.items().find(i => i.name === 'shield')) {
              results.push(subResult(await deps.ACTIONS.shield_block({ duration: 2 })));
            }
            results.push(subResult(await deps.ACTIONS.critical_hit({ target: tName })));
            await sleep(300);
            results.push(subResult(await deps.ACTIONS.flee({ distance: 6 })));
            break;
          case 'ranged':
            results.push(subResult(await deps.ACTIONS.shoot({ target: tName, predict: true })));
            await sleep(1200);
            results.push(subResult(await deps.ACTIONS.shoot({ target: tName, predict: true })));
            if (entity.isValid && entity.position.distanceTo(b.entity.position) < 8) {
              results.push(subResult(await deps.ACTIONS.sprint_attack({ target: tName })));
            }
            break;
          case 'berserker':
            results.push(subResult(await deps.ACTIONS.sprint_attack({ target: tName })));
            for (let i = 0; i < 3 && entity.isValid && b.health > 4; i++) {
              await sleep(500);
              results.push(subResult(await deps.ACTIONS.critical_hit({ target: tName })));
            }
            break;
          default:
            return fail(
              'INVALID_ARGS',
              `Unknown combo style: ${style}. Use: aggressive, defensive, ranged, berserker`,
              { retry_safe: false },
            );
        }
      } catch (err) {
        results.push(`Combo interrupted: ${err.message}`);
      }

      return ok({ result: `[${style}] ${results.join(' → ')}` });
    },

  };
}
