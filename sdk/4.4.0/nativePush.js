// nativePush.js — NOTIFICATIONS INSIDE THE ANDROID APP (docs/android-notifications.md). Its WebView has no Notification, no
// PushManager and no push on a service worker registration. The app's shell exposes `window.WitbitzPush` (PushBridge.kt): FCM
// for delivery, and the app's OWN Web Push keys (p256dh, auth), so the server encrypts exactly as for a browser. Here the three
// missing pieces are supplied from it, so every existing path — the permission check, subscribeRobust (pushCore.js), the
// subscription's toJSON to the app frame, unsubscribe — runs unchanged. Outside the app (no bridge) this does nothing.
// The bridge's calls are synchronous (a @JavascriptInterface); the permission prompt and the token fetch block this page for
// the moment they take — the prompt covers the page anyway. The bridge is visible to EVERY frame of the WebView, so each call
// but permission() carries this launch's key, which the shell serves on the vault's own origin only (KEY_PATH, no CORS): the
// app this page frames, or any widget, cannot read it.
const b64 = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer }
const parse = (s) => { try { return JSON.parse(s || 'null') } catch { return null } }

/** Install the shims on `w` (the window) when the app's bridge is there. → whether it did. */
export const KEY_PATH = '/__witbitz/push-key'
export function installNativePush (w = globalThis, { fetch: f = w && w.fetch ? w.fetch.bind(w) : null } = {}) {
  const B = w && w.WitbitzPush
  if (!B || typeof B.subscribe !== 'function') return false
  let _key = null
  const key = () => (_key = _key || Promise.resolve().then(async () => { const r = f && await f(KEY_PATH, { cache: 'no-store' }); return r && r.ok ? (await r.text()).trim() : '' }).catch(() => ''))
  const perm = () => { try { const p = String(B.permission()); return p === 'granted' || p === 'denied' ? p : 'default' } catch { return 'default' } }
  const subOf = (j) => {
    if (!j || typeof j.endpoint !== 'string' || !j.keys) return null
    const keys = { p256dh: String(j.keys.p256dh), auth: String(j.keys.auth) }
    return {
      endpoint: j.endpoint, expirationTime: null, options: { userVisibleOnly: true, applicationServerKey: null },
      toJSON: () => ({ endpoint: j.endpoint, expirationTime: null, keys: { ...keys } }),
      getKey: (name) => (keys[name] ? b64(keys[name]) : null),
      unsubscribe: async () => { try { const ok = String(B.unsubscribe(await key())) === 'ok'; if (ok && _native) _native.sent.clear(); return ok } catch { return false } }, // the app forgot the Space keys too: send them again next time (the review)
    }
  }
  const pushManager = Object.freeze({
    getSubscription: async () => { const k = await key(); raiseRotated(k); return subOf(parse(B.subscription(k))) },
    subscribe: async () => {
      const j = parse(B.subscribe(await key()))
      if (!j || j.error) { const e = new Error('notifications: ' + ((j && j.error) || 'unavailable')); e.name = j && j.error === 'permission' ? 'NotAllowedError' : 'AbortError'; throw e }
      return subOf(j)
    },
    permissionState: async () => (perm() === 'default' ? 'prompt' : perm()),
  })
  // ALWAYS replaced inside the app: a WebView may expose its own Notification / PushManager that can never be granted or
  // subscribe (APK 29: the vault saw "denied" and never subscribed — the shim had kept the WebView's)
  const def = (name, value) => { try { Object.defineProperty(w, name, { configurable: true, writable: true, value }) } catch { w[name] = value } }
  def('PushManager', function PushManager () {})
  {
    def('Notification', class Notification {
      static get permission () { return perm() }
      static async requestPermission () { try { const p = String(B.requestPermission(await key())); return p === 'granted' || p === 'denied' ? p : 'default' } catch { return 'default' } }
    })
  }
  if (w.ServiceWorkerRegistration && w.ServiceWorkerRegistration.prototype) {
    const proto = w.ServiceWorkerRegistration.prototype
    Object.defineProperty(proto, 'pushManager', { configurable: true, get () { return pushManager } })
    // ── THE APP'S NOTIFICATIONS IN THE TRAY (docs/state-machines.md C#17 b): the app shows them itself (nm.notify), so every page
    //    path that reads reg.getNotifications() — the vault's trayQuery / trayClose, the close when a Space is opened — never saw
    //    them. They are merged in here, shaped like the worker's ({ tag, data: { room }, close() }), so those paths run unchanged.
    const orig = typeof proto.getNotifications === 'function' ? proto.getNotifications : null
    Object.defineProperty(proto, 'getNotifications', { configurable: true, writable: true, value: async function (opts) {
      let web = []
      try { web = orig ? (await orig.call(this, opts)) || [] : [] } catch { web = [] }
      let mine = []
      try { const k = await key(); const a = parse(B.shown(k)); mine = Array.isArray(a) ? a.filter((x) => x && typeof x.room === 'string' && x.room) : [] } catch { mine = [] }
      const tagOf = (room) => 'native-' + room
      const want = opts && typeof opts.tag === 'string' ? opts.tag : null
      return [...web, ...mine.filter((x) => !want || want === tagOf(x.room)).map((x) => ({
        tag: tagOf(x.room), data: { room: x.room, native: true },
        close: () => { key().then((k) => { try { B.close(k, x.room) } catch { /* */ } }).catch(() => {}) },
      }))]
    } })
  }
  // ── A TOKEN FCM REPLACED (S#16): its endpoint stays in every Space's subscriber list until FCM calls it dead — two notifications,
  //    the author's own phone tickled. Each look at the subscription raises the replaced endpoints (once while their drop runs);
  //    the vault files op pushdrop for them (dropRotatedEndpoints) and only then are they forgotten here.
  const raiseRotated = (k) => {
    try {
      if (typeof B.rotated !== 'function' || typeof w.dispatchEvent !== 'function') return
      const a = parse(B.rotated(k)); const fresh = Array.isArray(a) ? a.filter((e) => typeof e === 'string' && e && !_rotBusy.has(e)) : []
      if (!fresh.length) return
      for (const e of fresh) _rotBusy.add(e)
      const Ev = w.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null)
      if (Ev) w.dispatchEvent(new Ev('wb-native-push-rotated', { detail: { endpoints: fresh } }))
    } catch { /* the next look raises them again */ }
  }
  // ── A REGISTRATION WITHOUT A SERVICE WORKER (the Windows app refuses them — windows/attested-client/bridge.go): the page's push
  //    paths ask for a registration first (pushCore.js swRegBounded) and only then for its pushManager. Inside an app this one
  //    answers: the bridge's pushManager and getNotifications, active from the start, nothing to update or show.
  const getN = w.ServiceWorkerRegistration && w.ServiceWorkerRegistration.prototype && w.ServiceWorkerRegistration.prototype.getNotifications
  const reg = Object.freeze({
    active: Object.freeze({ state: 'activated', postMessage () {} }), installing: null, waiting: null,
    scope: (w.location && w.location.origin ? w.location.origin : '') + '/', pushManager,
    getNotifications: async (opts) => { try { return getN ? await getN.call(reg, opts) : [] } catch { return [] } },
    showNotification: async () => {}, update: async () => {}, unregister: async () => false,
  })
  _native = { B, key, sent: new Map(), reg }
  return true
}

/** Inside the Android or Windows app: a registration for the push paths when no service worker is registered; null elsewhere. */
export function nativeRegistration () { return _native ? _native.reg : null }

// ── PREVIEWS (phase 3): the vault hands the app each Space's notification key (NK — opens a preview and nothing else) exactly
//    when it keeps that key in the clear itself, and the "Show message preview" switch. Write-only bridge calls; no-ops
//    outside the app. Repeats of the same key are not sent again.
let _native = null
const _rotBusy = new Set() // replaced endpoints whose drop is under way (raiseRotated)
export function nativeNotifKey (room, nk) {
  const n = _native; if (!n || !room || !nk || n.sent.get(room) === nk) return
  n.sent.set(room, nk)
  n.key().then((k) => { try { if (String(n.B.setNotifKey(k, String(room), String(nk))) !== 'ok') n.sent.delete(room) } catch { n.sent.delete(room) } }).catch(() => n.sent.delete(room))
}
/** room null = every Space's key. */
export function nativeForgetNotifKey (room = null) {
  const n = _native; if (!n) return
  if (room) n.sent.delete(room); else n.sent.clear()
  n.key().then((k) => { try { n.B.forgetNotifKey(k, room ? String(room) : '') } catch { /* */ } }).catch(() => {})
}
export function nativePreviews (on) {
  const n = _native; if (!n) return
  n.key().then((k) => { try { n.B.setPreviews(k, !!on) } catch { /* */ } }).catch(() => {})
}
/** Sender-proof hashes only, shared with the web notification worker. Older shells safely ignore this. */
export function nativeBlockTokens (tokens) {
  const n = _native; if (!n || typeof n.B.setBlocks !== 'function') return
  const list = Array.isArray(tokens) ? tokens.filter((x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x)).slice(0, 5000) : []
  n.key().then((k) => { try { n.B.setBlocks(k, JSON.stringify(list)) } catch { /* next sync retries */ } }).catch(() => {})
}

if (typeof window !== 'undefined') installNativePush(window)

/** The page's viewing record { room, at } (viewingBeacon.js): the app shows nothing for the Space on screen (C#17 b). */
export function nativeViewing (room, at) {
  const n = _native; if (!n || typeof n.B.setViewing !== 'function') return
  n.key().then((k) => { try { n.B.setViewing(k, String(room || ''), Number(at) || Date.now()) } catch { /* */ } }).catch(() => {})
}
/** Take a replaced token's endpoints off every Space this account holds (op pushdrop — keyless; the room's next turn removes a
 *  subscription whose address hashes the same, agent/pushDrop.mjs). `post(body)` → { status }. The app forgets an endpoint only when
 *  every drop for it was filed; else the next look raises it again. → how many drops were filed. */
export async function dropRotatedEndpoints (endpoints, rooms, post) {
  const n = _native
  const eps = (Array.isArray(endpoints) ? endpoints : []).filter((e) => typeof e === 'string' && e)
  const rs = [...new Set((Array.isArray(rooms) ? rooms : []).filter((r) => typeof r === 'string' && r))]
  let filed = 0; const done = []
  for (const e of eps) {
    let all = true
    for (const room of rs) {
      let r = null; try { r = await post({ op: 'pushdrop', room, subscription: { endpoint: e } }) } catch { r = null }
      if (r && r.status === 200) filed++; else all = false
    }
    if (all) done.push(e)
    _rotBusy.delete(e)
  }
  if (n && done.length && typeof n.B.rotatedDone === 'function') { try { const k = await n.key(); n.B.rotatedDone(k, JSON.stringify(done)) } catch { /* */ } }
  return filed
}
