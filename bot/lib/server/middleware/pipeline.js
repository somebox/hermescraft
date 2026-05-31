/**
 * Ordered middleware lists for the sync `dispatchAction` path.
 *
 * Pre-middleware runs before the action and may intercept with a structured
 * failure response. Each module exports `check(services, body, actionName,
 * meta) → { intercept: true, response } | { intercept: false }`.
 *
 * Post-middleware runs after the action returns and may replace the result.
 * Each module exports `apply(services, body, actionName, result, meta)
 * → newResult | undefined`. Returning `undefined` leaves the result
 * unchanged; returning a value replaces it (subsequent middleware sees the
 * replacement).
 *
 * `meta` is a per-request object the dispatcher creates; pre-middleware may
 * stash state in it (e.g. `announce.check` sets `meta.announceStartedAt`)
 * that post-middleware then reads.
 *
 * Order matters:
 *   pre: position-guard (cheap fail-fast) → place-repeat-guard (read state)
 *        → announce (side-effect chat, must run after intercepts)
 *   post: place-outcome (record into ring buffer) → announce (completion
 *        chat) → chat-banner (last so it sees the final result.result)
 *
 * Task mode (POST /task/<action>) does NOT run this pipeline — that's
 * preserved from pre-Phase-7 behaviour where /task didn't fire the F51.2
 * or F53.2 guards.
 */

import * as positionGuard from './position-guard.js';
import * as placeRepeatGuard from './place-repeat-guard.js';
import * as announce from './announce.js';
import * as chatBanner from './chat-banner.js';
import * as hintInjector from './hint-injector.js';

/** Each entry must expose `check(services, body, actionName, meta)`. */
export const syncPreMiddleware = Object.freeze([
  positionGuard,
  placeRepeatGuard,
  announce,
]);

/** Each entry must expose `apply(services, body, actionName, result, meta)`. */
export const syncPostMiddleware = Object.freeze([
  // place-repeat-guard does its post-action recording here. Wrapped so we
  // present a uniform `apply()` surface to the dispatcher even though the
  // module exports a more semantic `recordOutcome` name.
  {
    apply(services, body, actionName, result /* meta unused */) {
      placeRepeatGuard.recordOutcome(services, body, actionName, result);
      return undefined;
    },
  },
  announce,
  hintInjector,
  chatBanner,
]);
