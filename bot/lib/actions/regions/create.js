import { ok, fail } from '../../shared/action-contract.js';
import { normalizeId, parseSiteRef, normalizeSitesForStorage } from '../../runtime/regions/index.js';
import { PROFILES } from '../../runtime/regions/profiles.js';

const ID_RE = /^:?[a-z0-9]{2,12}:?$/i;
const VALID_INTENTS = new Set(['protect', 'resource', 'marker']);

function parseYRange(raw) {
  if (raw == null || raw === '') return {};
  const m = String(raw).match(/^(-?\d+)\.\.(-?\d+)$/);
  if (!m) return null;
  return { y_min: Number(m[1]), y_max: Number(m[2]) };
}

export function createRegionsMutateActions(deps) {
  const { ctx, ensureBot, posObj } = deps;

  function requireStore() {
    const store = ctx.runtime?.regions;
    if (!store) return { error: fail('UNAVAILABLE', 'Region store not initialized', { retry_safe: true }) };
    return { store };
  }

  return {
    async region_create(body) {
      ensureBot();
      const got = requireStore();
      if (got.error) return got.error;
      const store = got.store;

      const rawId = body.id ?? body.region_id ?? body.name;
      if (!rawId || !ID_RE.test(String(rawId).trim())) {
        return fail('INVALID_ID', 'Region id must be :name: (2–12 alphanumeric chars)', { retry_safe: false });
      }
      const id = normalizeId(rawId);
      if (store.get(id)) {
        return fail('REGION_EXISTS', `Region :${id}: already exists`, { retry_safe: false });
      }

      const profile = String(body.profile || body.args?.profile || '').toLowerCase();
      if (!profile || !(profile in PROFILES)) {
        return fail('INVALID_ARGS', `Unknown profile — use one of: ${Object.keys(PROFILES).join(', ')}`, {
          retry_safe: false,
        });
      }

      const bot = ctx.world.bot;
      const pos = body.anchor ? body.anchor : posObj(bot.entity.position);
      const radius = body.r != null ? Number(body.r) : body.radius != null ? Number(body.radius) : 16;
      const yRange = body.y != null ? parseYRange(body.y) : parseYRange(body.y_range);
      if (yRange === null) {
        return fail('INVALID_ARGS', 'y range must look like 60..80', { retry_safe: false });
      }

      const shape = {
        kind: body.shape === 'sphere' ? 'sphere' : 'column',
        radius: Number.isFinite(radius) ? radius : 16,
        ...yRange,
      };

      let intentOverride;
      if (body.intent != null && String(body.intent).trim() !== '') {
        intentOverride = String(body.intent).toLowerCase();
        if (!VALID_INTENTS.has(intentOverride)) {
          return fail('INVALID_ARGS', `Unknown intent — use one of: ${[...VALID_INTENTS].join(', ')}`, {
            retry_safe: false,
          });
        }
      }

      const region = store.upsert({
        id,
        profile,
        intent: intentOverride,
        status: 'unanchored',
        anchor: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
        shape,
        sites: {},
      });

      return ok({
        result: `Created region :${id}: (${profile}, r=${shape.radius}, unanchored)`,
        data: { region },
      });
    },

    async region_update_intent(body) {
      const got = requireStore();
      if (got.error) return got.error;
      const store = got.store;

      const rawId = body.id ?? body.region_id;
      if (!rawId) {
        return fail('INVALID_ID', 'Missing region id (usage: mc region_update_intent :id: <protect|resource|marker>)', { retry_safe: false });
      }
      const id = normalizeId(rawId);
      const region = store.get(id);
      if (!region) {
        return fail('REGION_NOT_FOUND', `No region :${id}:`, { retry_safe: false });
      }

      const rawIntent = body.intent ?? body.to;
      if (!rawIntent) {
        return fail('INVALID_ARGS', `Missing target intent (one of: ${[...VALID_INTENTS].join(', ')})`, { retry_safe: false });
      }
      const intent = String(rawIntent).toLowerCase();
      if (!VALID_INTENTS.has(intent)) {
        return fail('INVALID_ARGS', `Unknown intent "${intent}" — use one of: ${[...VALID_INTENTS].join(', ')}`, { retry_safe: false });
      }

      const previousIntent = region.intent;
      if (previousIntent === intent) {
        return ok({
          result: `Region :${id}: already has intent=${intent} — no change`,
          data: { region, no_op: true },
        });
      }

      // Preserve sites, anchor, shape, profile. Only intent changes; the store
      // recomputes capabilities via applyProfile/normalizeRegion on upsert.
      const updated = store.upsert({ ...region, intent });
      return ok({
        result: `Region :${id}: intent ${previousIntent} → ${intent}`,
        data: { region: updated, previous_intent: previousIntent },
      });
    },

    async region_remove(body) {
      const got = requireStore();
      if (got.error) return got.error;
      const store = got.store;

      const rawId = body.id ?? body.region_id;
      if (!rawId) return fail('INVALID_ID', 'Missing region id', { retry_safe: false });
      const id = normalizeId(rawId);
      if (!store.get(id)) {
        return fail('REGION_NOT_FOUND', `No region :${id}:`, { retry_safe: false });
      }
      const confirmed = body.confirm === true || body.confirm === 'true' || body['--confirm'] === true;
      if (!confirmed) {
        return fail('MISSING_CONFIRM', `Refusing to remove :${id}: without confirm=true`, {
          next_action_hint: `mc region remove :${id}: --confirm`,
          retry_safe: true,
        });
      }
      store.removeById(id);
      return ok({ result: `Removed region :${id}:`, data: { id } });
    },

    async site_add(body) {
      ensureBot();
      const got = requireStore();
      if (got.error) return got.error;
      const store = got.store;

      const ref = body.ref ?? body.site_ref ?? body.name;
      const parsed = parseSiteRef(ref);
      if (!parsed) {
        return fail('INVALID_ID', 'Site ref must be :region:/sitename', { retry_safe: false });
      }
      const region = store.get(parsed.regionId);
      if (!region) {
        return fail('REGION_NOT_FOUND', `No region :${parsed.regionId}:`, { retry_safe: false });
      }

      const x = Number(body.x);
      const y = Number(body.y);
      const z = Number(body.z);
      if (![x, y, z].every(Number.isFinite)) {
        return fail('INVALID_ARGS', 'site_add requires X Y Z coordinates', { retry_safe: false });
      }

      const sites = { ...normalizeSitesForStorage(region.sites) };
      sites[parsed.siteName] = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
      const updated = store.upsert({ ...region, sites });
      return ok({
        result: `Added site :${parsed.regionId}:/${parsed.siteName} at ${x},${y},${z}`,
        data: { region: updated },
      });
    },

    async site_remove(body) {
      const got = requireStore();
      if (got.error) return got.error;
      const store = got.store;

      const ref = body.ref ?? body.site_ref ?? body.name;
      const parsed = parseSiteRef(ref);
      if (!parsed) {
        return fail('INVALID_ID', 'Site ref must be :region:/sitename', { retry_safe: false });
      }
      const region = store.get(parsed.regionId);
      if (!region) {
        return fail('REGION_NOT_FOUND', `No region :${parsed.regionId}:`, { retry_safe: false });
      }
      const sites = { ...normalizeSitesForStorage(region.sites) };
      if (!sites[parsed.siteName]) {
        return fail('SITE_NOT_FOUND', `No site :${parsed.regionId}:/${parsed.siteName}`, { retry_safe: false });
      }
      delete sites[parsed.siteName];
      const updated = store.upsert({ ...region, sites });
      return ok({
        result: `Removed site :${parsed.regionId}:/${parsed.siteName}`,
        data: { region: updated },
      });
    },
  };
}
