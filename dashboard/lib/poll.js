/**
 * @param {number} ms
 * @param {RequestInit & { timeout?: number }} init
 */
export async function fetchWithTimeout(url, init = {}) {
  const timeout = init.timeout ?? 12_000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const { timeout: _, ...rest } = init;
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * @template T
 * @param {Promise<T>[]} promises
 * @returns {Promise<(T | { error: string })[]>}
 */
export async function settleAll(promises) {
  return Promise.all(
    promises.map((p) =>
      p.then(
        (v) => v,
        (e) => ({ error: e instanceof Error ? e.message : String(e) })
      )
    )
  );
}
