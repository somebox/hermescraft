/**
 * nearby_signs — list signs within `radius` blocks (default 32), each
 * with its 4 text lines + distance. Cross-references the personal-POI
 * store so signs that anchor a known POI are flagged with `owner_poi`.
 *
 * Phase A5. Complements observe's `nearby_signs[]` (which only surfaces
 * signs anchored to known POIs); this verb is the broader-sweep version
 * for discovering signs the agent hasn't catalogued yet.
 */
import { Vec3 } from 'vec3';
import { ok, fail } from '../../shared/action-contract.js';

function isSignBlockName(name) {
  return typeof name === 'string' && name.includes('sign');
}

function readSignLines(block) {
  if (!block) return ['', '', '', ''];
  if (Array.isArray(block.signText)) {
    return [0, 1, 2, 3].map((i) => String(block.signText[i] ?? ''));
  }
  const sig = block._signEntity || block.signEntity;
  if (sig?.text != null) {
    if (Array.isArray(sig.text)) return [0, 1, 2, 3].map((i) => String(sig.text[i] ?? ''));
    const split = String(sig.text).split('\n');
    return [0, 1, 2, 3].map((i) => split[i] ?? '');
  }
  return ['', '', '', ''];
}

/**
 * @param {{ ctx: object, ensureBot: () => object, loadPersonalPois?: () => Record<string, any> }} deps
 */
export function createSignsQueries({ ensureBot, loadPersonalPois }) {
  return {
    /**
     * @param {{ radius?: number }} body
     */
    async nearby_signs(body = {}) {
      const b = ensureBot();
      const radius = Math.max(4, Math.min(64, Number(body.radius) || 32));

      if (typeof b.findBlocks !== 'function') {
        return fail('FIND_BLOCKS_UNAVAILABLE', 'bot.findBlocks is not available — cannot scan for signs.', {
          retry_safe: true,
        });
      }

      let positions;
      try {
        positions = b.findBlocks({
          matching: (blk) => isSignBlockName(blk?.name),
          maxDistance: radius,
          count: 20,
        });
      } catch (e) {
        return fail('FIND_BLOCKS_FAILED', `bot.findBlocks threw: ${e?.message || String(e)}`, {
          retry_safe: true,
        });
      }
      if (!Array.isArray(positions)) positions = [];

      // Build a sign_at → poi_name index from personal POIs so we can
      // flag signs that anchor a known POI without an N×M comparison.
      const poiBySignAt = new Map();
      try {
        if (typeof loadPersonalPois === 'function') {
          const pois = loadPersonalPois();
          for (const [name, p] of Object.entries(pois || {})) {
            if (p.sign_at) {
              const k = `${p.sign_at.x},${p.sign_at.y},${p.sign_at.z}`;
              poiBySignAt.set(k, name);
            }
          }
        }
      } catch { /* loadPersonalPois may not be wired in tests */ }

      const botPos = b.entity?.position;
      const rows = [];
      for (const pos of positions) {
        const px = pos.x ?? pos[0];
        const py = pos.y ?? pos[1];
        const pz = pos.z ?? pos[2];
        const block = b.blockAt(new Vec3(px, py, pz));
        if (!block || !isSignBlockName(block.name)) continue;
        const lines = readSignLines(block);
        const dist = botPos != null
          ? Math.round(Math.sqrt((botPos.x - px) ** 2 + (botPos.y - py) ** 2 + (botPos.z - pz) ** 2))
          : null;
        const owner = poiBySignAt.get(`${px},${py},${pz}`) || null;
        rows.push({
          x: px,
          y: py,
          z: pz,
          block: block.name,
          dist,
          lines,
          owner_poi: owner,
        });
      }
      rows.sort((a, b2) => (a.dist ?? 0) - (b2.dist ?? 0));

      if (!rows.length) {
        return ok({
          result: `No signs within ${radius} blocks.`,
          data: { signs: [], radius },
        });
      }
      const summary = rows
        .map((r) => {
          const text = r.lines.filter(Boolean).join(' / ') || '(blank)';
          const owner = r.owner_poi ? ` [poi=${r.owner_poi}]` : '';
          return `${r.x},${r.y},${r.z} (${r.dist}m): ${text}${owner}`;
        })
        .join('\n');
      return ok({
        result: summary,
        data: { signs: rows, radius },
      });
    },
  };
}
