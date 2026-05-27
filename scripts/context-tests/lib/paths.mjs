import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CTX_ROOT = join(HERE, '..');
export const REPO_ROOT = join(CTX_ROOT, '..', '..');
export const DATA_DIR = join(REPO_ROOT, 'data', 'context-tests');
export const CONFIGS_DIR = join(CTX_ROOT, 'configs');
export const RUNS_DIR = join(CTX_ROOT, 'runs');
export const BENCHMARK_DIR = join(REPO_ROOT, 'scripts', 'benchmark');
