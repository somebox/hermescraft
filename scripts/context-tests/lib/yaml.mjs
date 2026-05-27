import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

const require = createRequire(import.meta.url);
const yamlPath = join(REPO_ROOT, 'bot', 'node_modules', 'yaml');
const { parse } = require(yamlPath);

export function parseYaml(text) {
  return parse(text);
}

export function readYamlFile(path) {
  return parseYaml(readFileSync(path, 'utf8'));
}
