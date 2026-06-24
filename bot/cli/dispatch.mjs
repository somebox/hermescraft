import { readFileSync } from 'node:fs';
import { normalizeMark, positionalToParams } from './args.mjs';
import { resolveCommand, buildAliasMap } from './registry.mjs';

const CLI_ALIAS_MAP = buildAliasMap();
const REGION_NAV_REF = /^:([a-z0-9]{2,12}):(\/[a-z0-9]{2,12})?$/i;
const empty = '{}';

/** @typedef {import('./registry.mjs').CmdDef} CmdDef */

/**
 * @param {string} name
 * @param {string[]} positional
 * @returns {Record<string, unknown>}
 */
function parseMarkFlags(positional) {
  const out = /** @type {Record<string, unknown>} */ ({});
  const q = positional.slice();
  const rest = [];
  for (let i = 0; i < q.length; ) {
    const f = String(q[i]);
    if (!f.startsWith('--')) {
      rest.push(String(q[i]));
      i += 1;
      continue;
    }
    if (f === '--category' || f === '--cat') {
      i += 2;
      out.category = String(q[i - 1] ?? '');
      continue;
    } else if (f === '--radius') {
      i += 2;
      out.radius = Number(q[i - 1]);
      continue;
    } else if (f === '--mode') {
      i += 2;
      out.mode = String(q[i - 1] ?? '');
      continue;
    } else if (f === '--stale') {
      i += 2;
      out.stale = String(q[i - 1] ?? 'true') === 'true';
      continue;
    } else if (f === '--at') {
      const a = String(q[i + 1] ?? '');
      if (!a) throw new Error('missing_value:--at');
      if (a.startsWith('@')) {
        out.at_mark = a.slice(1);
        i += 2;
        continue;
      }
      const y = q[i + 2];
      const z = q[i + 3];
      if (y == null || z == null) throw new Error('missing_coords:--at requires X Y Z');
      out.at = { x: Number(a), y: Number(y), z: Number(z) };
      i += 4;
      continue;
    } else throw new Error(`unknown_flag:${f}`);
  }
  out._rest = rest;
  return out;
}

/**
 * @param {CmdDef} def
 * @param {string} canonicalName
 * @param {string[]} positional
 */
export function buildHttpRequest(def, canonicalName, positional) {
  if (
    ['goto', 'goto_near', 'move'].includes(canonicalName) &&
    positional.length >= 1 &&
    REGION_NAV_REF.test(String(positional[0]))
  ) {
    const siteCmd = resolveCommand('go_site', CLI_ALIAS_MAP);
    if (!siteCmd) throw new Error('missing:go_site');
    return buildHttpRequest(siteCmd.def, siteCmd.canonicalName, positional);
  }

  if (canonicalName === 'bg') {
    const action = positional[0];
    if (!action) throw new Error('missing_action');
    const raw = positional[1] ?? '{}';
    /** @type {Record<string, unknown>} */
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      throw new Error('invalid_json_body');
    }
    normalizeMark(o);
    return { method: 'POST', path: `/task/${encodeURIComponent(action)}`, body: JSON.stringify(o), params: { action, ...o } };
  }

  if (def.customParse) {
    const p = customParse(canonicalName, positional);
    normalizeMark(p);
    if (p._redirect) {
      const redir = resolveCommand(p._redirect, CLI_ALIAS_MAP);
      if (!redir) throw new Error(`missing:${p._redirect}`);
      delete p._redirect;
      return finalize(redir.def, redir.canonicalName, p);
    }
    return finalize(def, canonicalName, p);
  }

  const params = positionalToParams(canonicalName, def.argSchema || [], positional);
  normalizeMark(params);
  return finalize(def, canonicalName, params);
}

/**
 * @param {CmdDef} def
 * @param {string} canonicalName
 * @param {Record<string, unknown>} params
 */
function finalize(def, canonicalName, params) {
  normalizeMark(params);
  if (canonicalName === 'advise') {
    return { method: 'GET', path: '/__advise__', body: null, params };
  }
  const method = /** @type {'GET'|'POST'|'DELETE'} */ (params._httpMethod || def.method || 'GET');
  if (params._httpMethod) delete params._httpMethod;
  const path = def.pathFn ? def.pathFn(params) : def.path;
  if (!path) throw new Error(`no_path:${canonicalName}`);

  let body = null;
  if (method === 'POST') {
    if (def.bodyFn) body = def.bodyFn(params);
    else if (def.customParse) {
      const clean = { ...params };
      delete clean._httpMethod;
      delete clean._rest;
      body = JSON.stringify(clean);
    } else body = empty;
  }

  return { method, path, body, params };
}

/** @param {string} t */
function isNumericCliToken(t) {
  if (t == null || t === '') return false;
  const s = String(t).trim();
  return /^-?\d+(\.\d+)?$/.test(s);
}

/**
 * mc deposit|withdraw ITEM [COUNT] [MARK|X Y Z] — mark may sit between count and coords.
 * @param {string[]} positional
 */
function parseDepositWithdrawPositional(positional) {
  if (positional[0]?.startsWith('{')) return JSON.parse(positional[0]);
  const item = positional[0];
  if (!item) throw new Error('missing_item');

  if (positional[1]?.startsWith('@')) {
    return {
      item,
      mark: positional[1].slice(1),
      count: positional[2] != null ? Number(positional[2]) : 0,
    };
  }

  if (positional.length === 1) {
    return { item, count: 0 };
  }

  const rest = positional.slice(1);
  if (rest.length === 1 && isNumericCliToken(rest[0])) {
    return { item, count: Number(rest[0]) };
  }

  if (!isNumericCliToken(rest[0])) {
    throw new Error('missing_count: use mc deposit ITEM COUNT …');
  }
  const count = Number(rest[0]);
  const tail = rest.slice(1);
  if (tail.length === 0) {
    return { item, count };
  }
  if (tail.length === 1 && !isNumericCliToken(tail[0])) {
    return {
      item,
      count,
      mark: String(tail[0]).replace(/^@/, ''),
    };
  }
  if (tail.length === 3 && tail.every(isNumericCliToken)) {
    return {
      item,
      count,
      x: Number(tail[0]),
      y: Number(tail[1]),
      z: Number(tail[2]),
    };
  }
  if (
    tail.length === 4
    && !isNumericCliToken(tail[0])
    && isNumericCliToken(tail[1])
    && isNumericCliToken(tail[2])
    && isNumericCliToken(tail[3])
  ) {
    return {
      item,
      count,
      mark: String(tail[0]).replace(/^@/, ''),
      x: Number(tail[1]),
      y: Number(tail[2]),
      z: Number(tail[3]),
    };
  }
  throw new Error('deposit_withdraw_args: expected COUNT, optional MARK, optional X Y Z');
}

/**
 * @param {CmdDef} def
 * @param {string} canonicalName
 * @param {string[]} positional
 */
function customParse(canonicalName, positional) {
  switch (canonicalName) {
    case 'advise': {
      // stripGlobalFlags already peels --reason / -r / reason= into
      // globals.reason BEFORE we get here, so the positional list will
      // typically be empty for the agent-form `mc advise --reason="..."`.
      // We accept whatever remains as a bare reason for back-compat with
      // older callers (`mc advise "find wood"`); index.mjs's advise
      // handler is the authoritative reason-required check (using
      // globals.reason as the canonical source) and produces a clearer
      // error if reason is truly missing.
      const q = positional.slice();
      let reason = '';
      while (q.length) {
        const t = String(q[0]);
        if (t === '--reason' || t === '-r') {
          q.shift();
          reason = String(q.shift() ?? '');
        } else if (t.startsWith('--reason=')) {
          reason = t.slice('--reason='.length);
          q.shift();
        } else if (!t.startsWith('--') && !reason) {
          reason = t;
          q.shift();
        } else if (t.startsWith('--')) {
          throw new Error(`unknown_flag:${t}`);
        } else {
          q.shift();
        }
      }
      if (q.length) throw new Error(`extra_arguments:advise`);
      return { reason: reason.trim() };
    }
    case 'status':
    case 'observe': {
      // mc status [--full] | mc observe [--full] — no positionals expected.
      const q = positional.slice();
      const out = {};
      while (q.length) {
        const t = String(q[0]);
        if (t === '--full') { q.shift(); out.full = true; }
        else throw new Error(`unknown_flag:${t}`);
      }
      return out;
    }
    case 'feed_mob': {
      const q = positional.slice();
      let item = '';
      while (q.length && String(q[0]).startsWith('--')) {
        const f = String(q.shift());
        if (f === '--item' || f === '-i') item = String(q.shift() ?? '');
        else throw new Error(`unknown_flag:${f}`);
      }
      const target = q.shift();
      if (!target) throw new Error('missing:target');
      if (q.length === 1 && !item) item = String(q[0]);
      else if (q.length > 1) throw new Error(`extra_arguments:feed_mob`);
      return { target, ...(item ? { item } : {}) };
    }
    case 'remind': {
      const q = positional.slice();
      let mark = '';
      const cleaned = [];
      for (let i = 0; i < q.length; i++) {
        if (String(q[i]) === '--mark' || String(q[i]) === '-m') { mark = String(q[++i] || ''); }
        else cleaned.push(q[i]);
      }
      const note = cleaned[0];
      if (!note) throw new Error('missing:note');
      const interval_minutes = cleaned[1] || '20';
      return { note, interval_minutes, ...(mark ? { mark } : {}) };
    }
    case 'unremind': {
      const id = positional[0];
      if (!id) throw new Error('missing:id');
      return { id };
    }
    case 'safe_dig': {
      // mc safe_dig X Y Z [--force]
      const q = positional.slice();
      const out = {};
      const positionals = [];
      while (q.length) {
        const t = String(q[0]);
        if (t === '--force') { q.shift(); out.force = true; }
        else { positionals.push(q.shift()); }
      }
      if (positionals.length < 3) throw new Error('missing:coords');
      out.x = Number(positionals[0]);
      out.y = Number(positionals[1]);
      out.z = Number(positionals[2]);
      return out;
    }
    case 'dig': {
      // mc dig X Y Z [--force]   (F54.1)
      const q = positional.slice();
      const out = {};
      const positionals = [];
      while (q.length) {
        const t = String(q[0]);
        if (t === '--force') { q.shift(); out.force = true; }
        else if (t.startsWith('@')) { out.mark = String(q.shift()).slice(1); }
        else { positionals.push(q.shift()); }
      }
      if (positionals.length < 3) throw new Error('missing:coords');
      out.x = Number(positionals[0]);
      out.y = Number(positionals[1]);
      out.z = Number(positionals[2]);
      return out;
    }
    case 'wait': {
      // mc wait [SECONDS] [--no-interrupt]   (F55.5)
      const q = positional.slice();
      const out = {};
      for (const t of q) {
        const s = String(t);
        if (s === '--no-interrupt' || s === '--no_interrupt') { out.interrupt = false; }
        else if (!isNaN(Number(s))) { out.seconds = Number(s); }
      }
      if (out.seconds == null) out.seconds = 5;
      return out;
    }
    case 'is_sheltered': {
      // mc is_sheltered [radius=N] [walls=X1,Y1,Z1,X2,Y2,Z2]   (F55.7)
      const q = positional.slice();
      const out = {};
      for (const t of q) {
        const s = String(t);
        if (s.startsWith('radius=')) {
          out.radius = Number(s.slice('radius='.length));
        } else if (s.startsWith('walls=')) {
          const parts = s.slice('walls='.length).split(',').map((x) => Number(String(x).trim()));
          if (parts.length === 6 && parts.every(Number.isFinite)) {
            out.walls = { x1: parts[0], y1: parts[1], z1: parts[2], x2: parts[3], y2: parts[4], z2: parts[5] };
          }
        } else if (!isNaN(Number(s)) && out.radius == null) {
          // Positional radius: mc is_sheltered 20
          out.radius = Number(s);
        }
      }
      return out;
    }
    case 'move': {
      // mc move X Y Z [--max-doors N] [--door GX GY GZ] [--force]
      const q = positional.slice();
      const out = {};
      const positionals = [];
      while (q.length) {
        const t = String(q[0]);
        if (t === '--max-doors' || t === '-md') { q.shift(); out.max_doors = Number(q.shift()); }
        else if (t === '--door') {
          q.shift();
          const dx = Number(q.shift()), dy = Number(q.shift()), dz = Number(q.shift());
          if (![dx, dy, dz].every(Number.isFinite)) throw new Error('invalid:--door requires 3 numeric coords');
          out.door = { x: dx, y: dy, z: dz };
        }         else if (t === '--force') { q.shift(); out.force = true; }
        else if (t === '--raw') { q.shift(); out.raw = true; }
        else if (t === '--near' || t === '-n') { q.shift(); out.near = Number(q.shift()); }
        else { positionals.push(q.shift()); }
      }
      if (positionals.length === 1) {
        const p0 = String(positionals[0]);
        if (p0.startsWith('@') || !/^-?\d/.test(p0)) {
          out.mark = p0.replace(/^@/, '');
          return out;
        }
      }
      if (positionals.length < 3) throw new Error('missing:coords');
      out.x = Number(positionals[0]);
      out.y = Number(positionals[1]);
      out.z = Number(positionals[2]);
      return out;
    }
    case 'through': {
      // mc through GX GY GZ [DX DY DZ]
      const p = positional.map(Number);
      if (p.length < 3 || p.slice(0, 3).some((v) => !Number.isFinite(v))) {
        throw new Error('missing:gate_coords');
      }
      const out = { gx: p[0], gy: p[1], gz: p[2] };
      if (p.length >= 6) {
        if (p.slice(3, 6).some((v) => !Number.isFinite(v))) throw new Error('invalid:dest_coords');
        out.dx = p[3]; out.dy = p[4]; out.dz = p[5];
      }
      return out;
    }
    case 'fence': {
      // mc fence BLOCK X1 Z1 X2 Z2 [--gate DIR] [--y Y]
      const q = positional.slice();
      let gate = '';
      let yOpt;
      const pos = [];
      for (let i = 0; i < q.length; i++) {
        const t = String(q[i]);
        if (t === '--gate' || t === '-g') gate = String(q[++i] || '');
        else if (t === '--y') yOpt = Number(q[++i]);
        else pos.push(q[i]);
      }
      const [block, x1, z1, x2, z2] = pos;
      if (!block) throw new Error('missing:block');
      if ([x1, z1, x2, z2].some((v) => v === undefined)) throw new Error('missing:coords');
      return {
        block,
        x1: Number(x1), z1: Number(z1), x2: Number(x2), z2: Number(z2),
        ...(gate ? { gate } : {}),
        ...(yOpt !== undefined ? { y: yOpt } : {}),
      };
    }
    case 'flee': {
      const q = positional.slice();
      let distance = 16;
      let to = '';
      while (q.length && String(q[0]).startsWith('--')) {
        const f = String(q.shift());
        if (f === '--to') to = String(q.shift() ?? '').replace(/^@/, '');
        else if (f === '--mark') to = String(q.shift() ?? '').replace(/^@/, '');
        else throw new Error(`unknown_flag:${f}`);
      }
      if (q[0] && !String(q[0]).startsWith('--')) distance = Number(q.shift());
      return { distance, ...(to ? { to } : {}) };
    }
    case 'shoot': {
      if (positional[0]?.startsWith('{')) return JSON.parse(positional[0]);
      const target = positional[0] && !positional[0].startsWith('{') ? positional[0] : '';
      const predTok = positional[1];
      const predict =
        predTok === undefined ? true : !(predTok === 'false' || predTok === '0' || predTok === 'no');
      return { target, predict };
    }
    case 'strafe':
    case 'combo':
    case 'bg_combo':
    case 'bg_strafe': {
      const isBg = canonicalName.startsWith('bg_');
      const base = isBg ? canonicalName.replace('bg_', '') : canonicalName;
      void base;
      const target = positional[0] || '';
      const dirOrStyle = positional[1] || (canonicalName.includes('combo') ? 'aggressive' : 'random');
      const dur = positional[2] ? Number(positional[2]) : canonicalName.includes('combo') ? undefined : 5;
      if (canonicalName.includes('combo')) return { target, style: dirOrStyle };
      return { target, direction: dirOrStyle, duration: dur ?? 5 };
    }
    case 'smelt_start': {
      const input = positional[0];
      const fuel = positional[1];
      const count = positional[2] ? Number(positional[2]) : 1;
      return { input, fuel, count };
    }
    case 'rally': {
      const x = Number(positional[0]);
      const y = Number(positional[1]);
      const z = Number(positional[2]);
      const message = positional.slice(3).join(' ') || '';
      return { x, y, z, message };
    }
    case 'set_team': {
      const team = positional[0];
      const role = positional[1] || 'warrior';
      const mates = positional[2] || '';
      return { team, role, teammates: mates ? mates.split(',') : [] };
    }
    case 'goal_add': {
      const spec = positional[0];
      if (!spec) throw new Error('missing_spec');
      if (spec.startsWith('{')) return { goal: JSON.parse(spec) };
      const raw = readFileSync(spec, 'utf8');
      return { goal: JSON.parse(raw) };
    }
    case 'goal_set': {
      return JSON.parse(positional[0]);
    }
    case 'goal_remove': {
      return { id: positional[0] };
    }
    case 'goal_status': {
      return { id: positional[0] };
    }
    case 'task_start': {
      const action = positional[0];
      const json = positional[1] ?? '{}';
      const o = JSON.parse(json);
      return { action, ...o };
    }
    case 'checkpoint_respond': {
      const decision = positional[0] || 'continue';
      const lease = positional[1] ? Number(positional[1]) : 45;
      return { decision, lease_seconds: lease };
    }
    case 'mark': {
      const flags = parseMarkFlags(positional);
      const q = /** @type {string[]} */ (flags._rest);
      delete flags._rest;
      const name = q.shift();
      const note = q.join(' ') || '';
      if (!name) throw new Error('missing_name');
      return { name, note, ...flags };
    }
    case 'mark_update': {
      const flags = parseMarkFlags(positional);
      const q = /** @type {string[]} */ (flags._rest);
      delete flags._rest;
      const name = q.shift();
      const note = q.join(' ') || '';
      if (!name) throw new Error('missing_name');
      return { name, note, ...flags };
    }
    case 'poi_add':
    case 'poi_update': {
      // Phase A4 + Phase E (the Phase A4 ship missed this case so every
      // call returned `unhandled_custom_parse:poi_add`).
      //
      // Grammar: mc poi_add NAME [NOTE] [--at X Y Z] [--sign X Y Z]
      //                          [--torch X Y Z] [--kind KIND]
      //
      // The registry bodyFn looks for `p.at / p.sign / p.torch` as
      // {x,y,z} objects; we build those here from the 3-arg flag values.
      const q = positional.slice();
      const out = /** @type {Record<string, unknown>} */ ({});
      const positionals = [];
      while (q.length) {
        const t = String(q[0]);
        if (t === '--at' || t === '--sign' || t === '--torch') {
          q.shift();
          const x = Number(q.shift());
          const y = Number(q.shift());
          const z = Number(q.shift());
          if (![x, y, z].every(Number.isFinite)) {
            throw new Error(`bad_coord:${t} expects three numeric args (X Y Z)`);
          }
          // 'at' / 'sign' / 'torch' on the request body
          const key = t.slice(2);
          out[key] = { x, y, z };
        } else if (t === '--kind') {
          q.shift();
          out.kind = String(q.shift() ?? '');
        } else if (t.startsWith('--')) {
          throw new Error(`unknown_flag:${t}`);
        } else {
          positionals.push(q.shift());
        }
      }
      const name = positionals.shift();
      if (!name) throw new Error('missing_name');
      const note = positionals.join(' ') || '';
      return { name, note, ...out };
    }
    case 'regions': {
      const q = positional.slice();
      /** @type {Record<string, unknown>} */
      const out = {};
      while (q.length && String(q[0]).startsWith('--')) {
        const f = String(q.shift());
        if (f === '--at') {
          const first = q.length ? String(q[0]) : '';
          if (first.includes(',')) {
            out.at = String(q.shift());
          } else {
            const x = Number(q.shift());
            const y = Number(q.shift());
            const z = Number(q.shift());
            out.at = `${x},${y},${z}`;
          }
        } else throw new Error(`unknown_flag:${f}`);
      }
      return out;
    }
    case 'region_create': {
      const q = positional.slice();
      /** @type {Record<string, unknown>} */
      const flags = {};
      while (q.length && String(q[0]).startsWith('--')) {
        const f = String(q.shift());
        if (f === '--r' || f === '--radius') flags.r = Number(q.shift());
        else if (f === '--y') flags.y = q.shift();
        else if (f === '--intent') flags.intent = q.shift();
        else if (f === '--shape') flags.shape = q.shift();
        else throw new Error(`unknown_flag:${f} — usage: mc region_create <ID> <PROFILE> [--r N] [--y MIN..MAX] [--intent protect|resource|marker] [--shape column|sphere]`);
      }
      const id = q.shift();
      const profile = q.shift();
      if (!id && !profile) {
        throw new Error('missing_args: <ID> and <PROFILE> required. usage: mc region_create <ID> <PROFILE> [--r N] [--y MIN..MAX] [--intent protect|resource|marker] [--shape column|sphere]. example: mc region_create :base1: base --r 18 --y 58..120 --intent protect');
      }
      if (!profile) {
        throw new Error(`missing_args: <PROFILE> required after <ID> (got id="${id}"). PROFILE is one of base|protect|mine|farm (the behaviour preset). example: mc region_create ${id} base --r 18 --y 58..120 --intent protect`);
      }
      return { id, profile, ...flags };
    }
    case 'region_remove': {
      const q = positional.slice();
      let confirm = false;
      const rest = [];
      for (const tok of q) {
        if (tok === '--confirm') confirm = true;
        else rest.push(tok);
      }
      if (!rest[0]) throw new Error('missing_id');
      return { id: rest[0], confirm };
    }
    case 'region_update_intent': {
      const q = positional.slice();
      const id = q.shift();
      const intent = q.shift();
      if (!id || !intent) {
        throw new Error('missing_args: usage mc region_update_intent <ID> <protect|resource|marker>. example: mc region_update_intent :hut3: marker');
      }
      const valid = ['protect', 'resource', 'marker'];
      if (!valid.includes(String(intent).toLowerCase())) {
        throw new Error(`bad_intent: "${intent}" — must be one of: ${valid.join(', ')}`);
      }
      return { id, intent: String(intent).toLowerCase() };
    }
    case 'mine_open': {
      const q = positional.slice();
      /** @type {Record<string, unknown>} */
      const out = {};
      const rest = [];
      while (q.length) {
        const t = String(q[0]);
        if (t === '--at') {
          q.shift();
          out.x = Number(q.shift());
          out.y = Number(q.shift());
          out.z = Number(q.shift());
        } else if (t.startsWith('--')) {
          throw new Error(`unknown_flag:${t} — usage: mc mine_open <ID> [DIR] [TARGET_Y] [RESOURCE] [--at X Y Z]`);
        } else {
          rest.push(String(q.shift()));
        }
      }
      out.id = rest[0];
      if (!out.id) throw new Error('missing_id: usage mc mine_open <ID> [DIR] [TARGET_Y] [RESOURCE] [--at X Y Z]');
      // Positional DIR / TARGET_Y / RESOURCE are order-tolerant: a cardinal is
      // the dir, a number is the target_y, anything else is the resource.
      const DIRS = new Set(['north', 'south', 'east', 'west']);
      for (const tok of rest.slice(1)) {
        if (DIRS.has(tok.toLowerCase())) out.dir = tok.toLowerCase();
        else if (/^-?\d+$/.test(tok)) out.target_y = Number(tok);
        else out.resource = tok;
      }
      return out;
    }
    case 'mine_note': {
      const q = positional.slice();
      /** @type {Record<string, unknown>} */
      const out = {};
      const tags = [];
      const rest = [];
      while (q.length) {
        const t = String(q[0]);
        if (t === '--at') {
          q.shift();
          out.x = Number(q.shift());
          out.y = Number(q.shift());
          out.z = Number(q.shift());
        } else if (t === '--note') { q.shift(); out.note = String(q.shift() ?? ''); }
        else if (t === '--tag') { q.shift(); tags.push(String(q.shift() ?? '')); }
        else if (t === '--dir') { q.shift(); out.dir = String(q.shift() ?? '').toLowerCase(); }
        else if (t === '--target-y') { q.shift(); out.target_y = Number(q.shift()); }
        else if (t === '--resource') { q.shift(); out.resource = String(q.shift() ?? ''); }
        else if (t === '--qty') { q.shift(); out.qty = Number(q.shift()); }
        else if (t === '--hazard') { q.shift(); out.hazard = String(q.shift() ?? '').toLowerCase(); }
        else if (t === '--sealed') { q.shift(); out.sealed = true; }
        else if (t.startsWith('--')) throw new Error(`unknown_flag:${t} — usage: mc mine_note <ID> <KIND> [--at X Y Z] [--note ..] [--tag T] [--dir D] [--target-y Y] [--resource R] [--qty N] [--hazard H] [--sealed]`);
        else rest.push(String(q.shift()));
      }
      out.id = rest[0];
      out.kind = rest[1];
      if (tags.length) out.tags = tags;
      if (!out.id || !out.kind) {
        throw new Error('missing_args: usage mc mine_note <ID> <KIND> — KIND is landing|chamber|junction|station|frontier|ore|danger');
      }
      return out;
    }
    case 'mine_status': {
      const q = positional.slice();
      const id = q.shift();
      const status = q.shift();
      if (!id || !status) {
        throw new Error('missing_args: usage mc mine_status <ID> <active|exhausted|abandoned|hazard_locked>');
      }
      return { id, status: String(status).toLowerCase() };
    }
    case 'mine_show':
    case 'mine_resume': {
      const id = positional[0];
      if (!id) throw new Error(`missing_id: usage mc ${canonicalName} <ID>`);
      return { id };
    }
    case 'mine_remove': {
      const q = positional.slice();
      let confirm = false;
      const rest = [];
      for (const tok of q) {
        if (tok === '--confirm') confirm = true;
        else rest.push(tok);
      }
      if (!rest[0]) throw new Error('missing_id: usage mc mine_remove <ID> --confirm');
      return { id: rest[0], confirm };
    }
    case 'edit_sign': {
      const q = positional.slice();
      let back = false;
      const rest = [];
      for (const tok of q) {
        if (tok === '--back') back = true;
        else rest.push(tok);
      }
      if (rest.length < 4) {
        throw new Error('missing_args: usage mc edit_sign X Y Z "line1\\nline2\\nline3\\nline4" [--back]');
      }
      const x = Number(rest[0]);
      const y = Number(rest[1]);
      const z = Number(rest[2]);
      if (![x, y, z].every(Number.isFinite)) {
        throw new Error(`bad_coord: X Y Z must be numeric — got ${rest[0]} ${rest[1]} ${rest[2]}`);
      }
      // Text may come as 1 arg (quoted) or as multiple arg tokens joined by space.
      // Prefer the joined form so 'mc edit_sign 1 2 3 "hello world"' works regardless of shell quoting.
      const text = rest.slice(3).join(' ').replace(/\\n/g, '\n');
      return { x, y, z, text, back };
    }
    case 'site_add': {
      const ref = positional[0];
      const x = Number(positional[1]);
      const y = Number(positional[2]);
      const z = Number(positional[3]);
      return { ref, x, y, z };
    }
    case 'site_remove': {
      return { ref: positional[0] };
    }
    case 'task_context': {
      const q = positional.slice();
      const sub = String(q.shift() || '').toLowerCase();
      if (sub === 'show') {
        return { subcommand: 'show', _httpMethod: 'GET' };
      }
      if (sub === 'clear') {
        return { subcommand: 'clear', _httpMethod: 'DELETE' };
      }
      if (sub === 'set') {
        let card = process.env.HERMES_KANBAN_TASK || '';
        let expiresMin = null;
        let plan = '';
        let level = null;
        let range = '';
        let phase = '';
        let cardKind = '';
        let planRevision = '';
        let constructAutoBegin = undefined;
        /** @type {string[]} */
        const positionals = [];
        while (q.length) {
          const t = String(q[0]);
          if (t === '--card') {
            q.shift();
            card = String(q.shift() || '').trim();
            continue;
          }
          if (t === '--expires-min') {
            q.shift();
            expiresMin = Number(q.shift());
            continue;
          }
          if (t === '--plan') {
            q.shift();
            plan = String(q.shift() || '').trim();
            continue;
          }
          if (t === '--level') {
            q.shift();
            level = Number(q.shift());
            continue;
          }
          if (t === '--range') {
            q.shift();
            range = String(q.shift() || '').trim();
            continue;
          }
          if (t === '--phase') {
            q.shift();
            phase = String(q.shift() || '').trim();
            continue;
          }
          if (t === '--card-kind') {
            q.shift();
            cardKind = String(q.shift() || '').trim();
            continue;
          }
          if (t === '--plan-revision') {
            q.shift();
            planRevision = String(q.shift() || '').trim();
            continue;
          }
          if (t === '--no-construct-auto-begin') {
            q.shift();
            constructAutoBegin = false;
            continue;
          }
          if (t.startsWith('--')) throw new Error(`unknown_flag:${t}`);
          positionals.push(String(q.shift()));
        }
        const worksite = positionals[0] || '';
        if (!worksite && !card) {
          throw new Error(
            'missing_card_or_worksite: usage mc task_context set [<worksite>] --card ID | set <worksite> [--card ID] (or HERMES_KANBAN_TASK + worksite)',
          );
        }
        if (!card) {
          throw new Error('missing_card_id: set HERMES_KANBAN_TASK or pass --card');
        }
        const now = Date.now();
        let expires_at_ms = now + 30 * 60 * 1000;
        if (Number.isFinite(expiresMin) && expiresMin > 0) {
          expires_at_ms = now + expiresMin * 60 * 1000;
        }
        const maxExp = now + 4 * 60 * 60 * 1000;
        if (expires_at_ms > maxExp) expires_at_ms = maxExp;
        return {
          subcommand: 'set',
          _httpMethod: 'POST',
          card_id: card,
          ...(worksite ? { worksite_region: String(worksite) } : {}),
          expires_at_ms,
          ...(plan ? { plan } : {}),
          ...(Number.isFinite(level) ? { level } : {}),
          ...(range ? { range } : {}),
          ...(phase ? { phase } : {}),
          ...(cardKind ? { card_kind: cardKind } : {}),
          ...(planRevision ? { plan_revision: planRevision } : {}),
          ...(constructAutoBegin === false ? { construct_auto_begin: false } : {}),
        };
      }
      throw new Error('task_context_subcommand: use set|clear|show');
    }
    case 'playbook_phase_clear': {
      return {};
    }
    case 'playbook':
    case 'playbook_phase_set':
    case 'playbook_phase_clear': {
      const q = positional.slice();
      if (canonicalName === 'playbook_phase_clear' || (q[0] === 'phase' && q[1] === 'clear')) {
        return { _redirect: 'playbook_phase_clear' };
      }
      if (q[0] === 'phase') q.shift();
      const sub = String(q.shift() || '').toLowerCase();
      if (sub === 'clear') {
        return { _redirect: 'playbook_phase_clear' };
      }
      if (sub !== 'set') {
        throw new Error('playbook_subcommand: use "phase set <playbook_id> <phase>" or "phase clear"');
      }
      // Flags may appear before OR after the positionals — scan the whole
      // queue and pull them out in place. Earlier "leading flags only"
      // form rejected the documented `phase set <id> <phase> --sub-playbook X`
      // order with `extra_arguments:playbook`.
      let subPlaybook = '';
      let subPhase = '';
      for (let i = 0; i < q.length; ) {
        const tok = String(q[i]);
        if (tok === '--sub-playbook') {
          subPlaybook = String(q[i + 1] || '').trim();
          q.splice(i, 2);
        } else if (tok === '--sub-phase') {
          subPhase = String(q[i + 1] || '').trim();
          q.splice(i, 2);
        } else if (tok.startsWith('--')) {
          throw new Error(`unknown_flag:${tok}`);
        } else {
          i += 1;
        }
      }
      const playbook_id = q.shift();
      const phase = q.shift();
      if (!playbook_id || !phase) {
        throw new Error('missing_playbook_phase: mc playbook phase set <playbook_id> <phase>');
      }
      if (q.length) throw new Error(`extra_arguments:playbook`);
      return {
        playbook_id,
        phase,
        ...(subPlaybook ? { sub_playbook_id: subPlaybook } : {}),
        ...(subPhase ? { sub_phase: subPhase } : {}),
      };
    }
    case 'reach': {
      const q = positional.slice();
      if (q[0]?.startsWith('@')) {
        return { mark: q[0].slice(1) };
      }
      if (q.length < 3) throw new Error('missing_coords: mc reach X Y Z | mc reach @mark');
      return { x: Number(q[0]), y: Number(q[1]), z: Number(q[2]) };
    }
    case 'check': {
      const verb = String(positional[0] || '').toLowerCase();
      if (verb === 'dig') {
        return { verb: 'dig', x: Number(positional[1]), y: Number(positional[2]), z: Number(positional[3]) };
      }
      if (verb === 'place') {
        return {
          verb: 'place',
          block: positional[1],
          x: Number(positional[2]),
          y: Number(positional[3]),
          z: Number(positional[4]),
        };
      }
      throw new Error('check_verb');
    }
    case 'blueprint': {
      const q = positional.slice();
      const sub = String(q.shift() || '').toLowerCase();
      if (!sub) throw new Error('blueprint_subcommand');
      let target = null;
      const body = { subcommand: sub };
      while (q.length && !String(q[0]).startsWith('--')) {
        if (!target) target = q.shift();
        else break;
      }
      if (target) body.target = target;
      while (q.length) {
        const f = String(q.shift());
        if (f === '--level') body.level = Number(q.shift());
        else if (f === '--range') body.range = String(q.shift());
        else if (f === '--at') {
          body.x = Number(q.shift());
          body.y = Number(q.shift());
          body.z = Number(q.shift());
        } else if (f === '--local') body.local = String(q.shift());
        else if (f === '--y') body.y = Number(q.shift());
        else if (f === '--limit') body.limit = Number(q.shift());
        else if (f === '--note') body.note = String(q.shift());
        else if (f === '--region') body.region = String(q.shift());
        else if (f === '--force') body.force = true;
        else if (f === '--allow-outside-region') body.allow_outside_region = true;
        else if (f === '--site') body.site = String(q.shift());
        else throw new Error(`unknown_flag:${f}`);
      }
      if (sub === 'capture' && target) body.plan_id = target.replace(/^:/, '').replace(/:$/, '');
      return body;
    }
    case 'construct':
    case 'repair': {
      const q = positional.slice();
      const body = { target: q.shift() };
      while (q.length) {
        const f = String(q.shift());
        if (f === '--level') body.level = Number(q.shift());
        else if (f === '--range') body.range = String(q.shift());
        else if (f === '--at') {
          body.x = Number(q.shift());
          body.y = Number(q.shift());
          body.z = Number(q.shift());
        } else throw new Error(`unknown_flag:${f}`);
      }
      return body;
    }
    case 'inspect': {
      const q = positional.slice();
      const out = {};
      while (q.length && String(q[0]).startsWith('--')) {
        const f = String(q.shift());
        if (f === '--mark' || f === '-m') out.mark = String(q.shift() ?? '').replace(/^:|:$/g, '');
        else throw new Error(`unknown_flag:${f}`);
      }
      if (out.mark) {
        if (q.length) throw new Error('extra_arguments:inspect');
        return out;
      }
      if (q.length < 3) throw new Error('missing:coords');
      out.x = Number(q.shift());
      out.y = Number(q.shift());
      out.z = Number(q.shift());
      if (q.length) throw new Error('extra_arguments:inspect');
      return out;
    }
    case 'farm_status': {
      const q = positional.slice();
      const out = {};
      while (q.length && String(q[0]).startsWith('--')) {
        const f = String(q.shift());
        if (f === '--mark' || f === '-m') out.mark = String(q.shift() ?? '').replace(/^:|:$/g, '');
        else if (f === '--size') out.size = Number(q.shift());
        else if (f === '--y') out.y = Number(q.shift());
        else throw new Error(`unknown_flag:${f}`);
      }
      if (out.mark) {
        if (q.length) throw new Error('extra_arguments:farm_status');
        return out;
      }
      if (q.length < 4) throw new Error('missing:rect');
      out.x1 = Number(q.shift());
      out.z1 = Number(q.shift());
      out.x2 = Number(q.shift());
      out.z2 = Number(q.shift());
      if (q.length === 1) out.y = Number(q.shift());
      else if (q.length) throw new Error('extra_arguments:farm_status');
      return out;
    }
    case 'chest':
    case 'list_container':
      if (positional[0]?.startsWith('{')) return JSON.parse(positional[0]);
      if (positional[0]?.startsWith('@'))
        return { mark: positional[0].slice(1) };
      return { x: Number(positional[0]), y: Number(positional[1]), z: Number(positional[2]) };
    case 'deposit':
    case 'withdraw':
      return parseDepositWithdrawPositional(positional);
    case 'verify': {
      // mc verify <kind> <args...>
      //   inventory_contains <item> [min_count]
      //   chest_contains <mark> <item> [min_count]
      //   at_mark <mark> [--near N | --block <id>] [from=X,Y,Z]
      //   region_blocks <x1> <y1> <z1> <x2> <y2> <z2> <block> [min_count]
      const q = positional.slice();
      const kind = String(q.shift() || '').toLowerCase();
      if (!kind) throw new Error('missing:kind');
      const out = { kind };
      if (kind === 'inventory_contains') {
        out.item = String(q.shift() || '');
        if (!out.item) throw new Error('missing:item');
        if (q.length) out.min_count = Number(q.shift());
      } else if (kind === 'chest_contains') {
        out.mark = String(q.shift() || '').replace(/^:|:$/g, '');
        if (!out.mark) throw new Error('missing:mark');
        out.item = String(q.shift() || '');
        if (!out.item) throw new Error('missing:item');
        if (q.length) out.min_count = Number(q.shift());
      } else if (kind === 'at_mark') {
        out.mark = String(q.shift() || '').replace(/^:|:$/g, '');
        if (!out.mark) throw new Error('missing:mark');
        // Parse --near N | --block <id> | from=X,Y,Z flags. `from` measures
        // proximity from an arbitrary point instead of the bot's position
        // (remote verification — no walking required).
        while (q.length) {
          const f = String(q.shift());
          if (f === '--near') out.near = Number(q.shift());
          else if (f === '--block') out.block = String(q.shift() || '');
          else if (f === '--from') out.from = String(q.shift() || '');
          else if (/^(--)?near=./.test(f)) out.near = Number(f.slice(f.indexOf('=') + 1));
          else if (/^(--)?block=./.test(f)) out.block = f.slice(f.indexOf('=') + 1);
          else if (/^(--)?from=./.test(f)) out.from = f.slice(f.indexOf('=') + 1);
          else throw new Error(`unknown_flag:${f}`);
        }
      } else if (kind === 'region_blocks') {
        if (q.length < 7) {
          throw new Error('missing:corners_or_block');
        }
        out.corner1 = {
          x: Number(q.shift()),
          y: Number(q.shift()),
          z: Number(q.shift()),
        };
        out.corner2 = {
          x: Number(q.shift()),
          y: Number(q.shift()),
          z: Number(q.shift()),
        };
        out.block = String(q.shift() || '');
        if (!out.block) throw new Error('missing:block');
        if (q.length) out.min_count = Number(q.shift());
      } else {
        // Forward unknown kinds with raw args so the server can reject
        // them with the canonical UNKNOWN_KIND error response — this
        // preserves error messages for forward-compat new kinds.
        out._args = q.slice();
      }
      return out;
    }
    case 'verify_plot': {
      const q = positional.slice();
      const out = {};
      const pos = [];
      while (q.length) {
        const t = String(q[0]);
        if (t === '--worksite' || t === '-w') {
          q.shift();
          out.worksite = String(q.shift() ?? '');
        } else if (t === '--expect-y' || t === '--expect_y') {
          q.shift();
          out.expect_y = Number(q.shift());
        } else if (t === '--flat-max-delta') {
          q.shift();
          out.flat_max_delta = Number(q.shift());
        } else if (t.startsWith('--')) {
          throw new Error(`unknown_flag:${t}`);
        } else {
          pos.push(q.shift());
        }
      }
      if (pos.length < 4) throw new Error('missing:rect');
      out.x1 = Number(pos[0]);
      out.z1 = Number(pos[1]);
      out.x2 = Number(pos[2]);
      out.z2 = Number(pos[3]);
      return out;
    }
    case 'regions_terrain': {
      const q = positional.slice();
      const out = {};
      if (q[0] === '--rect') {
        q.shift();
        const parts = q.splice(0, 4).map(Number);
        if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) throw new Error('missing:rect');
        out.rect = parts.join(',');
      } else if (q.length && !String(q[0]).startsWith('--')) {
        out.region = String(q.shift());
      }
      while (q.length) {
        const t = String(q[0]);
        if (t === '--expect-y' || t === '--expect_y') {
          q.shift();
          out.expect_y = Number(q.shift());
        } else if (t === '--flat-max-delta') {
          q.shift();
          out.flat_max_delta = Number(q.shift());
        } else if (t.startsWith('--')) {
          throw new Error(`unknown_flag:${t}`);
        } else {
          q.shift();
        }
      }
      if (!out.region && !out.rect) throw new Error('missing:region_or_rect');
      return out;
    }
    default:
      throw new Error(`unhandled_custom_parse:${canonicalName}`);
  }
}
