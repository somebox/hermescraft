// @size-exempt: pillar_step (from actions/building split)
import { Vec3 } from 'vec3';
import { equipForDig, isDigProtected } from '../../runtime/dig-tools.js';
import { fail } from '../../shared/action-contract.js';

/**
 * @param {{ ctx: any, ensureBot: () => any, sleep: (ms: number) => Promise<void> }} deps
 */
export function createBuildingPillarPart(deps) {
  const { ctx, ensureBot, sleep } = deps;

  return {
    async pillar_step({ block: blockName, jump: doJump, count: rawCount } = {}) {
      // Stand pillar: jump straight up and place a block on the top face of the
      // block currently underfoot. Repeats up to `count` times. Auto-stops if a
      // horizontal neighbor becomes walkable (the bot has reached a platform top
      // and the caller can simply step laterally instead of building a spire).
      const b = ensureBot();
      const wantJump = doJump !== false && doJump !== 'false';
      const maxSteps = Math.min(Math.max(parseInt(rawCount, 10) || 1, 1), 64);

      const cascade = [];
      if (blockName) cascade.push(String(blockName));
      // #99: prefer dirt/sand/gravel/netherrack — bare-hand-diggable so the
      // bot can recover the pillar after climbing. Cobblestone / stone /
      // granite-family need at least a wooden pickaxe to re-mine, so they
      // come last as fallbacks. Bottom-of-cascade planks are last resort.
      cascade.push(
        'dirt', 'sand', 'gravel', 'netherrack',
        'cobblestone', 'stone',
        'granite', 'andesite', 'diorite', 'deepslate', 'cobbled_deepslate',
        'oak_planks', 'spruce_planks', 'birch_planks',
      );

      const isAirLike = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');

      const equipBuildingBlock = async () => {
        let item = null;
        for (const nm of cascade) {
          item = b.inventory.items().find((it) => it.name === nm);
          if (item) break;
        }
        if (!item) {
          return fail(
            'NOT_IN_INVENTORY',
            `pillar_step needs a placing block (${cascade.join(', ')}).`,
            { retry_safe: false },
          );
        }
        if (b.heldItem?.type !== item.type) await b.equip(item, 'hand');
        return item;
      };

      const maybeReturnEquipFail = (r) => (r && typeof r === 'object' && r.ok === false ? r : null);

      // Locate the block the bot is currently standing on. Walks down from feet
      // up to 2 cells (handles full blocks at floor(y) and partial blocks like
      // chests/slabs at floor(y) where pos.y is fractional).
      const findStandingBlock = () => {
        const ix = Math.floor(b.entity.position.x);
        const iz = Math.floor(b.entity.position.z);
        const feetY = Math.floor(b.entity.position.y - 0.001);
        for (let dy = 0; dy <= 1; dy++) {
          const y = feetY - dy;
          const blk = b.blockAt(new Vec3(ix, y, iz));
          if (blk && blk.boundingBox === 'block') return blk;
        }
        return null;
      };

      const canStepLaterally = () => {
        const feetY = Math.floor(b.entity.position.y + 0.001);
        const cx = Math.floor(b.entity.position.x);
        const cz = Math.floor(b.entity.position.z);
        for (const [hdx, hdz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const floor = b.blockAt(new Vec3(cx + hdx, feetY - 1, cz + hdz));
          const feet = b.blockAt(new Vec3(cx + hdx, feetY, cz + hdz));
          const head = b.blockAt(new Vec3(cx + hdx, feetY + 1, cz + hdz));
          if (floor && floor.boundingBox === 'block' && isAirLike(feet) && isAirLike(head)) {
            return {
              dx: hdx, dz: hdz,
              floor: floor.name,
              // Absolute coords of the walkable cell — pass directly to goto_near.
              x: cx + hdx, y: feetY, z: cz + hdz,
            };
          }
        }
        return null;
      };

      const waitForOnGround = async (maxMs = 600) => {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
          if (b.entity.onGround) return true;
          await sleep(20);
        }
        return false;
      };

      // Dig overhead block(s) so the bot has clearance to jump and place.
      // Required for "pillar through a solid roof" to reach the surface above.
      const ensureHeadroom = async (ix, iz, baseFy) => {
        for (const y of [baseFy + 1, baseFy + 2]) {
          const blk = b.blockAt(new Vec3(ix, y, iz));
          if (!blk || isAirLike(blk) || blk.boundingBox !== 'block') continue;
          if (isDigProtected(blk.name, { x: ix, y, z: iz }, ctx)) continue;
          try {
            await equipForDig(b, blk);
            await b.dig(blk, true);
            await sleep(80);
          } catch { /* couldn't dig (bedrock?); next loop iteration handles it */ }
        }
      };

      /** One pillar step: jump and place on top of standing block. Returns y of new block, or null. */
      const doOneStep = async () => {
        await waitForOnGround(600);

        const standing = findStandingBlock();
        if (!standing) return null;

        const targetY = standing.position.y + 1;
        const targetPos = new Vec3(standing.position.x, targetY, standing.position.z);
        const targetCell = b.blockAt(targetPos);
        if (targetCell && !isAirLike(targetCell) && targetCell.boundingBox === 'block') return null;

        // Bot needs ~2 cells of clearance above feet to jump-and-place. If a roof
        // is overhead, dig through it (this is the "pillar through ceiling" case).
        const ix = Math.floor(b.entity.position.x);
        const iz = Math.floor(b.entity.position.z);
        const feetY = Math.floor(b.entity.position.y + 0.001);
        await ensureHeadroom(ix, iz, feetY);

        // Build the candidate-reference list. The standing block is the canonical
        // pillar reference, but mineflayer's `placeBlock` against a chest's top
        // face times out (the chest's top is a partial collision box; server
        // rejects the place). Fallback to lateral walls at the target's level —
        // any solid block adjacent to (ix, targetY, iz) works as a reference.
        /** @type {{ block: any, face: import('vec3').Vec3 }[]} */
        const refCandidates = [
          { block: standing, face: new Vec3(0, 1, 0) },
        ];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const wall = b.blockAt(new Vec3(targetPos.x + dx, targetPos.y, targetPos.z + dz));
          if (wall && !isAirLike(wall) && wall.boundingBox === 'block') {
            refCandidates.push({ block: wall, face: new Vec3(-dx, 0, -dz) });
          }
        }

        {
          const eq = await equipBuildingBlock();
          const eqFail = maybeReturnEquipFail(eq);
          if (eqFail) return eqFail;
        }

        b.setControlState('forward', false);
        b.setControlState('back', false);
        b.setControlState('left', false);
        b.setControlState('right', false);
        b.setControlState('sprint', false);
        b.setControlState('jump', true);

        // mineflayer's `b.placeBlock` waits up to 5s for a `blockUpdate` event.
        // When the server rejects (bot's hitbox overlaps the new block, partial-
        // block reference, etc.), no event fires and we eat the full timeout —
        // catastrophic for retry loops. Wrap with a short timeout and verify via
        // blockAt instead.
        const tryPlace = async (refBlock, faceVec, timeoutMs = 600) => {
          const placePromise = b.placeBlock(refBlock, faceVec).catch((e) => { throw e; });
          const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs));
          try { await Promise.race([placePromise, timeoutPromise]); }
          catch { /* either thrown by placeBlock or by our timer; verify via blockAt */ }
          const after = b.blockAt(targetPos);
          return after && !isAirLike(after) && after.boundingBox === 'block';
        };

        const cycleDeadline = Date.now() + 1500;
        let placedY = null;
        // Threshold for "high enough to place": ideally targetY + 1.0 (bot fully
        // above new block), but jumping from a partial block (chest, slab) only
        // reaches ~targetY + 0.95. Use 0.92 so server-side tolerance covers the gap.
        const placeThreshold = targetY + 0.92;
        let candIdx = 0;
        try {
          while (Date.now() < cycleDeadline) {
            if (b.entity.position.y >= placeThreshold) {
              const cand = refCandidates[candIdx % refCandidates.length];
              const ok = await tryPlace(cand.block, cand.face, 600);
              if (ok) { placedY = targetY; break; }
              candIdx++;
            }
            await sleep(30);
          }
        } finally {
          b.setControlState('jump', false);
        }
        if (placedY !== null) await sleep(150);  // let bot settle on new block
        return placedY === null ? null : { y: placedY };
      };

      {
        const eq = await equipBuildingBlock();
        const eqFail = maybeReturnEquipFail(eq);
        if (eqFail) return eqFail;
      }
      const startY = Math.floor(b.entity.position.y);
      let placed = 0;
      let lateralExit = null;
      let consecutiveFails = 0;

      for (let step = 0; step < maxSteps; step++) {
        // Skip lateral-exit check on first step — caller may have just dropped
        // into a pit and the "exit" is the entry they came from.
        if (step > 0) {
          await waitForOnGround(400);
          const exit = canStepLaterally();
          if (exit) { lateralExit = exit; break; }
        }

        if (!wantJump) {
          // Sneak-place underfoot variant — fall through to the same logic but
          // skip the jump (rare path; supported for compatibility).
          const standing = findStandingBlock();
          if (!standing) { consecutiveFails++; if (consecutiveFails >= 2) break; continue; }
          try {
            {
          const eq = await equipBuildingBlock();
          const eqFail = maybeReturnEquipFail(eq);
          if (eqFail) return eqFail;
        }
            await b.placeBlock(standing, new Vec3(0, 1, 0));
            placed++;
            consecutiveFails = 0;
          } catch {
            consecutiveFails++;
            if (consecutiveFails >= 2) break;
          }
          continue;
        }

        const result = await doOneStep();
        if (result) {
          placed++;
          consecutiveFails = 0;
        } else {
          consecutiveFails++;
          if (consecutiveFails >= 2) break;
        }
      }

      const endY = Math.floor(b.entity.position.y);
      const pos = b.entity.position;

      if (placed === 0 && !lateralExit) {
        return fail(
          'PILLAR_FAILED',
          `pillar_step could not place any blocks. Y=${startY}, pos=(${Math.floor(pos.x)},${endY},${Math.floor(pos.z)}). Headroom may be blocked or no suitable blocks in inventory.`,
          {
            observed_state: { start_y: startY, end_y: endY, x: Math.floor(pos.x), z: Math.floor(pos.z) },
            retry_safe: true,
          },
        );
      }

      // #93: post-pillar shaft detection. If the bot finished pillaring
      // with no lateral exit AND all 4 cardinal neighbors at head height
      // are solid, the bot is trapped in a 1×1 vertical shaft. Surface a
      // shaft_trap flag + hint so the agent picks a recovery strategy
      // (pillar further, dig a wall, mc escape) instead of looping.
      let shaftTrap = null;
      if (!lateralExit && placed > 0) {
        const cx = Math.floor(pos.x);
        const cz = Math.floor(pos.z);
        const headY = endY + 1;
        const cardinals = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const wallSides = [];
        let allSolid = true;
        for (const [dx, dz] of cardinals) {
          const neighbor = b.blockAt(new Vec3(cx + dx, headY, cz + dz));
          if (!neighbor || neighbor.boundingBox !== 'block') {
            allSolid = false;
            break;
          }
          wallSides.push({ dir: dx === 1 ? 'east' : dx === -1 ? 'west' : dz === 1 ? 'south' : 'north', block: neighbor.name });
        }
        if (allSolid) {
          // Also check the cell directly above the bot's head — if open,
          // pillaring further is viable. If blocked, dig is the only way out.
          const above = b.blockAt(new Vec3(cx, headY + 1, cz));
          const canPillarFurther = !above || above.boundingBox !== 'block';
          const hint = canPillarFurther
            ? `In a 1×1 shaft at (${cx},${endY},${cz}). Pillar 2-3 more to reach surface, OR mc dig one of the wall blocks to make a sideways exit.`
            : `In a 1×1 shaft at (${cx},${endY},${cz}) with ceiling overhead. mc dig ${cx} ${headY} ${cz} (a wall block) to make a sideways exit, then mc move to open ground.`;
          shaftTrap = { walls: wallSides, can_pillar_further: canPillarFurther, hint };
        }
      }

      const exitSuffix = lateralExit
        ? `. Lateral exit at ${lateralExit.x},${lateralExit.y},${lateralExit.z} (floor ${lateralExit.floor}) — caller should: mc goto_near ${lateralExit.x} ${lateralExit.y} ${lateralExit.z} 1.`
        : shaftTrap
          ? `. ⚠ ${shaftTrap.hint}`
          : '';
      return {
        result: `pillar_step climbed ${placed} block${placed !== 1 ? 's' : ''}: Y ${startY} → ${endY} (pos ${Math.floor(pos.x)},${endY},${Math.floor(pos.z)})${exitSuffix}`,
        placed,
        startY,
        endY,
        position: { x: Math.floor(pos.x), y: endY, z: Math.floor(pos.z) },
        ...(lateralExit ? { lateral_exit: lateralExit } : {}),
        ...(shaftTrap ? { shaft_trap: shaftTrap } : {}),
      };
    },
  };
}
