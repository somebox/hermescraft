// @size-exempt: pillar_step (from actions/building split)
import { Vec3 } from 'vec3';
import { equipForDig, isDigProtected, recordRecentPlace } from '../../runtime/dig-tools.js';
import { shouldSkipDigAt } from '../../runtime/regions/policy-guard.js';
import { fail } from '../../shared/action-contract.js';
import { cascadeFor } from '../../runtime/materials.js';
import { findStandingBlockCell, isPartialBlockShape } from './pillar-geometry.js';

/**
 * @param {{ ctx: any, ensureBot: () => any, sleep: (ms: number) => Promise<void>,
 *           getActions: () => any }} deps
 */
export function createBuildingPillarPart(deps) {
  const { ctx, ensureBot, sleep, getActions } = deps;

  return {
    async pillar_step({ block: blockName, jump: doJump, count: rawCount, force: rawForce } = {}) {
      // Stand pillar: jump straight up and place a block on the top face of the
      // block currently underfoot. Repeats up to `count` times. Auto-stops if a
      // horizontal neighbor becomes walkable (the bot has reached a platform top
      // and the caller can simply step laterally instead of building a spire).
      //
      // Self-rescue behavior: if no pillar block is in inventory, the loop
      // bare-hand digs the cell overhead, waits for the drop to enter
      // inventory, and pillars with that captured block. Region/global denylists
      // refuse the dig by default; pass `force: true` to bypass those guards
      // (and to allow slow bare-hand stone digs). `force` should only be set
      // when the bot is genuinely stuck — pillar_step verifies the
      // 4-wall+ceiling predicate before honouring it.
      const b = ensureBot();
      const wantJump = doJump !== false && doJump !== 'false';
      const maxSteps = Math.min(Math.max(parseInt(rawCount, 10) || 1, 1), 64);
      const force = rawForce === true || rawForce === 'true' || rawForce === '1';

      // Pre-flight: refuse pillar_step from a partial-height block (slab,
      // stairs, snow_layer, etc.). The bot's foot Y is fractional in that
      // state (e.g. slab.y + 0.5), so each pillar_step physically rises
      // +1.5 instead of +1 — endY - startY misreports by 1 per call (see
      // pillar-geometry.test.js's slab property test). Force lets a power-
      // user override; cleanup ops calling pillar_step from a known
      // partial-block context can pass force=true.
      const standingPre = findStandingBlockCell(
        b.entity.position,
        (pos) => b.blockAt(pos),
      );
      if (!force && standingPre && isPartialBlockShape(standingPre.name)) {
        return fail(
          'PILLAR_FROM_PARTIAL_BLOCK',
          `Refusing pillar_step from a ${standingPre.name} (partial-height block). ` +
          `Bot foot is on a half-block top (Y=${Math.floor(b.entity.position.y * 10) / 10}); ` +
          `pillar_step would over-rise by ~0.5-1 block per step and the reported ` +
          `endY-startY would be ${maxSteps + 1} instead of ${maxSteps}. ` +
          `Step off the slab first (mc move to an adjacent full-block cell), or ` +
          `pass force=true to acknowledge and proceed with off-by-one reporting.`,
          {
            observed_state: {
              standing_block: standingPre.name,
              standing_cell: standingPre.position,
              bot_position: {
                x: Math.floor(b.entity.position.x),
                y: b.entity.position.y,
                z: Math.floor(b.entity.position.z),
              },
              requested_count: maxSteps,
            },
            next_action_hint: 'mc move to an adjacent full-block cell, then mc pillar_step',
            retry_safe: false,
          },
        );
      }

      const cascade = [];
      if (blockName) cascade.push(String(blockName));
      // Pillar-rescue cascade — prefer bare-hand-diggable terrain blocks so
      // the bot can recover the pillar after climbing. Defined in
      // data/materials.json `cascades.pillar_rescue` (single source of truth
      // across primitives). Planks are intentionally NOT included — they are
      // tier_2 structural material; pillar_rescue stays tier_1 only.
      const rescueCascade = cascadeFor('pillar_rescue');
      for (const nm of rescueCascade) {
        if (!cascade.includes(nm)) cascade.push(nm);
      }
      // Legacy fallback: a few mid-tier stones the rescue cascade omits but
      // historically appeared in pillar_step's fallback. Kept for back-compat
      // until the live fleet has run long enough on the rescue-only cascade
      // to confirm they aren't needed.
      for (const nm of ['granite', 'andesite', 'diorite', 'deepslate']) {
        if (!cascade.includes(nm)) cascade.push(nm);
      }

      const isAirLike = (blk) => blk && (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air');

      // Audit trail for forceEscape region/global-denylist bypasses. Surfaced
      // in the result envelope so post-incident inspection can see exactly
      // which protected block was broken.
      /** @type {{ x:number, y:number, z:number, block:string, source:string }[]} */
      const forceBypasses = [];

      const findInventoryPillarBlock = () => {
        for (const nm of cascade) {
          const item = b.inventory.items().find((it) => it.name === nm);
          if (item) return item;
        }
        return null;
      };

      const equipBuildingBlock = async () => {
        const item = findInventoryPillarBlock();
        if (!item) return null; // signal to caller — try capture-from-ceiling
        if (b.heldItem?.type !== item.type) await b.equip(item, 'hand');
        return item;
      };

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

      // True when the bot is genuinely stuck: 4 cardinal walls within 1 cell
      // at head height AND a ceiling within 2 cells overhead. Gates the
      // forceEscape region-policy bypass so --force can't be abused to break
      // through arbitrary protected blocks during normal navigation.
      const isGenuinelyStuck = () => {
        const cx = Math.floor(b.entity.position.x);
        const cz = Math.floor(b.entity.position.z);
        const headY = Math.floor(b.entity.position.y + 0.001) + 1;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const wall = b.blockAt(new Vec3(cx + dx, headY, cz + dz));
          if (!wall || wall.boundingBox !== 'block') return false;
        }
        for (let dy = 1; dy <= 2; dy++) {
          const above = b.blockAt(new Vec3(cx, headY + dy, cz));
          if (above && above.boundingBox === 'block') return true;
        }
        return false;
      };

      // Dig overhead block(s) so the bot has clearance to jump and place.
      // Required for "pillar through a solid roof" to reach the surface above.
      // Returns { attempted, succeeded, lastError } so the loop can distinguish
      // "ceiling was already air" from "tried and failed to dig".
      const ensureHeadroom = async (ix, iz, baseFy) => {
        let attempted = 0;
        let succeeded = 0;
        let lastError = null;
        for (const y of [baseFy + 1, baseFy + 2]) {
          const blk = b.blockAt(new Vec3(ix, y, iz));
          if (!blk || isAirLike(blk) || blk.boundingBox !== 'block') continue;
          const policy = shouldSkipDigAt(
            ctx, null, blk.name, ix, y, iz, isDigProtected,
            { forceEscape: force && isGenuinelyStuck() },
          );
          if (policy.skip) {
            lastError = `POLICY_DENY at ${ix},${y},${iz} (${blk.name})`;
            continue;
          }
          if (policy.forceEscapeBypassed) {
            forceBypasses.push({ x: ix, y, z: iz, block: blk.name, source: policy.forceEscapeBypassed });
          }
          attempted++;
          try {
            await equipForDig(b, blk, { force });
            await b.dig(blk, true);
            await sleep(80);
            const after = b.blockAt(new Vec3(ix, y, iz));
            if (after && isAirLike(after)) succeeded++;
            else lastError = `dig completed but block remains at ${ix},${y},${iz}`;
          } catch (e) {
            lastError = e?.message || String(e);
          }
        }
        return { attempted, succeeded, lastError };
      };

      // Capture-from-ceiling: when inventory has no pillar block, dig the cell
      // directly above the bot's head, wait for the drop to enter inventory,
      // and return the captured block name (or null on failure).
      //
      // Cells (bot foot.y = 64.0 standing on block at y=63):
      //   footCell = 64 (air cell containing feet)
      //   headCell = 65 (air cell containing head)
      //   ceiling  = 66 = footCell + 2  ← what we want to dig
      // We need the DROP, not just the air, so we pickup() after the dig.
      const captureFromCeiling = async () => {
        const cx = Math.floor(b.entity.position.x);
        const cz = Math.floor(b.entity.position.z);
        const footCell = Math.floor(b.entity.position.y + 0.001);
        const targetY = footCell + 2; // first cell above bot's head
        const target = b.blockAt(new Vec3(cx, targetY, cz));
        if (!target || isAirLike(target) || target.boundingBox !== 'block') {
          return { captured: null, reason: `cell above head at (${cx},${targetY},${cz}) is air — nothing to capture` };
        }
        const policy = shouldSkipDigAt(
          ctx, null, target.name, cx, targetY, cz, isDigProtected,
          { forceEscape: force && isGenuinelyStuck() },
        );
        if (policy.skip) {
          return { captured: null, reason: `POLICY_DENY at ${cx},${targetY},${cz} (${target.name}) — region/global denylist refused. Retry with force=true if you are genuinely stuck.` };
        }
        if (policy.forceEscapeBypassed) {
          forceBypasses.push({ x: cx, y: targetY, z: cz, block: target.name, source: policy.forceEscapeBypassed });
        }
        try {
          await equipForDig(b, target, { force });
        } catch (e) {
          return { captured: null, reason: `equip refused: ${e?.message || e}. Retry with force=true to slow-dig.` };
        }
        try {
          await b.dig(target, true);
          await sleep(120); // let drop spawn
        } catch (e) {
          return { captured: null, reason: `dig failed: ${e?.message || e}` };
        }
        // Pull any dropped items into inventory. pickup() is the same verb the
        // agent would call manually; reusing keeps the magnet-radius + sweep
        // semantics consistent.
        try {
          const pickup = getActions?.()?.pickup;
          if (typeof pickup === 'function') await pickup();
        } catch { /* pickup is best-effort; the next loop check sees inv */ }
        await sleep(60);
        const captured = findInventoryPillarBlock();
        if (!captured) {
          // The block dug but dropped nothing (stone bare-hand without pickaxe)
          // or dropped something not in our cascade.
          return {
            captured: null,
            reason: `dug ${target.name} at ${cx},${targetY},${cz} but no pillar-compatible drop landed in inventory. Bare-hand stone drops nothing; get a pickaxe or extract dirt/sand from walls/floor.`,
          };
        }
        return { captured, reason: null };
      };

      /** One pillar step: jump and place on top of standing block. Returns
       *  { y } on success, { failReason } on failure. */
      const doOneStep = async () => {
        await waitForOnGround(600);

        const standing = findStandingBlock();
        if (!standing) return { failReason: 'no standing block beneath feet' };

        const targetY = standing.position.y + 1;
        const targetPos = new Vec3(standing.position.x, targetY, standing.position.z);
        const targetCell = b.blockAt(targetPos);
        if (targetCell && !isAirLike(targetCell) && targetCell.boundingBox === 'block') {
          return { failReason: `target cell at ${targetPos.x},${targetPos.y},${targetPos.z} is already solid (${targetCell.name})` };
        }

        // Bot needs ~2 cells of clearance above feet to jump-and-place. If a roof
        // is overhead, dig through it (this is the "pillar through ceiling" case).
        const ix = Math.floor(b.entity.position.x);
        const iz = Math.floor(b.entity.position.z);
        const feetY = Math.floor(b.entity.position.y + 0.001);
        const headroom = await ensureHeadroom(ix, iz, feetY);

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

        // Equip a pillar block. If inventory is empty:
        //   1. Call pickup() first — ensureHeadroom above just dug 1-2 cells
        //      and the drops are sitting on the ground in our cavity. Collect
        //      those before trying to dig fresh.
        //   2. Poll inventory briefly — pickup() resolves before the
        //      inventory_change packet lands, so a tight check returns null
        //      stale. Wait up to ~500ms for the captured block to appear.
        //   3. If STILL empty after pickup (e.g. the dig dropped nothing, the
        //      block was stone bare-hand), call captureFromCeiling — which
        //      digs whatever is now overhead and tries pickup again.
        let blockReady = await equipBuildingBlock();
        if (!blockReady && headroom.succeeded > 0) {
          // The ceiling block just dug should produce a drop. Two paths to
          // get it into inventory:
          //   (a) Minecraft's auto-magnet pulls it (drops within ~1.5 blocks
          //       of player auto-collect on next tick). In a 1×1 cavity the
          //       drop lands right under the bot, so magnet is the normal path.
          //   (b) The drop lands too far / behind a corner, in which case we
          //       need to run pickup() to pathfind to it.
          // Poll inventory for up to ~1.2s. If inventory updates, magnet got
          // it — skip pickup. If not, look for a dropped item entity in
          // b.entities and only THEN call pickup (running pickup against
          // empty entity list exits immediately, wasted call).
          const cx = Math.floor(b.entity.position.x);
          const cz = Math.floor(b.entity.position.z);
          const deadline = Date.now() + 1200;
          while (Date.now() < deadline) {
            await sleep(80);
            blockReady = await equipBuildingBlock();
            if (blockReady) break;
            // Auto-magnet didn't grab it. Look for an item entity to pickup.
            let dropEntity = null;
            for (const e of Object.values(b.entities || {})) {
              if (!e || !e.position) continue;
              if (e.name !== 'item' && e.displayName !== 'Item') continue;
              if (Math.abs(e.position.x - (cx + 0.5)) <= 3 &&
                  Math.abs(e.position.z - (cz + 0.5)) <= 3) {
                dropEntity = e; break;
              }
            }
            if (dropEntity) {
              try {
                const pickup = getActions?.()?.pickup;
                if (typeof pickup === 'function') await pickup();
              } catch { /* best effort */ }
              // pickup() blocks; check inventory immediately and loop one
              // more time if it still hasn't landed.
              blockReady = await equipBuildingBlock();
              if (blockReady) break;
            }
          }
        }
        if (!blockReady) {
          const cap = await captureFromCeiling();
          if (!cap.captured) {
            return { failReason: `no pillar block in inventory; capture-from-ceiling failed: ${cap.reason}` };
          }
          blockReady = await equipBuildingBlock();
          if (!blockReady) return { failReason: `captured ${cap.captured.name} but failed to re-equip` };
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
        if (placedY !== null) {
          // Read the now-placed block back so we have its canonical name
          // for the recentPlaces audit trail (mineflayer may have placed a
          // captured-from-ceiling variant rather than what we asked for).
          const placedBlock = b.blockAt(targetPos);
          return {
            y: placedY,
            cell: { x: targetPos.x, y: targetPos.y, z: targetPos.z },
            blockName: placedBlock?.name || null,
          };
        }
        // Failed to place. Include headroom info so the loop knows whether
        // the issue was overhead-blocked (couldn't jump high enough) vs
        // place-rejected (server refused the place at threshold).
        const headInfo = headroom.attempted > 0
          ? ` (ensureHeadroom: attempted=${headroom.attempted}, succeeded=${headroom.succeeded}${headroom.lastError ? `, lastError=${headroom.lastError}` : ''})`
          : '';
        return { failReason: `placement did not register within 1.5s${headInfo}` };
      };

      // First attempt to equip a pillar block. If empty and we're not yet
      // stuck, we surface the legacy NOT_IN_INVENTORY error — the loop will
      // still try captureFromCeiling per-step. We only fail-fast here when
      // there's no plausible path forward.
      const initial = await equipBuildingBlock();
      if (!initial) {
        // Allow entry to the loop — captureFromCeiling will try to extract a
        // pillar block from the cell overhead. If that's also air, we'll hit
        // doOneStep's "ceiling is air — pillar with held block" and bail.
      }

      const startY = Math.floor(b.entity.position.y);
      let placed = 0;
      let lateralExit = null;
      let consecutiveFails = 0;
      const failReasons = [];

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
            const eq = await equipBuildingBlock();
            if (!eq) {
              consecutiveFails++;
              if (consecutiveFails >= 2) break;
              continue;
            }
            await b.placeBlock(standing, new Vec3(0, 1, 0));
            placed++;
            consecutiveFails = 0;
            // Track this placed cell so isDigProtected exempts it during
            // cleanup AND so future audit / pillar_undo passes can find
            // the bot's own pillar blocks. See dig-tools.js:116.
            const placedCell = { x: standing.position.x, y: standing.position.y + 1, z: standing.position.z };
            const placedBlk = b.blockAt(new Vec3(placedCell.x, placedCell.y, placedCell.z));
            recordRecentPlace(ctx, placedCell, placedBlk?.name || 'unknown');
          } catch {
            consecutiveFails++;
            if (consecutiveFails >= 2) break;
          }
          continue;
        }

        const result = await doOneStep();
        if (result.y !== undefined) {
          placed++;
          consecutiveFails = 0;
          // Record into the recentPlaces ring so isDigProtected exempts
          // this block during the bot's own cleanup (the bot is allowed
          // to mine its own recently-placed pillar blocks). See the
          // 2026-05-27 audit: pillar_step previously never populated
          // recentPlaces, so 377+ orphan columns accumulated in one
          // session because Steward couldn't dig them via mc collect
          // (they looked like protected infrastructure).
          if (result.cell) {
            recordRecentPlace(ctx, result.cell, result.blockName || 'unknown');
          }
        } else {
          failReasons.push(result.failReason);
          consecutiveFails++;
          // Permit one extra retry compared to the legacy `>= 2` exit so that
          // dig-capture-pillar cycles aren't cut off by transient hiccups
          // (e.g. the first capture-from-ceiling needs an extra moment for
          // the dropped item to enter inventory). Three consecutive failures
          // with identical reasons is the new break condition.
          if (consecutiveFails >= 3) break;
          if (consecutiveFails >= 2 && failReasons.length >= 2
              && failReasons.at(-1) === failReasons.at(-2)) {
            break;
          }
        }
      }

      // Final settle before snapshotting endY. doOneStep ends with a 150ms
      // sleep after a successful place — enough for 1 block fall on a local
      // network, marginal under server lag. Without this wait, position.y
      // can be mid-fall when we read it → floor(position.y) reports one
      // less than the bot's actual settled foot. waitForOnGround spins on
      // bot.entity.onGround, returning early once the fall completes.
      // No-op when the bot is already settled (last step exited via
      // lateralExit or stallbreak without a recent place).
      await waitForOnGround(400);
      const endY = Math.floor(b.entity.position.y);
      const pos = b.entity.position;

      if (placed === 0 && !lateralExit) {
        return fail(
          'PILLAR_FAILED',
          `pillar_step could not place any blocks. Y=${startY}, pos=(${Math.floor(pos.x)},${endY},${Math.floor(pos.z)}). ${failReasons.length ? `Reasons: ${failReasons.slice(0, 3).join(' | ')}. ` : ''}Headroom may be blocked, inventory empty with no diggable ceiling, or region policy refused (try force=true if genuinely stuck).`,
          {
            observed_state: { start_y: startY, end_y: endY, x: Math.floor(pos.x), z: Math.floor(pos.z), fail_reasons: failReasons.slice(0, 5) },
            retry_safe: true,
            ...(forceBypasses.length ? { force_escape_bypassed: forceBypasses } : {}),
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
            ? `In a 1×1 shaft at (${cx},${endY},${cz}). Call mc pillar_step again with a higher count — primitive will dig the ceiling and pillar with the captured drop. Pass force=true if the ceiling is stone and you're bare-handed.`
            : `In a 1×1 shaft at (${cx},${endY},${cz}) with ceiling overhead. Call mc pillar_step again — the primitive will try to bare-hand dig the ceiling cell and pillar with the drop. If the ceiling is stone, pass force=true to allow slow bare-hand digs.`;
          shaftTrap = { walls: wallSides, can_pillar_further: canPillarFurther, hint };
        }
      }

      const exitSuffix = lateralExit
        ? `. Lateral exit at ${lateralExit.x},${lateralExit.y},${lateralExit.z} (floor ${lateralExit.floor}) — caller should: mc goto_near ${lateralExit.x} ${lateralExit.y} ${lateralExit.z} 1.`
        : shaftTrap
          ? `. ⚠ ${shaftTrap.hint}`
          : '';
      const forceSuffix = forceBypasses.length
        ? ` force=true bypassed ${forceBypasses.length} protected dig${forceBypasses.length === 1 ? '' : 's'}.`
        : '';

      // Cleanup hint — fires when the bot climbed but has no lateral exit.
      // From 2026-05-27 live evidence: workers were oscillating
      // pillar_step → mc move → BOT_ON_PILLAR → partial pillar_down →
      // pillar_step again, each cycle leaving 1-2 orphan blocks. The
      // hint nudges the caller toward immediate cleanup OR explicit
      // sideways escape via mc dig of a wall.
      const cleanupHint = (!lateralExit && placed > 0)
        ? `mc pillar_down ${placed}`
        : null;
      const cleanupSuffix = cleanupHint
        ? ` ⚠ Pathfinding from a 1×1 column will refuse with BOT_ON_PILLAR. Cleanup options: \`${cleanupHint}\` to come back down, OR \`mc dig\` an adjacent wall block to step off sideways.`
        : '';

      return {
        result: `pillar_step climbed ${placed} block${placed !== 1 ? 's' : ''}: Y ${startY} → ${endY} (pos ${Math.floor(pos.x)},${endY},${Math.floor(pos.z)})${exitSuffix}${forceSuffix}${cleanupSuffix}`,
        placed,
        startY,
        endY,
        position: { x: Math.floor(pos.x), y: endY, z: Math.floor(pos.z) },
        ...(lateralExit ? { lateral_exit: lateralExit } : {}),
        ...(shaftTrap ? { shaft_trap: shaftTrap } : {}),
        ...(cleanupHint ? { cleanup_hint: cleanupHint } : {}),
        ...(forceBypasses.length ? { force_escape_bypassed: forceBypasses } : {}),
      };
    },
  };
}
