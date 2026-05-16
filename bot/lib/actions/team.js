
/**
 * createTeamActions — extracted from former lib/actions/containers.js (Phase 5 split).
 */
export function createTeamActions(deps) {
  const { ctx, config, ensureBot, goals, fmt, posObj, sleep, log, loadLocations, saveLocations, flagMarkStale, clearMarkStale, resolveMarkPlaceFromBody, resolveContainerCoords, normalizeDepositWithdrawItems, buildMarksListApi, isContainerBlock, findNearbyContainer, snapshotChestAtPosition, rememberSocialEvent, saveReminders, getMyName } = deps;
  return {
    async team_chat({ message }) {
      const b = ensureBot();
      if (!ctx.team.teamConfig.team) throw new Error('Not assigned to a team. Use /action/set_team first.');

      for (const mate of ctx.team.teamConfig.teammates) {
        b.chat(`/msg ${mate} [${ctx.team.teamConfig.team.toUpperCase()}] ${message}`);
        await sleep(100);
      }
      ctx.team.teamConfig.teamChat.push({ time: Date.now(), from: config.mc.username, message });
      if (ctx.team.teamConfig.teamChat.length > 50) ctx.team.teamConfig.teamChat.shift();
      return { result: `[${ctx.team.teamConfig.team}] Sent to ${ctx.team.teamConfig.teammates.length} teammates: ${message}` };
    },

    async team_status() {
      const b = ensureBot();
      if (!ctx.team.teamConfig.team) return { result: 'Not on a team.' };

      const teammates = [];
      for (const name of ctx.team.teamConfig.teammates) {
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
        result: `Team ${ctx.team.teamConfig.team.toUpperCase()} | Role: ${ctx.team.teamConfig.role} | Rally: ${ctx.team.teamConfig.rallyPoint ? `${ctx.team.teamConfig.rallyPoint.x},${ctx.team.teamConfig.rallyPoint.y},${ctx.team.teamConfig.rallyPoint.z}` : 'none'}`,
        teammates,
      };
    },

    async rally({ x, y, z, message }) {
      const b = ensureBot();
      if (!ctx.team.teamConfig.team) throw new Error('Not on a team.');
      ctx.team.teamConfig.rallyPoint = { x: Math.round(x), y: Math.round(y), z: Math.round(z) };

      const msg = message || `Rally at ${ctx.team.teamConfig.rallyPoint.x},${ctx.team.teamConfig.rallyPoint.y},${ctx.team.teamConfig.rallyPoint.z}!`;
      for (const mate of ctx.team.teamConfig.teammates) {
        b.chat(`/msg ${mate} [RALLY] ${msg}`);
        await sleep(100);
      }
      return { result: `Rally point set and announced to team: ${msg}` };
    },

    async report({ message }) {
      const b = ensureBot();
      if (!ctx.team.teamConfig.team) throw new Error('Not on a team.');
      const pos = posObj();
      const fullMsg = `[INTEL] ${message} (at ${pos.x},${pos.y},${pos.z})`;
      for (const mate of ctx.team.teamConfig.teammates) {
        b.chat(`/msg ${mate} ${fullMsg}`);
        await sleep(100);
      }
      return { result: `Report sent to team: ${fullMsg}` };
    },

    async set_team({ team, role, teammates }) {
      ctx.team.teamConfig.team = team;
      ctx.team.teamConfig.role = role || 'warrior';
      ctx.team.teamConfig.teammates = teammates || [];
      return { result: `Assigned to team ${team} as ${role}. Teammates: ${teammates?.join(', ') || 'none'}` };
    },

    // ── Fair Play Toggle ─────────────────────────────

    async set_fair_play({ enabled }) {
      ctx.reactive.fairPlayMode = !!enabled;
      return { result: `Fair play mode: ${ctx.reactive.fairPlayMode ? 'ON (LOS, sound, reaction delay)' : 'OFF (god-mode perception)'}` };
    },

    // ── Reminders ────────────────────────────────────

  };
}
