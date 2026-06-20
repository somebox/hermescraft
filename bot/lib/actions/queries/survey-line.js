/**
 * mc survey_line <x1> <z1> <x2> <z2> [width=3] [--diff] [--y-hint Y]
 *   — adaptive-road-planning §7.2.
 *
 * The field workhorse. Scans the column under each cell along the line +
 * its path-width swath + one shoulder block per side, hands the result
 * to the K1 walk-classify kernel, and returns the RLE runs + deficits +
 * literal fix commands in a `roadplan ingest`-ready JSON envelope.
 *
 * Output size is O(terrain features), never O(blocks). The actual block
 * stack stays in the kernel; the envelope only carries runs, deficits,
 * deltas, and the per-deficit fix command lines that the planner pipes
 * into card bodies (§6.5).
 *
 * Read-only as far as the world is concerned. The verb DOES append one
 * line to data/runtime/roadplan/surveys.jsonl per call (the diff log)
 * — that side-log is single-writer (this verb), append-only, and never
 * read by any other action; same pattern as `mc feedback`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { classifyLine, diffRuns } from '../../shared/walk-classify.js';
import { getWalkabilitySpec } from '../../shared/walkability-spec.js';
import { ok, fail } from '../../shared/action-contract.js';

const SURVEY_LINE_MAX_LENGTH = 96;
const SURVEYS_LOG = 'data/runtime/roadplan/surveys.jsonl';
const SCAN_ABOVE = 16;   // blocks above y_hint we look for canopy
const SCAN_BELOW_PAD = 2; // blocks past no_floor_min_depth so K1 sees the gap floor

function lineCells(a, b) {
  let [x, z] = a, [x1, z1] = b;
  const dx = Math.abs(x1 - x), dz = Math.abs(z1 - z);
  const sx = x < x1 ? 1 : -1, sz = z < z1 ? 1 : -1;
  let err = dx - dz;
  const out = [[x, z]];
  while (x !== x1 || z !== z1) {
    const e2 = 2 * err;
    if (e2 > -dz) { err -= dz; x += sx; }
    if (e2 < dx) { err += dx; z += sz; }
    out.push([x, z]);
  }
  return out;
}

function swathCells(line, half, shoulder) {
  // Path-width-perpendicular fan: half + shoulder cells off each side.
  const axisX = Math.abs(line.to[0] - line.from[0])
              >= Math.abs(line.to[1] - line.from[1]);
  const offsetTotal = half + shoulder;
  const cells = new Map(); // key "x,z" → [x,z]
  for (const [x, z] of lineCells(line.from, line.to)) {
    for (let o = -offsetTotal; o <= offsetTotal; o++) {
      const sx = axisX ? x : x + o;
      const sz = axisX ? z + o : z;
      cells.set(`${sx},${sz}`, [sx, sz]);
    }
  }
  return [...cells.values()];
}

/**
 * Scan one column into the [[y, name], ...] shape K1 consumes.
 *
 * Returns { blocks, anyLoaded } so callers can detect unloaded chunks.
 * Air is implicit — we only record solids, fluids, vegetation.
 */
export function scanColumn(b, x, z, { yLo, yHi }) {
  const blocks = [];
  let anyLoaded = false;
  for (let y = yLo; y <= yHi; y++) {
    const blk = b.blockAt(new Vec3(x, y, z));
    if (!blk) continue;
    anyLoaded = true;
    if (blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air') continue;
    blocks.push([y, blk.name]);
  }
  return { blocks, anyLoaded };
}

function fixCommandsFor(deficits) {
  const out = [];
  for (const d of deficits) {
    if (d.kind === 'tree') {
      // Registry form is `mc fell_tree X Z [y_hint=Y]` — emitting base_y as the
      // 2nd positional silently mis-parsed it as Z (broken fix command).
      out.push(`mc fell_tree ${d.at[0]} ${d.at[1]} y_hint=${d.base_y}`);
    } else if (d.kind === 'water' || d.kind === 'gap') {
      // bridge-fill: level the span at the line's elevation. Caller fills in y.
      out.push(
        `mc level ${d.from[0]} <deck-y> ${d.from[1]} ${d.to[0]} <deck-y> ${d.to[1]} y=<deck-y>`,
      );
    } else if (d.kind === 'step') {
      out.push(`mc level ${d.at[0]} <step-y> ${d.at[1]} ${d.at[0]} <step-y> ${d.at[1]} y=<step-y>`);
    } else if (d.kind === 'drop') {
      out.push(`mc level ${d.at[0]} <fill-y> ${d.at[1]} ${d.at[0]} <fill-y> ${d.at[1]} y=<fill-y>`);
    } else if (d.kind === 'clearance') {
      out.push(`mc clear_strip ${d.from[0]} <y> ${d.from[1]} ${d.to[0]} <y> ${d.to[1]}`);
    } else if (d.kind === 'drop_hazard') {
      out.push(`mc place rail ${d.at[0]} <y> ${d.at[1]}   # or guard rail`);
    } else if (d.kind === 'forbidden_floor') {
      out.push(`mc dig ${d.at[0]} <y> ${d.at[1]}   # replace ${d.block}`);
    }
  }
  return out;
}

function loadPrevSurvey(repoRoot, fromTo) {
  const file = path.join(repoRoot, SURVEYS_LOG);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]);
      if (
        rec.from?.[0] === fromTo.from[0] && rec.from?.[1] === fromTo.from[1]
        && rec.to?.[0] === fromTo.to[0] && rec.to?.[1] === fromTo.to[1]
      ) {
        return rec;
      }
    } catch { /* skip malformed lines */ }
  }
  return null;
}

function appendSurvey(repoRoot, rec) {
  const file = path.join(repoRoot, SURVEYS_LOG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
}

/**
 * Build the K1 classification + envelope. Extracted so contract tests
 * can hit it without spinning up the action surface.
 */
export function classifyFromBot(b, body, spec) {
  const x1 = Math.floor(Number(body.x1));
  const z1 = Math.floor(Number(body.z1));
  const x2 = Math.floor(Number(body.x2));
  const z2 = Math.floor(Number(body.z2));
  for (const [k, v] of Object.entries({ x1, z1, x2, z2 })) {
    if (!Number.isFinite(v)) {
      return { ok: false, code: 'INVALID_COORD',
        message: `mc survey_line requires numeric ${k}` };
    }
  }
  const width = Math.max(1, Math.min(parseInt(String(body.width ?? spec.path_width), 10) || spec.path_width, 7));
  const shoulder = spec.shoulder_width;
  const half = Math.floor((width - 1) / 2);

  const yHintRaw = body.y_hint != null ? Number(body.y_hint)
    : Math.floor(b.entity.position.y - 1);
  const yHint = Math.round(yHintRaw);

  const center = lineCells([x1, z1], [x2, z2]);
  if (center.length > SURVEY_LINE_MAX_LENGTH) {
    return {
      ok: false, code: 'OUT_OF_RANGE',
      message: `mc survey_line: ${center.length} cells > ${SURVEY_LINE_MAX_LENGTH} cap. Split into shorter legs.`,
      observed_state: {
        cells: center.length, cap: SURVEY_LINE_MAX_LENGTH,
        from: [x1, z1], to: [x2, z2],
      },
    };
  }

  const line = { from: [x1, z1], to: [x2, z2], y_hint: yHint };
  const yLo = yHint - spec.no_floor_min_depth - SCAN_BELOW_PAD;
  const yHi = yHint + SCAN_ABOVE;

  const columns = [];
  const unloaded = [];
  for (const [sx, sz] of swathCells(line, half, shoulder)) {
    const { blocks, anyLoaded } = scanColumn(b, sx, sz, { yLo, yHi });
    if (!anyLoaded) {
      unloaded.push({ x: sx, z: sz });
      continue;
    }
    columns.push({ x: sx, z: sz, blocks });
  }

  if (unloaded.length > 0) {
    // Pick a midpoint of the unloaded run for the move hint.
    const mid = unloaded[Math.floor(unloaded.length / 2)];
    return {
      ok: false, code: 'UNLOADED_CHUNKS',
      message: `mc survey_line: ${unloaded.length} unloaded cells around (${mid.x},${mid.z}). Move closer first: mc move ${mid.x} ${yHint} ${mid.z}`,
      observed_state: {
        unloaded_n: unloaded.length, mid, from: [x1, z1], to: [x2, z2],
      },
      next_action_hint: `mc move ${mid.x} ${yHint} ${mid.z}`,
    };
  }

  const result = classifyLine({ line, columns, width }, spec);
  return {
    ok: true,
    line, width, yHint, result,
  };
}

export function createSurveyLineQueries({ ensureBot, repoRoot = process.cwd() }) {
  return {
    async survey_line(body) {
      const b = ensureBot();
      const spec = getWalkabilitySpec();
      const out = classifyFromBot(b, body, spec);
      if (!out.ok) {
        return fail(out.code, out.message, {
          observed_state: out.observed_state || {},
          ...(out.next_action_hint ? { next_action_hint: out.next_action_hint } : {}),
          retry_safe: out.code === 'UNLOADED_CHUNKS',
        });
      }

      const { line, width, yHint, result } = out;
      const fixes = fixCommandsFor(result.deficits);

      let diff = null;
      if (body.diff === true || body.diff === 'true' || body.diff === '1') {
        const prev = loadPrevSurvey(repoRoot, { from: line.from, to: line.to });
        if (prev?.classification) {
          diff = diffRuns(prev.classification, result);
        }
      }

      const rec = {
        ts: new Date().toISOString(),
        bot: b.username || null,
        from: line.from,
        to: line.to,
        width,
        y_hint: yHint,
        classification: result,
      };
      try { appendSurvey(repoRoot, rec); } catch (e) {
        // surveys log is best-effort; the envelope is what matters.
      }

      const verdict = result.walkable
        ? 'walkable'
        : `NOT walkable — ${result.deficits.length} deficit${result.deficits.length === 1 ? '' : 's'}`;
      const summary = result.runs
        .map((r) => `${r.kind} ${r.length}`).join(', ');
      const resultText = diff
        ? (diff.to_spec
            ? `to spec — ${diff.resolved.length} deficit${diff.resolved.length === 1 ? '' : 's'} resolved`
            : `NOT yet to spec — ${diff.added.length + diff.resolved.length + diff.changed.length} change${diff.changed.length === 1 ? '' : 's'}`)
        : `${verdict}; runs: ${summary}`;

      return ok({
        result: resultText,
        data: {
          from: line.from, to: line.to, width, y_hint: yHint,
          runs: result.runs,
          deficits: result.deficits,
          walkable: result.walkable,
          ...(diff ? { diff } : {}),
          fix_commands: fixes,
          envelope_schema: 'roadplan-survey/v1',
        },
      });
    },
  };
}
