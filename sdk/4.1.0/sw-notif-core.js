// sw-notif-core.js — the SHARED service-worker notification core, importScripts()'d by BOTH spaces/public/sw.js (the
// regular / L2-app SW) and spaces/public/vault-sw.js (the tenant VAULT SW, served AS /sw.js on the vault origin). It
// holds the parts that MUST behave identically in both apps, so a fix lands in ONE place instead of two separate files
// (a one-sided edit to this contract silently shipped to only one app — see docs/spaces-convergence-plan.md):
//   • wbxUb64            — base64url → bytes
//   • wbxIdbGet/wbxIdbSet — the IndexedDB kv helpers (a SW can't read localStorage, so the page mirrors keys into idb)
//   • wbxOpenEnvelope     — AES-GCM v1-envelope open, PARAMETERISED by the symmetric key: the regular SW passes the
//                           room mk (opens the ledger) OR the notif-only NK; the vault SW only ever passes NK.
//   • wbxWireNotifClick   — the notificationclick → focus + {ch:'notif-open'} relay (the "opens the wrong room on iOS"
//                           fix), parameterised by the cold-open URL and whether to stash the tap (vault only).
//
//   • wbxWirePush         — the `push` handler (since 2026-10-18): each worker passes only its own preview read (the
//                           regular app may open the ledger with mk; the vault holds NK alone) and its words
//   • wbxPollForTap       — the push's one network read, keeping the tap's prefetch
//   • the edge and the pins — wbxMatchesPin, wbxFetchShellOurs, wbxLiveBuildIs, wbxClean, wbxOfflinePage, the schedule
//
// What DOESN'T live here: each worker's CACHE LAYOUT. The regular app serves Official and Beta builds from folders
// (/b/<build>/), tops its cache up in slices and sweeps by channel; the vault serves only the tip, its precache verified
// against the pins in its own shell. Different by design — each worker keeps its install/activate/fetch.
//
// Classic (non-module) worker: everything attaches to `self` so the importing SW can call it after importScripts().
// build-vault.sh MUST copy this into the vault bundle — its importScripts closure check FATALs the build otherwise.
// Both SWs import it network-fresh as `/sw-notif-core.js?v=<build>`, so a new deploy always re-imports the new bytes.

self.wbxUb64 = (s) => { let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/'); t += '='.repeat((4 - (t.length % 4)) % 4); const b = atob(t); const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o }

// The page mirrors keys (mk:<room>, nk:<room>) and the tapped-room stash into IndexedDB precisely because a service
// worker cannot read localStorage.
// ★ BOUNDED (2026-10-02): on an iPhone a page frozen in the background mid-transaction holds this database until it
//   resumes, and a worker awaiting it waits with it — measured as every WARM tap in the tenant app (whose vault, with the
//   app framed, writes here constantly) lost while cold taps and a frame-less vault's warm taps arrived. No caller may hang
//   on storage: past IDB_WAIT a read answers null and a write answers false.
const IDB_WAIT = 2500
self.wbxIdbGet = (key) => new Promise((resolve) => {
  setTimeout(() => resolve(null), IDB_WAIT)
  try {
    const r = indexedDB.open('spaces', 1)
    r.onsuccess = () => { try { const rq = r.result.transaction('kv', 'readonly').objectStore('kv').get(key); rq.onsuccess = () => resolve(rq.result || null); rq.onerror = () => resolve(null) } catch { resolve(null) } }
    r.onerror = () => resolve(null)
    r.onupgradeneeded = () => { try { r.result.createObjectStore('kv') } catch { /* already there */ } }
  } catch { resolve(null) }
})
self.wbxIdbSet = (key, value) => new Promise((resolve) => {
  setTimeout(() => resolve(false), IDB_WAIT)
  try {
    const r = indexedDB.open('spaces', 1)
    r.onsuccess = () => { try { const rq = r.result.transaction('kv', 'readwrite').objectStore('kv').put(value, key); rq.onsuccess = () => resolve(true); rq.onerror = () => resolve(false) } catch { resolve(false) } }
    r.onerror = () => resolve(false)
    r.onupgradeneeded = () => { try { r.result.createObjectStore('kv') } catch { /* already there */ } }
  } catch { resolve(false) }
})

// THE WORKER'S OWN TRAIL (2026-10-01): every push it receives and every tap, written BEFORE anything can bail — a tap
// whose notification carries no room used to leave no trace at all, and the owner's trail came back empty on both halves
// with nothing to say which hand never ran. The vault reads it back with its own lines (tapTrailQuery). Device-only,
// last 20, no content: a room's first characters and what kind of push it was. `V` is the importing worker's build.
// ONE WRITER AT A TIME (2026-10-05): it is a read-modify-write, and two notes in the same Promise.all (a push's line beside
// another) each read the old list and the second write dropped the first line — a probe's `push test` vanished from the
// very trail that was meant to show it. Every note joins one chain; the line is stamped when it is ASKED for.
let _swTrailChain = Promise.resolve()
self.wbxNoteSw = (line) => {
  const entry = { at: Date.now(), b: (typeof V !== 'undefined' ? V : '?'), line: String(line).slice(0, 160) }
  _swTrailChain = _swTrailChain.then(async () => {
    try {
      const a = await self.wbxIdbGet('swTrail')
      const list = Array.isArray(a) ? a : []
      list.push(entry)
      while (list.length > 20) list.shift()
      await self.wbxIdbSet('swTrail', list)
    } catch { /* a diagnostic must never be the thing that breaks a push or a tap */ }
  })
  return _swTrailChain
}

// WHAT THE WORKER PUT ON SCREEN FROM A PUSH (the owner's decision, 2026-10-02, after a day of measurements: in the tenant
// app a tap on a push notification never reaches this worker while the app is running, though iOS does consume it — the
// notification leaves the list). So the vault reads this record on each foreground and compares it with what is still
// showing (vault-loader.js _inferVanished): EXACTLY ONE gone → that room was tapped. Bounded idb; {room, tag, at}, one
// entry per tag (a re-shown tag replaced its notification). A click this worker DOES receive forgets the entry.
// `id` is THIS showing's own mark (the worker puts it in the notification's data too): iOS keeps GHOSTS of long-gone
// notifications in getNotifications() — the owner's list held two stale 'space-test' entries for hours — so a fresh
// notification that shares a ghost's TAG would read as "still showing" and a consumed tap could never be inferred.
self.wbxNoteShown = async (room, tag, id) => {
  if (!room || !tag) return
  try {
    const a = await self.wbxIdbGet('notifShown')
    const list = (Array.isArray(a) ? a : []).filter((x) => x && x.tag !== tag)
    list.push({ room, tag, id: id || '', at: Date.now() })
    while (list.length > 12) list.shift()
    await self.wbxIdbSet('notifShown', list)
  } catch { /* */ }
}
self.wbxForgetShown = async (tag, id) => {
  if (!tag && !id) return
  const hit = (x) => x && ((id && x.id === id) || (tag && x.tag === tag))
  try { const a = await self.wbxIdbGet('notifShown'); if (Array.isArray(a) && a.some(hit)) await self.wbxIdbSet('notifShown', a.filter((x) => !hit(x))) } catch { /* */ }
}

// Minimal AES-GCM open for the v1 envelope — the same shape as e2ee.js, inlined because a service worker can't share the
// page's module graph. Iterates the envelope's recipient slots with the passed symmetric key (mk opens the room slot,
// NK opens the `notif` slot); returns the plaintext string or null (fail-closed — a wrong key opens nothing).
self.wbxOpenEnvelope = async (env, key) => {
  try {
    const ikm = await crypto.subtle.importKey('raw', self.wbxUb64(key), 'HKDF', false, ['deriveKey'])
    const wrapKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('memwrap') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
    for (const slot of Object.keys(env.recipients || {})) {
      const r = env.recipients[slot]
      if (!r || !r.iv || !r.w) continue
      try {
        const cek = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: self.wbxUb64(r.iv) }, wrapKey, self.wbxUb64(r.w))
        const k = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt'])
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: self.wbxUb64(env.iv) }, k, self.wbxUb64(env.ct))
        return new TextDecoder().decode(pt)
      } catch { /* wrong slot — try the next */ }
    }
  } catch { /* fall through to the generic notification */ }
  return null
}

// THE PREVIEW RIDES THE PUSH (the owner, 2026-10-08: "So let's do option 1" — WhatsApp's shape). The payload's `notif` is
// the newest entry's preview sealed under NK = HKDF(mk,'notif') (agent/notif.mjs); the page mirrored NK to idb as
// `nk:<room>` (notifKey.js). Opened HERE, before any fetch: an email-gated room refuses this worker's keyless read, so
// that path could only ever show the generic line. → { title, body } or null (no key, nothing carried, or it won't open).
// "Show message preview" (notifPreview.js): OFF on this device → no notification opens a preview, carried or fetched.
self.wbxPreviewAllowed = async () => { try { return (await self.wbxIdbGet('notifPreview')) !== false } catch { return true } }
self.wbxPreviewFromPush = async (room, notif) => {
  if (!room || typeof notif !== 'string' || !notif) return null
  try {
    const nk = await self.wbxIdbGet('nk:' + room)
    if (!nk) return null
    const o = JSON.parse((await self.wbxOpenEnvelope(JSON.parse(notif), nk)) || 'null')
    if (!o) return null
    const text = String(o.preview || '').replace(/[#*`>]/g, '').trim()
    return { title: String(o.who || '') || 'Someone', body: text ? text.slice(0, 140) : 'sent something', ...(typeof o.k === 'string' ? { k: o.k } : {}), ...(typeof o.u === 'string' ? { u: o.u } : {}) }
  } catch { return null }
}

// NO NOTIFICATION FROM A PERSON YOU BLOCKED (blocksPush.js; docs/report-and-block.md §4 (b)). The page leaves the blocked proofs as
// hashes under 'blocks:sw'; the opened preview names its writer (`k` the signing key, `u` a verified @username — agent/notif.mjs).
// wbxBlockToken MUST stay byte-identical to blocksPush.blockToken (a test asserts it).
self.wbxBlockToken = async (s) => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))))
  let b = ''; for (let i = 0; i < 16; i++) b += d[i].toString(16).padStart(2, '0')
  return b
}
self.wbxBlockedSender = async (room, d) => {
  try {
    if (!room || !d || (!d.k && !d.u)) return false
    const list = await self.wbxIdbGet('blocks:sw')
    if (!Array.isArray(list) || !list.length) return false
    const mine = await Promise.all([d.k ? self.wbxBlockToken('s:' + room + '|' + d.k) : null, d.u ? self.wbxBlockToken('u:' + String(d.u).toLowerCase()) : null])
    return mine.some((t) => t && list.includes(t))
  } catch { return false }
}

// "WAITING FOR YOUR APPROVAL" (docs/approval-reminders.md; agent/approvalRemind.mjs). The push for a waiting card or a waiting
// Code ask → { title, body, tag, data } to show, or null when the push is something else. A ROOM reminder is
// { room, remind: 1, card, notif } — the text sealed under the room's NK, as a message preview; a CODE reminder is
// { code: 1, n } — sealed by this device's computer under this device's own key (idb 'codeRemindKey', codeRemind.js).
// A reminder that will not open still says what it is; "Show message preview" off keeps the line generic.
self.wbxCodeRemindOpen = async (n) => {
  try {
    const raw = await self.wbxIdbGet('codeRemindKey')
    if (!raw || typeof n !== 'string') return null
    const b = self.wbxUb64(n)
    const k = await crypto.subtle.importKey('raw', self.wbxUb64(raw), { name: 'AES-GCM' }, false, ['decrypt'])
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: new TextEncoder().encode('witbitz-code-remind') }, k, b.slice(12))
    const o = JSON.parse(new TextDecoder().decode(pt))
    return o && typeof o === 'object' ? o : null
  } catch { return null }
}
self.wbxWaitingNotice = async (p) => {
  if (!p || typeof p !== 'object') return null
  const allowed = await self.wbxPreviewAllowed()
  const s = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n)
  if (p.remind && typeof p.room === 'string' && p.room) {
    const d = allowed ? await self.wbxPreviewFromPush(p.room, p.notif) : null
    return { title: 'Waiting for your approval', body: d && d.body && d.body !== 'sent something' ? d.body : 'Open the Space to approve or deny it.', tag: 'remind-' + p.room, data: { room: p.room, card: s(p.card, 40) } }
  }
  if (p.code) {
    const o = await self.wbxCodeRemindOpen(p.n)
    const code = o ? { computer: s(o.computer, 80), session: s(o.session, 120) } : {}
    const body = o && allowed ? [s(o.where, 60), s(o.what, 120)].filter(Boolean).join(' · ') : ''
    return { title: 'Code is waiting for your approval', body: body || 'Open Code to approve or deny it.', tag: 'code-remind-' + (code.session || 'any'), data: { code } }
  }
  return null
}

// Wire the notificationclick handler. cfg = { coldUrl(room) => string, stashTap: boolean }.
//   coldUrl  — where to launch when NO window is open (regular: /space?room=…; vault: /vault-loader?room=…).
//   stashTap — stash the tapped room to idb so the page's foreground re-check routes it even when iOS drops the
//              SW→client postMessage to a resuming PWA. Both apps set it: the vault reads it in vault-loader.js, the
//              regular app in notifTap.js (2026-10-01 — before that the regular app opened the LAST room on iOS).
self.wbxWireNotifClick = (cfg) => {
  const coldUrl = cfg.coldUrl
  const stashTap = !!cfg.stashTap
  // iOS may report a tap as a CLOSE (or close it unseen) — either way the trail should say so, not stay silent.
  self.addEventListener('notificationclose', (e) => { const d = (e.notification && e.notification.data) || {}; e.waitUntil(self.wbxNoteSw('close ' + (d.room ? String(d.room).slice(0, 10) : '(no room)'))) })
  self.addEventListener('notificationclick', (e) => {
    e.notification.close()
    const data = e.notification.data || {}
    const room = data.room || ''
    const isCall = !!data.call // §CALL: a "started a call" tickle — also open the room's meeting link
    const card = typeof data.card === 'string' ? data.card : '' // a "waiting for your approval" reminder: the card to show
    const code = data.code && typeof data.code === 'object' ? data.code : null // …or the Code session it waits in
    const intake = data.intake ? 1 : 0 // "New message for your assistant": no room on the wire — the app collects and opens where it went (space.js openIntakeTap)
    const invite = data.invite ? 1 : 0 // "New Space invite": no room on the wire either — the app reads its inbox and opens the Space it brought (space.js openInviteTap)
    const url = coldUrl(room)
    const label = data.diag ? 'tap on the TEST notification shown by the ' + data.diag : 'tap ' + (room ? room.slice(0, 10) : '— the notification carries NO room') + (isCall ? ' (call)' : '')
    e.waitUntil((async () => {
      // ★★ ROUTE FIRST, STORE AFTER. This handler used to write the tap record and its log line BEFORE focusing the app —
      //   and a write can wait on a database the frozen page still holds (see IDB_WAIT). Then nothing at all happened:
      //   no log line, no focus, no room. The tap is the user's; storage is bookkeeping.
      const t0 = Date.now()
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      let c = null, focused = false, posted = false
      if (all.length) {
        // A warm PWA (esp. iOS) has ONE window; navigate()/openWindow() would only RE-FOCUS it on its LAST room without
        // switching — the reported "opens the wrong room" bug. So focus it and POST the tickle's room: the first-party
        // app listens on navigator.serviceWorker ('notif-open' → openRoomInApp); the vault-loader relays it DOWN to the
        // app iframe (vcHandoff 'notifOpen'). A window already ON this room is just focused. `call` rides along so the
        // page shows its "Join call" affordance.
        c = all.find((w) => room && w.url.includes('room=' + room)) || all[0]
        try { if ('focus' in c) { await c.focus(); focused = true } } catch (err) { /* */ }
        if (room || code || intake || invite) { try { c.postMessage({ ch: 'notif-open', room, call: isCall ? 1 : 0, ...(card ? { card } : {}), ...(code ? { code } : {}), ...(intake ? { intake } : {}), ...(invite ? { invite } : {}) }); posted = true } catch (err) { /* */ } }
      } else if (self.clients.openWindow) {
        try { await self.clients.openWindow(url) } catch (err) { /* */ } // cold: no window → launch at the cold URL (the room); the page's "Join call" banner covers the call link
      }
      // …then the bookkeeping, each step bounded (wbxIdbGet/Set give up after IDB_WAIT).
      await self.wbxNoteSw(label + ' · routed in ' + (Date.now() - t0) + ' ms')
      await self.wbxForgetShown(e.notification.tag, e.notification.data && e.notification.data.id) // this tap was delivered — the vault must not infer it again from its absence
      // The stash: the loader re-reads it on every foreground, so a postMessage iOS dropped still routes.
      if ((room || code || intake || invite) && stashTap) await self.wbxIdbSet('notifTap', { room, at: Date.now(), call: isCall ? 1 : 0, ...(card ? { card } : {}), ...(code ? { code } : {}), ...(intake ? { intake } : {}), ...(invite ? { invite } : {}) })
      // THE TAP TRAIL (tapTrail.js): what the worker found and did, for the page to read back into the device log.
      if (room) await self.wbxIdbSet('notifTapSeen', all.length ? { at: Date.now(), room, windows: all.length, onRoom: !!(c && c.url.includes('room=' + room)), focused, posted } : { at: Date.now(), room, windows: 0, cold: true })
      // §CALL: open the meeting link LAST so the call is in the foreground and the PWA (now on the room) sits behind
      // it. The URL is read from DEVICE idb (mirrored by the page — 'zoom:<room>'), never from the push wire. Best
      // effort: iOS may decline an external openWindow from a SW, in which case the page's "Join call" banner covers it.
      if (all.length && isCall && room && self.clients.openWindow) { try { const z = await self.wbxIdbGet('zoom:' + room); if (z && /^https:\/\//i.test(z)) await self.clients.openWindow(z) } catch (err) { /* */ } }
    })())
  })
}

// IS THIS ROOM ON SCREEN? (2026-10-03 — "When I am in the chat … I still get the tickle".) A visible window AND the
// page's own `viewing` record ({ room, at }, spaces/public/viewingBeacon.js), believed for VIEWING_FRESH_MS. The record
// beats the window URL: a cold tap leaves the vault at ?room=<the tapped room> long after the user moved on. With no
// record at all (an older page), the URL decides, as before.
const VIEWING_FRESH_MS = 30_000
self.wbxViewing = async (room) => {
  if (!room) return false
  let list = []
  try { list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }) } catch { list = [] }
  const shown = list.filter((c) => c && (c.focused || c.visibilityState === 'visible'))
  if (!shown.length) return false
  const v = await self.wbxIdbGet('viewing')
  if (v && typeof v === 'object' && Number(v.at) > 0) return Date.now() - Number(v.at) < VIEWING_FRESH_MS && v.room === room
  return shown.some((c) => String(c.url || '').includes(room))
}
// iOS: a push must SHOW something (or the permission is revoked) and `silent` is ignored — so for the room on screen,
// show it and then close it at once. Closes every notification with that tag (iOS keeps same-tag ghosts).
self.wbxQuietIfViewing = async (room, tag) => {
  try {
    if (!(await self.wbxViewing(room))) return false
    const ns = await self.registration.getNotifications({ tag })
    for (const n of ns) { try { n.close() } catch { /* */ } }
    return true
  } catch { return false }
}

// THE NUMBER ON THE APP'S ICON (appBadge.js; the owner, 2026-10-25: iOS never badges an icon by itself). The page keeps the
// rooms it shows as unread under 'badge'; a push for a room NOT on screen adds it here, so the number rises while the app is
// closed, and the page's next count replaces the list. No badge API, or no permission: nothing happens.
// ⚑ A PROTECTED device keeps nothing under a room's name in the clear (idbSeal.js §NAMES), and this worker holds no key: there
// it leaves the number alone — the page, unlocked, sets it from its own count.
self.wbxBadgeAdd = async (room) => {
  try {
    if (await self.wbxIdbGet('protectedNames')) return 0
    const rec = await self.wbxIdbGet('badge')
    const rooms = rec && Array.isArray(rec.rooms) ? rec.rooms.filter((r) => typeof r === 'string') : []
    if (!rooms.includes(room) && rooms.length < 200) rooms.push(room)
    await self.wbxIdbSet('badge', { rooms, at: Date.now() })
    if (self.navigator && typeof self.navigator.setAppBadge === 'function') await self.navigator.setAppBadge(rooms.length)
    return rooms.length
  } catch { return 0 }
}

// ── THE PUSH HANDLER, ONCE (convergence review step 6, 2026-10-18) ───────────────────────────────────────────────────
// Until today each worker kept its own; they drifted (the vault marked every showing with an id against iOS's ghosts and
// noted calls and tests for tap inference, the regular app did not; the regular app silenced the room on screen, the
// vault only closed it). What stays per worker is what differs BY DESIGN — how a message's preview is read (the regular
// app may open the ledger with mk; the vault holds only NK) and the app's own words:
//   cfg = { describe(room) → { title, body } | null,  generic: { title, body },  testBody }
// ★ iOS REQUIRES a visible notification for every push (`userVisibleOnly`): every path ends in showNotification.
const WBX_ALERT_THROTTLE_MS = 120000 // at most one ALERTING notification per room per 2 minutes; sooner ones show silently
self.wbxWirePush = (cfg) => self.addEventListener('push', (e) => {
  let p = {}; try { p = (e.data && e.data.json && e.data.json()) || {} } catch { /* malformed → generic */ }
  if (!p || typeof p !== 'object') p = {}
  const room = typeof p.room === 'string' ? p.room : ''
  const sealedPreview = typeof p.notif === 'string' ? p.notif : ''
  const art = { icon: '/icon-192.png', badge: '/icon-192.png' }
  const idFor = (tag) => tag + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) // THIS showing's mark: ghosts share tags, never ids
  e.waitUntil((async () => {
    if (p.remind || p.code) { // "WAITING FOR YOUR APPROVAL" — a room's card or a Code ask (wbxWaitingNotice)
      await self.wbxNoteSw('push remind ' + (p.code ? 'code' : room.slice(0, 10)))
      const w = (await self.wbxWaitingNotice(p)) || { title: 'Waiting for your approval', body: 'Open the app to answer.', tag: 'remind', data: {} }
      return self.registration.showNotification(w.title, { body: w.body, tag: w.tag, data: { ...w.data, id: idFor(w.tag) }, ...art, renotify: true })
    }
    // A MESSAGE WAITS IN THE ACCOUNT'S INTAKE (agent/messageIntake.mjs wake list; the owner, 2026-11-09: no notification when Claude Code
    // wrote to the private lane). Content-free by construction: the box is sealed to the account's devices and nobody on the way knows
    // who sent it. The tap opens the app (no room: the message room is not one to show), which collects it into its Space.
    if (p.intake) {
      await self.wbxNoteSw('push intake')
      const id = idFor('intake'); await self.wbxNoteShown('', 'intake', id)
      return self.registration.showNotification('New message for your assistant', { body: cfg.intakeBody || 'An agent you let in (or Siri) sent your assistant a message. Open the app to read it.', tag: 'intake', data: { intake: 1, id }, ...art, renotify: true })
    }
    const kind = p.test ? 'test' : p.invite ? 'invite' : p.call ? 'call' : 'message'
    await self.wbxNoteSw('push ' + kind + ' ' + (room ? room.slice(0, 10) : '(no room)'))
    // The confirmation sent when someone turns notifications ON: unambiguous on purpose — a room's last message here
    // would look like a real one and confirm nothing.
    if (p.test) { const id = idFor('space-test'); await self.wbxNoteShown(room, 'space-test', id); return self.registration.showNotification('Notifications are on', { body: cfg.testBody, tag: 'space-test', data: { room, id }, ...art }) }
    // A content-free INVITE tickle: the box key is not here, so just ask them to open (the page polls the inbox).
    //   The tap says `invite` (2026-11-12, the owner: "After pressing it it doesn't open the new room"): the page reads its inbox and
    //   opens the Space the newest invite brought (inviteTap.js) — the worker still names none, it cannot.
    if (p.invite) { const id = idFor('space-invite'); return self.registration.showNotification('New Space invite', { body: 'Someone invited you to a Space — open to see it.', tag: 'space-invite', data: { invite: 1, id }, ...art }) }
    // §CALL: content-free {room, call:1}; the tap opens the room AND its meeting link (device idb, never the wire). Always alerts.
    if (p.call) { const tag = room ? 'call-' + room : 'call'; const id = idFor(tag); await self.wbxNoteShown(room, tag, id); return self.registration.showNotification('📞 Call started', { body: 'Someone started a video call — tap to join.', tag, data: { room, call: 1, id }, ...art, renotify: true }) }
    // THE NEWEST ENTRY THE PUSH CARRIED (2026-10-20; webPush.mjs payloadFor): filed as the room's prefetch, so the tap draws it
    // with no read — the only way in a room that requires sign-in, where this worker's own read is refused.
    const tailKept = room ? await self.wbxStoreCarriedTail(room, p.tail) : false
    // The preview the push CARRIED (sealed under NK) first; the worker's own read only when it did not — but that read
    // still runs for the tap's prefetch, after the notification is up (below).
    const allowed = await self.wbxPreviewAllowed() // "Show message preview" off → the line only
    const opened = room ? await self.wbxPreviewFromPush(room, sealedPreview) : null // opened even with previews off: it names its writer
    // A PERSON YOU BLOCKED: shown silently with the plain line and closed at once (iOS requires a showing) — no sound, no badge.
    if (opened && await self.wbxBlockedSender(room, opened)) {
      const tag = 'blocked-' + room, id = idFor(tag)
      await self.registration.showNotification(cfg.generic.title, { body: cfg.generic.body, tag, data: { room, id }, ...art, silent: true })
      try { for (const n of await self.registration.getNotifications({ tag })) n.close() } catch { /* */ }
      await self.wbxNoteSw('closed at once — from a person you blocked')
      return
    }
    const carried = allowed ? opened : null
    const fetched = carried || !room ? null : await cfg.describe(room)
    const d = allowed ? (carried || fetched) : null
    // ALERT or update quietly ("don't notify" is not an option on iOS — "don't buzz" is). Stamped only on an alert, or a
    // continuous conversation keeps pushing the window forward and never alerts again.
    const last = room ? Number(await self.wbxIdbGet('notifAt:' + room)) || 0 : 0
    const viewing = room ? await self.wbxViewing(room) : false
    const silent = viewing || (!!room && Date.now() - last < WBX_ALERT_THROTTLE_MS)
    if (!silent && room) await self.wbxIdbSet('notifAt:' + room, Date.now())
    const tag = room || 'space' // collapse repeats from the same room rather than stacking
    const id = idFor(tag)
    // Recorded for the page (strayPush.js: a room this device cannot open asks to be taken off its list) and for tap inference.
    await self.wbxNoteShown(room, tag, id)
    await self.registration.showNotification(d ? d.title : cfg.generic.title, { body: d ? d.body : cfg.generic.body, tag, data: { room, id }, ...art, silent, renotify: !silent })
    // …and iOS ignores `silent`: the room on screen is closed at once (it was shown, which is what iOS requires).
    if (viewing && await self.wbxQuietIfViewing(room, tag)) await self.wbxNoteSw('closed at once — the room is on screen')
    else if (room) await self.wbxBadgeAdd(room) // the number on the app's icon counts it until it is read (appBadge.js)
    // The push carried the preview, so describe() did not run: run it now for its PREFETCH — after the notification is up,
    // so a slow or refused fetch never delays or blanks what is shown.
    if (carried && room && !tailKept) { try { await cfg.describe(room) } catch { /* the tap's prefetch is best-effort */ } }
  })())
})

// PREFETCH FOR THE TAP (prefetchPoll.js), the one network read a push makes: ask since the room's last known position (the
// L1 worker keeps cnt:<room>) so the answer is the new entries only, keep it so the room's first poll after the tap is
// answered at once, and say what became of it in the worker trail. Returns the server's answer (its `notif` / `sealed`
// for the caller's preview) or null.
self.wbxPollForTap = async (endpoint, room) => {
  const cnt = await self.wbxIdbGet('cnt:' + room)
  let since = cnt && Number.isInteger(cnt.count) ? { sinceCount: cnt.count } : {}
  const ask1 = async (extra) => { const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'pollsealed', room, ...extra }) }); let b = null; try { b = await r.json() } catch { b = null } return { res: r, j: b } }
  // A CONFIDENTIAL room: the worker keeps no tier mark, so the first read goes to the regular tier, which answers it with the tier
  // said (agent/tierGuard.mjs — and none of the room's entries). Asked again where the room lives, once; every later ask goes there
  // (sync sweep 11-09: the tap's prefetch of a confidential room fetched nothing). Content-blind either way: no key rides.
  let encl = false
  const ask = async (extra) => { let a = await ask1(encl ? { ...extra, enclave: true } : extra); if (!encl && a.j && a.j.tier === 'enclave') { encl = true; a = await ask1({ ...extra, enclave: true }) } return a }
  // NO POSITION KNOWN (a protected device keeps none; a first push): ask the room's COUNT — a position past the end answers
  // with no entries and the total — then its last WBX_PREFETCH_TAIL, kept as a TAIL under a hash of the room
  // (prefetchPoll.js; 2026-10-20, the owner's phone waited 9 s for a tapped message). Content-blind, no server change.
  let tail = false, first = null
  if (since.sinceCount === undefined) {
    first = await ask({ sinceCount: 1e9 })
    if (first.res.ok && first.j && Number.isInteger(first.j.count)) { since = { sinceCount: Math.max(0, first.j.count - WBX_PREFETCH_TAIL) }; tail = true }
  }
  if (since.sinceCount === undefined) { await self.wbxNoteSw('prefetch ' + room.slice(0, 10) + ': no position known, and the room gave no count'); return (first && first.j) || null }
  const { res, j } = await ask(since)
  let pfNote = ''
  if (!res.ok) pfNote = 'server answered ' + res.status
  else if (!j || !j.changed) pfNote = 'nothing new since ' + since.sinceCount
  else if (typeof j.sealed !== 'string') pfNote = 'answer carried no sealed slice'
  else if (j.sealed.length > 400000) pfNote = 'too large to keep (' + Math.round(j.sealed.length / 1024) + ' KB)'
  else {
    const hashed = tail || !!(await self.wbxIdbGet('protectedNames')) // a protected device keeps nothing under a room's name
    const key = hashed ? await self.wbxPrefetchHashKey(room) : 'prefetch:' + room
    const { notif, ...rest } = j
    const ok = await self.wbxIdbSet(key, { at: Date.now(), sinceCount: since.sinceCount, ...(tail ? { tail: true } : {}), r: { status: res.status, ...rest } })
    try { new BroadcastChannel('wb-prefetch').postMessage({ room }) } catch { /* a closed channel: the worker looks on its next first poll */ }
    pfNote = !ok ? 'COULD NOT KEEP it' : (tail ? 'kept the last ' + (j.count - since.sinceCount) + ' of ' + j.count + ' (no position known)' : 'kept ' + (j.count - since.sinceCount) + ' new') + (hashed ? ', under a hash of the room' : '')
  }
  await self.wbxNoteSw('prefetch ' + room.slice(0, 10) + ': ' + pfNote)
  return j || null
}
// A carried { count, box } → the same TAIL record wbxPollForTap keeps, under the room's hash. → true when kept.
self.wbxStoreCarriedTail = async (room, t) => {
  if (!t || typeof t !== 'object' || !Number.isInteger(t.count) || t.count < 1 || typeof t.box !== 'string' || t.box.length > 4000) return false
  const from = t.count - 1
  const sealed = JSON.stringify({ v: 3, from, count: t.count, boxes: [t.box] })
  const ok = await self.wbxIdbSet(await self.wbxPrefetchHashKey(room), { at: Date.now(), sinceCount: from, tail: true, r: { status: 200, changed: true, count: t.count, from, sealed } })
  try { new BroadcastChannel('wb-prefetch').postMessage({ room }) } catch { /* the worker looks on its next first poll */ }
  await self.wbxNoteSw('prefetch ' + room.slice(0, 10) + ': ' + (ok ? 'the push carried the newest entry (' + t.count + ')' : 'COULD NOT KEEP the carried entry'))
  return !!ok
}
const WBX_PREFETCH_TAIL = 30 // ⇄ prefetchPoll.js PREFETCH_TAIL
// ⇄ prefetchPoll.js prefetchHashKey — the same key, or the L1 worker never finds a tail.
self.wbxPrefetchHashKey = async (room) => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wb-prefetch\n' + String(room || ''))))
  return 'prefetch:h:' + Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
}
// A one-line preview from an opened envelope's { who, preview } (Markdown marks stripped).
self.wbxOneLine = (s) => String(s || '').replace(/[#*`>]/g, '').trim()
self.wbxPreviewOf = (who, text) => { const t = self.wbxOneLine(text); return { title: String(who || '') || 'Someone', body: t ? t.slice(0, 140) : 'sent something' } }

// ── THE EDGE AND THE PINS, ONCE ──────────────────────────────────────────────────────────────────────────────────────
// §EDGE CONVERGENCE (the owner, 2026-10-06: "we can wait for the new version"): a Pages deploy reaches the edge over
// seconds, and an edge still on the previous build answers another build's bytes. Both workers wait it out, ~11 s.
self.wbxSleep = (ms) => new Promise((r) => setTimeout(r, ms))
self.WBX_EDGE_RETRY_MS = [300, 600, 1000, 1500, 2000, 2500, 3000]
const _wbxB64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s) }
// Do these bytes match an SRI pin ("sha384-… sha256-…")? Any one token matching is enough.
self.wbxMatchesPin = async (buf, pin) => {
  for (const tok of String(pin).trim().split(/\s+/)) {
    const m = /^(sha256|sha384|sha512)-(.+)$/.exec(tok); if (!m) continue
    if (_wbxB64(await crypto.subtle.digest(m[1].replace('sha', 'SHA-'), buf)) === m[2]) return true
  }
  return false
}
// A cached copy with its `redirected` flag set is a NETWORK ERROR when served to a navigation: a fresh Response over the body.
self.wbxClean = (r) => (r && r.redirected ? new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers }) : r)
// Is `b` the build the live /sw.js carries? Then the network is not lagging — this worker is the older one — and waiting
// would only delay the fallback. Unreadable → false (= wait: the lag is the likelier story).
self.wbxLiveBuildIs = async (b) => {
  try { const t = await (await fetch(new Request('/sw.js?vc=' + Date.now(), { cache: 'no-store' }))).text(); const m = /const V = '([^']+)'/.exec(t); return !!m && m[1] === b } catch { return false }
}
// The network's shell, accepted only when it is THIS build's (or carries no stamp); another build's is waited out.
//   o = { V, shellBuildOf(html) → build | '', putCache(req, res), onWait(b, i) }
self.wbxFetchShellOurs = async (req, key, first, o) => {
  let r = null
  for (let i = 0; i <= self.WBX_EDGE_RETRY_MS.length; i++) {
    try { r = i === 0 && first ? await first : await fetch(new Request(req.url, { cache: 'reload', credentials: 'same-origin' })) } catch { return null }
    if (!r || !r.ok) return null
    let b = ''; try { b = o.shellBuildOf(await r.clone().text()) } catch { return null }
    if (!b || b === o.V) { if (i > 0) o.putCache(new Request(key), r.clone()); return r }
    if (i === 0 && await self.wbxLiveBuildIs(b)) return null // the edge is CONVERGED on that build and WE are the stale worker
    if (o.onWait) o.onWait(b, i)
    if (i < self.WBX_EDGE_RETRY_MS.length) await self.wbxSleep(self.WBX_EDGE_RETRY_MS[i])
  }
  return null
}
// NEVER HAND A TOP-LEVEL OPEN TO THE BROWSER'S OWN ERROR PAGE. `Response.error()` for a shell navigation paints Safari's
// "your iPhone is not connected to the internet" — nothing anyone can act on (the owner, three times on 2026-09-17). A
// worker with nothing to serve says so itself: the build, the reason, every cache with its count. A 503 with a body —
// nothing caches it or mistakes it for the shell — and "Try again" reloads back through the same worker.
self.wbxOfflinePage = async (V, why) => {
  let state = 'no caches'
  try {
    const parts = []
    for (const k of await caches.keys()) parts.push(k + ':' + (await (await caches.open(k)).keys()).length)
    if (parts.length) state = parts.join(' · ')
  } catch (e) { state = 'caches unreadable' }
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>You’re offline</title>' +
    '<body style="margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;color:#111;background:#fff"><div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 24px;gap:14px;box-sizing:border-box">' +
    '<h2 style="margin:0;font-size:20px">You’re offline</h2>' +
    '<p style="color:#666;margin:0;max-width:22rem">This device hasn’t saved the app yet. Open it once with a connection and it will be here offline after that.</p>' +
    '<button onclick="location.reload()" style="font:inherit;font-weight:600;padding:12px 20px;border:0;border-radius:12px;background:#111;color:#fff">Try again</button>' +
    '<div style="color:#999;font-size:12px">worker ' + esc(V) + ' · ' + esc(why) + ' · ' + esc(state) + '</div></div>'
  return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}
// A worker's own failures in its trail (a worker has no console anyone reads).
self.wbxWireErrors = () => {
  self.addEventListener('error', (e) => { self.wbxNoteSw('worker error: ' + ((e && e.message) || e)) })
  self.addEventListener('unhandledrejection', (e) => { self.wbxNoteSw('worker rejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || '?')) })
}

// THE TAP TEST'S WORKER HALF (crashTrail.js "Test a notification tap"; both workers since 2026-10-25). The page shows one test
// notification itself and asks this worker to show its own — and, for the room on screen, one dressed exactly like a push for
// it (tag = the room, data = { room }) but shown with no push. One tap each splits "push-shown notifications lose their tap"
// from "every notification of this app does" (the tenant app's taps, 2026-10).
self.wbxWireDiagShow = () => {
  self.addEventListener('message', (e) => {
    const d = e && e.data
    if (!d || d.ch !== 'diag-show') return
    // Round 2: the plain worker notification's tap ARRIVED (owner, 09:26:53) while no push-shown tap ever has. So a second
    // one is dressed EXACTLY like a push for the room on screen — tag = the room, data = { room } — but shown with no push.
    // Plain arrives + dressed lost ⇒ the room tag/data is the cause; both arrive ⇒ it is being shown from a PUSH.
    const room = typeof d.room === 'string' ? d.room : ''
    const show = (title, opts, what) => self.registration.showNotification(title, opts).then(() => self.wbxNoteSw('shown: TEST notification by the ' + what), (err) => self.wbxNoteSw('could not show the ' + what + ' TEST notification: ' + ((err && err.message) || err)))
    e.waitUntil(Promise.all([
      show('Test from the worker', { body: 'Tap this one', tag: 'diag-worker', data: { diag: 'worker' }, icon: '/icon-192.png', badge: '/icon-192.png' }, 'worker'),
      room ? show('Test shaped like a message', { body: 'Tap this one as well', tag: room, data: { room, diag: 'worker, shaped like a push for ' + room.slice(0, 10) }, icon: '/icon-192.png', badge: '/icon-192.png' }, 'worker, shaped like a push') : null,
    ]))
  })
}

// ★★ A STORED PAGE KEEPS ITS SECURITY HEADERS (docs/hosted-app-design.md §8; 2026-10-25; both workers). The hash stores keep the
//    bytes once per hash, so the headers cannot ride with them (the same bytes may be served at two addresses): each release's
//    LIST records, per entry, the headers that protect a document or a worker — its CSP above all, which our pages carry only
//    as a header. Without this a page answered from a store ran with NO CSP (measured live, both engines;
//    spaces/test/storeKeepsHeaders.test.mjs).
self.WBX_SEC_HEADERS = ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'x-content-type-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'allow-csp-from', 'report-to', 'reporting-endpoints']
/** The security headers of a response that carries a policy (a page, a worker) → { name → value }, or null. A PAGE (`text/html`)
 *  is always recorded when `recordPages` — {} when it carried none — so "recorded, none" differs from "kept before headers were". */
self.wbxSecHeadersOf = (h, recordPages = false) => {
  if (!h.get('content-security-policy') && !h.get('content-security-policy-report-only') && !h.get('x-frame-options')) return recordPages && /^text\/html/i.test(h.get('content-type') || '') ? {} : null
  const o = {}; for (const n of self.WBX_SEC_HEADERS) { const v = h.get(n); if (v) o[n] = v } return o
}
/** A stored file as a fresh Response with the headers its entry was recorded with. A document recorded with none (kept before
 *  headers were) is marked `x-wb-noheaders`: online, a navigation takes the network's copy (which carries them) instead. */
self.wbxWithSecHeaders = (r, sec) => {
  const headers = new Headers(r.headers)
  if (sec) for (const [n, v] of Object.entries(sec)) headers.set(n, v)
  else if (/^text\/html/i.test(headers.get('content-type') || '')) headers.set('x-wb-noheaders', '1')
  return new Response(r.body, { status: 200, headers })
}
/** A stored page recorded with no security headers, while the network may be there: take the network's copy. */
self.wbxStaleHeaders = (r) => !!(r && r.headers.get('x-wb-noheaders') && self.navigator.onLine !== false)
