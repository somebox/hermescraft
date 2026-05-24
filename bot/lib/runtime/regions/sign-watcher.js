import { parseRegionSignText, regionRowFromSign, signHasRegionDirectives } from './sign-directives.js';
import { normalizeId } from './index.js';

const INSTALLED = Symbol('regionSignWatcherInstalled');

function readSignText(block) {
  if (!block) return '';
  const signBlock = block._signEntity || block.signEntity;
  if (signBlock?.text) {
    return Array.isArray(signBlock.text) ? signBlock.text.join('\n') : String(signBlock.text);
  }
  if (block.metadata?.Text) return String(block.metadata.Text);
  return '';
}

function isSignBlockName(name) {
  return typeof name === 'string' && name.includes('sign');
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {ReturnType<import('./index.js').createRegionStore>} store
 * @returns {{ scan: () => void, dispose: () => void }}
 */
export function setupRegionSignWatcher(bot, store) {
  const noop = { scan: () => {}, dispose: () => {} };
  if (!bot || !store) return noop;
  if (bot[INSTALLED]) return bot[INSTALLED];

  const handleSignBlock = (block, { removed }) => {
    if (!block || !isSignBlockName(block.name)) return;
    const pos = block.position;
    const bx = pos.x;
    const by = pos.y;
    const bz = pos.z;

    if (removed) {
      const at = store.at(bx, by, bz);
      for (const r of at) {
        if (r.status === 'active' && r.anchor?.x === bx && r.anchor?.y === by && r.anchor?.z === bz) {
          store.setStatus(r.id, 'orphaned');
        }
      }
      return;
    }

    const text = readSignText(block);
    const parsed = parseRegionSignText(text);
    if (!parsed.id && !signHasRegionDirectives(parsed)) return;

    const id = normalizeId(parsed.id || '');
    if (!id) return;

    const existing = store.get(id);
    const fromSign = regionRowFromSign({ ...parsed, id }, { x: bx, y: by, z: bz });

    if (existing) {
      store.upsert({
        ...existing,
        ...fromSign,
        status: 'active',
        anchor: fromSign.anchor,
        sites: { ...(existing.sites || {}), ...fromSign.sites },
      });
    } else if (signHasRegionDirectives(parsed) || parsed.id) {
      store.upsert(fromSign);
    }
  };

  const onBlockUpdate = (oldBlock, newBlock) => {
    if (oldBlock && isSignBlockName(oldBlock.name) && (!newBlock || newBlock.name === 'air')) {
      handleSignBlock(oldBlock, { removed: true });
    }
    if (newBlock && isSignBlockName(newBlock.name)) {
      handleSignBlock(newBlock, { removed: false });
    }
  };

  bot.on('blockUpdate', onBlockUpdate);

  const scanLoadedSigns = () => {
    try {
      const positions = bot.findBlocks?.({
        matching: (b) => isSignBlockName(b.name),
        maxDistance: 128,
        count: 200,
      });
      if (!Array.isArray(positions)) return;
      for (const p of positions) {
        const block = bot.blockAt(p);
        if (block) handleSignBlock(block, { removed: false });
      }
    } catch {
      /* ignore scan errors in partial mocks */
    }
  };

  bot.once('spawn', () => {
    setTimeout(scanLoadedSigns, 2000);
  });

  const api = {
    scan: scanLoadedSigns,
    dispose: () => {
      bot.removeListener('blockUpdate', onBlockUpdate);
      delete bot[INSTALLED];
    },
  };
  bot[INSTALLED] = api;
  return api;
}

export { readSignText, isSignBlockName };
