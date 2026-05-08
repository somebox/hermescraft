import { Vec3 } from 'vec3';

/**
 * ASCII map + verbal surroundings using Mineflayer `bot.blockAt` / entities.
 * @param {{ ensureBot: () => import('mineflayer').Bot; fmt: (v: unknown) => unknown; posObj: (pos?: import('vec3').Vec3) => { x: number; y: number; z: number } | null }} deps
 */
export function createSpatial(deps) {
  const { ensureBot, fmt, posObj } = deps;

  function getCardinal(dx, dz) {
    const angle = (Math.atan2(dx, -dz) * 180) / Math.PI;
    if (angle > -22.5 && angle <= 22.5) return 'N';
    if (angle > 22.5 && angle <= 67.5) return 'NE';
    if (angle > 67.5 && angle <= 112.5) return 'E';
    if (angle > 112.5 && angle <= 157.5) return 'SE';
    if (angle > 157.5 || angle <= -157.5) return 'S';
    if (angle > -157.5 && angle <= -112.5) return 'SW';
    if (angle > -112.5 && angle <= -67.5) return 'W';
    return 'NW';
  }

  function generateMap(radius = 16) {
    const b = ensureBot();
    const pos = b.entity.position;
    const mapSize = Math.min(radius, 24);
    const step = mapSize > 16 ? 2 : 1;
    const gridR = Math.floor(mapSize / step);

    const grid = [];
    const heightMap = [];
    for (let rz = -gridR; rz <= gridR; rz++) {
      const row = [];
      const hrow = [];
      for (let rx = -gridR; rx <= gridR; rx++) {
        const wx = Math.floor(pos.x) + rx * step;
        const wz = Math.floor(pos.z) + rz * step;
        let surfaceBlock = null;
        let surfaceY = 0;
        for (let dy = 8; dy >= -8; dy--) {
          const wy = Math.floor(pos.y) + dy;
          const block = b.blockAt(new Vec3(wx, wy, wz));
          if (block && block.name !== 'air' && block.name !== 'cave_air') {
            surfaceBlock = block;
            surfaceY = wy;
            break;
          }
        }
        row.push(surfaceBlock);
        hrow.push(surfaceY);
      }
      grid.push(row);
      heightMap.push(hrow);
    }

    function blockChar(block, _y) {
      if (!block) return ' ';
      const n = block.name;
      if (n === 'water' || n === 'flowing_water') return '~';
      if (n === 'lava' || n === 'flowing_lava') return '!';
      if (n.includes('log') || n.includes('wood')) return 'T';
      if (n.includes('leaves')) return '*';
      if (n.includes('ore')) return '$';
      if (n === 'sand' || n === 'sandstone') return '.';
      if (n === 'gravel') return ',';
      if (n === 'grass_block') return '.';
      if (n === 'dirt' || n === 'coarse_dirt') return '.';
      if (n.includes('stone') || n === 'cobblestone') return '#';
      if (n === 'deepslate' || n.includes('deepslate')) return '#';
      if (n.includes('plank') || n.includes('slab') || n.includes('stair')) return '=';
      if (n === 'crafting_table') return 'C';
      if (n === 'furnace' || n === 'blast_furnace') return 'F';
      if (n === 'chest' || n === 'barrel') return 'B';
      if (n.includes('door')) return 'D';
      if (n === 'torch' || n === 'wall_torch' || n === 'lantern') return 'i';
      if (n === 'snow' || n === 'snow_block') return 'o';
      if (n.includes('ice')) return '-';
      if (
        n.includes('flower') ||
        n.includes('tulip') ||
        n.includes('daisy') ||
        n === 'dandelion' ||
        n === 'poppy'
      )
        return '+';
      if (n === 'tall_grass' || n === 'short_grass' || n === 'fern') return '"';
      if (n === 'cactus') return 'I';
      if (n === 'sugar_cane' || n === 'bamboo') return '|';
      if (n === 'farmland' || n === 'wheat' || n.includes('crop')) return '%';
      if (n === 'bed' || n.includes('bed')) return 'b';
      return '.';
    }

    const entityMarkers = {};
    Object.values(b.entities).forEach((e) => {
      if (e === b.entity) return;
      const dx = Math.round((e.position.x - pos.x) / step);
      const dz = Math.round((e.position.z - pos.z) / step);
      if (Math.abs(dx) <= gridR && Math.abs(dz) <= gridR) {
        const key = `${dz + gridR},${dx + gridR}`;
        if (e.type === 'player' || e.username) {
          entityMarkers[key] = '@';
        } else if (
          e.name &&
          (e.name.includes('zombie') ||
            e.name.includes('skeleton') ||
            e.name.includes('creeper') ||
            e.name.includes('spider') ||
            e.name.includes('enderman'))
        ) {
          entityMarkers[key] = 'X';
        } else if (e.type === 'mob') {
          entityMarkers[key] = 'a';
        }
      }
    });

    const lines = [];
    lines.push(`     N`);
    lines.push(`     |`);

    for (let rz = 0; rz < grid.length; rz++) {
      let line = rz === gridR ? 'W -- ' : '     ';
      for (let rx = 0; rx < grid[rz].length; rx++) {
        if (rz === gridR && rx === gridR) {
          line += 'P';
        } else {
          const key = `${rz},${rx}`;
          line += entityMarkers[key]
            ? entityMarkers[key]
            : blockChar(grid[rz][rx], heightMap[rz][rx]);
        }
      }
      if (rz === gridR) line += ' -- E';
      lines.push(line);
    }

    lines.push(`     |`);
    lines.push(`     S`);

    const legend = [
      'P=you @=player X=hostile a=animal',
      'T=tree ~=water !=lava $=ore #=stone',
      'C=craft F=furnace B=chest D=door b=bed',
      '=wall/floor .=ground "=grass +=flower',
    ];

    const entityLabels = [];
    Object.values(b.entities).forEach((e) => {
      if (e === b.entity) return;
      const dist = e.position.distanceTo(pos);
      if (dist > mapSize) return;
      const dx = e.position.x - pos.x;
      const dz = e.position.z - pos.z;
      const dir = getCardinal(dx, dz);
      if (e.username) {
        entityLabels.push(`${e.username} (${dir}, ${fmt(dist)}m)`);
      } else if (e.name) {
        entityLabels.push(`${e.name} (${dir}, ${fmt(dist)}m)`);
      }
    });

    return {
      map: lines.join('\n'),
      legend: legend.join('\n'),
      entities_on_map: entityLabels.slice(0, 15),
      center: posObj(),
      radius: mapSize,
      scale: step > 1 ? `1 char = ${step} blocks` : '1 char = 1 block',
    };
  }

  function generateLookAround() {
    const b = ensureBot();
    const pos = b.entity.position;
    const parts = [];

    const time = b.time.timeOfDay;
    const phase =
      time < 3000
        ? 'early morning'
        : time < 6000
          ? 'morning'
          : time < 9000
            ? 'midday'
            : time < 12000
              ? 'afternoon'
              : time < 13500
                ? 'sunset'
                : time < 18000
                  ? 'evening'
                  : 'night';
    parts.push(`It's ${phase}${b.isRaining ? ', raining' : ''}.`);

    const biome = b.blockAt(pos)?.biome?.name || 'unknown';
    const ground = b.blockAt(pos.offset(0, -1, 0))?.name || 'unknown';
    parts.push(`Standing on ${ground} in ${biome.replace(/_/g, ' ')}.`);

    const y = Math.floor(pos.y);
    if (y > 90) parts.push(`High up (Y:${y}).`);
    else if (y < 50) parts.push(`Underground (Y:${y}).`);
    else parts.push(`Y:${y}.`);

    const directions = [
      { name: 'North', dx: 0, dz: -1 },
      { name: 'East', dx: 1, dz: 0 },
      { name: 'South', dx: 0, dz: 1 },
      { name: 'West', dx: -1, dz: 0 },
    ];

    for (const dir of directions) {
      let hasWater = false;
      let hasTrees = false;
      let hasStone = false;
      let hasBuilding = false;

      for (let dist = 2; dist <= 20; dist += 2) {
        const wx = Math.floor(pos.x) + dir.dx * dist;
        const wz = Math.floor(pos.z) + dir.dz * dist;

        for (let dy = -4; dy <= 10; dy++) {
          const block = b.blockAt(new Vec3(wx, Math.floor(pos.y) + dy, wz));
          if (!block || block.name === 'air') continue;
          if (block.name === 'water' || block.name === 'flowing_water') hasWater = true;
          if (block.name.includes('log')) hasTrees = true;
          if (
            block.name.includes('plank') ||
            block.name.includes('stair') ||
            block.name === 'cobblestone_wall'
          )
            hasBuilding = true;
          if (dy > 4 && block.name !== 'leaves' && block.name !== 'air') {
            /* terrainDelta unused — kept for parity with prior scanner */
          }
        }

        for (let sy = 20; sy >= -10; sy--) {
          const block = b.blockAt(new Vec3(wx, Math.floor(pos.y) + sy, wz));
          if (
            block &&
            block.name !== 'air' &&
            block.name !== 'cave_air' &&
            block.name !== 'leaves'
          ) {
            const surfaceY = Math.floor(pos.y) + sy;
            if (Math.abs(surfaceY - pos.y) > 5 && surfaceY > pos.y + 5) hasStone = true;
            break;
          }
        }
      }

      const desc = [];
      if (hasBuilding) desc.push('structures');
      if (hasTrees) desc.push('trees');
      if (hasWater) desc.push('water');
      if (hasStone) desc.push('high ground');
      parts.push(
        desc.length > 0 ? `${dir.name}: ${desc.join(', ')}` : `${dir.name}: open terrain`,
      );
    }

    const players = Object.values(b.entities)
      .filter((e) => e !== b.entity && e.username && e.position.distanceTo(pos) < 40)
      .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));

    if (players.length > 0) {
      const playerDescs = players.map((p) => {
        const dx = p.position.x - pos.x;
        const dz = p.position.z - pos.z;
        return `${p.username} ${getCardinal(dx, dz)} ${fmt(p.position.distanceTo(pos))}m`;
      });
      parts.push(`Players: ${playerDescs.join(', ')}`);
    }

    const threats = Object.values(b.entities)
      .filter((e) => {
        if (e === b.entity || e.type !== 'mob') return false;
        const hostile = [
          'zombie',
          'skeleton',
          'creeper',
          'spider',
          'witch',
          'enderman',
          'drowned',
          'phantom',
        ];
        return (
          hostile.some((h) => (e.name || '').includes(h)) && e.position.distanceTo(pos) < 20
        );
      })
      .sort((a, c) => a.position.distanceTo(pos) - c.position.distanceTo(pos));

    if (threats.length > 0) {
      const threatDescs = threats.slice(0, 5).map((t) => {
        const dx = t.position.x - pos.x;
        const dz = t.position.z - pos.z;
        return `${t.name} ${getCardinal(dx, dz)} ${fmt(t.position.distanceTo(pos))}m`;
      });
      parts.push(`⚠ THREATS: ${threatDescs.join(', ')}`);
    }

    const animals = Object.values(b.entities).filter((e) => {
      if (e === b.entity || e.type !== 'mob') return false;
      const passive = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey'];
      return passive.some((a) => (e.name || '').includes(a)) && e.position.distanceTo(pos) < 25;
    });

    if (animals.length > 0) {
      const animalCounts = {};
      animals.forEach((a) => {
        animalCounts[a.name] = (animalCounts[a.name] || 0) + 1;
      });
      const animalDesc = Object.entries(animalCounts)
        .map(([n, c]) => `${c}x${n}`)
        .join(', ');
      parts.push(`Animals nearby: ${animalDesc}`);
    }

    return {
      description: parts.join(' '),
      position: posObj(),
      biome: biome.replace(/_/g, ' '),
      time_phase: phase,
      light_level: b.blockAt(pos)?.light || 0,
    };
  }

  return { getCardinal, generateMap, generateLookAround };
}
