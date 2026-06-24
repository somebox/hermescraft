import { ok, fail } from '../../shared/action-contract.js';
import {
  getConstructContext,
  setConstructContext,
  worksetFromVerifyMismatches,
  constructScopingEnabled,
} from '../../runtime/construct-context.js';
import { clearConstructSession, runConstructBeginPipeline, buildGuidedEditProgress, runConstructEndGateCheck, resolvePhaseKey } from '../../runtime/construct-lifecycle.js';

function constructEnabled() {
  return constructScopingEnabled();
}

/**
 * @param {ReturnType<import('../blueprints/index.js').createBlueprintActions>} blueprintFns
 * @param {object} deps
 */
export function createConstructActions(deps, blueprintFns) {
  const { ctx, config, ensureBot } = deps;

  async function runVerify(body) {
    return blueprintFns.blueprint_verify(body);
  }

  return {
    async construct(body) {
      const op = String(body.subcommand || body.op || '').toLowerCase();
      if (op === 'begin') return this.construct_begin(body);
      if (op === 'show') return this.construct_show(body);
      if (op === 'end') return this.construct_end(body);
      if (!op) return this.construct_begin(body);
      return fail('INVALID_ARGS', `Unknown construct op: ${op}`, {
        retry_safe: false,
        next_action_hint: 'mc construct begin|show|end',
      });
    },

    async construct_begin(body) {
      if (!constructEnabled()) {
        return fail('FEATURE_DISABLED', 'Construct context is off (set HERMES_CONSTRUCT_CONTEXT=1)', {
          retry_safe: false,
          next_action_hint: 'Use mc blueprint verify and unscoped place/fill/dig until construct is enabled',
        });
      }
      const existing = getConstructContext(ctx);
      if (existing?.kind === 'construct') {
        return fail('CONSTRUCT_ALREADY_ACTIVE', `Construct session already active for plan ${existing.plan_id}`, {
          retry_safe: false,
          next_action_hint: 'mc construct end or mc task_context clear before a new begin',
          observed_state: { plan_id: existing.plan_id, phase: existing.phase },
        });
      }
      return runConstructBeginPipeline(deps, { ...body, mismatch_cap: body.mismatch_cap || 5000 }, blueprintFns);
    },

    async construct_show(body) {
      const session = getConstructContext(ctx);
      if (!session) {
        return fail('NOT_IN_CONSTRUCT', 'No active construct context', {
          retry_safe: false,
          next_action_hint: 'mc task_context set :worksite: --card <id> or mc construct begin :region:',
        });
      }
      const verifyRes = await runVerify({ ...body, target: body.target || session.target, ...session.phase });
      if (!verifyRes.ok) return verifyRes;
      const data = verifyRes.data || {};
      session.progress = data.summary || session.progress;
      const phaseKey = resolvePhaseKey(session.phase);
      session.workset_size = worksetFromVerifyMismatches(data.mismatches || [], { phase_id: phaseKey }).size;
      ctx.runtime._constructWorkset = worksetFromVerifyMismatches(
        data.mismatches || [],
        { phase_id: phaseKey },
      );
      setConstructContext(ctx, session);
      try {
        const b = ensureBot();
        const items = typeof b.inventory?.items === 'function' ? b.inventory.items() : [];
        session.materials_missing = computeMaterialsMissing(session.materials_for_phase, items);
        setConstructContext(ctx, session);
      } catch {
        /* inventory optional */
      }
      return ok({
        result: `Construct show ${session.plan_id}`,
        data: {
          construct_context: session,
          verify_summary: data.summary,
          sample_mismatches: (data.mismatches || []).slice(0, 12),
          guided_edit_progress: buildGuidedEditProgress(ctx),
        },
      });
    },

    async construct_end(body) {
      const session = getConstructContext(ctx);
      if (!session) {
        return fail('NOT_IN_CONSTRUCT', 'No active construct context to end', { retry_safe: true });
      }
      const gateCheck = runConstructEndGateCheck(deps, session, body);
      if (!gateCheck.ok) return gateCheck.response;
      clearConstructSession(ctx);
      return ok({
        result: `Construct context ended for ${session.plan_id}`,
        data: { ended: session, final_progress: session.progress },
      });
    },
  };
}

/** @param {Map<string, object>|undefined} map */
export function getActiveConstructWorkset(ctx) {
  return ctx?.runtime?._constructWorkset;
}
