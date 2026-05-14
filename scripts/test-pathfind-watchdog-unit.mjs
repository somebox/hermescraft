#!/usr/bin/env node
/**
 * test-pathfind-watchdog-unit.mjs — F50.4 verification (no bot needed).
 *
 * Drives `pathfindWithProgressWatchdog` against a mock mineflayer bot whose
 * position we tick by hand. Cheap, deterministic, no rcon, no live server.
 *
 * Scenarios:
 *   A — Bot never moves at all → NoProgressError after windowMs.
 *       (Strictly, the watchdog ARMS only after the bot has crossed the
 *        initial-motion threshold. Without motion the wallclock cap fires
 *        first — we set cap > windowMs and *bump* once to arm it.)
 *   B — Bot moves continuously → pathfinder's resolved value comes through.
 *   C — Bot moves for 1s then freezes → NoProgressError, after grace.
 *   D — Pathfinder rejects with a normal error → that error propagates.
 *   E — Wallclock cap fires when bot stalls but never armed the watchdog.
 */

import {
  pathfindWithProgressWatchdog,
  NoProgressError,
  OperationTimeoutError,
} from '../bot/lib/actions/_helpers.js';

function mockBot(startPos = { x: 0, y: 64, z: 0 }) {
  return {
    entity: { position: { ...startPos } },
    pathfinder: { setGoal: () => {} },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runScenario(name, fn) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const t0 = Date.now();
  try {
    const result = await fn();
    const dt = Date.now() - t0;
    if (result.passed) {
      console.log(`  → PASS (${dt}ms) ${result.note || ''}`);
    } else {
      console.log(`  → FAIL (${dt}ms) ${result.note || ''}`);
    }
    return result.passed;
  } catch (e) {
    const dt = Date.now() - t0;
    console.log(`  → FAIL (${dt}ms) threw: ${e?.message || e}`);
    return false;
  }
}

async function scenarioStalledFromStart() {
  // Wallclock cap will fire because bot never moves enough to arm watchdog.
  const bot = mockBot();
  let stallCalled = false;
  const promise = pathfindWithProgressWatchdog({
    bot,
    pathfinderGoto: () => new Promise(() => { /* never resolves */ }),
    onStall: () => { stallCalled = true; },
    opName: 'goto',
    capMs: 1500,
    windowMs: 600,
    minDelta: 0.3,
    minTotalMovement: 0.6,
    sampleMs: 100,
  });
  let err = null;
  try { await promise; } catch (e) { err = e; }
  return {
    passed: err instanceof OperationTimeoutError && stallCalled,
    note: `err=${err?.constructor?.name} stallCalled=${stallCalled}`,
  };
}

async function scenarioStallAfterInitialMove() {
  // Bump position past minTotalMovement, then freeze. Watchdog should arm
  // and trip after windowMs.
  const bot = mockBot();
  // Schedule the position bump 100ms in.
  setTimeout(() => { bot.entity.position.x = 1.0; }, 100);
  // After that, no further motion.

  let stallCalled = false;
  const promise = pathfindWithProgressWatchdog({
    bot,
    pathfinderGoto: () => new Promise(() => { /* never resolves */ }),
    onStall: () => { stallCalled = true; },
    opName: 'goto',
    capMs: 5000,
    windowMs: 600,
    minDelta: 0.3,
    minTotalMovement: 0.6,
    sampleMs: 100,
  });
  let err = null;
  const t0 = Date.now();
  try { await promise; } catch (e) { err = e; }
  const dt = Date.now() - t0;
  // Should have tripped on watchdog, well before the 5000ms cap.
  return {
    passed: err instanceof NoProgressError && stallCalled && dt < 2000,
    note: `err=${err?.constructor?.name} stallCalled=${stallCalled} dt=${dt}ms info=${JSON.stringify(err?.info || {})}`,
  };
}

async function scenarioContinuousMotionResolves() {
  // Bot moves smoothly until pathfinder resolves. Should NOT trip watchdog.
  const bot = mockBot();
  let cancel = false;
  const ticker = setInterval(() => {
    if (cancel) return;
    bot.entity.position.x += 0.5; // moves 5 blocks/sec
  }, 100);

  let stallCalled = false;
  const promise = pathfindWithProgressWatchdog({
    bot,
    pathfinderGoto: () => sleep(1200).then(() => ({ ok: true, arrived: true })),
    onStall: () => { stallCalled = true; },
    opName: 'goto',
    capMs: 5000,
    windowMs: 400,
    minDelta: 0.3,
    minTotalMovement: 0.6,
    sampleMs: 100,
  });
  let err = null, value = null;
  try { value = await promise; } catch (e) { err = e; }
  cancel = true;
  clearInterval(ticker);
  return {
    passed: !err && value?.ok === true && !stallCalled,
    note: `err=${err?.constructor?.name} value=${JSON.stringify(value)} stallCalled=${stallCalled}`,
  };
}

async function scenarioPathfinderRejects() {
  // Pathfinder rejects with a normal Error (e.g. "No path"). Should propagate.
  const bot = mockBot();
  const promise = pathfindWithProgressWatchdog({
    bot,
    pathfinderGoto: () => sleep(50).then(() => { throw new Error('No path to the goal!'); }),
    onStall: () => {},
    opName: 'goto',
    capMs: 5000,
    windowMs: 600,
    sampleMs: 100,
  });
  let err = null;
  try { await promise; } catch (e) { err = e; }
  return {
    passed: err instanceof Error && /No path/i.test(err.message) && !(err instanceof NoProgressError) && !(err instanceof OperationTimeoutError),
    note: `err.msg=${err?.message}`,
  };
}

async function scenarioMovementResetsWatchdog() {
  // Bot moves once, stalls for 300ms (< windowMs), moves again, stalls
  // again for 300ms. Total stall >600ms but no single stall >600ms ⇒ no trip.
  const bot = mockBot();
  setTimeout(() => { bot.entity.position.x = 1.0; }, 100);
  setTimeout(() => { bot.entity.position.x = 2.0; }, 500);
  setTimeout(() => { bot.entity.position.x = 3.0; }, 900);

  let stallCalled = false;
  const promise = pathfindWithProgressWatchdog({
    bot,
    pathfinderGoto: () => sleep(1300).then(() => ({ ok: true })),
    onStall: () => { stallCalled = true; },
    opName: 'goto',
    capMs: 5000,
    windowMs: 600,
    minDelta: 0.3,
    minTotalMovement: 0.6,
    sampleMs: 100,
  });
  let err = null, value = null;
  try { value = await promise; } catch (e) { err = e; }
  return {
    passed: !err && value?.ok === true && !stallCalled,
    note: `err=${err?.constructor?.name} stallCalled=${stallCalled}`,
  };
}

async function main() {
  const results = [
    ['A: stall-from-start (cap wins, watchdog unarmed)', await runScenario('A', scenarioStalledFromStart)],
    ['B: stall after initial motion (watchdog trips)', await runScenario('B', scenarioStallAfterInitialMove)],
    ['C: continuous motion (resolves cleanly)',         await runScenario('C', scenarioContinuousMotionResolves)],
    ['D: pathfinder rejects (error propagates)',         await runScenario('D', scenarioPathfinderRejects)],
    ['E: brief stalls reset window (no trip)',           await runScenario('E', scenarioMovementResetsWatchdog)],
  ];
  console.log('\n=== Summary ===');
  for (const [name, ok] of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  const allPassed = results.every(([, ok]) => ok);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
