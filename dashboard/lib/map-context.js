/**
 * Runtime map hints for dashboard (establish / proc-lab seed, arena anchors).
 */

import fs from 'fs';
import path from 'path';

/**
 * @param {string} repoRoot
 * @param {string} hermesWorld
 */
export function loadMapContext(repoRoot, hermesWorld) {
  const runtime = path.join(repoRoot, 'data', 'runtime');
  /** @type {Record<string, unknown>} */
  const out = { world: hermesWorld };

  const statePath = path.join(runtime, 'proc-lab-state.json');
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (raw && typeof raw === 'object') {
      out.proc_lab = {
        seed: raw.seed != null ? String(raw.seed) : null,
        requirements_id: raw.requirements_id ?? null,
        updated_at: raw.updated_at ?? null,
        world_name: raw.world_name ?? 'proc-lab',
      };
      if (hermesWorld === 'proc-lab' || hermesWorld === raw.world_name) {
        out.tile_revision = [raw.seed, raw.updated_at].filter(Boolean).join('|') || null;
      }
    }
  } catch {
    out.proc_lab = null;
  }

  const mapPath = path.join(runtime, 'last-establish-map.json');
  try {
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    if (map && typeof map === 'object') {
      const arena = map.arena;
      const reqId = map.requirements_id ?? null;
      let mission = null;
      if (reqId === 'scenario_establish_mapping') mission = 'mapping';
      else if (reqId === 'scenario_establish_explore' || reqId?.includes?.('establish')) {
        mission = 'explore';
      }
      out.establish = {
        seed: map.seed != null ? String(map.seed) : null,
        requirements_id: reqId,
        mission,
        spawn: Array.isArray(map.spawn) ? map.spawn : map.placements?.spawn ?? null,
        muster: Array.isArray(map.muster) ? map.muster : map.placements?.muster ?? null,
        starter_chest: map.placements?.starter_chest ?? map.starter_chest ?? null,
        arena:
          arena && typeof arena === 'object'
            ? {
                center: arena.center,
                radius: arena.radius ?? 32,
              }
            : null,
      };
      if (hermesWorld === 'proc-lab' && map.seed != null) {
        const rev = [map.seed, map.spawn?.join(','), map.muster?.join(',')].filter(Boolean).join('|');
        out.tile_revision = out.tile_revision || rev;
      }
    }
  } catch {
    out.establish = null;
  }

  return out;
}
