/**
 * Thin registry around server action handlers (named async functions).
 * Keeps lookup/list stable while handlers migrate into domain modules.
 *
 * @param {Record<string, unknown>} handlerMap
 * @param {Record<string, unknown>} [metaByName]
 */
export function createActionRegistry(handlerMap, metaByName = {}) {
  /** @returns {string[]} */
  function names() {
    return Object.keys(handlerMap)
      .filter((k) => typeof handlerMap[k] === 'function')
      .sort();
  }

  return {
    names,
    /** @param {string} name */
    has(name) {
      return typeof handlerMap[name] === 'function';
    },
    /** @param {string} name */
    get(name) {
      return handlerMap[name];
    },
    /** @param {string} name */
    meta(name) {
      return metaByName[name];
    },
  };
}
