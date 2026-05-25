import { Vec3 } from 'vec3';
import path from 'node:path';
import { ok, fail } from '../../shared/action-contract.js';
import { containsPoint } from '../../runtime/regions/resolver.js';
import {
  parsePlanIdFromTarget,
  resolvePlanContext,
  buildCellsIndex,
  enrichPlan,
  loadPlanJson,
  planFilePath,
} from '../../runtime/blueprints/loader.js';
import { verifyPlan, writePlanAtomic, acquirePlanWriteLock, releasePlanWriteLock } from '../../runtime/blueprints/verify.js';
import { adoptWorldCell } from '../../runtime/blueprints/plan-mutations.js';
import {
  iterateFootprintLocals,
  localToWorld,
  tightFootprintFromCells,
  worldToLocal,
} from '../../runtime/blueprints/footprint.js';
import { isAirBlockName } from '../../runtime/blueprints/compare.js';
import { BLUEPRINT_LIMITS } from '../../runtime/blueprints/limits.js';

function dataDirFromCtx(ctx) {
  if (ctx.runtime?.dataDir) return ctx.runtime.dataDir;
  const fp = ctx.runtime?.regions?.filePath;
  if (fp) return path.dirname(fp);
  return null;
}

function canMutatePlan(config) {
  const allow = String(process.env.HERMES_BLUEPRINT_MUTATORS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allow.length) return false;
  return allow.includes(String(config.mc.username || '').toLowerCase());
}

function parseTarget(body) {
  const raw = body.target || body.plan_id || body.region || body.plan;
  if (!raw) return null;
  return parsePlanIdFromTarget(raw);
}

function parsePhase(body) {
  if (body.at && body.x != null) {
    return { atWorld: { x: Number(body.x), y: Number(body.y), z: Number(body.z) } };
  }
  if (body.level != null) return { level: Number(body.level) };
  const range = body.range || body.layer_range;
  if (range && typeof range === 'string') {
    const m = range.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (m) return { range: [Number(m[1]), Number(m[2])] };
  }
  if (Array.isArray(body.range)) return { range: body.range.map(Number) };
  return {};
}

function resolveCtx(deps, body) {
  const { ctx, config } = deps;
  const dataDir = dataDirFromCtx(ctx);
  if (!dataDir) {
    return { err: fail('INTERNAL', 'Blueprint dataDir not configured', { retry_safe: false }) };
  }
  const target = parseTarget(body);
  if (!target) {
    return { err: fail('NO_PLAN_CONTEXT', 'Missing blueprint target (:region: or plan_id)', { retry_safe: false }) };
  }
  const regions = ctx.runtime?.regions?.list?.() || [];
  const ctxPlan = resolvePlanContext({
    dataDir,
    target,
    regions,
    siteRef: body.site,
  });
  if (!ctxPlan.ok) {
    return { err: fail(ctxPlan.code || 'PLAN_NOT_FOUND', ctxPlan.message || 'Plan not found', { retry_safe: false }) };
  }
  if (!ctxPlan.sizeCheck?.ok && ctxPlan.sizeCheck?.code) {
    return {
      err: fail(ctxPlan.sizeCheck.code, ctxPlan.sizeCheck.message, { retry_safe: false }),
    };
  }
  ctxPlan.cellsIndex = buildCellsIndex(ctxPlan.plan.cells);
  return { dataDir, ctxPlan };
}

export function createBlueprintActions(deps) {
  const { ctx, config, ensureBot } = deps;

  return {
    async blueprint(body) {
      const sub = String(body.subcommand || body.op || '').toLowerCase();
      if (sub === 'show') return this.blueprint_show(body);
      if (sub === 'cell') return this.blueprint_cell(body);
      if (sub === 'layer') return this.blueprint_layer(body);
      if (sub === 'materials') return this.blueprint_materials(body);
      if (sub === 'verify') return this.blueprint_verify(body);
      if (sub === 'adopt') return this.blueprint_adopt(body);
      if (sub === 'capture') return this.blueprint_capture(body);
      return fail('INVALID_ARGS', `Unknown blueprint subcommand: ${sub}`, { retry_safe: false });
    },

    async blueprint_show(body) {
      const r = resolveCtx(deps, body);
      if (r.err) return r.err;
      const { ctxPlan } = r;
      return ok({
        result: `Plan ${ctxPlan.planId}`,
        data: {
          plan_id: ctxPlan.planId,
          path: ctxPlan.path,
          footprint: ctxPlan.footprint,
          anchor: ctxPlan.anchor,
          stats: ctxPlan.plan.stats,
          cells: ctxPlan.plan.cells?.length,
          source: ctxPlan.plan.source,
        },
      });
    },

    async blueprint_cell(body) {
      const r = resolveCtx(deps, body);
      if (r.err) return r.err;
      const { ctxPlan } = r;
      let lx;
      let ly;
      let lz;
      if (body.local) {
        const parts = String(body.local).split(',').map(Number);
        [lx, ly, lz] = parts;
      } else if (body.x != null) {
        [lx, ly, lz] = worldToLocal(ctxPlan.anchor, ctxPlan.footprint, body.x, body.y, body.z);
      } else {
        return fail('INVALID_ARGS', 'Provide local x,y,z or world x y z', { retry_safe: false });
      }
      const key = `${lx},${ly},${lz}`;
      const cell = ctxPlan.cellsIndex.get(key);
      const expected = cell?.block || 'air';
      return ok({
        result: `Expected ${expected} at local ${lx},${ly},${lz}`,
        data: { local: [lx, ly, lz], expected, cell: cell || null },
      });
    },

    async blueprint_layer(body) {
      const r = resolveCtx(deps, body);
      if (r.err) return r.err;
      const { ctxPlan } = r;
      const y = Number(body.y ?? body.level);
      if (!Number.isFinite(y)) {
        return fail('INVALID_ARGS', 'layer requires --y (local Y)', { retry_safe: false });
      }
      const cells = (ctxPlan.plan.cells || []).filter((c) => c.local[1] === y);
      return ok({
        result: `Layer Y=${y}: ${cells.length} cells`,
        data: { layer_y: y, cells },
      });
    },

    async blueprint_materials(body) {
      const r = resolveCtx(deps, body);
      if (r.err) return r.err;
      return ok({
        result: 'materials_planned',
        data: { materials_planned: r.ctxPlan.plan.materials_planned || [] },
      });
    },

    async blueprint_verify(body) {
      const b = ensureBot();
      const r = resolveCtx(deps, body);
      if (r.err) return r.err;
      const phase = parsePhase(body);
      const limit = Math.min(Number(body.limit) || BLUEPRINT_LIMITS.verifyMaxCellsPerCall, BLUEPRINT_LIMITS.verifyMaxCellsPerCall);
      const result = verifyPlan(
        r.ctxPlan,
        (x, y, z) => {
          const blk = b.blockAt(new Vec3(x, y, z));
          return blk?.name || 'air';
        },
        phase,
      );
      const sample = result.mismatches.slice(0, Number(body.sample) || 20);
      return ok({
        result: `verify: ok=${result.summary.ok} missing=${result.summary.missing} wrong=${result.summary.wrong} extra=${result.summary.extra}`,
        data: {
          blueprint_verify: true,
          summary: result.summary,
          mismatches: sample,
          truncated: result.truncated,
          next_hint: result.next_hint,
        },
      });
    },

    async blueprint_adopt(body) {
      if (!canMutatePlan(config) && !body.allow_plan_mutation) {
        return fail('POLICY_DENY', 'Blueprint adopt requires HERMES_BLUEPRINT_MUTATORS', { retry_safe: false });
      }
      const b = ensureBot();
      const r = resolveCtx(deps, body);
      if (r.err) return r.err;
      const x = Number(body.x);
      const y = Number(body.y);
      const z = Number(body.z);
      if (![x, y, z].every(Number.isFinite)) {
        return fail('INVALID_ARGS', 'adopt requires --at X Y Z', { retry_safe: false });
      }
      const blk = b.blockAt(new Vec3(x, y, z));
      const blockName = blk?.name || 'air';
      const lock = acquirePlanWriteLock(r.dataDir);
      if (!lock.ok) {
        return fail('WRITE_LOCKED', 'Plan write lock held', { retry_safe: true });
      }
      try {
        const plan = { ...r.ctxPlan.plan, cells: [...(r.ctxPlan.plan.cells || [])] };
        const { local, air } = adoptWorldCell(plan, r.ctxPlan.footprint, r.ctxPlan.anchor, x, y, z, blockName);
        plan.history = [...(plan.history || []), {
          at: new Date().toISOString(),
          actor: config.mc.username,
          action: 'adopted',
          cells: [[x, y, z]],
          note: body.note || null,
        }];
        writePlanAtomic(r.ctxPlan.path, plan);
        return ok({
          result: air ? 'Removed cell (expected air)' : `Adopted ${blockName}`,
          data: { local, block: air ? 'air' : blockName },
        });
      } finally {
        releasePlanWriteLock(lock.lockPath);
      }
    },

    async blueprint_capture(body) {
      if (!canMutatePlan(config) && !body.allow_plan_mutation) {
        return fail('POLICY_DENY', 'Blueprint capture requires HERMES_BLUEPRINT_MUTATORS', { retry_safe: false });
      }
      const b = ensureBot();
      const dataDir = dataDirFromCtx(ctx);
      const planId = String(body.plan_id || '').toLowerCase();
      if (!planId) {
        return fail('INVALID_ARGS', 'capture requires plan_id', { retry_safe: false });
      }
      const outPath = planFilePath(dataDir, planId);
      const fs = await import('node:fs');
      if (fs.existsSync(outPath) && !body.force) {
        return fail('INVALID_ARGS', 'Plan exists; pass force to overwrite', { retry_safe: false });
      }

      const regions = ctx.runtime?.regions?.list?.() || [];
      const regionRef = body.region;
      let cells = [];
      let regionId = null;
      let anchor = null;
      let captureRegion = null;

      if (regionRef) {
        const t = parsePlanIdFromTarget(regionRef);
        if (t.kind !== 'region') {
          return fail('INVALID_ARGS', 'capture --region expects :id:', { retry_safe: false });
        }
        regionId = t.regionId;
        const region = regions.find((rg) => rg.id === regionId);
        if (!region) return fail('INVALID_ARGS', 'Region not found', { retry_safe: false });
        captureRegion = region;
        const radius = region.shape?.radius ?? 16;
        if (radius > BLUEPRINT_LIMITS.captureMaxRegionRadius) {
          return fail('BLUEPRINT_SIZE_EXCEEDED', `Region radius ${radius} exceeds capture max`, { retry_safe: false });
        }
        const ax = region.anchor.x;
        const ay = region.anchor.y;
        const az = region.anchor.z;
        const yMin = region.shape?.y_min ?? ay - 16;
        const yMax = region.shape?.y_max ?? ay + 16;
        for (let x = ax - radius; x <= ax + radius; x++) {
          for (let z = az - radius; z <= az + radius; z++) {
            for (let y = yMin; y <= yMax; y++) {
              if (!containsPoint(region.shape, region.anchor, x, y, z)) continue;
              const blk = b.blockAt(new Vec3(x, y, z));
              const name = blk?.name;
              if (!name || isAirBlockName(name)) continue;
              cells.push({ world: [x, y, z], block: name });
            }
          }
        }
        if (!cells.length) {
          return fail('BLUEPRINT_SIZE_EXCEEDED', 'No non-air blocks in region scan', { retry_safe: false });
        }
        const xs = cells.map((c) => c.world[0]);
        const ys = cells.map((c) => c.world[1]);
        const zs = cells.map((c) => c.world[2]);
        anchor = [Math.min(...xs), Math.min(...ys), Math.min(...zs)];
      } else {
        return fail('INVALID_ARGS', 'capture requires --region :id: (v1)', { retry_safe: false });
      }

      const planned = cells.map((c) => ({
        local: [c.world[0] - anchor[0], c.world[1] - anchor[1], c.world[2] - anchor[2]],
        block: c.block,
      }));
      const footprint = tightFootprintFromCells(planned);
      if (captureRegion && !body.allow_outside_region) {
        const outside = [];
        for (const c of planned) {
          const wx = anchor[0] + c.local[0];
          const wy = anchor[1] + c.local[1];
          const wz = anchor[2] + c.local[2];
          if (!containsPoint(captureRegion.shape, captureRegion.anchor, wx, wy, wz)) {
            outside.push([wx, wy, wz]);
            if (outside.length >= 5) break;
          }
        }
        if (outside.length) {
          return fail('FOOTPRINT_OUTSIDE_REGION', 'Tight footprint extends outside region shape', {
            retry_safe: false,
            observed_state: { sample: outside },
            next_action_hint: 'Enlarge region, use --corners (later), or --allow-outside-region',
          });
        }
      }
      const plan = {
        kind: 'construct',
        plan_id: planId,
        source: {
          type: 'captured',
          captured_from: {
            region_id: regionId,
            world: config.behaviors?.regionsWorld || 'world',
            by: config.mc.username,
            at: new Date().toISOString(),
          },
        },
        footprint,
        anchor: { coords: anchor, site: body.site || null },
        cells: planned,
        history: [{
          at: new Date().toISOString(),
          actor: config.mc.username,
          action: 'captured',
          region: regionId,
          count: planned.length,
        }],
      };

      const lock = acquirePlanWriteLock(dataDir);
      if (!lock.ok) return fail('WRITE_LOCKED', 'Plan write lock held', { retry_safe: true });
      try {
        writePlanAtomic(outPath, plan);
      } finally {
        releasePlanWriteLock(lock.lockPath);
      }

      return ok({
        result: `Captured ${planned.length} cells → ${planId}`,
        data: { plan_id: planId, path: outPath, cells: planned.length, anchor },
      });
    },

    async construct(body) {
      return fail('NOT_IMPLEMENTED', 'mc construct from blueprint ships after regions Phase 2c guided edit', {
        retry_safe: false,
        next_action_hint: 'Use mc blueprint verify and manual mc place until construct is enabled',
      });
    },

    async repair(body) {
      if (body.target || body.plan_id || body.region) {
        const r = resolveCtx(deps, body);
        if (r.err) return r.err;
        return fail('NOT_IMPLEMENTED', 'Blueprint-aware mc repair ships after regions Phase 2c', {
          retry_safe: false,
          next_action_hint: 'mc blueprint verify :region: then fix mismatches manually',
        });
      }
      return fail('NOT_IMPLEMENTED', 'mc repair not implemented', { retry_safe: false });
    },
  };
}
