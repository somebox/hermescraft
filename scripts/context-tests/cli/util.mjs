export function parseArgv(argv) {
  const positional = [];
  const flags = new Set();
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-q' || a === '--quiet') {
      flags.add('quiet');
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('-')) {
        opts[key] = next;
        i++;
      } else {
        flags.add(key);
      }
      continue;
    }
    if (a.startsWith('-') && a.length === 2) {
      flags.add(a.slice(1));
      continue;
    }
    positional.push(a);
  }
  return { positional, flags, opts };
}

export function isPiped() {
  return !process.stdout.isTTY;
}
