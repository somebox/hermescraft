import { Vec3 } from 'vec3';
import { ok, fail } from '../shared/action-contract.js';
import { pathfindGotoNear, ACTION_CAPS_MS } from './_helpers.js';

/**
 * createFurnaceActions — extracted from former lib/actions/containers.js (Phase 5 split).
 */
export function createFurnaceActions(deps) {
  const { ctx, config, ensureBot, goals, fmt, posObj, sleep, log, loadLocations, saveLocations, flagMarkStale, clearMarkStale, resolveMarkPlaceFromBody, resolveContainerCoords, normalizeDepositWithdrawItems, buildMarksListApi, isContainerBlock, findNearbyContainer, snapshotChestAtPosition, rememberSocialEvent, saveReminders, getMyName } = deps;
  return {
    async smelt_start({ input, fuel, count = 1 }) {
      const b = ensureBot();
      const isFurnace = block =>
        block.name === 'furnace' || block.name === 'lit_furnace' ||
        block.name === 'blast_furnace' || block.name === 'smoker';

      let furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
      if (!furnaceBlock) {
        furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 32 });
        if (furnaceBlock) {
          const fp = furnaceBlock.position;
          await pathfindGotoNear(b, goals, fp.x, fp.y, fp.z, 3, { opName: 'smelt_start', capMs: ACTION_CAPS_MS.reach });
          furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
        }
      }
      if (!furnaceBlock) throw new Error('No furnace within 32 blocks. Place one first (craft furnace from 8 cobblestone).');

      const inputItem = b.inventory.items().find(i => i.name === input);
      if (!inputItem) throw new Error(`No ${input} in inventory. Withdraw it from a chest first.`);

      const furnace = await b.openFurnace(furnaceBlock);

      // Clear finished output so it doesn't block new input
      const existingOutput = furnace.outputItem();
      if (existingOutput) await furnace.takeOutput();
      const existingInput = furnace.inputItem();
      if (existingInput && existingInput.name !== input) await furnace.takeInput();

      const qty = Math.min(count, inputItem.count, 64);
      await furnace.putInput(inputItem.type, null, qty);

      if (!furnace.fuelItem()) {
        const fuelNames = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick', 'lava_bucket', 'blaze_rod'];
        const fuelItem = fuel
          ? b.inventory.items().find(i => i.name === fuel)
          : b.inventory.items().find(i => fuelNames.includes(i.name));
        if (!fuelItem) { furnace.close(); throw new Error('No fuel available.'); }
        const fuelPer = fuelItem.name === 'coal_block' ? 80 : fuelItem.name.includes('coal') || fuelItem.name === 'charcoal' ? 8 : fuelItem.name === 'blaze_rod' ? 12 : fuelItem.name === 'lava_bucket' ? 100 : 1.5;
        const fuelNeeded = Math.ceil(qty / fuelPer);
        await furnace.putFuel(fuelItem.type, null, Math.min(fuelNeeded, fuelItem.count));
      }

      furnace.close();

      const fp = furnaceBlock.position;
      const eta = Date.now() + qty * 10000;
      ctx.team.activeFurnaces.push({
        x: fp.x, y: fp.y, z: fp.z,
        input, count: qty, startTime: Date.now(), estimatedDone: eta,
      });

      const minutes = Math.ceil(qty * 10 / 60);
      const collected = existingOutput ? ` Collected ${existingOutput.count}x ${existingOutput.name} from furnace.` : '';
      return { result: `Loaded ${qty} ${input} into furnace at ${fp.x},${fp.y},${fp.z}. ETA: ~${minutes} min.${collected} Go do something else!` };
    },

    async furnace_check({ x, y, z }) {
      const b = ensureBot();
      const furnaceBlock = b.blockAt(new Vec3(x, y, z));
      if (!furnaceBlock || (!furnaceBlock.name.includes('furnace') && furnaceBlock.name !== 'smoker' && furnaceBlock.name !== 'blast_furnace'))
        throw new Error(`No furnace at ${x},${y},${z}`);

      if (b.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
        await pathfindGotoNear(b, goals, x, y, z, 3, { opName: 'furnace_check', capMs: ACTION_CAPS_MS.reach });
      }
      const furnace = await b.openFurnace(furnaceBlock);
      const inputItem = furnace.inputItem();
      const fuelItem = furnace.fuelItem();
      const outputItem = furnace.outputItem();
      furnace.close();

      return {
        result: `Furnace at ${x},${y},${z}: ` +
          `Input: ${inputItem ? `${inputItem.name} x${inputItem.count}` : 'empty'} | ` +
          `Fuel: ${fuelItem ? `${fuelItem.name} x${fuelItem.count}` : 'empty'} | ` +
          `Output: ${outputItem ? `${outputItem.name} x${outputItem.count}` : 'empty'} | ` +
          `Status: ${outputItem ? 'output ready!' : inputItem ? 'smelting...' : 'idle'}`,
        ready: !!outputItem,
        output: outputItem ? { name: outputItem.name, count: outputItem.count } : null,
      };
    },

    async furnace_take({ x, y, z }) {
      const b = ensureBot();
      const furnaceBlock = b.blockAt(new Vec3(x, y, z));
      if (!furnaceBlock) throw new Error(`No block at ${x},${y},${z}`);

      if (b.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
        await pathfindGotoNear(b, goals, x, y, z, 3, { opName: 'furnace_check', capMs: ACTION_CAPS_MS.reach });
      }
      const furnace = await b.openFurnace(furnaceBlock);
      const output = furnace.outputItem();
      if (!output) { furnace.close(); return { result: 'Furnace has no output ready yet.' }; }
      await furnace.takeOutput();

      const remaining = furnace.inputItem();
      furnace.close();

      ctx.team.activeFurnaces = ctx.team.activeFurnaces.filter(f => !(f.x === x && f.y === y && f.z === z));

      return { result: `Collected ${output.name} x${output.count} from furnace.${remaining ? ` (${remaining.count} ${remaining.name} still being smelted)` : ''}` };
    },

    // ── Team System ──────────────────────────────────

    async smelt({ input, fuel, count = 1, reason }) {
      // ─ Phase-2 action contract (docs/design/phase-2/action-contracts.md mc smelt) ─
      // ok=true requires smelted_count >= 1; verified via inventory delta on output item.

      const b = ensureBot();
      const inventoryAt = () =>
        b.inventory.items().reduce((acc, it) => {
          acc[it.name] = (acc[it.name] || 0) + it.count;
          return acc;
        }, /** @type {Record<string, number>} */ ({}));
      const startedInventory = inventoryAt();

      const isFurnace = block =>
        block.name === 'furnace' || block.name === 'lit_furnace' ||
        block.name === 'blast_furnace' || block.name === 'smoker';

      // ── Locate furnace ──
      let furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
      let nearestFurnaceSeen = null;
      if (!furnaceBlock) {
        const wide = b.findBlock({ matching: isFurnace, maxDistance: 32 });
        if (wide) {
          nearestFurnaceSeen = { x: wide.position.x, y: wide.position.y, z: wide.position.z, kind: wide.name };
          try {
            await pathfindGotoNear(b, goals, wide.position.x, wide.position.y, wide.position.z, 3, { opName: 'smelt_furnace', capMs: ACTION_CAPS_MS.reach });
            furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
          } catch { /* leave null */ }
        }
      }
      if (!furnaceBlock) {
        try {
          const locs = loadLocations();
          const botPos = b.entity.position;
          const furnaceMarks = Object.entries(locs)
            .filter(([name, l]) => /furnace|smelter|smelt/i.test(name) || /furnace|smelter/i.test(l.note || ''))
            .map(([name, l]) => ({ name, x: l.x, y: l.y, z: l.z, dist: botPos.distanceTo(new Vec3(l.x, l.y, l.z)) }))
            .sort((a, c) => a.dist - c.dist);
          if (furnaceMarks.length > 0 && furnaceMarks[0].dist < 100) {
            const m = furnaceMarks[0];
            nearestFurnaceSeen = nearestFurnaceSeen || { x: m.x, y: m.y, z: m.z, kind: 'furnace_mark' };
            await pathfindGotoNear(b, goals, m.x, m.y, m.z, 3, { opName: 'smelt_furnace_mark', capMs: ACTION_CAPS_MS.reach });
            furnaceBlock = b.findBlock({ matching: isFurnace, maxDistance: 4 });
          }
        } catch { /* ignore */ }
      }
      if (!furnaceBlock) {
        return fail(
          'NO_FURNACE',
          nearestFurnaceSeen
            ? `Furnace at (${nearestFurnaceSeen.x}, ${nearestFurnaceSeen.y}, ${nearestFurnaceSeen.z}) seen but pathfind didn't reach within 4 blocks.`
            : `No furnace within 32 blocks or in marks. Place one (mc place furnace X Y Z) and retry.`,
          {
            observed_state: {
              requested_input: input,
              requested_count: count,
              nearest_furnace: nearestFurnaceSeen,
            },
            next_action_hint: nearestFurnaceSeen
              ? `mc goto_near ${nearestFurnaceSeen.x} ${nearestFurnaceSeen.y} ${nearestFurnaceSeen.z} 2 then retry`
              : 'mc craft furnace then mc place furnace X Y Z near you',
            retry_safe: false,
          },
        );
      }

      // ── NO_INPUT ──
      const inputItem = b.inventory.items().find(i => i.name === input);
      if (!inputItem) {
        return fail(
          'NO_INPUT',
          `No ${input} in inventory. Get some first (mc collect / mc chest withdraw).`,
          {
            observed_state: {
              requested_input: input,
              requested_count: count,
              started_inventory: startedInventory,
            },
            retry_safe: false,
          },
        );
      }

      const furnaceCoord = { x: furnaceBlock.position.x, y: furnaceBlock.position.y, z: furnaceBlock.position.z, kind: furnaceBlock.name };
      let furnace;
      try {
        furnace = await b.openFurnace(furnaceBlock);
      } catch (err) {
        return fail(
          'INTERRUPTED',
          `Failed to open furnace at ${furnaceCoord.x},${furnaceCoord.y},${furnaceCoord.z}: ${/** @type {Error} */(err).message}`,
          {
            observed_state: { furnace: furnaceCoord, requested_input: input, mineflayer_error: /** @type {Error} */(err).message },
            retry_safe: true,
          },
        );
      }

      const existingOutput = furnace.outputItem();
      if (existingOutput) await furnace.takeOutput();
      const existingInput = furnace.inputItem();
      if (existingInput && existingInput.name !== input) {
        await furnace.takeInput();
      }

      const inputAmount = Math.min(count, inputItem.count);
      await furnace.putInput(inputItem.type, null, inputAmount);

      // ── NO_FUEL ──
      let fuelUsed = null;
      if (!furnace.fuelItem()) {
        const fuelNames = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick'];
        const fuelItem = fuel
          ? b.inventory.items().find(i => i.name === fuel)
          : b.inventory.items().find(i => fuelNames.includes(i.name));
        if (!fuelItem) {
          // Restore the input to the player so they can retry without losing it.
          try { await furnace.takeInput(); } catch { /* best-effort */ }
          try { furnace.close(); } catch {}
          return fail(
            'NO_FUEL',
            `No fuel in inventory (need coal/charcoal/planks/logs).${fuel ? ` Requested fuel "${fuel}" not found.` : ''}`,
            {
              observed_state: {
                furnace: furnaceCoord,
                requested_input: input,
                requested_count: count,
                requested_fuel: fuel || null,
                accepted_fuels: fuelNames,
                started_inventory: startedInventory,
              },
              next_action_hint: 'mc collect coal_ore + smelt; or mc craft charcoal from logs',
              retry_safe: false,
            },
          );
        }
        const fuelPer = fuelItem.name === 'coal_block' ? 80 : fuelItem.name.includes('coal') || fuelItem.name === 'charcoal' ? 8 : 1.5;
        const fuelNeeded = Math.ceil(inputAmount / fuelPer);
        const fuelToPut = Math.min(fuelNeeded, fuelItem.count);
        await furnace.putFuel(fuelItem.type, null, fuelToPut);
        fuelUsed = { name: fuelItem.name, amount: fuelToPut, smelts_per_unit: fuelPer };
      }

      // Wait for smelting. Vanilla smelt is exactly 10s per item; we add 2s
      // slack for server lag + fuel-ignition delay. Capped at 60s for the
      // test loop.
      await sleep(Math.min(inputAmount * 10000 + 2000, 60000));
      const output = furnace.outputItem();
      const outputName = output ? output.name : null;
      const outputCount = output ? output.count : 0;
      if (output) await furnace.takeOutput();
      try { furnace.close(); } catch {}

      const endedInventory = inventoryAt();
      // Inventory delta includes BOTH the auto-collected pre-existing output
      // (if it matches outputName) AND the freshly-smelted items. Subtract
      // the existing-output count so smelted_count reflects the actual smelt.
      const existingOutputCount =
        existingOutput && existingOutput.name === outputName ? existingOutput.count : 0;
      const smeltedCount = outputName
        ? Math.max(0, (endedInventory[outputName] || 0) - (startedInventory[outputName] || 0) - existingOutputCount)
        : 0;

      // ── NOT_SMELTABLE / partial / interrupted ──
      if (!outputName || smeltedCount < 1) {
        return fail(
          outputName ? 'INTERRUPTED' : 'NOT_SMELTABLE',
          outputName
            ? `Furnace output present (${outputName} x${outputCount}) but inventory delta is ${smeltedCount}.`
            : `${input} produced no output after ${Math.min(inputAmount * 10, 30)}s — likely not a smeltable item.`,
          {
            observed_state: {
              furnace: furnaceCoord,
              requested_input: input,
              requested_count: count,
              fuel_used: fuelUsed,
              started_inventory: startedInventory,
              ended_inventory: endedInventory,
              output_in_furnace: outputName ? { name: outputName, count: outputCount } : null,
            },
            retry_safe: !outputName,
          },
        );
      }

      return ok({
        data: {
          smelted_count: smeltedCount,
          requested_count: count,
          input_item: input,
          output_item: outputName,
          fuel_used: fuelUsed,
          existing_output_collected: existingOutput ? { name: existingOutput.name, count: existingOutput.count } : null,
          furnace: furnaceCoord,
          started_inventory: startedInventory,
          ended_inventory: endedInventory,
          _reason: reason,
        },
        result: `Smelted ${outputName} x${smeltedCount}${existingOutput ? ` (+ ${existingOutput.count}x ${existingOutput.name} already in furnace)` : ''}`,
      });
    },
  };
}
