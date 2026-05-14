import { readFileSync } from 'node:fs';
import { normalizeMark, positionalToParams } from './args.mjs';

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
  while (q.length && String(q[0]).startsWith('--')) {
    const f = String(q.shift());
    if (f === '--category' || f === '--cat') out.category = String(q.shift() ?? '');
    else if (f === '--radius') out.radius = Number(q.shift());
    else if (f === '--mode') out.mode = String(q.shift() ?? '');
    else if (f === '--stale') out.stale = String(q.shift() ?? 'true') === 'true';
    else if (f === '--at') {
      const a = String(q.shift() ?? '');
      if (a.startsWith('@')) out.at_mark = a.slice(1);
      else {
        const y = q.shift();
        const z = q.shift();
        out.at = { x: Number(a), y: Number(y), z: Number(z) };
      }
    } else throw new Error(`unknown_flag:${f}`);
  }
  out._rest = q;
  return out;
}

/**
 * @param {CmdDef} def
 * @param {string} canonicalName
 * @param {string[]} positional
 */
export function buildHttpRequest(def, canonicalName, positional) {
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
  const method = def.method || 'GET';
  const path = def.pathFn ? def.pathFn(params) : def.path;
  if (!path) throw new Error(`no_path:${canonicalName}`);

  let body = null;
  if (method === 'POST' || method === 'DELETE') {
    if (def.bodyFn) body = def.bodyFn(params);
    else if (method === 'POST') body = empty;
  }

  return { method, path, body, params };
}

/**
 * @param {CmdDef} def
 * @param {string} canonicalName
 * @param {string[]} positional
 */
function customParse(canonicalName, positional) {
  switch (canonicalName) {
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
      // mc move X Y Z [--max-doors N] [--door GX GY GZ]
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
        } else { positionals.push(q.shift()); }
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
    case 'chest':
    case 'list_container':
      if (positional[0]?.startsWith('{')) return JSON.parse(positional[0]);
      if (positional[0]?.startsWith('@'))
        return { mark: positional[0].slice(1) };
      return { x: Number(positional[0]), y: Number(positional[1]), z: Number(positional[2]) };
    case 'deposit':
    case 'withdraw':
      if (positional[0]?.startsWith('{')) return JSON.parse(positional[0]);
      if (positional[1]?.startsWith('@')) {
        return {
          item: positional[0],
          mark: positional[1].slice(1),
          count: positional[2] != null ? Number(positional[2]) : 0,
        };
      }
      // mc deposit ITEM COUNT MARK (mark without @)
      if (positional.length === 3 && isNaN(Number(positional[2]))) {
        return {
          item: positional[0],
          count: positional[1] != null ? Number(positional[1]) : 0,
          mark: String(positional[2]).replace(/^@/, ''),
        };
      }
      // mc deposit ITEM COUNT X Y Z
      if (positional.length >= 5) {
        return {
          item: positional[0],
          count: positional[1] != null ? Number(positional[1]) : 0,
          x: Number(positional[2]),
          y: Number(positional[3]),
          z: Number(positional[4]),
        };
      }
      // mc deposit ITEM COUNT (no location — server will use nearest chest)
      if (positional.length === 2 && !isNaN(Number(positional[1]))) {
        return {
          item: positional[0],
          count: Number(positional[1]),
        };
      }
      // mc deposit ITEM (deposit all of item to nearest chest)
      return {
        item: positional[0],
        count: 0,
      };
    default:
      throw new Error(`unhandled_custom_parse:${canonicalName}`);
  }
}
