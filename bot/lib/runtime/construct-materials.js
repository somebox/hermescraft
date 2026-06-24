/**
 * Plan materials vs bot inventory (construct show / guided_edit_progress).
 */

/**
 * @param {Array<{ name: string, count: number }>|undefined} materialsForPhase
 * @param {Array<{ name: string, count?: number }>} inventoryItems
 * @returns {Array<{ name: string, need: number, have: number, count: number }>}
 */
export function computeMaterialsMissing(materialsForPhase, inventoryItems) {
  if (!materialsForPhase?.length) return [];
  /** @type {Record<string, number>} */
  const haveByName = {};
  for (const it of inventoryItems || []) {
    if (!it?.name) continue;
    haveByName[it.name] = (haveByName[it.name] || 0) + (Number(it.count) || 0);
  }
  const missing = [];
  for (const row of materialsForPhase) {
    const name = row?.name;
    const need = Number(row?.count) || 0;
    if (!name || need <= 0) continue;
    const have = haveByName[name] || 0;
    if (have < need) {
      missing.push({ name, need, have, count: need - have });
    }
  }
  return missing;
}
