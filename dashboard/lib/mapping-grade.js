/**
 * Read last mapping grader output written by establish-mapping-check.py.
 */

import fs from 'fs';
import path from 'path';

/**
 * @param {string} repoRoot
 */
export function loadLastMappingGrade(repoRoot) {
  const file = path.join(repoRoot, 'data', 'runtime', 'last-mapping-grade.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}
