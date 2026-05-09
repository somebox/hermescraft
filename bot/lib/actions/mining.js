import { Vec3 } from 'vec3';
import { equipForDig, PROTECTED_DIG_BLOCKS } from '../bot/dig-tools.js';
import { bearingFromDelta, classifySector, angleDiffDegrees } from '../shared/perception.js';

export function createMiningActions(deps) {
  const { ctx, ensureBot, goals, fmt, posObj, sleep, log, resolveMiningBlockName, fairPlayHarvestTrunkCandidates, findVisibleBlocksByNameWithPhysicalSweep, entitiesMatchingAfterLookSweep, rememberSocialEvent } = deps;
  return {
    async collect({ block, count = 1 }) {
      const b = ensureBot();
      const blockName = resolveMiningBlockName(block);
      const blockType = ctx.mcData.blocksByName[blockName];
      if (!blockType) throw new Error(`Unknown block "${blockName}". Check spelling (e.g. oak_log, iron_ore, cobblestone).`);

      const batchSize = Math.min(count, 20);

      /** @type {Vec3[]} */
      let found = [];
      const isTrunkHarvest = /_log$|_stem$|^crimson_stem$|^warped_stem$/i.test(blockName);
      const isNonSolidPlant = blockType.boundingBox !== 'block';
      if (ctx.fairPlayMode) {
        if (isTrunkHarvest) {
          found = fairPlayHarvestTrunkCandidates(blockName, blockType.id, batchSize, b);
        }
        if (found.length === 0 && !isNonSolidPlant) {
          const visible = await findVisibleBlocksByNameWithPhysicalSweep(blockName, {
            range: 16,
            count: batchSize * 3,
          });
          found = visible.map(
            (entry) => new Vec3(entry.position.x, entry.position.y, entry.position.z),
          );
        }
        if (found.length === 0 && isNonSolidPlant) {
          // Non-solid blocks (grass, flowers, crops) can't be raycast-detected;
          // use proximity search with a short range since they're visible at ground level
          found = b.findBlocks({
            matching: blockType.id,
            maxDistance: 12,
            count: batchSize * 3,
          });
        }
        if (found.length === 0 && !isNonSolidPlant) {
          // Fair-play fallback: scout nearby ore coordinates and use short-range
          // assist to avoid repeated "look/check" loops in tight caves.
          const scout = b.findBlocks({
            matching: blockType.id,
            maxDistance: 10,
            count: Math.max(batchSize * 2, 8),
          });
          if (scout.length > 0) {
            const nearest = scout.sort(
              (a, c) => b.entity.position.distanceTo(a) - b.entity.position.distanceTo(c),
            )[0];
            try {
              await b.pathfinder.goto(new goals.GoalNear(nearest.x, nearest.y, nearest.z, 2));
            } catch {
              // Keep graceful failure path below with an actionable hint.
            }
            const reVisible = await findVisibleBlocksByNameWithPhysicalSweep(blockName, {
              range: 16,
              count: batchSize * 3,
            });
            found = reVisible.map(
              (entry) => new Vec3(entry.position.x, entry.position.y, entry.position.z),
            );
            if (found.length === 0) {
              // Last-resort short-range scout-assist: harvest only very nearby
              // coordinates to keep behavior practical without long-range xray.
              found = scout
                .filter((p) => b.entity.position.distanceTo(p) <= 10)
                .map((p) => new Vec3(p.x, p.y, p.z));
              if (found.length === 0) {
                throw new Error(
                  `Can't see any ${blockName} right now. Nearest scout hit at ${nearest.x}, ${nearest.y}, ${nearest.z}. Try mc goto_near ${nearest.x} ${nearest.y} ${nearest.z} 2, then mc scene and mc collect ${blockName} 2.`,
                );
              }
            }
          }
        }
      } else {
        found = b.findBlocks({
          matching: blockType.id,
          maxDistance: 64,
          count: batchSize * 3,
        });
      }

      if (found.length === 0) {
        throw new Error(
          ctx.fairPlayMode
            ? isTrunkHarvest
              ? `No ${blockName} with harvest line-of-sight in range (leaves/water between you and the trunk are ok; dirt/stone/other wood are not). Try mc discover logs, mc goto_near, or circle the tree.`
              : `Can't see any ${blockName} right now. Turn, move, or use mc scene/mc look before collecting.`
            : `No ${blockName} found within 64 blocks.`,
        );
      }

      const botPos = b.entity.position;
      const safe = found.filter(pos => {
        if (Math.abs(pos.x - Math.floor(botPos.x)) < 1 &&
            Math.abs(pos.z - Math.floor(botPos.z)) < 1 &&
            pos.y < Math.floor(botPos.y)) return false;
        return true;
      });

      if (safe.length === 0) throw new Error(`No safely reachable ${blockName} found.`);

      // Group blocks into clusters (trees) by XZ proximity, then sort:
      // 1. Nearest cluster first (minimizes travel)
      // 2. Within a cluster, bottom-up (dig trunk base then reach up)
      const clusters = [];
      const assigned = new Set();
      for (let i = 0; i < safe.length; i++) {
        if (assigned.has(i)) continue;
        const cluster = [safe[i]];
        assigned.add(i);
        for (let j = i + 1; j < safe.length; j++) {
          if (assigned.has(j)) continue;
          const dx = Math.abs(safe[j].x - safe[i].x);
          const dz = Math.abs(safe[j].z - safe[i].z);
          if (dx <= 1 && dz <= 1) {
            cluster.push(safe[j]);
            assigned.add(j);
          }
        }
        cluster.sort((a, c) => a.y - c.y);
        clusters.push(cluster);
      }
      // Sort clusters by horizontal distance from bot (nearest tree first)
      clusters.sort((a, c) => {
        const aBase = a[0];
        const cBase = c[0];
        const aD = Math.abs(aBase.x - botPos.x) + Math.abs(aBase.z - botPos.z);
        const cD = Math.abs(cBase.x - botPos.x) + Math.abs(cBase.z - botPos.z);
        return aD - cD;
      });
      const sorted = clusters.flat();

      let collected = 0;
      let lastCollectErr = '';
      /** @type {Set<string>} */
      const tipSet = new Set();
      for (const pos of sorted.slice(0, batchSize)) {
        if (ctx.currentTask?.status !== 'running') break;
        try {
          const target = b.blockAt(pos);
          if (!target || target.name !== blockName) continue;
          const { hints } = await equipForDig(b, target);
          for (const h of hints) tipSet.add(h);

          const dist = b.entity.position.distanceTo(pos);
          if (dist > 4.5) {
            const curPos = b.entity.position;
            const horizDist = Math.abs(pos.x - curPos.x) + Math.abs(pos.z - curPos.z);
            if (horizDist > 4) {
              // Far away horizontally — navigate to ground level near the tree
              // to avoid long pathfinder timeouts on distant elevated blocks
              const navY = Math.floor(curPos.y);
              try {
                await b.pathfinder.goto(new goals.GoalNear(pos.x, navY, pos.z, 2));
              } catch {
                try {
                  await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
                } catch { continue; }
              }
            } else {
              // Close horizontally but above — let pathfinder scaffold up
              try {
                await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
              } catch { continue; }
            }
          }

          // Re-fetch target (may have been mined by falling tree physics etc.)
          const recheck = b.blockAt(pos);
          if (!recheck || recheck.name !== blockName) continue;
          // Skip if out of reach or if we'd dig the block we're standing on
          const curPos = b.entity.position;
          if (curPos.distanceTo(pos) > 5.5) continue;
          const feetY = Math.floor(curPos.y);
          if (pos.y === feetY - 1 &&
              Math.abs(pos.x - Math.floor(curPos.x)) < 1 &&
              Math.abs(pos.z - Math.floor(curPos.z)) < 1) continue;

          // Dig with timeout to prevent indefinite hangs
          await Promise.race([
            b.dig(recheck, true),
            new Promise((_, rej) => setTimeout(() => rej(new Error('dig_timeout')), 12000)),
          ]);
          collected++;
          await sleep(200);
        } catch (err) {
          const m = /** @type {Error} */ (err).message || String(err);
          if (m === 'dig_timeout') {
            try { b.stopDigging(); } catch {}
          }
          lastCollectErr = m;
          log(`[collect] Error mining ${blockName} at ${pos.x},${pos.y},${pos.z}: ${m}`);
        }
      }

      await sleep(600);
      for (let attempt = 0; attempt < 3; attempt++) {
        const drops = Object.values(b.entities)
          .filter(e => (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(b.entity.position) < 12)
          .sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position));
        if (drops.length === 0) break;
        for (const drop of drops.slice(0, 6)) {
          try {
            await b.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1));
            await sleep(400);
          } catch {}
        }
      }

      const invCount = b.inventory.items().filter(i => i.name === blockName).reduce((s, i) => s + i.count, 0);
      const remaining = count - collected;
      if (collected === 0 && lastCollectErr) {
        throw new Error(
          `Could not mine any ${blockName} (${batchSize} attempts). Last error: ${lastCollectErr}`,
        );
      }
      const tips = [...tipSet];
      const tipsSuffix = tips.length ? ` Tips: ${tips.join(' | ')}` : '';
      const msg = remaining > 0
        ? `Mined ${collected} ${blockName} (${remaining} more needed). Have ${invCount} ${blockName} in inventory.${tipsSuffix}`
        : `Mined ${collected}/${count} ${blockName}. Have ${invCount} ${blockName} in inventory.${tipsSuffix}`;
      return { result: msg, ...(tips.length ? { hints: tips } : {}) };
    },

    async dig({ x, y, z }) {
      const b = ensureBot();
      const target = b.blockAt(new Vec3(x, y, z));

      // ─ Phase-2 action contract (see docs/phase-2-architecture.md §8 mc dig) ─
      // Soft failures return { ok: false, error: { code, message, observed_state, ... } }.
      // The HTTP wrapper spreads result over { ok: true, ... }, so ok=false propagates.

      if (!target || target.name === 'air' || target.name === 'cave_air' || target.name === 'void_air') {
        return {
          ok: false,
          error: {
            code: 'NO_BLOCK_AT_COORD',
            message: `No block at ${x}, ${y}, ${z} — target is ${target?.name || 'unknown'}`,
            observed_state: { block_at_target: target?.name || null, requested_coord: { x, y, z } },
            retry_safe: false,
          },
        };
      }

      if (PROTECTED_DIG_BLOCKS.has(target.name)) {
        return {
          ok: false,
          error: {
            code: 'PROTECTED_BLOCK',
            message: `Cannot dig ${target.name} — it is part of a building. Use doors to enter buildings.`,
            observed_state: { block_at_target: target.name, requested_coord: { x, y, z } },
            retry_safe: false,
          },
        };
      }

      const distance = b.entity.position.distanceTo(target.position);

      let hints = [];
      try {
        const ed = await equipForDig(b, target);
        hints = ed.hints || [];
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'TOOL_INADEQUATE',
            message: err.message,
            observed_state: {
              block_at_target: target.name,
              held: b.tool?.itemInHand()?.name ?? null,
              distance: Math.round(distance * 10) / 10,
            },
            next_action_hint: err.message,
            retry_safe: false,
          },
        };
      }

      if (distance > 4.5) {
        try {
          await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
        } catch (err) {
          return {
            ok: false,
            error: {
              code: 'OUT_OF_RANGE',
              message: `Target at (${x}, ${y}, ${z}) is ${Math.round(distance * 10) / 10} blocks away and pathfind failed: ${err.message}`,
              observed_state: {
                block_at_target: target.name,
                distance: Math.round(distance * 10) / 10,
                bot_position: posObj(b.entity.position),
              },
              retry_safe: false,
            },
          };
        }
      }

      const targetPos = target.position;
      const beforeDropIds = new Set(
        Object.values(b.entities)
          .filter((e) => e.name === 'item' || e.displayName === 'Item')
          .map((e) => e.id),
      );

      try {
        await b.dig(target, true);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'INTERRUPTED',
            message: `Dig interrupted: ${err.message}`,
            observed_state: { block_at_target: target.name, requested_coord: { x, y, z } },
            retry_safe: true,
          },
        };
      }

      // ─ Success: scan for drop entities at/near the target for data.dropped_items ─
      // Drops appear ~1-3 server ticks after the block break packet. Wait briefly
      // (default 300ms; tunable via MC_DIG_DROP_SCAN_MS) then collect any item
      // entities that weren't there before, restricted to ≤2.5 blocks of the
      // broken coord (drops can scatter slightly with falling-block physics).
      const dropScanMs = Number(process.env.MC_DIG_DROP_SCAN_MS) || 300;
      await sleep(dropScanMs);
      const dropped = [];
      for (const e of Object.values(b.entities)) {
        if (e.name !== 'item' && e.displayName !== 'Item') continue;
        if (beforeDropIds.has(e.id)) continue;
        if (!e.position || e.position.distanceTo(targetPos) > 2.5) continue;
        // mineflayer exposes the held item via metadata index 8 (1.16+) or 7 (older).
        // Both shapes carry { itemId, itemCount } as the slot data.
        const meta = e.metadata?.[8] || e.metadata?.[7];
        const itemName = meta?.itemId
          ? (ctx.mcData.items[meta.itemId]?.name || `item:${meta.itemId}`)
          : (e.displayName || 'unknown');
        const count = meta?.itemCount ?? meta?.count ?? 1;
        dropped.push({
          name: itemName,
          count,
          position: posObj(e.position),
        });
      }

      const tips = [...new Set(hints)];

      return {
        ok: true,
        data: {
          block_name: target.name,
          dropped_items: dropped,
          position_after: posObj(b.entity.position),
        },
        // Preserve legacy fields so existing callers (goal engine, older tests) still see them.
        result: `Mined ${target.name} at ${x}, ${y}, ${z}${tips.length ? ` Tips: ${tips.join(' | ')}` : ''}`,
        ...(tips.length ? { hints: tips } : {}),
      };
    },

    async pickup() {
      const b = ensureBot();
      const invBefore = b.inventory.items().reduce((s, i) => s + i.count, 0);

      for (let attempt = 0; attempt < 3; attempt++) {
        const pos = b.entity.position;
        const drops = Object.values(b.entities)
          .filter(e => (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(pos) < 16)
          .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));

        if (drops.length === 0) break;

        for (const drop of drops.slice(0, 8)) {
          try {
            await b.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1));
            await sleep(400);
          } catch {}
        }
      }

      const invAfter = b.inventory.items().reduce((s, i) => s + i.count, 0);
      const gained = invAfter - invBefore;
      return { result: gained > 0 ? `Picked up ${gained} items.` : 'No items to pick up.' };
    },

    async find_blocks({ block, radius = 32, count = 10 }) {
      const b = ensureBot();
      const blockName = resolveMiningBlockName(block);
      const blockType = ctx.mcData.blocksByName[blockName];
      if (!blockType) throw new Error(`Unknown block "${blockName}".`);

      const r = Math.min(Math.max(parseInt(String(radius), 10) || 32, 1), 96);
      const n = Math.min(Math.max(parseInt(String(count), 10) || 10, 1), 64);
      const baseYawDeg = (b.entity.yaw * 180) / Math.PI;

      const found = b
        .findBlocks({
          matching: blockType.id,
          maxDistance: r,
          count: n,
        })
        .map((p) => {
          const dx = p.x - b.entity.position.x;
          const dz = p.z - b.entity.position.z;
          const relDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
          return {
            position: { x: p.x, y: p.y, z: p.z },
            distance: fmt(b.entity.position.distanceTo(p)),
            bearing: bearingFromDelta(dx, dz),
            sector: classifySector(angleDiffDegrees(baseYawDeg, relDeg)),
          };
        });

      if (found.length === 0) {
        return { result: `No ${blockName} found within ${r} blocks.`, locations: [] };
      }

      const locations = found.map((entry) => ({
        x: entry.position.x,
        y: entry.position.y,
        z: entry.position.z,
        distance: entry.distance,
        bearing: entry.bearing,
        sector: entry.sector,
      }));

      const fpNote = ctx.fairPlayMode ? ` (scout; mc collect needs trunk in sight)` : '';
      return { result: `Found ${found.length} ${blockName}${fpNote}`, locations };
    },

    async find_entities({ type, radius = 32 }) {
      const b = ensureBot();
      const pos = b.entity.position;
      const r = Math.min(96, Math.max(4, parseInt(String(radius), 10) || 32));

      let raw;
      if (ctx.fairPlayMode) {
        raw = await entitiesMatchingAfterLookSweep(b, pos, r, type);
      } else {
        raw = Object.values(b.entities).filter((e) => e !== b.entity && e.position.distanceTo(pos) < r);
        if (type) {
          const tl = String(type).toLowerCase();
          raw = raw.filter(
            (e) =>
              (e.name || '').toLowerCase().includes(tl) ||
              (e.username || '').toLowerCase().includes(tl) ||
              (e.displayName || '').toLowerCase().includes(tl),
          );
        }
      }

      let entities = raw
        .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos))
        .slice(0, 20)
        .map((e) => ({
          type: e.username || e.name || e.displayName || 'unknown',
          distance: fmt(e.position.distanceTo(pos)),
          position: posObj(e.position),
          health: e.health ?? undefined,
        }));

      return {
        result: `Found ${entities.length} ${type || 'entities'}${ctx.fairPlayMode ? ' (look sweep)' : ''}`,
        locations: entities.map((e) => ({ ...e.position, distance: e.distance, type: e.type })),
        entities,
      };
    },

    async complete_command({ index = 0, message }) {
      if (ctx.commandQueue.length === 0) return { result: 'No commands in queue.' };
      const pending = ctx.commandQueue.filter(c => c.status === 'pending' || c.status === 'acknowledged');
      if (index >= pending.length) return { result: 'No pending command at that index.' };
      const cmd = pending[index];
      cmd.status = 'completed';
      cmd.completed_at = Date.now();
      rememberSocialEvent({ actor: cmd.from, kind: 'completed_command', channel: cmd.channel || 'direct', message: cmd.command });
      const reply = message || `Done: "${cmd.command}"`;
      return { result: reply };
    },

    async acknowledge_command({ index = 0, plan }) {
      const pending = ctx.commandQueue.filter(c => c.status === 'pending');
      if (pending.length === 0) return { result: 'No pending commands to acknowledge.' };
      if (index >= pending.length) return { result: 'No pending command at that index.' };
      const cmd = pending[index];
      cmd.status = 'acknowledged';
      cmd.acknowledged_at = Date.now();
      if (plan) cmd.plan = plan;
      rememberSocialEvent({ actor: cmd.from, kind: 'acknowledged_command', channel: cmd.channel || 'direct', message: cmd.command });
      return { result: `Acknowledged: "${cmd.command}"${plan ? ` — plan: ${plan}` : ''}` };
    },

    async cancel_command({ index = 0, reason }) {
      const active = ctx.commandQueue.filter(c => c.status === 'pending' || c.status === 'acknowledged');
      if (active.length === 0) return { result: 'No active commands to cancel.' };
      if (index >= active.length) return { result: 'No command at that index.' };
      const cmd = active[index];
      cmd.status = 'cancelled';
      cmd.cancelled_at = Date.now();
      cmd.cancel_reason = reason || 'cancelled by bot';
      rememberSocialEvent({ actor: cmd.from, kind: 'cancelled_command', channel: cmd.channel || 'direct', message: cmd.command });
      return { result: `Cancelled: "${cmd.command}"${reason ? ` — ${reason}` : ''}` };
    },
  };
}
