import { Vec3 } from 'vec3';
import { coord3 } from '../_args.js';
import { ok } from '../../shared/action-contract.js';

/**
 * @param {object} deps
 */
export function createLook({ ensureBot }) {
  return async function look(args) {
    const c = coord3(args);
    if (!c.ok) return c.response;
    const { x, y, z } = c;
    const b = ensureBot();
    await b.lookAt(new Vec3(x, y, z));
    return ok({ result: `Looking at ${x}, ${y}, ${z}` });
  };
}
