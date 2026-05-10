/**
 * Combat action handlers: attack, eat, feed_mob, fight, flee,
 * sneak, shield_block, shoot, sprint_attack, critical_hit, strafe, combo,
 * plus reactive layer mode selection (mc mode normal|guard|hold).
 */
const VALID_MODES = ['normal', 'guard', 'hold'];

export function createCombatActions(deps) {
  const { ctx, ensureBot, goals, fmt, posObj, sleep, filterEntitiesFairPlay, reactionDelay, loadLocations, rememberSocialEvent, getMyName, ACTIONS } = deps;
  return {

    /**
     * Reactive mode selector — Layer 2 per docs/phase-2/reactive-layer.md.
     *   normal: auto-engage if attacked or hostile in melee range; auto-flee creepers.
     *   guard:  auto-engage hostiles in 12-block radius; hold ground.
     *   hold:   no auto-actions (pure observation).
     */
    async mode({ name }) {
      if (!name) {
        return {
          ok: true,
          data: { current: ctx.mode || 'normal', valid: VALID_MODES },
          result: `Reactive mode: ${ctx.mode || 'normal'}`,
        };
      }
      const next = String(name).toLowerCase().trim();
      if (!VALID_MODES.includes(next)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_MODE',
            message: `Mode must be one of ${VALID_MODES.join(', ')}.`,
            observed_state: { requested: next, current: ctx.mode || 'normal' },
            retry_safe: false,
          },
        };
      }
      const previous = ctx.mode || 'normal';
      ctx.mode = next;
      return {
        ok: true,
        data: { previous, current: next },
        result: `Reactive mode: ${previous} → ${next}`,
      };
    },

    /**
     * Combat skill setter — clamps to [0, 1]. Reactive layer reads ctx.combat_skill
     * to decide multi-target probability and tick rate. soldier ≈ 0.9, farmer ≈ 0.2.
     */
    async combat_skill({ value }) {
      if (value === undefined || value === null) {
        return {
          ok: true,
          data: { current: ctx.combat_skill ?? 0.5 },
          result: `combat_skill = ${(ctx.combat_skill ?? 0.5).toFixed(2)}`,
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
      const previous = ctx.combat_skill ?? 0.5;
      ctx.combat_skill = clamped;
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
      if (!entity) throw new Error(`No ${target || 'hostile mob'} found nearby.`);

      if (entity.position.distanceTo(b.entity.position) > 3) {
        await b.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
      }
      await b.attack(entity);
      return { result: `Attacked ${entity.name || target} (${fmt(entity.position.distanceTo(b.entity.position))}m away)` };
    },

    async eat() {
      const b = ensureBot();
      const foods = b.inventory.items().filter(i => ctx.mcData.foodsByName?.[i.name]);
      if (foods.length === 0) throw new Error('No food in inventory.');
      foods.sort((a, c) => (ctx.mcData.foodsByName[c.name]?.foodPoints || 0) - (ctx.mcData.foodsByName[a.name]?.foodPoints || 0));
      await b.equip(foods[0], 'hand');
      await b.consume();
      return { result: `Ate ${foods[0].name}. Health: ${fmt(b.health)}, Food: ${b.food}` };
    },

    /**
     * Right-click (use) on a mob — breeding food, empty bucket on cow, etc.
     * Fair-play: same visibility rules as combat; does not target players.
     */
    async feed_mob({ target, item }) {
      const b = ensureBot();
      const t = target != null ? String(target).trim() : '';
      if (!t) throw new Error('feed_mob needs target (mob name substring, e.g. chicken, cow).');
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
        throw new Error(`No mob matching "${t}" in range or line-of-sight (players excluded).`);
      }

      if (item != null && String(item).trim()) {
        const name = String(item).trim();
        const invItem = b.inventory.items().find((i) => i.name === name);
        if (!invItem) {
          const available = [...new Set(b.inventory.items().map((i) => i.name))].join(', ');
          throw new Error(`No ${name} in inventory. Have: ${available || 'nothing'}`);
        }
        await b.equip(invItem, 'hand');
      }

      if (entity.position.distanceTo(b.entity.position) > 3.5) {
        await b.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
      }
      const hh = Math.min(entity.height || 1, 1.4);
      await b.lookAt(entity.position.offset(0, hh * 0.85, 0));
      b.useOn(entity);
      const held = b.heldItem?.name || 'hand';
      return {
        result: `Used ${held} on ${entity.name || t} (~${fmt(entity.position.distanceTo(b.entity.position))}m)`,
      };
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
      if (!entity) return { result: `No ${target || 'hostile'} found nearby` };

      const startHealth = b.health;
      let hits = 0, targetName = entity.name || entity.displayName || 'entity';
      const endTime = Date.now() + duration * 1000;

      while (Date.now() < endTime) {
        if (b.health <= retreat_health) {
          const fleePos = b.entity.position.offset(
            -(entity.position.x - b.entity.position.x) * 2, 0,
            -(entity.position.z - b.entity.position.z) * 2
          );
          try { await b.pathfinder.goto(new goals.GoalNear(fleePos.x, fleePos.y, fleePos.z, 2)); } catch {}
          const food = b.inventory.items().find(i => ctx.mcData.foodsByName?.[i.name]);
          if (food) { await b.equip(food, 'hand'); try { await b.consume(); } catch {} }
          return { result: `Retreated from ${targetName} at ${b.health} HP. ${hits} hits dealt.` };
        }

        if (!entity.isValid) {
          return { result: `Killed ${targetName}! ${hits} hits. Lost ${Math.round(startHealth - b.health)} HP.` };
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
        await b.attack(entity);
        hits++;
        // Wooden sword cooldown is ~0.625s for full damage; 500ms is a slight
        // tradeoff (small dmg loss for higher swing rate) that prevents the bot
        // taking 2 hits between its own swings.
        await sleep(500);
      }

      return { result: `Fight timeout. ${hits} hits on ${targetName}. Health: ${b.health}` };
    },

    async flee({ distance = 16, from, to }) {
      const b = ensureBot();

      const locs = loadLocations();

      const markTo = typeof to === 'string' && to.trim() ? to.trim() : '';

      let threat;
      if (!markTo) {
        const hostiles = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'drowned', 'husk', 'stray', 'phantom', 'blaze', 'wither_skeleton', 'player'];
        if (from) {
          const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
          const visible = filterEntitiesFairPlay(rawEnts);
          threat = visible.find(e => (e.name || '').toLowerCase().includes(from.toLowerCase()) || (e.username || '').toLowerCase().includes(from.toLowerCase()));
        } else {
          const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
          const visible = filterEntitiesFairPlay(rawEnts);
          threat = visible.find(e => hostiles.some(h => (e.name || '').includes(h)));
        }
        if (!threat && !markTo) return { result: 'No threats nearby' };
      }

      if (markTo) {
        const tgt = locs[markTo];
        if (!tgt) throw new Error(`Unknown mark '${markTo}'. Try mc marks.`);

        if (markTo && threat) {
          const dx = b.entity.position.x - threat.position.x;
          const dz = b.entity.position.z - threat.position.z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          const fleeX = b.entity.position.x + (dx / len) * distance;
          const fleeZ = b.entity.position.z + (dz / len) * distance;
          try {
            await b.pathfinder.goto(new goals.GoalNear(fleeX, b.entity.position.y, fleeZ, 3));
          } catch (_) { /* partial move ok */ }
        }

        await b.pathfinder.goto(new goals.GoalNear(tgt.x, tgt.y, tgt.z, 2));
        return {
          result: threat
            ? `Fled threats then moved toward mark '${markTo}'`
            : `Moving to mark '${markTo}' (${Math.round(distance)} steps context)`,
          data: { to: markTo, position: { x: tgt.x, y: tgt.y, z: tgt.z } },
        };
      }

      const dx = b.entity.position.x - threat.position.x;
      const dz = b.entity.position.z - threat.position.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const fleeX = b.entity.position.x + (dx / len) * distance;
      const fleeZ = b.entity.position.z + (dz / len) * distance;

      try {
        await b.pathfinder.goto(new goals.GoalNear(fleeX, b.entity.position.y, fleeZ, 3));
        return { result: `Fled ${distance} blocks from ${threat.name}` };
      } catch {
        return { result: `Tried to flee, moved partially. Health: ${b.health}` };
      }
    },

    // ── Advanced Combat ───────────────────────────────
    async sneak({ enable = true }) {
      const b = ensureBot();
      b.setControlState('sneak', !!enable);
      ctx.isSneaking = !!enable;
      return { result: enable ? 'Sneaking — nameplate hidden, reduced detection range' : 'Stopped sneaking' };
    },

    async shield_block({ duration = 3 }) {
      const b = ensureBot();
      const shield = b.inventory.items().find(i => i.name === 'shield');
      if (!shield) throw new Error('No shield in inventory. Craft one first (1 iron + 6 planks).');

      if (!b.inventory.slots[45] || b.inventory.slots[45].name !== 'shield') {
        await b.equip(shield, 'off-hand');
      }

      b.activateItem(true);
      const blockTime = Math.min(duration, 10) * 1000;
      await sleep(blockTime);
      b.deactivateItem();
      return { result: `Blocked with shield for ${duration}s` };
    },

    async shoot({ target, predict = true }) {
      const b = ensureBot();
      await reactionDelay();

      const bow = b.inventory.items().find(i => i.name === 'bow' || i.name === 'crossbow');
      if (!bow) throw new Error('No bow/crossbow in inventory.');
      const arrows = b.inventory.items().find(i => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow');
      if (!arrows) throw new Error('No arrows in inventory.');
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
      if (!entity) throw new Error(`No ${target || 'target'} visible.`);

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

      return { result: `Shot ${bow.name} at ${entity.name || target} (${fmt(entity.position.distanceTo(b.entity.position))}m)` };
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
      if (!entity) throw new Error(`No ${target || 'target'} visible.`);

      b.setControlState('sprint', true);
      if (entity.position.distanceTo(b.entity.position) > 3.5) {
        await b.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
      }
      await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
      await b.attack(entity);
      b.setControlState('sprint', false);

      return { result: `Sprint-attacked ${entity.name || target}! (extra knockback)` };
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
      if (!entity) throw new Error(`No ${target || 'target'} visible within range.`);

      if (entity.position.distanceTo(b.entity.position) > 3.5) {
        await b.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
      }

      b.setControlState('jump', true);
      await sleep(200);
      b.setControlState('jump', false);
      await sleep(150);
      await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
      await b.attack(entity);

      return { result: `Critical hit on ${entity.name || target}! (150% damage, star particles)` };
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
      if (!entity) throw new Error(`No ${target || 'target'} visible.`);

      let hits = 0;
      const endTime = Date.now() + Math.min(duration, 15) * 1000;
      const dir = direction === 'random' ? (Math.random() > 0.5 ? 'left' : 'right') : direction;

      while (Date.now() < endTime && entity.isValid) {
        if (b.health <= 6) return { result: `Strafing stopped — low HP (${b.health}). ${hits} hits.` };

        const dx = entity.position.x - b.entity.position.x;
        const dz = entity.position.z - b.entity.position.z;
        const dist = Math.sqrt(dx*dx + dz*dz);

        const perpX = dir === 'left' ? -dz/dist : dz/dist;
        const perpZ = dir === 'left' ? dx/dist : -dx/dist;

        await b.lookAt(entity.position.offset(0, entity.height * 0.8, 0));

        b.setControlState(dir === 'left' ? 'left' : 'right', true);
        b.setControlState(dir === 'left' ? 'right' : 'left', false);

        if (dist < 4) {
          await b.attack(entity);
          hits++;
        }

        await sleep(500);
      }

      b.setControlState('left', false);
      b.setControlState('right', false);

      return { result: `Strafed ${dir} around ${entity.name || target}. ${hits} hits in ${duration}s.` };
    },

    async combo({ target, style = 'aggressive' }) {
      const b = ensureBot();

      const rawEnts = Object.values(b.entities).filter(e => e !== b.entity);
      const visible = filterEntitiesFairPlay(rawEnts);
      const entity = target
        ? visible.find(e => (e.name || '').toLowerCase().includes(target.toLowerCase()) || (e.username || '').toLowerCase().includes(target.toLowerCase()))
        : visible.filter(e => e.position.distanceTo(b.entity.position) < 16)[0];
      if (!entity) throw new Error(`No ${target || 'target'} visible.`);
      const tName = entity.name || entity.username || target || 'target';

      const results = [];
      try {
        switch (style) {
          case 'aggressive':
            results.push((await deps.ACTIONS.sprint_attack({ target: tName })).result);
            await sleep(600);
            results.push((await deps.ACTIONS.critical_hit({ target: tName })).result);
            await sleep(600);
            results.push((await deps.ACTIONS.critical_hit({ target: tName })).result);
            if (b.inventory.items().find(i => i.name === 'shield')) {
              await sleep(200);
              results.push((await deps.ACTIONS.shield_block({ duration: 1 })).result);
            }
            break;
          case 'defensive':
            if (b.inventory.items().find(i => i.name === 'shield')) {
              results.push((await deps.ACTIONS.shield_block({ duration: 2 })).result);
            }
            results.push((await deps.ACTIONS.critical_hit({ target: tName })).result);
            await sleep(300);
            results.push((await deps.ACTIONS.flee({ distance: 6 })).result);
            break;
          case 'ranged':
            results.push((await deps.ACTIONS.shoot({ target: tName, predict: true })).result);
            await sleep(1200);
            results.push((await deps.ACTIONS.shoot({ target: tName, predict: true })).result);
            if (entity.isValid && entity.position.distanceTo(b.entity.position) < 8) {
              results.push((await deps.ACTIONS.sprint_attack({ target: tName })).result);
            }
            break;
          case 'berserker':
            results.push((await deps.ACTIONS.sprint_attack({ target: tName })).result);
            for (let i = 0; i < 3 && entity.isValid && b.health > 4; i++) {
              await sleep(500);
              results.push((await deps.ACTIONS.critical_hit({ target: tName })).result);
            }
            break;
          default:
            throw new Error(`Unknown combo style: ${style}. Use: aggressive, defensive, ranged, berserker`);
        }
      } catch (err) {
        results.push(`Combo interrupted: ${err.message}`);
      }

      return { result: `[${style}] ${results.join(' → ')}` };
    },

  };
}
