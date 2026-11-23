// workerLiveness.js — IS THE ROOM WORKER STILL THERE? iOS reclaims a Web Worker under memory pressure and leaves a dead
// handle that swallows every postMessage: rooms stop opening, sync stops, and nothing says why. Ping it; a missed reply
// within the grace means it is gone, and the owner restarts it. The vault page did this for its hosted worker first
// (vault-loader.js); the regular app's l1.js uses this module for its own (docs/convergence-review-2026-10-17.md).
//
// createLiveness({ ping(n), restart(), setTimeout, graceMs, isHidden }) → { tick(), pong(n) }
//   tick()  — send a ping (call it on an interval and when the page returns to the foreground); skipped while hidden
//   pong(n) — the worker answered ping n
// One restart per silence: a restart counts every ping sent so far as answered, so older pings' timers do not fire again.
export function createLiveness ({ ping, restart, setTimeout: st = globalThis.setTimeout, graceMs = 5000, isHidden = () => false }) {
  let sent = 0, answered = 0
  return {
    tick () {
      if (isHidden()) return
      const n = ++sent
      try { ping(n) } catch { /* a dead handle may throw; the timer below decides */ }
      st(() => { if (answered < n) { answered = sent; try { restart() } catch { /* the next tick tries again */ } } }, graceMs)
    },
    pong (n) { answered = Math.max(answered, n | 0) },
  }
}
