/**
 * Golden-capture harness (Track F, adaptive-road-planning §8.0.1).
 *
 * Runs `level_ground` DRY-RUN over each terrain fixture in
 * data/fixtures/terrain/*.json (mock world backed by the fixture's column
 * stacks) and writes data/fixtures/terrain/goldens/<name>.golden.json.
 *
 * The goldens record what the shipped classification oracle says about
 * fixture terrain — per-column survey (top_block_y, top_block) and
 * disposition (action, delta, hole_depth, fill_kind) against an explicit
 * target of line.y_hint. Python parity tests (K1/K2) compare against these
 * records, NOT against re-derived truth.
 *
 * Regenerate:  node bot/scripts/capture-terrain-goldens.js
 * Drift guard: bot/test/shared/terrain-goldens.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuildingTerrainPart } from '../lib/actions/building/terrain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const FIXTURE_DIR = path.join(REPO_ROOT, 'data', 'fixtures', 'terrain');
export const GOLDEN_DIR = path.join(FIXTURE_DIR, 'goldens');

export function loadFixtures() {
  return fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')));
}

function terrainMap(fixture) {
  const terrain = new Map();
  for (const col of fixture.columns) {
    for (const [y, name] of col.blocks) {
      terrain.set(`${col.x},${y},${col.z}`, name);
    }
  }
  return terrain;
}

function makeMockBot(terrain) {
  return {
    entity: { position: { x: 0, y: 70, z: 0, distanceTo: () => 0 } },
    game: { minY: -64, height: 384 },
    inventory: { items: () => [{ name: 'dirt' }, { name: 'cobblestone' }] },
    blockAt({ x, y, z }) {
      const name = terrain.get(`${x},${y},${z}`) || 'air';
      return { name, position: { x, y, z } };
    },
  };
}

function makePart(bot) {
  return createBuildingTerrainPart({
    ctx: { runtime: { regions: null, recentPlaces: [] } },
    config: { behaviors: {} },
    ensureBot: () => bot,
    sleep: async () => {},
    getActions: () => null,
  });
}

export async function captureGolden(fixture) {
  const part = makePart(makeMockBot(terrainMap(fixture)));
  const surfaceY = fixture.line.y_hint + 1;
  const xs = fixture.columns.map((c) => c.x);
  const zs = [...new Set(fixture.columns.map((c) => c.z))].sort((a, b) => a - b);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);

  // One call per z row keeps every call under the 16-column cap regardless
  // of fixture length; explicit surface_y keeps the target identical across
  // rows (no per-slice median drift).
  const columns = [];
  for (const z of zs) {
    const res = await part.level_ground({ x1: minX, z1: z, x2: maxX, z2: z, surface_y: surfaceY });
    if (!res.ok) {
      throw new Error(`${fixture.name} z=${z}: ${res.error.code} — ${res.error.message}`);
    }
    for (const c of res.data.columns) {
      columns.push({
        x: c.x,
        z: c.z,
        top_block_y: c.top_block_y,
        top_block: c.top_block,
        action: c.action,
        delta: c.delta,
        hole_depth: c.hole_depth ?? null,
        fill_kind: c.fill_kind ?? null,
      });
    }
  }
  columns.sort((a, b) => (a.x - b.x) || (a.z - b.z));
  return {
    schema: 'terrain-golden/v1',
    fixture: fixture.name,
    captured_with: {
      verb: 'level_ground',
      execute: false,
      surface_y: surfaceY,
      exclude_foliage: true,
      slice: 'per-z-row',
    },
    columns,
  };
}

export async function captureAll() {
  const goldens = {};
  for (const fixture of loadFixtures()) {
    goldens[fixture.name] = await captureGolden(fixture);
  }
  return goldens;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortKeysDeep(value[k])]));
  }
  return value;
}

async function main() {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  for (const [name, golden] of Object.entries(await captureAll())) {
    const p = path.join(GOLDEN_DIR, `${name}.golden.json`);
    fs.writeFileSync(p, `${JSON.stringify(sortKeysDeep(golden), null, 1)}\n`);
    console.log(p);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
