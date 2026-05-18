import pathfinderPkg from 'mineflayer-pathfinder';
import { executeServerCommand, paperMcpConfig } from '../runtime/paper-mcp.js';
import { ok } from '../shared/action-contract.js';

const { goals } = pathfinderPkg;

/**
 * createLifecycleActions — extracted from former lib/actions/world.js (Phase 4 split).
 */
export function createLifecycleActions(services) {
  const { state: ctx, config, ensureBot, utils, social, resolver, fairPlay, getActions } = services;
  const { fmt, posObj, sleep, log } = utils;
  const { resolveInventoryItem } = resolver;
  const { rememberSocialEvent, getMyName } = social;
  const { hasLineOfSight, eyePosition } = fairPlay;

  return {
  async chat({ message }) {
    const b = ensureBot();
    // F59: chat rate limiter. G26 showed bots emitting 4-6 chat lines in a
    // single burst (within 200ms of each other), faster than partners
    // could read or respond. We auto-sleep to enforce a minimum interval
    // between sent chats. This is transparent — the brain still calls
    // `mc chat "..."` and gets ok=true; it just takes a bit longer when
    // the bot is chatting rapidly. Override with MC_CHAT_MIN_INTERVAL_MS
    // env var if needed.
    const MIN_INTERVAL_MS = config.behaviors.chatMinIntervalMs;
    if (ctx) {
      const now = Date.now();
      const elapsed = now - (ctx.social.lastChatTs || 0);
      if (elapsed < MIN_INTERVAL_MS) {
        const wait = MIN_INTERVAL_MS - elapsed;
        await new Promise((r) => setTimeout(r, wait));
      }
      ctx.social.lastChatTs = Date.now();
    }
    b.chat(message);
    // Mineflayer's 'chat' event early-returns on the bot's own username, so
    // self-sent messages never reach ctx.social.chatLog via the normal handler.
    // That's invisible in 2-bot tests (the other bot sees you) but breaks
    // solo-bot tests where the orchestrator polls THIS bot's /chat endpoint
    // for keyword acks. Echo it back here so /chat reflects what we said.
    if (ctx) {
      ctx.social.chatLog.push({
        time: Date.now(),
        from: getMyName(),
        message,
        private: false,
        channel: 'public',
        self: true,
      });
      if (ctx.social.chatLog.length > ctx.social.MAX_LOG) ctx.social.chatLog.shift();
    }
    rememberSocialEvent({ actor: getMyName(), kind: 'sent', channel: 'public', message });
    return { result: `Sent: ${message}` };
  },

  async wait({ seconds = 5, until_mention, until_direct, interrupt }) {
    const b = ensureBot();
    const cap = Math.min(Number(seconds) || 5, 60) * 1000;
    // F55.5: opt-out via `interrupt=false` (or both flags false). Default
    // is to interrupt on @-mention or direct/whisper — see G21 v6 finding
    // that bots couldn't coordinate because chat arrived during waits.
    const optOut = interrupt === false || interrupt === 'false';
    const wantMention = !optOut && (until_mention === undefined || until_mention === true || until_mention === 'true');
    const wantDirect = !optOut && (until_direct === undefined || until_direct === true || until_direct === 'true');
    const start = Date.now();
    const myName = String(b.username || '').toLowerCase();
    if (!wantMention && !wantDirect) {
      await sleep(cap);
      return { result: `Waited ${Math.round(cap / 100) / 10}s`, data: { interrupted: false, elapsed_s: Math.round(cap / 100) / 10 } };
    }
    // Time-based cursor: chatLog is capped at MAX_LOG=100 with shift()
    // on overflow. An index-based cursor (`chatLog.length` at start)
    // desyncs on the first trim that lands mid-wait — push+shift keeps
    // length steady so `length <= startLen` skips the new entry. Walk
    // the log newest→oldest each tick and stop when entries predate
    // `start`; entries are time-ordered so this is O(new since start).
    while (Date.now() - start < cap) {
      await sleep(250);
      const log = ctx.social.chatLog || [];
      for (let i = log.length - 1; i >= 0; i--) {
        const m = log[i];
        if (!m) continue;
        if (typeof m.time === 'number' && m.time < start) break;
        if (m.from === b.username || m.from === 'Server') continue;
        const msg = String(m.message || '').toLowerCase();
        const isMention = wantMention && myName && (msg.includes(`@${myName}`) || msg.includes(`${myName}:`) || msg.includes(`${myName},`));
        const isDirect = wantDirect && (m.private === true || m.whisper === true);
        if (isMention || isDirect) {
          const elapsed_s = Math.round((Date.now() - start) / 100) / 10;
          return {
            result: `Wait interrupted by chat after ${elapsed_s}s — ${m.from}: ${m.message}`,
            data: {
              interrupted: true,
              by: m.from,
              message: m.message,
              elapsed_s,
              reason: isMention ? 'mention' : 'direct',
            },
          };
        }
      }
    }
    const elapsed_s = Math.round((Date.now() - start) / 100) / 10;
    return { result: `Waited ${elapsed_s}s`, data: { interrupted: false, elapsed_s } };
  },

  async surface() {
    const b = ensureBot();
    if (!b.entity.isInWater) {
      return { result: `Not in water — already at surface.`, data: { in_water: false } };
    }
    const start = Date.now();
    const startY = b.entity.position.y;
    let ticks = 0;
    try {
      b.setControlState('jump', true);
      // Tick loop: every 200ms check if head is out of water. Bound to 30s.
      while (Date.now() - start < 30000) {
        await sleep(200);
        ticks++;
        // Mineflayer caches isInWater on the entity object, updated each
        // physics tick. Check the EYE level too — head out of water = surfaced.
        const eyePos = b.entity.position.offset(0, 1.62, 0);
        const eyeBlock = b.blockAt(eyePos.floored());
        const surfaced = !b.entity.isInWater || (eyeBlock && eyeBlock.name !== 'water');
        if (surfaced) break;
      }
    } finally {
      b.setControlState('jump', false);
    }
    const endY = b.entity.position.y;
    return {
      result: `Surfaced from y=${startY.toFixed(1)} to y=${endY.toFixed(1)} in ${ticks * 0.2}s.`,
      data: { start_y: startY, end_y: endY, ticks, in_water: !!b.entity.isInWater },
    };
  },

  /**
   * Fill an empty bucket from a water/lava source block at (x,y,z).
   * ── Phase-2 action contract (Sprint 7) ──
   *   MISSING_BUCKET   no empty bucket in inventory
   *   NOT_A_LIQUID     target block isn't water/lava
   *   NOT_A_SOURCE     target is flowing (level > 0), not a source
   *   OUT_OF_RANGE     bot couldn't reach within 4.5 blocks
   *   UNCHANGED        server rejected — inventory delta is zero
   */
  async sleep_bed() {
    const b = ensureBot();
    let bed = b.findBlock({ matching: block => block.name?.includes('bed'), maxDistance: 6 });
    if (!bed) {
      bed = b.findBlock({ matching: block => block.name?.includes('bed'), maxDistance: 32 });
      if (!bed) throw new Error('No bed within 32 blocks. Craft one (3 wool + 3 planks) or move closer.');
      try { await b.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)); }
      catch { throw new Error(`Found bed at ${bed.position.x},${bed.position.y},${bed.position.z} but cannot reach it.`); }
    }
    await b.sleep(bed);
    return { result: `Sleeping in ${bed.name} at ${bed.position.x},${bed.position.y},${bed.position.z}. Spawn point set here.` };
  },

  async set_home({ x, y, z } = {}) {
    const b = ensureBot();
    const username = getMyName();
    const px = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(b.entity.position.x);
    const py = Number.isFinite(Number(y)) ? Math.floor(Number(y)) : Math.floor(b.entity.position.y);
    const pz = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(b.entity.position.z);

    const pmcpCfg = paperMcpConfig();
    if (pmcpCfg) {
      const res = await executeServerCommand(pmcpCfg, `spawnpoint ${username} ${px} ${py} ${pz}`);
      if (res.ok) return { result: `Spawn point set to ${px},${py},${pz} via server command.`, x: px, y: py, z: pz };
      log(`PaperMCP set_home failed: ${res.error}, trying bed fallback`);
    }

    // Fallback: find and sleep in a bed
    const bed = b.findBlock({ matching: block => block.name?.includes('bed'), maxDistance: 32 });
    if (bed) {
      try {
        await b.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
        await b.sleep(bed);
        return { result: `Spawn point set by sleeping in bed at ${bed.position.x},${bed.position.y},${bed.position.z}.` };
      } catch (err) {
        throw new Error(`Cannot set home: PaperMCP unavailable and bed at ${bed.position.x},${bed.position.y},${bed.position.z} unreachable: ${/** @type {Error} */ (err).message}`);
      }
    }
    throw new Error('Cannot set home: PaperMCP unavailable and no bed within 32 blocks. Craft a bed (3 wool + 3 planks) and place it, then run mc sleep.');
  },

  // ── Chat / Whisper ──────────────────────────────
  // F55.6: route addressed messages through public chat with @<player>
  // prefix. The /msg private system on Paper doesn't reliably surface to
  // mineflayer chat listeners — partner bots missed Flint's "roof done"
  // whisper in G21 v6. Public @-mention is captured by the standard chat
  // log AND triggers F55.5's wait-interrupt. Same behavior for chat_to
  // and whisper — both are "address one player".
  async chat_to({ player, message }) {
    const b = ensureBot();
    const text = `@${player} ${message}`;
    // F59 rate limit (shared budget with mc chat — these all emit to the
    // same public chat channel).
    const MIN_INTERVAL_MS = config.behaviors.chatMinIntervalMs;
    if (ctx) {
      const elapsed = Date.now() - (ctx.social.lastChatTs || 0);
      if (elapsed < MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
      ctx.social.lastChatTs = Date.now();
    }
    b.chat(text);
    if (ctx) {
      ctx.social.chatLog.push({
        time: Date.now(), from: getMyName(), message: text,
        private: false, channel: 'public', self: true,
      });
      if (ctx.social.chatLog.length > ctx.social.MAX_LOG) ctx.social.chatLog.shift();
    }
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'public_mention', message: text });
    return { result: `[@${player}]: ${message}` };
  },

  async whisper({ player, message }) {
    const b = ensureBot();
    const text = `@${player} ${message}`;
    const MIN_INTERVAL_MS = config.behaviors.chatMinIntervalMs;
    if (ctx) {
      const elapsed = Date.now() - (ctx.social.lastChatTs || 0);
      if (elapsed < MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
      ctx.social.lastChatTs = Date.now();
    }
    b.chat(text);
    if (ctx) {
      ctx.social.chatLog.push({
        time: Date.now(), from: getMyName(), message: text,
        private: false, channel: 'public', self: true,
      });
      if (ctx.social.chatLog.length > ctx.social.MAX_LOG) ctx.social.chatLog.shift();
    }
    rememberSocialEvent({ actor: getMyName(), target: player, kind: 'sent', channel: 'public_mention', message: text });
    return { result: `[@${player}]: ${message}` };
  },

  // ── Death / Respawn ─────────────────────────────────
  async respawn({ confirm, force } = {}) {
    if (String(confirm) !== 'yes') {
      return { error: 'Respawn uses /kill — you die and DROP ALL ITEMS. Pass confirm=yes to proceed. If you just want to go home, use mc go_mark home or mc goto.' };
    }
    const b = ensureBot();
    const pos = posObj();
    const username = getMyName();
    const items = b.inventory.items().map((i) => `${i.name}x${i.count}`);
    // Safety guard: refuse to /kill a live, healthy bot. Voluntary respawn
    // at HP > 6 is almost always misuse (agent interpreting "go back to
    // base" as a respawn cue). Force=yes lets a deliberate user opt out.
    const hp = b.health ?? 20;
    const isAlive = b.isAlive !== false;
    if (isAlive && hp > 6 && String(force) !== 'yes') {
      return {
        ok: false,
        error: {
          code: 'RESPAWN_REFUSED_HEALTHY',
          message: `Refusing /kill — bot is alive with HP=${hp.toFixed(1)} (> 6). Voluntary respawn while healthy almost always destroys inventory needlessly. Use mc go_mark home / mc goto to travel, or mc escape if stuck. If you really need to die, pass force=yes.`,
          observed_state: {
            hp,
            inventory_size: items.length,
            position: pos,
            alternatives: ['mc go_mark home', 'mc goto X Y Z', 'mc escape'],
          },
          retry_safe: false,
        },
      };
    }
    log(`Voluntary respawn at ${pos.x},${pos.y},${pos.z}. Dropping: ${items.join(', ') || 'nothing'}`);

    // Primary: use PaperMCP to run /kill server-side (bypasses chat protocol issues)
    const pmcpCfg = paperMcpConfig();
    if (pmcpCfg) {
      log('Respawn: using PaperMCP server-side /kill');
      const res = await executeServerCommand(pmcpCfg, `kill ${username}`);
      if (!res.ok) log(`PaperMCP kill failed: ${res.error}, falling back to chat`);
    }

    // Fallback: send /kill through bot chat (may not work on all server configs)
    if (!pmcpCfg) {
      if (b._client._signedChat) {
        b._client._signedChat('/kill');
      } else {
        b.chat('/kill');
      }
    }

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      b.once('death', () => { clearTimeout(timer); resolve(); });
    });
    // mineflayer health.js auto-respawns; nudge once in case /kill + respawn screen lagged.
    try {
      if (typeof b.respawn === 'function' && b.isAlive === false) b.respawn();
    } catch { /* ignore */ }
    await sleep(2000);
    ctx.world.positionHistory = [];

    const newPos = posObj();
    return {
      result: `Respawned via /kill. Old pos: ${pos.x},${pos.y},${pos.z}. New pos: ${newPos.x},${newPos.y},${newPos.z}. Dropped items: ${items.join(', ') || 'none'}.`,
      old_position: pos,
      new_position: newPos,
      dropped_items: items,
    };
  },

  async deathpoint() {
    if (!ctx.death.lastDeath) return { result: 'No deaths recorded.' };
    const pos = ctx.death.lastDeath.position;
    const age = Math.round((Date.now() - ctx.death.lastDeath.time) / 1000);
    const b = ensureBot();
    await b.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
    return { result: `At death #${ctx.death.lastDeath.deathNumber} (${age}s ago). Lost: ${ctx.death.lastDeath.inventory.map(i=>`${i.name}x${i.count}`).join(', ')}` };
  },

  /**
   * Enclosure test: can the bot pathfind OUT of its current position?
   * Pathfinding is symmetric — if the bot can walk out, mobs can walk in.
   * Uses the same non-destructive movements pathfinder normally uses
   * (closed doors/gates count as walls; fences are 1.5 tall so pathfinder
   * treats them as impassable).
   *
   * Tests several distant cardinal+vertical targets. If ANY succeeds, the
   * bot is NOT fully enclosed — returns the first leak's exit cell
   * (the first block the path would walk into, i.e. the gap).
   *
   * Use after building a shelter to verify it's actually sealed before
   * settling in for the night.
   */
  /**
   * F48: Reachability pre-flight. Given a target cell, report whether
   * the bot could physically STAND there (foot air, head air, ground
   * solid below). If not, find the closest cell that IS standable and
   * report its coords + distance + the reason the original cell failed.
   *
   * This is the cure for the G21 v2 Mason stuck pattern: `goto_near`
   * was failing on a cell whose head was a wall block, and the bot
   * had no signal about which nearby cell DID work. After F48 the
   * brain can just call `mc reachable X Y Z` first and pick the
   * suggested `best_stand` for the actual goto.
   *
   * Note: this is geometry-only — does NOT verify a PATH exists from
   * the bot's current position. A cell can be standable but cut off
   * by walls. For path verification, follow up with the actual `goto`.
   */
  };
}
