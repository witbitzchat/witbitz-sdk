// vaultWorkerHost.js — ONE HOST FOR A VAULT'S ROOM-KEY WORKER (docs/vault-core-convergence-review.md, option C, C1).
// Our hosted vault (vault-loader.js) and the builders' vault (vault-core.js) each start the same l1-worker and each wrote
// its own liveness, restart and replay — and each had its own bug there: the core never pinged, so a worker iOS reclaimed
// hung every call (sync sweep 2026-10-18 #7); ours replayed too little, so attested rooms stayed dark until a relaunch
// (2026-11-08). Now both ask this module. It owns: making the worker (the CALLER's factory — ours pins the source,
// vcWorker.js), the heartbeat (workerLiveness.js, the same as the regular app's l1.js), the restart, and a REPLAY LIST
// each vault registers into: what a new worker must be told before anything else reaches it.
//
// It holds no key and decides nothing about trust: a replay step reads the caller's own state when it runs.
//
// createWorkerHost({ make, onMessage, onCurrent, onRestart, onRestarted, graceMs, beatMs, timers, doc }) → host
//   make()           → Worker; called synchronously (a network round trip in front of it races the heartbeat, vcWorker.js)
//   onMessage(ev, w) the worker's messages, except the heartbeat's `pong` (the host takes those)
//   onCurrent(w|null) the current worker changed (made, dropped) — the caller keeps its own handle in step
//   onRestart()      the heartbeat found the worker dead: fail what waits on it (before the new one exists)
//   onRestarted(w)   the new worker exists and its replay has been sent — tell whoever must hand back what only it held
// host.replay(name, step)  register `step(w)` (order = registration order; the same name replaces in place). A step
//                          that returns a promise holds the steps after it (the core awaits its enclave and open).
// host.ensure()            the worker; made and replayed when there is none. Synchronous.
// host.start()             replace the worker with a new one (no onRestart) and resolve once its replay is done
// host.restart()           what a missed pong does: onRestart, a new worker, its replay, onRestarted. No worker → nothing.
// host.drop()              terminate and forget it (a sign-out); nothing restarts until ensure()/start()
// host.tick()              send a ping now (the beat and the page's return to the foreground call it)
// host.worker              the current worker or null;  host.replays() the registered names, in order
import { createLiveness } from './workerLiveness.js'

export function createWorkerHost ({ make, onMessage = () => {}, onCurrent = () => {}, onRestart = () => {}, onRestarted = () => {}, graceMs = 5000, beatMs = 25000, timers = globalThis, doc = typeof document !== 'undefined' ? document : null } = {}) {
  if (typeof make !== 'function') throw new Error('createWorkerHost: make() is required')
  let worker = null
  let recover = false
  let started = Promise.resolve()
  const steps = []
  const set = (w) => { worker = w; try { onCurrent(w) } catch { /* the caller's mirror; never stops the host */ } }
  function runReplay (w) {
    let chain = null
    for (const { step } of steps) {
      if (chain) { chain = chain.then(() => (worker === w ? step(w) : undefined)); continue }
      let r
      try { r = step(w) } catch { r = undefined } // one step that throws never keeps the others from a new worker
      if (r && typeof r.then === 'function') chain = Promise.resolve(r)
    }
    return chain || Promise.resolve()
  }
  function make1 () {
    const w = make()
    set(w)
    recover = false
    w.onmessage = (ev) => {
      const m = (ev && ev.data) || {}
      if (m.t === 'pong') { live.pong(m.n); return } // the heartbeat's answer
      onMessage(ev, w)
    }
    started = runReplay(w)
    started.catch(() => { /* the caller awaits start(); a restart's replay that fails waits for the next beat */ })
    return w
  }
  const terminate = () => { const w = worker; set(null); try { if (w) w.terminate() } catch { /* already gone */ } }
  const live = createLiveness({
    ping: (n) => { if (worker) worker.postMessage({ t: 'ping', n }) },
    restart: () => host.restart(),
    setTimeout: (f, ms) => timers.setTimeout(f, ms),
    graceMs,
    isHidden: () => !!(doc && doc.hidden),
  })
  const host = {
    get worker () { return worker },
    replays: () => steps.map((s) => s.name),
    replay (name, step) {
      const at = steps.findIndex((s) => s.name === name)
      if (at >= 0) steps[at] = { name, step }; else steps.push({ name, step })
      return host
    },
    ensure () { return worker || make1() },
    async ready () {
      const current = worker
      await started
      if (!current || worker !== current) throw Object.assign(new Error('the room worker was replaced'), { code: 'worker_restarted' })
      return current
    },
    start () { terminate(); make1(); return started },
    restart () {
      if (!worker && !recover) return // dropped (signed out): nothing to bring back
      try { onRestart() } catch { /* */ }
      terminate()
      let w
      try { w = make1() } catch { recover = true; return } // the next beat tries again
      try { onRestarted(w) } catch { /* */ }
    },
    drop () { recover = false; terminate() },
    tick () { if (worker) live.tick(); else if (recover && !doc?.hidden) host.restart() },
    pong: (n) => live.pong(n),
  }
  try {
    if (doc && beatMs > 0) {
      timers.setInterval(() => host.tick(), beatMs)
      doc.addEventListener('visibilitychange', () => { if (!doc.hidden) host.tick() })
    }
  } catch { /* no timers */ }
  return host
}

/** Each frame owns at most one holder per room on each worker generation. */
export function workerStreams() {
  const sent = new WeakMap()
  return (worker, room, open) => {
    if (!worker || !room) return
    if (!sent.has(worker)) sent.set(worker, new Set())
    const rooms = sent.get(worker)
    if (open && !rooms.has(room)) {
      worker.postMessage(open)
      rooms.add(room)
    } else if (!open && rooms.has(room)) {
      worker.postMessage({ t: 'streamClose', room })
      rooms.delete(room)
    }
  }
}
