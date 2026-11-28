// vaultCorePush.js — NOTIFICATIONS FROM A BUILDERS' VAULT (vault-core.js; docs/sdk-vault-mode.md § Notifications; the owner,
// 2026-11-13: "Do all including #5"). Loaded ONLY for a vault started with `push: true` — a vault without it never fetches this
// file — and on only once the PERSON says yes, in the vault's own card (wb.vault.showNotifications()).
//
// What it does is what our hosted vault does, with the same pieces: the browser's subscription with Witbitz's PUBLIC push key
// (config.js — the server signs every tickle with its private half), made the robust way (pushCore.js: the iOS lessons), then
// registered on each Space the vault holds through the vault's OWN key worker (`subscribe` / `unsubscribe` — never page ops).
// Witbitz's server already tickles every device a room lists, so nothing new runs there. The service worker is the kit's
// push-sw.js over the shared sw-notif-core.js: it opens the sealed preview with the room's notification key the key worker
// keeps in this origin's IndexedDB (generic text when the device's storage is protected), and routes a tap.
//
// The page learns { available, on } and, when a notification is tapped, which Space (`notifOpen`) — only one this vault holds.
import { swRegBounded, subscribeRobust } from './pushCore.js'
import { VAPID_PUBLIC_KEY } from './config.js'

export const PUSH_KEY = 'wbvault:push' // { on, endpoint, rooms: [the Spaces this device is listed on] } — this device's setting

/**
 * @param {object} o
 * @param {Storage} o.storage
 * @param {(room: string, sub: object, quiet: boolean) => Promise<object>} o.subscribe    through the vault's key worker
 * @param {(room: string, sub: object) => Promise<object>} o.unsubscribe
 * @param {(endpoint: string) => void} o.setSelf   the key worker's turns skip this device (its own posts do not tickle it)
 * @param {(room: string) => boolean} o.held
 * @param {(room: string) => void} o.onOpen      a tapped notification's Space (warm)
 * @param {string} [o.worker]  the service worker's path (default /push-sw.js, the kit's)
 */
export function createVaultPush ({ storage, subscribe, unsubscribe, setSelf, held, onOpen, onChange = null, worker = '/push-sw.js', nav = (typeof navigator !== 'undefined' ? navigator : null), N = (typeof Notification !== 'undefined' ? Notification : null) }) {
  const read = () => { try { const v = JSON.parse(storage.getItem(PUSH_KEY) || 'null'); return v && typeof v === 'object' ? v : { on: false } } catch { return { on: false } } }
  const save = (v) => { try { storage.setItem(PUSH_KEY, JSON.stringify(v)) } catch { /* a full store: on for this session */ } }
  let sub = null, chain = Promise.resolve()
  // KNOWN: start() has finished (a subscription loaded, or found off / unsupported). Until then this device's endpoint is NOT KNOWN —
  // the account service must not be told "none" (Codex sweep 2026-11-16 #2). `changed` runs after every change of it.
  let readyOk = null
  const ready = new Promise((r) => { readyOk = r })
  const changed = () => { readyOk(); try { if (typeof onChange === 'function') onChange() } catch { /* */ } }
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p } // one change of the list at a time
  const supported = () => !!(nav && nav.serviceWorker && N && typeof globalThis.PushManager !== 'undefined')
  const view = () => ({ available: true, on: !!read().on })
  const json = (s) => (s && typeof s.toJSON === 'function' ? s.toJSON() : s)
  // what an unsubscribe names: the live subscription, else the endpoint this device was listed under (the server drops by endpoint) —
  // a revoked permission or a missing worker must not leave every Space tickling a device that turned notifications off (review)
  const named = (st) => (sub ? json(sub) : st && st.endpoint ? { endpoint: st.endpoint } : null)
  // ⛔ A SPACE IS TAKEN OFF ITS LIST ONLY WHEN THE SERVER SAYS SO (review, 2026-11-13): a failed unsubscribe (offline) is kept in
  //   `off` and tried again at the next start — three starts, then it is let go (a Space whose key is gone can never be asked).
  //   → whether it is settled (taken off, or refused for good by the server).
  const takeOff = async (room, s) => { const a = s ? await unsubscribe(room, s).catch(() => null) : null; return !!(a && a.status >= 200 && a.status < 500) }
  const stillOff = (st, room) => { const off = (Array.isArray(st.off) ? st.off : []).filter((o) => o && o.room !== room); return [...off, { room, n: 0 }].slice(-200) }

  // THE LIST, kept in step: every Space held is listed, a Space dropped is taken off — the vault calls it after each change
  // `loud`: the first Space listed asks the server for its "Notifications are on" push — the person's proof it works, now
  function sync (rooms, { loud = false } = {}) {
    return serial(async () => {
      let st = read(); if (!st.on || !sub) return
      const want = new Set(rooms), had = new Set(Array.isArray(st.rooms) ? st.rooms : [])
      for (const r of want) if (!had.has(r)) { const a = await subscribe(r, json(sub), !loud).catch(() => null); if (a && a.status === 200) { had.add(r); loud = false } }
      for (const r of [...had]) if (!want.has(r)) { had.delete(r); if (!(await takeOff(r, json(sub)))) st = { ...st, off: stillOff(st, r) } }
      save({ ...read(), rooms: [...had], ...(st.off ? { off: st.off } : {}) })
    })
  }
  try { // a TAP on a warm vault: sw-notif-core focuses this window and posts the room
    nav && nav.serviceWorker && nav.serviceWorker.addEventListener('message', (e) => {
      const d = e && e.data
      if (d && d.ch === 'notif-open' && typeof d.room === 'string' && d.room && held(d.room)) onOpen(d.room)
    })
  } catch { /* no service workers here */ }
  return {
    view,
    sync,
    endpoint: () => (sub ? sub.endpoint : ''),
    /** Resolves once start() knows this device's endpoint (or that there is none). */
    ready,
    /** A Space about to be forgotten: off its list NOW, while the key worker still holds its key (after, the request has none). */
    drop (room) {
      return serial(async () => {
        const st = read(), rs = Array.isArray(st.rooms) ? st.rooms : []
        if (!rs.includes(room)) return
        const done = await takeOff(room, named(st))
        save({ ...read(), rooms: rs.filter((r) => r !== room), ...(done ? {} : { off: stillOff(read(), room) }) })
      })
    },
    /** At start: a device that turned notifications on keeps its subscription (and the worker, its current bytes). */
    async start (rooms) {
      try { return await this._start(rooms) } finally { changed() } // known now, whatever the outcome
    },
    /** @private */
    async _start (rooms) {
      if (!read().on) return this._retryOff() // turned off with a list it could not reach: try those once more
      if (!supported()) return
      if (N.permission !== 'granted') { await this.disable(); return } // revoked in the browser's settings: off, and off every list (review)
      await serial(async () => { // what an earlier unsubscribe could not reach, once more
        const st = read(), s = named(st), off = []
        for (const o of Array.isArray(st.off) ? st.off : []) if (o && !(await takeOff(o.room, s)) && o.n < 2) off.push({ room: o.room, n: o.n + 1 })
        save({ ...read(), off })
      })
      try { await nav.serviceWorker.register(worker); const r = await subscribeRobust(await swRegBounded({ path: worker, sw: nav.serviceWorker }), VAPID_PUBLIC_KEY); sub = r.sub } catch { sub = null }
      if (!sub) return
      setSelf(sub.endpoint)
      if (sub.endpoint !== read().endpoint) save({ ...read(), endpoint: sub.endpoint, rooms: [] }) // a new subscription: every Space lists it again
      return sync(rooms)
    },
    /** On — call it right after the person's click (the permission prompt needs that gesture). */
    async enable (rooms) {
      if (!supported()) throw Object.assign(new Error('vault: this browser cannot receive notifications here'), { code: 'push_unavailable' })
      const perm = N.permission === 'granted' ? 'granted' : await N.requestPermission()
      if (perm !== 'granted') throw Object.assign(new Error('vault: notifications were not allowed'), { code: 'push_denied' })
      await nav.serviceWorker.register(worker)
      const reg = await swRegBounded({ path: worker, sw: nav.serviceWorker })
      const r = await subscribeRobust(reg, VAPID_PUBLIC_KEY)
      if (!r.sub) throw Object.assign(new Error('vault: the push service did not answer — ' + r.err), { code: 'push_unavailable' })
      sub = r.sub; setSelf(sub.endpoint)
      save({ on: true, endpoint: sub.endpoint, rooms: [] })
      await sync(rooms, { loud: true })
      changed()
      return view()
    },
    /** Off: every Space takes this device off its list, then the subscription goes. */
    async disable () {
      await serial(async () => {
        const st = read(), s = named(st), off = []
        for (const r of [...(Array.isArray(st.rooms) ? st.rooms : []), ...(Array.isArray(st.off) ? st.off.map((o) => o && o.room) : [])].filter(Boolean)) if (!(await takeOff(r, s))) off.push({ room: r, n: 0 })
        try { if (sub) await sub.unsubscribe() } catch { /* the push service forgets it on its own */ }
        sub = null; setSelf('')
        save(off.length && st.endpoint ? { on: false, endpoint: st.endpoint, off } : { on: false }) // what could not be reached is tried again at the next start
      })
      changed()
      return view()
    },
    /** @private an OFF device's leftovers — the Spaces an earlier "off" could not reach (start() runs it while off) */
    async _retryOff () {
      await serial(async () => {
        const st = read(); if (st.on || !Array.isArray(st.off) || !st.off.length) return
        const off = []
        for (const o of st.off) if (o && !(await takeOff(o.room, named(st))) && o.n < 2) off.push({ room: o.room, n: o.n + 1 })
        save(off.length ? { ...st, off } : { on: false })
      })
      return view()
    },
  }
}
