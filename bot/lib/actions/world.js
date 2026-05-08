import { Vec3 } from 'vec3';
import { equipForDig, PROTECTED_DIG_BLOCKS, DIG_PASSABLE_NAMES, columnTopSolid, nudgeOffStandPillar } from '../bot/dig-tools.js';

export function createWorldActions(deps) {
  const { ctx, ensureBot, goals, fmt, posObj, sleep, log, resolveInventoryItem, rememberSocialEvent, getMyName, ACTIONS } = deps;
  return {

  // ── Inventory ────────────────────────────────────
  async equip({ item, slot = 'hand' }) {
    const b = ensureBot();
    const invRows = b.inventory.items().map((i) => ({ name: i.name, count: i.count }));
    const er = resolveInventoryItem({
      mcData: ctx.mcData,
      inventory: invRows,
      query: String(item),
      policy: 'best_available',
    });
    if (!er.ok) throw new Error(er.message || `No ${item} in inventory.`);
    const invItem = b.inventory.items().find((i) => i.name === er.selected.name);
    if (!invItem) {
      const available = b.inventory.items().map((i) => i.name);
      throw new Error(`No ${er.selected.name} in inventory. Have: ${[...new Set(available)].join(', ')}`);
    }
    await b.equip(invItem, slot);
    return { result: `Equipped ${er.selected.name} to ${slot}` };
  },

  async unequip({ slot = 'hand' }) {
    const b = ensureBot();
    if (slot === 'hand') {
      const qbStart = b.QUICK_BAR_START ?? 36;
      let cleared = false;
      for (let s = 0; s < 9; s++) {
        if (!b.inventory.slots[qbStart + s]) {
          b.setQuickBarSlot(s);
          cleared = true;
          break;
        }
      }
      if (!cleared) {
        await b.unequip('hand');
      }
    } else {
      await b.unequip(slot);
    }
    const nowHeld = b.heldItem;
    return { result: nowHeld?.name ? `Hand now holds ${nowHeld.name}` : 'Hand is now empty.' };
  },

  async toss({ item, count }) {
    const b = ensureBot();
    const invItem = b.inventory.items().find(i => i.name === item);
    if (!invItem) throw new Error(`No ${item} in inventory.`);
    if (count && count > 0 && count < invItem.count) {
      await b.toss(invItem.type, null, count);
    } else {
      await b.tossStack(invItem);
    }
    return { result: `Tossed ${count || invItem.count} ${item}` };
  },

  /**
   * Climb pillar safely: place underfoot only (never above head), then jump.
   * Use from holes when pathfinder cannot staircase to surface.
   */
  async pillar_step({ block: blockName, jump: doJump } = {}) {
    const b = ensureBot();
    const wantJump = doJump !== false && doJump !== 'false';
    const cascade = [];
    if (blockName) cascade.push(String(blockName));
    cascade.push(
      'dirt',
      'sand',
      'gravel',
      'netherrack',
      'cobblestone',
      'stone',
      'granite',
      'andesite',
      'diorite',
      'deepslate',
      'oak_planks',
      'spruce_planks',
      'birch_planks',
    );

    let item = null;
    const equipBuildingBlock = async () => {
      item = null;
      for (const nm of cascade) {
        item = b.inventory.items().find((it) => it.name === nm);
        if (item) break;
      }
      if (!item) throw new Error(`pillar_step needs a placing block (${cascade.join(', ')}).`);
      await b.equip(item, 'hand');
      return item;
    };

    await equipBuildingBlock();
    const p0 = b.entity.position;
    const ix = Math.floor(p0.x);
    const iz = Math.floor(p0.z);
    const startFy = Math.floor(p0.y);

    const faceOffsets = [
      [0, -1, 0],
      [0, 1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];

    const isAirLike = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');
    const canPlaceAt = async (y, allowFeetLevel, baseFy) => {
      if (!allowFeetLevel && y >= baseFy) return null;
      if (y === baseFy && b.entity.position.y < baseFy + 1.0) return null;
      const targetPos = new Vec3(ix, y, iz);
      const cur = b.blockAt(targetPos);
      if (!isAirLike(cur)) return null;
      for (const [dx, dy, dz] of faceOffsets) {
        const ref = b.blockAt(targetPos.offset(dx, dy, dz));
        if (
          ref &&
          !isAirLike(ref) &&
          ref.boundingBox === 'block'
        ) {
          try {
            await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
            return { y };
          } catch {
            /* try next face/cell */
          }
        }
      }
      return null;
    };

    const tryOnce = async (allowFeetLevel, baseFy) => {
      for (const y of [baseFy, baseFy - 1]) {
        const placed = await canPlaceAt(y, allowFeetLevel, baseFy);
        if (placed) return placed;
      }
      return null;
    };

    const ensureHeadroom = async (baseFy) => {
      for (const y of [baseFy + 1, baseFy + 2]) {
        const blk = b.blockAt(new Vec3(ix, y, iz));
        if (!blk || isAirLike(blk) || blk.boundingBox !== 'block') continue;
        await equipForDig(b, blk);
        await b.dig(blk, true);
        await sleep(80);
      }
    };

    if (!wantJump) {
      const baseFy = Math.floor(b.entity.position.y);
      await equipBuildingBlock();
      const placed = await tryOnce(false, baseFy);
      if (placed) return { result: `pillar_step placed ${item.name} at ${ix},${placed.y},${iz}` };
      throw new Error(`pillar_step could not place underfoot at (${ix},${baseFy} or ${baseFy - 1},${iz}).`);
    }

    const jumpCycles = 3;
    for (let cycle = 0; cycle < jumpCycles; cycle++) {
      const baseFy = Math.floor(b.entity.position.y);
      await ensureHeadroom(baseFy);
      await equipBuildingBlock();
      b.setControlState('forward', false);
      b.setControlState('back', false);
      b.setControlState('left', false);
      b.setControlState('right', false);
      b.setControlState('sprint', false);
      b.setControlState('jump', true);
      try {
        const cycleDeadline = Date.now() + 400;
        while (Date.now() < cycleDeadline) {
          const placed = await tryOnce(true, baseFy);
          if (placed) {
            await sleep(150);
            return { result: `pillar_step placed ${item.name} at ${ix},${placed.y},${iz} (+jump)` };
          }
          await sleep(10);
        }
      } finally {
        b.setControlState('jump', false);
      }
      await sleep(50);
    }

    throw new Error(
      `pillar_step could not place underfoot in column (${ix},${startFy}/${startFy - 1},${iz}) after ${jumpCycles} timed jumps; headroom may still be blocked.`,
    );
  },

  // ── Building ─────────────────────────────────────
  async place({ block: blockName, x, y, z }) {
    const b = ensureBot();
    const item = b.inventory.items().find(i => i.name === blockName);
    if (!item) throw new Error(`No ${blockName} in inventory.`);

    await b.equip(item, 'hand');
    const targetPos = new Vec3(x, y, z);

    const existing = b.blockAt(targetPos);
    if (existing && existing.name !== 'air' && existing.name !== 'cave_air') {
      throw new Error(
        `Cannot place at ${x}, ${y}, ${z}: block is already ${existing.name}. Choose an empty air cell with a solid face next to it (or dig this cell first).`,
      );
    }

    if (b.entity.position.distanceTo(targetPos) > 4.5) {
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
    }

    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    const neighborSummary = offsets
      .map(([dx, dy, dz]) => {
        const ref = b.blockAt(targetPos.offset(dx, dy, dz));
        const nm = ref?.name ?? '?';
        const solid = Boolean(ref && ref.name !== 'air' && ref.name !== 'cave_air');
        return `${dx},${dy},${dz}=${nm}${solid ? '' : '*air*'}`;
      })
      .join(' | ');
    const botP = posObj(b.entity.position);

    for (const [dx, dy, dz] of offsets) {
      const ref = b.blockAt(targetPos.offset(dx, dy, dz));
      if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
        try {
          await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
          return { result: `Placed ${blockName} at ${x}, ${y}, ${z}` };
        } catch (err) {
          const reason = /** @type {Error} */ (err).message || String(err);
          throw new Error(
            `Mineflayer place failed for ${blockName} at ${x},${y},${z} (attach offset ${dx},${dy},${dz}): ${reason}. Neighbors: ${neighborSummary}. Bot ~${botP ? `${botP.x},${botP.y},${botP.z}` : '?'}.`,
          );
        }
      }
    }
    throw new Error(
      `No solid neighbor for ${blockName} at ${x},${y},${z}. Neighbors: ${neighborSummary}. Bot ~${botP ? `${botP.x},${botP.y},${botP.z}` : '?'}. Stand beside the face you want to extend (target cell must touch solid on one side).`,
    );
  },

  async place_fill({ block: blockName, x1, y1, z1, x2, y2, z2, hollow = false }) {
    const b = ensureBot();
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
    const total = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (total > 500) throw new Error(`Area too large (${total} blocks, max 500). Split into smaller fills.`);

    const positions = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (hollow) {
            const onEdge = x === minX || x === maxX || y === minY || y === maxY || z === minZ || z === maxZ;
            if (!onEdge) continue;
          }
          positions.push({ x, y, z });
        }
      }
    }

    const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    let placed = 0;
    for (const pos of positions) {
      const existing = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
      if (existing && existing.name !== 'air' && existing.name !== 'cave_air') continue;

      const item = b.inventory.items().find(i => i.name === blockName);
      if (!item) throw new Error(`Out of ${blockName} (placed ${placed}/${positions.length})`);
      await b.equip(item, 'hand');

      if (b.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) > 4.5) {
        try { await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)); } catch {}
      }

      for (const [dx, dy, dz] of offsets) {
        const ref = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
        if (ref && ref.name !== 'air' && ref.name !== 'cave_air') {
          try {
            await b.placeBlock(ref, new Vec3(-dx, -dy, -dz));
            placed++;
          } catch {}
          break;
        }
      }
    }
    return { result: `Placed ${placed}/${positions.length} ${blockName} blocks (${hollow ? 'hollow' : 'solid'})` };
  },

  /**
   * Highest solid block per vertical column — for pit/site selection without N×find_blocks.
   * Optional `radius`: square (2r+1)² around (x,z), returns max top among sampled columns.
   */
  async terrain_top({ x, z, radius = 0 }) {
    const b = ensureBot();
    const cx = Math.floor(Number(x));
    const cz = Math.floor(Number(z));
    const r = Math.min(Math.max(parseInt(String(radius), 10) || 0, 0), 32);
    /** @type {{ x:number, z:number, topY:number, blockName:string }[]} */
    const columns = [];
    let maxTopY = Number.NEGATIVE_INFINITY;
    let maxBlock = '';
    let maxAt = { x: cx, z: cz };

    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const ix = cx + dx;
        const iz = cz + dz;
        const col = columnTopSolid(b, ix, iz);
        if (!col) continue;
        columns.push({ x: ix, z: iz, topY: col.topY, blockName: col.blockName });
        if (col.topY > maxTopY) {
          maxTopY = col.topY;
          maxBlock = col.blockName;
          maxAt = { x: ix, z: iz };
        }
      }
    }

    if (!columns.length) {
      return {
        result: `No solid blocks in column(s) around ${cx},${cz} (radius ${r}).`,
        topY: null,
        blockName: null,
        columns: [],
      };
    }

    const feetYHint = maxTopY + 1;
    return {
      result: `Top solid ≈Y${maxTopY} (${maxBlock}) at ${maxAt.x},${maxAt.z}${r ? ` (max over radius ${r})` : ''}`,
      topY: maxTopY,
      blockName: maxBlock,
      columnX: maxAt.x,
      columnZ: maxAt.z,
      feetYHint,
      ...(r > 0 ? { columns } : {}),
    };
  },

  /**
   * Clear a box of diggable blocks (inverse of place_fill): top Y down, stand-block deferred per layer.
   */
  async dig_area({
    x1, y1, z1, x2, y2, z2,
    pickup: doPickup = true,
    abort_on_fail: abortOnFail = false,
    clear_stand: clearStand = true,
  }) {
    const b = ensureBot();
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    const minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
    const total = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (total > 500) throw new Error(`Area too large (${total} blocks, max 500). Split into smaller digs.`);

    let dug = 0;
    let skipped = 0;
    /** @type {string[]} */
    const errors = [];
    /** @type {Set<string>} */
    const digHintSet = new Set();

    for (let y = maxY; y >= minY; y--) {
      const bx = Math.floor(b.entity.position.x);
      const bz = Math.floor(b.entity.position.z);
      const botFloorY = Math.floor(b.entity.position.y);
      const underFeetY = botFloorY - 1;

      /** @type {{ x:number, y:number, z:number }[]} */
      const cells = [];
      for (let xi = minX; xi <= maxX; xi++) {
        for (let zi = minZ; zi <= maxZ; zi++) {
          cells.push({ x: xi, y, z: zi });
        }
      }

      /** @type {{ x:number, y:number, z:number }[]} */
      const deferred = [];
      /** @type {{ x:number, y:number, z:number }[]} */
      const normal = [];
      for (const c of cells) {
        if (clearStand && c.x === bx && c.z === bz && c.y === underFeetY) deferred.push(c);
        else normal.push(c);
      }

      normal.sort((a, c) => {
        const da = Math.max(Math.abs(a.x - bx), Math.abs(a.z - bz));
        const dc = Math.max(Math.abs(c.x - bx), Math.abs(c.z - bz));
        if (da !== dc) return da - dc;
        const ma = Math.abs(a.x - bx) + Math.abs(a.z - bz);
        const mc = Math.abs(c.x - bx) + Math.abs(c.z - bz);
        return ma - mc;
      });

      const order = [...normal, ...deferred];

      for (const pos of order) {
        if (clearStand && pos.x === bx && pos.z === bz && pos.y === underFeetY) {
          await nudgeOffStandPillar(b, pos.x, pos.y, pos.z, goals);
          await sleep(120);
        }

        const target = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
        if (!target || DIG_PASSABLE_NAMES.has(target.name)) continue;

        if (target.name === 'bedrock') {
          skipped++;
          continue;
        }
        if (PROTECTED_DIG_BLOCKS.has(target.name)) {
          skipped++;
          continue;
        }

        try {
          const { hints } = await equipForDig(b, target);
          for (const h of hints) digHintSet.add(h);
          if (b.entity.position.distanceTo(target.position) > 4.5) {
            try {
              await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
            } catch {}
          }
          await b.dig(target, true);
          dug++;
          await sleep(80);
        } catch (err) {
          const msg = /** @type {Error} */ (err).message || String(err);
          errors.push(`(${pos.x},${pos.y},${pos.z}): ${msg}`);
          skipped++;
          if (abortOnFail) throw /** @type {Error} */ (err);
        }
      }
    }

    let pickupResult = '';
    if (doPickup) {
      try {
        const pu = await ACTIONS.pickup();
        pickupResult = pu?.result ? ` ${pu.result}` : '';
      } catch {
        pickupResult = ' (pickup skipped)';
      }
    }

    const digHints = [...digHintSet];
    const tipsSuffix = digHints.length ? ` Tips: ${digHints.join(' | ')}` : '';
    return {
      result: `Dug ${dug} blocks (${skipped} skipped).${pickupResult}${tipsSuffix}${errors.length ? ` Errors: ${errors.slice(0, 3).join('; ')}` : ''}`,
      dug,
      skipped,
      ...(digHints.length ? { hints: digHints } : {}),
      ...(errors.length ? { errors: errors.slice(0, 20) } : {}),
    };
  },

  // ── Interaction ─────────────────────────────────
  async interact({ x, y, z }) {
    const b = ensureBot();
    const block = b.blockAt(new Vec3(x, y, z));
    if (!block) throw new Error(`No block at ${x}, ${y}, ${z}`);
    if (b.entity.position.distanceTo(block.position) > 4.5) {
      await b.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
    }
    await b.activateBlock(block);
    return { result: `Interacted with ${block.name} at ${x}, ${y}, ${z}` };
  },

  async close_screen() {
    const b = ensureBot();
    if (b.currentWindow) b.closeWindow(b.currentWindow);
    return { result: 'Closed screen.' };
  },

  // ── Utility ──────────────────────────────────────
  async chat({ message }) {
    const b = ensureBot();
    b.chat(message);
    rememberSocialEvent({ actor: getMyName(), kind: 'sent', channel: 'public', message });
    return { result: `Sent: ${message}` };
  },

  async wait({ seconds = 5 }) {
    ensureBot();
    await sleep(Math.min(seconds, 60) * 1000);
    return { result: `Waited ${seconds}s` };
  },

  async use() {
    const b = ensureBot();
    await b.activateItem();
    return { result: `Used ${b.heldItem?.name || 'hand'}` };
  },

  async sleep_bed() {
    const b = ensureBot();
    const bed = b.findBlock({
      matching: block => block.name?.includes('bed'),
      maxDistance: 4,
    });
    if (!bed) throw new Error('No bed within 4 blocks.');
    await b.sleep(bed);
    return { result: 'Sleeping...' };
  },

  // ── Chat / Whisper ──────────────────────────────
  async chat_to({ player, message }) {
    const b = ensureBot();
    b.chat(`/msg ${player} ${message}`);
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'whisper', message });
    return { result: `[→${player}]: ${message}` };
  },

  async whisper({ player, message }) {
    const b = ensureBot();
    b.chat(`/msg ${player} ${message}`);
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'whisper', message });
    return { result: `[→${player}]: ${message}` };
  },

  // ── Death Recovery ────────────────────────────────
  async deathpoint() {
    if (!ctx.lastDeath) return { result: 'No deaths recorded.' };
    const pos = ctx.lastDeath.position;
    const age = Math.round((Date.now() - ctx.lastDeath.time) / 1000);
    const b = ensureBot();
    await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
    return { result: `At death #${ctx.lastDeath.deathNumber} (${age}s ago). Lost: ${ctx.lastDeath.inventory.map(i=>`${i.name}x${i.count}`).join(', ')}` };
  },

  };
}
