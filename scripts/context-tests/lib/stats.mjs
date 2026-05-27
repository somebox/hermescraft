export function median(nums) {
  const a = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function stddev(nums) {
  const a = nums.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (a.length < 2) return 0;
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const v = a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length;
  return Math.sqrt(v);
}

/** Wilson score lower bound (95%, z=1.96) for pass rate */
export function wilsonLowerBound(successes, trials, z = 1.96) {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return Math.max(0, (center - margin) / denom);
}
