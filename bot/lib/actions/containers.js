import { Vec3 } from 'vec3';

export function createContainerActions(deps) {
  const { ctx, config, ensureBot, goals, fmt, posObj, sleep, log, loadLocations, saveLocations, flagMarkStale, clearMarkStale, resolveMarkPlaceFromBody, resolveContainerCoords, normalizeDepositWithdrawItems, buildMarksListApi, isContainerBlock, findNearbyContainer, snapshotChestAtPosition, rememberSocialEvent, saveReminders, getMyName } = deps;
  return {

    // ── Container Interaction ─────────────────────────

    async list_container(body) {
      const b = ensureBot();
      const { ix, iy, iz } = resolveContainerCoords(body);
      const block = findNearbyContainer(b, ix, iy, iz);
      if (!block || !isContainerBlock(block)) {
        const markName = body.mark || body.at_mark || '';
        if (markName) flagMarkStale(markName, 'no container found at location');
        throw Object.assign(
          new Error(`No chest/container found near ${ix},${iy},${iz}${markName ? ` (mark '${markName}' flagged stale)` : ''}`),
          { type: 'invalid_args', hint: markName
            ? `Mark '${markName}' may be outdated. Verify with mc scene or mc find_blocks chest 8, then mc unmark ${markName} and re-mark at the correct position.`
            : `Verify chest exists at these coordinates with mc scene or mc find_blocks chest 8.` },
        );
      }
      const x = block.position.x;
      const y = block.position.y;
      const z = block.position.z;
      if (b.entity.position.distanceTo(block.position) > 4.5)
        await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
      const chest = await b.openContainer(block);
      if (body.mark) clearMarkStale(body.mark);
      const items = chest.containerItems();
      snapshotChestAtPosition(x, y, z, items);
      const summary = items.length > 0 ? items.map(i => `${i.name}x${i.count}`).join(', ') : '(empty)';
      chest.close();
      const total = items.reduce((s, i) => s + i.count, 0);
      return {
        result: `Container: ${summary}`,
        container: {
          position: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) },
          total,
          items: items.map((i) => ({ name: i.name, count: i.count })),
        },
      };
    },

    async deposit(body) {
      const b = ensureBot();
      const { ix, iy, iz } = resolveContainerCoords(body);

      const block = findNearbyContainer(b, ix, iy, iz);
      if (!block || !isContainerBlock(block)) {
        const markName = body.mark || body.at_mark || '';
        if (markName) flagMarkStale(markName, 'no container found at location');
        throw Object.assign(
          new Error(`No chest/container found near ${ix},${iy},${iz}${markName ? ` (mark '${markName}' flagged stale)` : ''}`),
          { type: 'invalid_args', hint: markName
            ? `Mark '${markName}' may be outdated. Verify with mc scene or mc find_blocks chest 8, then mc unmark ${markName} and re-mark at the correct position.`
            : `Verify chest exists at these coordinates with mc scene or mc find_blocks chest 8.` },
        );
      }
      const x = block.position.x;
      const y = block.position.y;
      const z = block.position.z;
      if (b.entity.position.distanceTo(block.position) > 4.5) await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
      const chest = await b.openContainer(block);
      if (body.mark) clearMarkStale(body.mark);

      const itemsNorm = normalizeDepositWithdrawItems(body);
      const lines = [];

      try {
        for (const req of itemsNorm) {
          const invItem = b.inventory.items().find((i) => i.name.includes(req.item));
          if (!invItem) {
            lines.push(`skip ${req.item} (missing in inventory)`);
            continue;
          }
          const qty =
            req.count && req.count > 0 ? Math.min(req.count, invItem.count) : invItem.count;
          await chest.deposit(invItem.type, null, qty);
          lines.push(`deposited ${qty}x ${invItem.name}`);
        }

        const after = chest.containerItems();
        snapshotChestAtPosition(x, y, z, after);
        const totalAfter = after.reduce((s, i) => s + i.count, 0);
        return {
          result: `Deposit: ${lines.join('; ') || '(nothing moved)'}`,
          data: {
            container: {
              position: { x, y, z },
              total: totalAfter,
              items: after.map((i) => ({ name: i.name, count: i.count })),
            },
            steps: lines,
          },
        };
      } finally {
        chest.close();
      }
    },

    async withdraw(body) {
      const b = ensureBot();
      const { ix, iy, iz } = resolveContainerCoords(body);

      const block = findNearbyContainer(b, ix, iy, iz);
      if (!block || !isContainerBlock(block)) {
        const markName = body.mark || body.at_mark || '';
        if (markName) flagMarkStale(markName, 'no container found at location');
        throw Object.assign(
          new Error(`No chest/container found near ${ix},${iy},${iz}${markName ? ` (mark '${markName}' flagged stale)` : ''}`),
          { type: 'invalid_args', hint: markName
            ? `Mark '${markName}' may be outdated. Verify with mc scene or mc find_blocks chest 8, then mc unmark ${markName} and re-mark at the correct position.`
            : `Verify chest exists at these coordinates with mc scene or mc find_blocks chest 8.` },
        );
      }
      const x = block.position.x;
      const y = block.position.y;
      const z = block.position.z;
      if (b.entity.position.distanceTo(block.position) > 4.5) await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
      const chest = await b.openContainer(block);
      if (body.mark) clearMarkStale(body.mark);

      const itemsNorm = normalizeDepositWithdrawItems(body);
      const lines = [];

      try {
        for (const req of itemsNorm) {
          const chestItem = chest.containerItems().find((i) => i.name.includes(req.item));
          if (!chestItem) {
            lines.push(`skip ${req.item} (missing in chest)`);
            continue;
          }
          const qty =
            req.count && req.count > 0 ? Math.min(req.count, chestItem.count) : chestItem.count;
          await chest.withdraw(chestItem.type, null, qty);
          lines.push(`withdrew ${qty}x ${chestItem.name}`);
        }

        const after = chest.containerItems();
        snapshotChestAtPosition(ix, iy, iz, after);
        const totalAfter = after.reduce((s, i) => s + i.count, 0);
        return {
          result: `Withdraw: ${lines.join('; ') || '(nothing moved)'}`,
          data: {
            container: {
              position: { x: ix, y: iy, z: iz },
              total: totalAfter,
              items: after.map((i) => ({ name: i.name, count: i.count })),
            },
            steps: lines,
          },
        };
      } finally {
        chest.close();
      }
    },

    // ── Coordinate Memory ────────────────────────────

    async mark(body) {
      ensureBot();
      const name = body.name != null ? String(body.name).trim() : '';
      if (!name) throw new Error('Missing mark name');
      const locsPre = loadLocations();
      const place = resolveMarkPlaceFromBody(body, locsPre) || posObj();
      const noteRaw = body.note != null ? String(body.note) : '';
      const now = new Date().toISOString();
      const locs = loadLocations();

      const prev = locs[name] || {};
      locs[name] = {
        x: Math.round(place.x),
        y: Math.round(place.y),
        z: Math.round(place.z),
        note: noteRaw,
        saved: prev.saved ?? now,
        updated: now,
        category:
          body.category !== undefined ? (body.category === null ? null : String(body.category)) : (prev.category ?? null),
        radius: body.radius !== undefined ? Number(body.radius) : (prev.radius ?? null),
        mode: body.mode !== undefined ? (body.mode === null ? null : String(body.mode)) : (prev.mode ?? null),
        stale: body.stale !== undefined ? Boolean(body.stale) : false,
        stale_reason: body.stale ? (prev.stale_reason ?? null) : null,
        last_visited: prev.last_visited ?? null,
        visit_count: typeof prev.visit_count === 'number' ? prev.visit_count : 0,
      };
      saveLocations(locs);
      const l = locs[name];
      return {
        result: `Saved '${name}' at ${l.x}, ${l.y}, ${l.z}`,
        data: { mark: l },
      };
    },

    async mark_update(body) {
      ensureBot();
      const name = body.name != null ? String(body.name) : '';
      if (!name) throw new Error('Missing mark name');
      const locs = loadLocations();
      if (!locs[name]) return { result: `No location '${name}'` };

      const m = locs[name];
      const now = new Date().toISOString();
      if (body.note !== undefined) m.note = String(body.note);
      if (body.category !== undefined) m.category = body.category === null ? null : String(body.category);
      if (body.radius !== undefined) m.radius = Number(body.radius);
      if (body.mode !== undefined) m.mode = body.mode === null ? null : String(body.mode);
      if (body.stale !== undefined) m.stale = Boolean(body.stale);
      if (body.at || body.at_mark) {
        const alt = resolveMarkPlaceFromBody(body, locs);
        if (!alt) throw new Error('Invalid at/at_mark for relocation');
        m.x = alt.x;
        m.y = alt.y;
        m.z = alt.z;
      }
      m.updated = now;
      saveLocations(locs);
      return { result: `Updated '${name}'`, data: { mark: m } };
    },

    async marks() {
      const b = ensureBot();
      const list = buildMarksListApi();
      if (!list.length) return { result: 'No saved locations', data: { marks: [] } };
      const lines = list.map((e) =>
        `${e.stale ? '⚠ STALE ' : ''}${e.name}: ${e.x},${e.y},${e.z} (${e.distance_m}m)${
          e.note ? ` — ${e.note}` : ''
        }${e.category ? ` [${e.category}]` : ''}${
          e.stale_reason ? ` (${e.stale_reason})` : ''
        }`,
      );
      return { result: lines.join('\n'), data: { marks: list } };
    },

    async go_mark({ name }) {
      const locs = loadLocations();
      if (!locs[name]) return { result: `No location '${name}'` };
      const l = locs[name];
      const b = ensureBot();
      await b.pathfinder.goto(new goals.GoalNear(l.x, l.y, l.z, 2));
      l.last_visited = new Date().toISOString();
      l.visit_count = (l.visit_count || 0) + 1;
      saveLocations(locs);
      return { result: `Arrived at '${name}' (${l.x},${l.y},${l.z})`, data: { mark: locs[name] } };
    },

    async unmark({ name }) {
      const locs = loadLocations();
      if (!locs[name]) return { result: `No location '${name}'` };
      delete locs[name];
      saveLocations(locs);
      return { result: `Deleted '${name}'` };
    },

    // ── Fire-and-Forget Smelting ─────────────────────

    async smelt_start({ input, fuel, count = 1 }) {
      const b = ensureBot();
      const furnaceBlock = b.findBlock({
        matching: block => block.name === 'furnace' || block.name === 'lit_furnace' || block.name === 'blast_furnace' || block.name === 'smoker',
        maxDistance: 4,
      });
      if (!furnaceBlock) throw new Error('No furnace within 4 blocks. Place one first.');

      const furnace = await b.openFurnace(furnaceBlock);
      const inputItem = b.inventory.items().find(i => i.name === input);
      if (!inputItem) { furnace.close(); throw new Error(`No ${input} in inventory.`); }

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
      ctx.activeFurnaces.push({
        x: fp.x, y: fp.y, z: fp.z,
        input, count: qty, startTime: Date.now(), estimatedDone: eta,
      });

      const minutes = Math.ceil(qty * 10 / 60);
      return { result: `Loaded ${qty} ${input} into furnace at ${fp.x},${fp.y},${fp.z}. ETA: ~${minutes} min. Go do something else!` };
    },

    async furnace_check({ x, y, z }) {
      const b = ensureBot();
      const furnaceBlock = b.blockAt(new Vec3(x, y, z));
      if (!furnaceBlock || (!furnaceBlock.name.includes('furnace') && furnaceBlock.name !== 'smoker' && furnaceBlock.name !== 'blast_furnace'))
        throw new Error(`No furnace at ${x},${y},${z}`);

      if (b.entity.position.distanceTo(furnaceBlock.position) > 4.5) {
        await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
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
        await b.pathfinder.goto(new goals.GoalNear(x, y, z, 3));
      }
      const furnace = await b.openFurnace(furnaceBlock);
      const output = furnace.outputItem();
      if (!output) { furnace.close(); return { result: 'Furnace has no output ready yet.' }; }
      await furnace.takeOutput();

      const remaining = furnace.inputItem();
      furnace.close();

      ctx.activeFurnaces = ctx.activeFurnaces.filter(f => !(f.x === x && f.y === y && f.z === z));

      return { result: `Collected ${output.name} x${output.count} from furnace.${remaining ? ` (${remaining.count} ${remaining.name} still being smelted)` : ''}` };
    },

    // ── Team System ──────────────────────────────────

    async team_chat({ message }) {
      const b = ensureBot();
      if (!ctx.teamConfig.team) throw new Error('Not assigned to a team. Use /action/set_team first.');

      for (const mate of ctx.teamConfig.teammates) {
        b.chat(`/msg ${mate} [${ctx.teamConfig.team.toUpperCase()}] ${message}`);
        await sleep(100);
      }
      ctx.teamConfig.teamChat.push({ time: Date.now(), from: config.mc.username, message });
      if (ctx.teamConfig.teamChat.length > 50) ctx.teamConfig.teamChat.shift();
      return { result: `[${ctx.teamConfig.team}] Sent to ${ctx.teamConfig.teammates.length} teammates: ${message}` };
    },

    async team_status() {
      const b = ensureBot();
      if (!ctx.teamConfig.team) return { result: 'Not on a team.' };

      const teammates = [];
      for (const name of ctx.teamConfig.teammates) {
        const entity = Object.values(b.entities).find(e => e.username === name);
        if (entity) {
          teammates.push({
            name,
            distance: fmt(entity.position.distanceTo(b.entity.position)),
            position: posObj(entity.position),
            health: entity.health ?? '?',
          });
        } else {
          teammates.push({ name, distance: '?', position: 'not visible', health: '?' });
        }
      }

      return {
        result: `Team ${ctx.teamConfig.team.toUpperCase()} | Role: ${ctx.teamConfig.role} | Rally: ${ctx.teamConfig.rallyPoint ? `${ctx.teamConfig.rallyPoint.x},${ctx.teamConfig.rallyPoint.y},${ctx.teamConfig.rallyPoint.z}` : 'none'}`,
        teammates,
      };
    },

    async rally({ x, y, z, message }) {
      const b = ensureBot();
      if (!ctx.teamConfig.team) throw new Error('Not on a team.');
      ctx.teamConfig.rallyPoint = { x: Math.round(x), y: Math.round(y), z: Math.round(z) };

      const msg = message || `Rally at ${ctx.teamConfig.rallyPoint.x},${ctx.teamConfig.rallyPoint.y},${ctx.teamConfig.rallyPoint.z}!`;
      for (const mate of ctx.teamConfig.teammates) {
        b.chat(`/msg ${mate} [RALLY] ${msg}`);
        await sleep(100);
      }
      return { result: `Rally point set and announced to team: ${msg}` };
    },

    async report({ message }) {
      const b = ensureBot();
      if (!ctx.teamConfig.team) throw new Error('Not on a team.');
      const pos = posObj();
      const fullMsg = `[INTEL] ${message} (at ${pos.x},${pos.y},${pos.z})`;
      for (const mate of ctx.teamConfig.teammates) {
        b.chat(`/msg ${mate} ${fullMsg}`);
        await sleep(100);
      }
      return { result: `Report sent to team: ${fullMsg}` };
    },

    async set_team({ team, role, teammates }) {
      ctx.teamConfig.team = team;
      ctx.teamConfig.role = role || 'warrior';
      ctx.teamConfig.teammates = teammates || [];
      return { result: `Assigned to team ${team} as ${role}. Teammates: ${teammates?.join(', ') || 'none'}` };
    },

    // ── Fair Play Toggle ─────────────────────────────

    async set_fair_play({ enabled }) {
      ctx.fairPlayMode = !!enabled;
      return { result: `Fair play mode: ${ctx.fairPlayMode ? 'ON (LOS, sound, reaction delay)' : 'OFF (god-mode perception)'}` };
    },

    // ── Reminders ────────────────────────────────────

    async remind({ note, interval_minutes, mark }) {
      const n = (note || '').trim();
      if (!n) throw new Error('remind needs a "note" string');
      let mins = parseFloat(interval_minutes);
      if (!Number.isFinite(mins) || mins < 1) mins = 20;
      const id = ctx.remindersNextId++;
      const entry = { id, note: n, interval_ms: mins * 60000, created: Date.now(), last_fired: 0 };
      if (mark) entry.mark = String(mark).trim();
      ctx.reminders.push(entry);
      saveReminders();
      return { result: `Reminder #${id} set: "${n}" every ${mins} min${entry.mark ? ` (mark: ${entry.mark})` : ''}`, id };
    },

    async list_reminders() {
      if (!ctx.reminders.length) return { result: 'No reminders set.', reminders: [] };
      const lines = ctx.reminders.map(r => {
        const minAgo = Math.round((Date.now() - (r.last_fired || r.created)) / 60000);
        return `#${r.id}: "${r.note}" every ${Math.round(r.interval_ms / 60000)} min (${minAgo} min since last)${r.mark ? ` [mark: ${r.mark}]` : ''}`;
      });
      return { result: lines.join('\n'), reminders: ctx.reminders };
    },

    async unremind({ id }) {
      const idx = ctx.reminders.findIndex(r => r.id === Number(id));
      if (idx === -1) throw new Error(`No reminder with id ${id}`);
      const removed = ctx.reminders.splice(idx, 1)[0];
      saveReminders();
      return { result: `Removed reminder #${removed.id}: "${removed.note}"` };
    },
  };
}
