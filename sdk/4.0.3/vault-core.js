// vault-core.js — the key-holding core of a BUILDER-HOSTED VAULT (docs/sdk-vault-mode.md).
//
// A builder serves two origins: this vault (e.g. https://vault.acme.com) and their own app page (https://app.acme.com),
// which the vault frames. The room keys live ONLY here — in the l1 worker this module starts, the same worker the Spaces
// app keeps its keys in. The framed page uses the SDK (`Witbitz.inVault`), which sends each room operation up the
// `wbvault` channel; this module checks it, runs it in the worker and sends the answer back. A key never goes down.
//
// What is the builder's: the SCREENS (sign-in, share, "didn't load" — `screens`, see vault-screens.js for the defaults)
// and the page. What is ours: everything that touches a key, here and in l1-worker.js. Upgrading = replacing these files.
//
//   import { startVault } from './vault-core.js'
//   import { defaultScreens } from './vault-screens.js'
//   startVault({ page: 'https://app.acme.com/chat', tenant: 't_…', screens: defaultScreens({ brand: 'Acme' }) })
//
// The page may ask for ONLY: the room operations in PAGE_OPS on a room this vault holds, create, rooms, share, signIn,
// signOut, whoami, forget, stream, and the account calls in ACCOUNT_CALLS / ROOM_ACCOUNT_CALLS. Everything else the worker can do (remember a key, export, the index, protection) is the
// vault's own and is not reachable from the page.
import { Witbitz, Space, Lane } from './witbitz-sdk.js'
import { LaneA2A } from './sdkA2A.js'
import { openGrant, relink, changeMembers, rotateKey, changeable, planMembers } from './sdkRekey.js' // a Space's members changed in place (https://witbitz.chat/docs/sdk-people.md#members)
import { setPendingKeyStore } from './connections.js' // the SDK's pending-key store (N#7): this vault's
import { adoptPendingKeys } from './connPending.js'
import { openItem, cardUrlOf, mcpUrlOf } from './a2aCore.js'
import { judgeMove, checkNewRoomGov } from './emailFork.js'
import { ROSTER_DOC, selfRow, ensureSelf, unseenIn, entriesMissing, announcedIn } from './roomRoster.js'
import { readAllPages } from './ledgerView.js'
import { commit as keyCommit } from './e2ee.js'
import { createEnclaveHandoff, enclaveReady, reattestOnce, saysConfidential } from './vaultEnclaveHandoff.js' // what the worker is told of the confidential tier — the same rules as our hosted vault's (C2)
import { dropFor, receiptFor } from './usageReceipts.js'
import { makeVerifiedWorker } from './vcWorker.js' // the key worker from its PINNED source, never a file fetched by URL
import { createWorkerHost } from './vaultWorkerHost.js' // the key worker's host: load, heartbeat, restart, replay (shared with our hosted vault)
import { keepPass, viewOfKeep, tabStores } from './vaultKeep.js' // connections, Siri and outside agents on every device of the account (sync sweep 2026-11-11 P7)
import { laneInherits, gatedStub } from './laneConfig.js' // the heartbeat that finds a worker iOS reclaimed (l1.js and the app's vault use it too)
import { createAtRest, deviceWrapKey, holdsSealed } from './vaultAtRest.js' // the room list's keys and the backup state, sealed on disk (2026-11-13)
import { deviceStorageKey } from './vaultDeviceKey.js' // the key worker's store sealed at rest too (11-21 sweep P8): our hosted vault's device key
import { pushAcctSecretOf } from './spaceClient.js' // the account's push tag secret (handDownPushAcct)
import { indexRoomOf } from './sdkAccount.js'
import { accountService, restoreBridge, idbKeyStore } from './sdkBackupV2.js' // NEW accounts on the Witbitz account service (account v2; the owner, 2026-11-16: "Yes. Do the sdk.")
import { makeRoomPassHolder, roomPassSwitchOn, isRoomPassAsk, isSigninRenewAsk } from './roomPass.js' // the room pass of an account on the account service (docs/device-gate-design.md)

export const VAULT_PROTOCOL = 1
// The room operations a page may run, on a room this vault holds. Left out on purpose: purge/carry (destructive or
// cross-room), subscribe/unsubscribe (push belongs to the vault), the intake ops (the account's), exports and imports.
// (no 'safeCopy': a safe copy is made only where the sign-in and the key are — space.safeMedia.make is refused in a vault, and
// nothing in vault mode posts one; sync sweep backlog P7)
export const PAGE_OPS = new Set(['poll', 'pollSealed', 'turn', 'state', 'data', 'title', 'decide', 'pending', 'mirror', 'toolResult', 'getConfig', 'setConfig', 'blob', 'react', 'mark', 'sealed', 'exportSealed', 'stop'])
const KEYS = { rooms: 'wbvault:rooms', session: 'wbvault:session', siri: 'wbvault:siri', a2a: 'wbvault:a2a', invite: 'wbvault:invite', connections: 'wbvault:connections', backup: 'wbvault:backup', keep: 'wbvault:keep', connPending: 'wbvault:connPending' }
// THE ACCOUNT, through the vault's session (docs/sdk-vault-mode.md § The account). The page asks; the vault runs it on its
// own SDK client, which holds the sign-in. What stays here: the session, the Siri inbox's private keys, each connection's
// callKey (a grant is made by id). `confirm`: the person says yes in the vault's own pixels first — it acts in their name.
export const ACCOUNT_CALLS = {
  connections: { attach: {}, list: {}, detach: { confirm: true }, startConnect: {}, finishConnect: {}, startMcp: {}, attachMcp: {}, finishMcp: {}, mcpTools: {} }, // MCP servers (2026-10-23): the callKey stays here, as attach's
  usernames: { claim: { confirm: true }, release: { confirm: true }, mine: {}, resolve: {} },
  siri: { status: {}, rotateKey: { confirm: true }, revoke: { confirm: true }, shortcut: {}, showKey: {} },
  a2a: { status: {}, revoke: { confirm: true } },
  // the account BACKUP and the account INDEX across devices: the vault's own, over the Spaces it holds. The recovery code
  // is shown and typed ONLY in the vault's screens (screens.recoveryCode / screens.restore) — a page that saw it would hold
  // the way back to every key.
  // signOutOthers / newRecoveryCode / deleteAccount: an account on the Witbitz account service (sdkBackupV2.js) — the vault's
  // screens ask for the emailed code (screens.emailCode) and show a new code (screens.recoveryCode)
  backup: { enable: {}, restore: {}, save: {}, upgrade: {}, remove: { confirm: true }, signOutOthers: { confirm: true }, newRecoveryCode: { confirm: true }, deleteAccount: { confirm: true } },
  // (SERVICE_CALLS, below: the three that need an account on the service — checked before their confirm)
  account: { sync: {}, start: {}, stop: {}, archive: {}, rename: {}, forget: { confirm: true }, signOut: { confirm: true }, noteLink: {}, dropLink: {}, section: {}, usage: {} }, // section: wb.account.contacts / .name / .roomDefaults (sdkAccountSections.js — the person's own data, no key; plan phase 5) // usage: what the account used, from its receipts (2026-10-23) // noteLink/dropLink: lane.link() across devices (sync sweep, 10-17 #6)
  erasure: { file: {}, status: {} },
}
/** The backup calls that need an account on the Witbitz account service (sync sweep 11-16 #15). */
const SERVICE_CALLS = new Set(['signOutOthers', 'newRecoveryCode', 'deleteAccount'])
export const ROOM_ACCOUNT_CALLS = {
  connections: { grant: { confirm: true }, revoke: {} },
  siri: { enable: {}, disable: {}, collect: {} },
  // a private lane's door for outside agents: `pull` opens the waiting messages here (the inbox key stays), the page posts
  // each into the lane, then `ack`s it — as outside a vault
  a2a: { view: {}, enable: {}, addPeer: { confirm: true }, setReply: {}, removePeer: {}, disable: {}, pull: {}, ack: {}, reply: {} },
}
const ASK_MS = 60_000 // the page's answer to a question the vault asks it (a Siri drop handed to its deliver)
// What a page may put in a NEW Space's config — the fields the SDK's createSpace writes (roomConfig + the email gate).
// Anything else (a key model, a confidential tier, a direct chat) is refused HERE: the SDK's own refusals run in the
// page, and a hostile page skips them (security review, 2026-10-15).
export const CREATE_FIELDS = new Set(['agentName', 'persona', 'tools', 'immediateTools', 'model', 'admission', 'allow', 'advertise', 'admins', 'owners', 'platformTools', 'framing', 'dataWrites', 'dataSchema', 'region', 'direct', 'safeMedia', 'lanes', 'lane']) // lane: a private lane says so (laneConfig.js) — it only takes things away (no schedules, no always on)
const CREATE_LIMIT = { n: 20, ms: 10 * 60_000 } // new Spaces per window, per vault page
const SPEECH_LIMIT = { n: 30, ms: 10 * 60_000 } // speech keys (dictation, reading aloud) per window, per vault page
const REFRESH_BEFORE_MS = 10 * 60_000 // renew the sign-in this long before it expires
const WIPE_PUSH_MS = 10_000 // a sign-out takes this device off its Spaces' notification lists for at most this long — then it goes on

const read = (st, k, d) => { try { const v = st.getItem(k); return v ? JSON.parse(v) : d } catch { return d } }
const write = (st, k, v) => { try { if (v == null) st.removeItem(k); else st.setItem(k, JSON.stringify(v)) } catch { /* a full or blocked store: the vault still works this session */ } }

/** What an invite link carries: `…/space?room=<id>#mk=<key>` → { room, mk }; a SPLIT room's `#us=<half>&spc=<commit>`
 *  → { room, userShare, commit, split: true } (the other half is the builder's app-half function's); else null. */
export function linkParts(href) {
  try {
    const u = new URL(href)
    const room = u.searchParams.get('room') || ''
    const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
    const mk = frag.get('mk') || '', us = frag.get('us') || ''
    if (room && mk) return { room, mk }
    if (room && us) return { room, userShare: us, commit: frag.get('spc') || '', split: true }
    return null
  } catch { return null }
}
/** A room's config as the page may see it: each connection without its callKey (the key that lets the room spend it),
 *  a funding grant without its secrets. Everything else — the assistant, the gate, the store — the page shows. */
/** A refusal the vault's own SDK made, as the PAGE must read it: in a vault the call that signs in is wb.vault.signIn — wb.signIn
 *  is refused there (sync sweep 11-14 P7: space.connections / siri through the vault said "wb.signIn"). Same error, same code. */
export function vaultSignInWords(e) {
  if (e && e.code === 'sign_in_required' && typeof e.message === 'string' && /\bwb\.signIn\b/.test(e.message)) {
    try { e.message = e.message.replace(/\bwb\.signIn\b/g, 'wb.vault.signIn') } catch { /* a frozen message: as it was */ }
  }
  return e
}

export function configForPage(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg
  const out = { ...cfg }
  if (Array.isArray(out.connections)) out.connections = out.connections.map((c) => { if (!c || typeof c !== 'object') return c; const { callKey: _k, ...rest } = c; return rest })
  if (out.funding && typeof out.funding === 'object') { const { grant: _g, grantToken: _t, key: _x, token: _y, ...rest } = out.funding; out.funding = rest }
  return out
}
const holdLink = (worker, p) => { if (!p) return; if (p.mk) worker.postMessage({ t: 'remember', room: p.room, mk: p.mk }); else if (p.split) worker.postMessage({ t: 'rememberSplit', room: p.room, userShare: p.userShare, commit: p.commit }) }

/**
 * Start the vault: frame the builder's page, start the key worker, answer the page.
 * @param {object} o
 * @param {string} o.page        the builder's page (full https URL); only its ORIGIN may talk to this vault
 * @param {string} [o.tenant]    the builder's tenant id (public) — the Spaces this vault creates are its tenant's
 * @param {string} [o.endpoint]  the Space API (default: Witbitz's)
 * @param {string} [o.loginBase] where the email sign-in endpoints live (default: Witbitz's)
 * @param {string} [o.app]       a short app tag sent with each request
 * @param {object} o.screens     the builder's screens: { signIn, share, failed?, ready? } (vault-screens.js)
 * @param {HTMLElement} [o.mount] where the page's frame goes (default: document.body)
 * @param {Storage} [o.storage]  where the room list and the session are kept (default: localStorage of THIS origin)
 * @param {Function} [o.makeWorker] () => Worker — tests inject; default: ./l1-worker.js as a module worker
 * @param {boolean} [o.lock]     offer the person the lock and storage protection (vaultCoreLock.js; the page: wb.vault.showLock())
 * @param {boolean} [o.push]     offer the person notifications (vaultCorePush.js; the page: wb.vault.showNotifications())
 * @param {string} [o.pushWorker] the service worker's path (default /push-sw.js, the kit's)
 * @param {string|false} [o.accountService] where NEW accounts are kept: the Witbitz account service (default
 *   https://api.witbitz.chat/v1, with a `tenant` — the vault's origin must be one of the tenant's proven origins); `false` keeps
 *   new accounts on the old backup store, as before this release. Without a tenant: the old store.
 */
export async function startVault(o = {}) {
  const pageUrl = new URL(String(o.page || ''))
  const pageOrigin = pageUrl.origin
  if (!/^https?:$/.test(pageUrl.protocol)) throw new Error('vault: `page` must be an http(s) URL')
  if (pageOrigin === location.origin) throw new Error('vault: the page must be on ANOTHER origin — that is the wall that keeps the keys out of it')
  const screens = o.screens || {}
  // A screen the builder's screens.js does not have falls back to OURS (sync sweep 10-15 #7): a kit upgraded from an older
  // release keeps the builder's screens.js (it is theirs) — and the backup and Siri-key screens came later. Brand: theirs if given.
  let _ours = null
  const screenFor = async (name) => {
    if (typeof screens[name] === 'function') return screens[name].bind(screens)
    try { _ours = _ours || (await import('./vault-screens.js')).defaultScreens({ brand: String(o.brand || (typeof document !== 'undefined' && document.title) || location.hostname || 'this app').slice(0, 60) }) } catch { _ours = {} } // an older kit's vault.js passes no brand: the vault page's own title, then its host (sync sweep, 10-16)
    return typeof _ours[name] === 'function' ? _ours[name] : null
  }
  // ── THE LOCK, opt-in twice (vaultCoreLock.js; 2026-11-13): the builder starts the vault with `lock: true`, the person turns it
  //   on in the vault's sheet (wb.vault.showLock()). Without `lock: true` none of it is even loaded. With it, a locked launch waits
  //   HERE — before the vault reads its storage, starts its worker or frames the page — for the passkey.
  let frameEl = null, frameHidden = false
  const vlock = o.lock === true ? await (async () => {
    const lockUi = await screenFor('lockUi')
    return (await import('./vaultCoreLock.js')).createVaultLock({
      brand: String(o.brand || (typeof document !== 'undefined' && document.title) || location.hostname || 'this app').slice(0, 60),
      mountUi: () => { if (lockUi) lockUi() },
      hide: () => { frameHidden = true; if (frameEl) frameEl.style.display = 'none' },
      show: () => { frameHidden = false; if (frameEl) frameEl.style.display = 'block' },
      onState: (lock) => { if (frameEl) emit({ ev: 'lock', lock }) },
      confirm: (q) => (typeof screens.confirm === 'function' ? screens.confirm(q) : Promise.resolve(window.confirm(q.title))),
      onUnprotected: () => workerAtRest(), // protection off: the worker's store goes back under the device key, never clear
    })
  })() : null
  if (vlock) await vlock.boot()
  const st = o.storage || localStorage
  // THE ROOM PASS (docs/device-gate-design.md; roomPass.js): an account on the Witbitz account service proves, on every verified-Space
  // request, that this device is still one of its active devices — a ten-minute pass from the service (this vault's device key, its
  // tenant's scope) and the session key's signature. Made HERE (the page never holds a key); the worker asks for it under the reserved
  // name '#room-pass', and this vault's own client carries it too. On only with the apps' switch (ROOM_PASS_APP, or `space:roompass=1`
  // in this vault's storage) and an account on the service; set below, once the account service is.
  let roomPass = null
  const roomPassClient = { fieldsFor: (b, o) => (roomPass ? roomPass.client.fieldsFor(b, o) : Promise.resolve({})), /* o: { ts } — the request's time (roomPass.js sign; sync sweep 11-16 #8) */ renew: (b) => (roomPass ? roomPass.client.renew(b) : Promise.resolve()) }
  // A SIGN-IN THAT NAMES NO APP (docs/device-gate-design.md § 12.1, `pass: app_unnamed` — a session token from before `asc`): the
  // session is renewed once, quietly (its /refresh names this vault's tenant), and the request sent again. One renewal at a time.
  let renewing = null
  const renewSession = () => {
    if (!renewing) renewing = (async () => {
      try {
        if (!signedIn()) return null
        await sdk.refreshSession()
        keepSession(); emit({ ev: 'session', keyId: sessionKeyId() }); scheduleRefresh()
        return { idToken: sdk.session.idToken, spk: sdk.session.sign.pub }
      } catch { return null }
    })().finally(() => { renewing = null })
    return renewing
  }
  const sdk = new Witbitz({ ...(o.endpoint ? { endpoint: o.endpoint } : {}), ...(o.loginBase ? { loginBase: o.loginBase } : {}), ...(o.tenant ? { tenant: o.tenant } : {}), ...(o.enclaveClaim ? { enclaveClaim: o.enclaveClaim } : {}), ...(o.vaultApi ? { vaultApi: o.vaultApi } : {}), deviceName: String(o.deviceName || ''), live: false, _roomPass: roomPassClient, _renewSignIn: () => renewSession() })
  // The worker gets the endpoint as an ABSOLUTE address. It runs from a pinned source held in memory (a blob:), where a
  // relative one ('/api/space', a vault that serves its own Space API) has no base to resolve against: every fetch threw
  // "Failed to parse URL" (CI 43560453677, after 580fdd9ca). Resolved here, against the vault's own page.
  const endpoint = (() => { try { return new URL(sdk._endpoint, location.href).href } catch { return sdk._endpoint } })()
  const savedSession = read(st, KEYS.session, null)
  if (savedSession) sdk.useSession(savedSession)
  // ON DISK NO ROOM KEY IS CLEAR (vaultAtRest.js; the owner, 2026-11-13): the list keeps each link without its key and the key
  // sealed, under a non-extractable key of this vault's own (IndexedDB); the backup state is sealed whole. An older vault's clear
  // list is read as it is and written back sealed.
  // A KEY THAT COULD NOT BE READ (sync sweep 2026-11-15 #3): deviceWrapKey retried and threw — the person is asked, and the vault never
  // runs keyless over sealed data (it read the backup as off and a new master replaced it). "Not now" stops here; nothing is deleted.
  let wrapKey = null
  for (;;) {
    try {
      wrapKey = await deviceWrapKey()
      // NO IndexedDB this launch (null) over storage that holds sealed data: the same as a read that failed — never keyless (sync sweep 11-18)
      if (!wrapKey && holdsSealed(st, { rooms: KEYS.rooms, backup: KEYS.backup })) throw Object.assign(new Error('this vault\'s saved data could not be opened (no IndexedDB here just now)'), { code: 'device_key_unreadable' })
      break
    } catch (e) {
      const again = await (typeof screens.confirm === 'function' ? screens.confirm({ title: 'Couldn\u2019t open this vault\u2019s saved data', text: 'This device did not let the vault read its storage just now. Nothing was deleted. Try again — or close the app and open it again.', ok: 'Try again', cancel: 'Not now' }) : Promise.resolve(window.confirm('Couldn\u2019t open this vault\u2019s saved data. Try again?'))).catch(() => false)
      if (!again) throw e
    }
  }
  const atRest = createAtRest({ storage: st, key: wrapKey })
  let rooms = await atRest.loadRooms(KEYS.rooms) // [{ room, link, title, at }] — in memory the link IS the key; it never leaves this origin
  let vpush = null // notifications (`push: true`, vaultCorePush.js): every Space held lists this device, kept in step at each save
  let pushAcctSecret = '' // the account's push tag secret the key worker holds (handDownPushAcct) — '' while no account is here
  const saveRooms = () => { if (vpush) vpush.sync(rooms.map((r) => r.room)).catch(() => {}); return atRest.saveRooms(KEYS.rooms, rooms) } // in order; resolves once on disk
  const backupsAtStart = await atRest.loadBackups(KEYS.backup) // here, before the frame: nothing awaits between the frame and the page's hello listener
  const publicRooms = () => rooms.map(({ room, title, at, lane, enc, link }) => ({ room, title: title || '', at, ...(lane ? { lane } : {}), ...(enc ? { tier: 'enclave' } : {}), ...(/[#&]lanes=1(?:&|$)/.test(String(link || '')) ? { lanes: true } : {}) })) // lane: the Space it is a private lane of; lanes: a private assistant for every member (its link says so — never the link itself)

  // ── the key worker ───────────────────────────────────────────────────────────────────────────────────────────────
  let worker = null, wseq = 0
  const streaming = new Set() // rooms the page holds a live stream for (CALLS.stream); the socket lives in the worker
  const wwait = new Map()
  const signedIn = () => { const s = sdk.session; return !!(s && s.idToken && s.sign && !(s.exp && s.exp <= Date.now())) }
  // the session key's PUBLIC id (agentIdentity.keyIdOf) — the page marks its own messages by it (space.isMine; sweep 11-07 #9)
  const sessionKeyId = () => { const k = signedIn() ? sdk.session.sign.pub : null; return k && k.kty && k.crv && k.x != null && k.y != null ? `${k.kty}:${k.crv}:${k.x}:${k.y}` : '' }
  // OPTION B's hints, fetched by THE WORKER's client — the one that sends this vault's room requests (sweep 11-07 #7: the SDK's
  // own prefetch reached only this page's client, so the first sealed request fetched them inline). In the background, a few
  // seconds after a sign-in / a renewal / a (re)started worker, then hourly — never right before a room request.
  let idPrefetchT = null
  function prefetchWorker(delayMs = 2000 + Math.floor(Math.random() * 8000)) {
    try {
      clearTimeout(idPrefetchT)
      idPrefetchT = setTimeout(() => {
        if (!worker || !signedIn()) return
        try { worker.postMessage({ t: 'prefetchIdentity', token: sdk.session.idToken }) } catch { /* the next sealed request fetches them */ }
        prefetchWorker(50 * 60_000 + Math.floor(Math.random() * 10 * 60_000))
      }, delayMs)
    } catch { /* no timers */ }
  }
  // PER-USER BILLING (sync sweep, 10-17 #5): the page hands its current user token over right before an op that can spend
  // (CALLS.userToken); memory only, never stored. The worker asks for it under the reserved name '#account-billing'.
  let pageUserToken = ''
  const authFor = (room) => (room === '#account-billing' ? { ...(signedIn() ? { idToken: sdk.session.idToken, spk: sdk.session.sign.pub } : {}), ...(pageUserToken ? { userToken: pageUserToken } : {}) } : (signedIn() ? { idToken: sdk.session.idToken, spk: sdk.session.sign.pub } : {}))
  const wcall = (msg) => new Promise((res, rej) => { const id = ++wseq; wwait.set(id, { res, rej }); worker.postMessage({ id, ...msg }) })
  // a call waiting on a worker that is gone fails at once, named (a dead worker, a sign-out's new one): it can never be answered, and
  // the push queue (vaultCorePush.js, one change at a time) waited for ever behind such a call (sync sweep 11-22 P8)
  const failWaiting = (why) => { for (const [id, w] of wwait) { wwait.delete(id); try { w.rej(Object.assign(new Error(why), { code: 'worker_restarted' })) } catch { /* */ } } }
  let workerRooms = [] // the rooms the worker says it holds a key for (its `presence`: ids only, never a key) — a sign-out forgets them all
  const onWorker = (e) => {
    const m = e.data || {}
    if (m.t === 'presence') { if (Array.isArray(m.rooms)) workerRooms = m.rooms.filter((r) => typeof r === 'string' && r).slice(0, 5000); return }
    if (m.authReq != null && isSigninRenewAsk(m.room)) { const a = m.authReq, w = worker; renewSession().then((v) => { try { w.postMessage({ t: 'authRes', a, v: v || {} }) } catch { /* a restarted worker asks again */ } }); return } // the sign-in renewed to name its app (above)
    if (m.authReq != null && isRoomPassAsk(m.room)) { const a = m.authReq, w = worker; (roomPass ? roomPass.answer(m.room) : Promise.resolve({})).then((v) => { try { w.postMessage({ t: 'authRes', a, v: v && v.pass && v.psig ? { pass: v.pass, psig: v.psig } : {} }) } catch { /* a restarted worker asks again */ } }); return } // the room pass (above)
    if (m.authReq != null) { worker.postMessage({ t: 'authRes', a: m.authReq, v: authFor(m.room) }); return }
    if (m.attestReq != null) { worker.postMessage({ t: 'attestRes', a: m.attestReq, v: null }); return }
    if (m.delReq != null) { sdk.erasure._commitFor(String(m.room || '')).then((v) => worker.postMessage({ t: 'delRes', a: m.delReq, v: v || null }), () => worker.postMessage({ t: 'delRes', a: m.delReq, v: null })); return } // the erase list's commitment
    // ROOM STREAMS: the worker's events for a room the page asked to stream — the reply text as it grows, "poll now",
    // "the turn ended". The same plaintext a poll's partialText already carries to the page; never a key.
    if (m.t === 'stream') { if (streaming.has(m.room)) emit({ ev: 'stream', room: m.room, ...(m.ev ? { event: m.ev } : {}), ...('up' in m ? { up: !!m.up } : {}) }); return }
    if (m.id != null && wwait.has(m.id)) { const w = wwait.get(m.id); wwait.delete(m.id); if (m.error) w.rej(Object.assign(new Error(m.error), { code: m.code, ...(m.verdict && typeof m.verdict === 'object' ? { verdict: m.verdict } : {}) })); else w.res(m.result) } // the verdict too: which stage of a build did not match (errExtra passes it on; sync sweep 11-09, 11-08 #28)
  }
  const identity = () => (signedIn() ? { email: sdk.session.email, googleIdToken: sdk.session.idToken, sign: sdk.session.sign } : null)
  const seedIdentity = (room) => { const id = identity(); if (id) worker.postMessage({ t: 'rememberId', room, identity: id }) }
  // A WORKER iOS RECLAIMED IS RESTARTED (sync sweep, 10-18 #7): the app's two hosts ping theirs; this one never did, so a dead
  // handle swallowed every call and each hung for ever (vault_timeout on the page). A call waiting on the dead worker fails at
  // once, named, and the page's next call reaches the new one. The heartbeat, the restart and the replay are the SAME host our
  // hosted vault uses (vaultWorkerHost.js, docs/vault-core-convergence-review.md C1); what this vault replays is registered below.
  // ★ THE KEY WORKER FROM A PINNED SOURCE (the owner, 2026-11-14: "Do it now"; docs/vault-core-convergence-review.md § 5), as our own
  //   vault: it was a Worker made from the URL of l1-worker.js — a file the browser fetched from this host at every start, checked by
  //   nothing (kit.json's hashes are read only when the kit is built), into the realm that holds every key. Its source now arrives as
  //   a MODULE (`l1-worker-src.js`: bundled by each SDK release, named with its sha384 in the kit page's import map) and runs from
  //   memory (vcWorker.js). Read ONCE, before the host and its heartbeat exist — a restart builds from the same string, synchronously
  //   (vcWorker.js: no network round trip in front of a worker the heartbeat may restart). Missing → the vault does not start: a URL
  //   fallback would be exactly the unpinned load this closes.
  let workerSrc = ''
  if (typeof o.makeWorker !== 'function') {
    try { ({ SRC: workerSrc } = await import('./l1-worker-src.js')) } catch (e) { workerSrc = '' }
    if (typeof workerSrc !== 'string' || workerSrc.length < 1000) throw Object.assign(new Error('the vault cannot start: its key worker (core/l1-worker-src.js) is missing or was refused — run the vault kit again'), { code: 'vault_worker_missing' })
  }
  const WORKER_AT_REST = 'wbvault:worker-at-rest' // set once the worker's store was sealed by the device key: later starts unseal
  let workerDeviceKey = null
  try { const dk = await deviceStorageKey(); if (dk && dk.raw) workerDeviceKey = dk.raw } catch { /* no key: the store stays as before */ }
  const workerHost = createWorkerHost({
    make: () => (typeof o.makeWorker === 'function' ? o.makeWorker() : makeVerifiedWorker(workerSrc, '', { type: 'module' })),
    onCurrent: (w) => { worker = w },
    onMessage: onWorker,
    onRestart: () => failWaiting('the room worker stopped and was restarted — try again'),
  })
  // THE CONFIDENTIAL TIER FIRST, awaited (sync sweep 2026-11-09 #1, as our hosted vault): the held snapshot — every confidential room,
  // the newer attested key — before the open and any link. It used to be an EMPTY list here and the real one only after the links,
  // so an op landing in between met a worker that held keys from its own store (l1-worker keysReady) and no confidential room.
  // A PROTECTED DEVICE's worker opens its sealed store first (the lock's device key, held in this page only while unlocked)
  if (vlock) workerHost.replay('protect', () => { const m = vlock.workerUnseal(); return m ? wcall(m) : null })
  // THE KEY WORKER'S STORE, SEALED AT REST (the 11-21 sync sweep P8; owner, 2026-11-22: "do both"): with no passkey protection the worker
  // wrote every room key to IndexedDB in the clear, against this vault's own rule (vaultAtRest.js: nothing on disk carries a room key in
  // the clear). As our hosted vault: the device key (vaultDeviceKey.js, 32 bytes kept wrapped under a non-extractable key of this origin)
  // seals the worker's store — the first time `seal` (a clear store is rewritten sealed), after that `unseal`. A protected device's
  // passkey key takes precedence (the replay above); no IndexedDB → as before, clear (a key is never lost for want of a seal).
  workerHost.replay('atRest', () => workerAtRest())
  workerHost.replay('enclave', () => wcall(enclaveMsg()))
  workerHost.replay('open', () => wcall({ t: 'open', room: null, mk: null, endpoint, app: o.app || 'vault', ...(o.tenant ? { tenant: o.tenant } : {}) }))
  workerHost.replay('links', (w) => { for (const r of rooms) { const p = linkParts(r.link); if (p && p.room === r.room) holdLink(w, p); seedIdentity(r.room) } }) // a link that names another room is never held for it
  workerHost.replay('streams', (w) => { for (const room of streaming) w.postMessage({ t: 'streamOpen', room }) }) // a restarted worker (sign-out) picks the page's streams back up
  workerHost.replay('pushSelf', (w) => { const e = vpush && vpush.endpoint(); if (e) w.postMessage({ t: 'setPushSelf', endpoint: e }) }) // this device's own posts do not tickle it
  workerHost.replay('pushAcct', (w) => { if (pushAcctSecret) w.postMessage({ t: 'setPushAcct', secret: pushAcctSecret }) }) // …nor its account's other devices (handDownPushAcct)
  workerHost.replay('prefetch', () => prefetchWorker())
  function workerAtRest() {
    if (!workerDeviceKey || !worker || (vlock && vlock.workerUnseal())) return null
    let sealed = false; try { sealed = st.getItem(WORKER_AT_REST) === '1' } catch { /* */ }
    return wcall({ t: sealed ? 'unseal' : 'seal', key: workerDeviceKey, previews: true }).then(() => { try { st.setItem(WORKER_AT_REST, '1') } catch { /* */ } }).catch(() => { /* the store stays as it was; the next start tries again */ })
  }
  async function startWorker() { await workerHost.start() } // a new worker, replayed (at start and at sign-out)
  // ── THE CONFIDENTIAL TIER: the vault attests the enclave with the SDK's own code (the published claim, the policy
  // text, the Nitro document) and hands its worker the attested key. The worker seals a room's key only to a build
  // Witbitz publishes — the SDK's rule (enclaveAccept.publishedKey): `trusted` is exactly the published live build.
  // The rules for what the worker is told are vaultEnclaveHandoff.js (C2, shared with our hosted vault): the confidential rooms are
  // a UNION that never shrinks in a worker's life (11-10 #1), the newer attested key wins (pass 9 X#1), and a new worker hears the
  // held snapshot first (11-09 #1). Who attests stays here: this vault, never its page.
  const encHandoff = createEnclaveHandoff({ trust: 'published' })
  const encRooms = () => rooms.filter((r) => r.enc).map((r) => r.room)
  const isEncRoom = (room) => rooms.some((r) => r.room === room && r.enc)
  // ★ THE VAULT'S OWN CLIENT KNOWS THE TIER TOO (sweep 11-06 #2, #3): only the worker learned it, so a call this page's client made
  //   itself (a turn's stop) went to the standard tier and was refused. Marked only once the enclave is attested: a marked room
  //   with no key would send its room key readable (enclaveReady). → whether the room may be called on the enclave from here.
  const encReadyFor = (room) => enclaveReady({ confidential: isEncRoom(room), hasKey: () => !!sdk._enc.key, attest: () => encAttest(room), mark: () => { if (!sdk._enc.rooms.has(room)) sdk._enc.rooms.set(room, true) } })
  function enclaveMsg() { // the SDK's attested state, merged into what the worker holds → the whole snapshot to send it
    const e = sdk._enc, keys = {}
    if (e.key) for (const r of encRooms()) if (!e.rooms.has(r)) e.rooms.set(r, true) // the page's client: the same tier the worker sends to
    for (const [region, v] of e.byRegion) keys[region] = { key: v.key, attested: { ...v.attested, platform: v.platform } }
    return encHandoff.offer({ key: e.key || null, attested: e.attested ? { ...e.attested, platform: e.platform } : null, keys, rooms: encRooms() })
  }
  function pushEnclave() {
    if (!worker) return
    worker.postMessage(enclaveMsg())
  }
  let encReady = null // one attestation at a time, shared
  const encAttest = (room) => (encReady ||= sdk._encAttest(room).then(() => { pushEnclave() }).finally(() => { encReady = null }))
  await startWorker()
  if (vlock) vlock.setWorker((m) => wcall(m)) // the lock's seal / unseal / relock / unprotect reach whichever worker is current
  // ── NOTIFICATIONS, opt-in twice (vaultCorePush.js; 2026-11-13): the builder starts the vault with `push: true`, the person turns
  //   them on in the vault's card (wb.vault.showNotifications()). Subscribing a Space is the vault's own worker op — never a page op.
  if (o.push === true) {
    vpush = (await import('./vaultCorePush.js')).createVaultPush({
      storage: st, worker: typeof o.pushWorker === 'string' ? o.pushWorker : '/push-sw.js',
      subscribe: (room, sub, quiet) => wop('subscribe', room, sub, '', quiet),
      unsubscribe: (room, sub) => wop('unsubscribe', room, sub),
      setSelf: (endpoint) => { try { worker.postMessage({ t: 'setPushSelf', endpoint }) } catch { /* the replay sends it to the next one */ } },
      held: (room) => held(room),
      onOpen: (room) => emit({ ev: 'notifOpen', room }),
      // this device's address changed (loaded at start, turned on or off): the account service learns it now (Codex sweep 11-16 #2)
      onChange: () => { try { const b = sdk.backup; if (b && b._v2 && b.enabled && b._s) b._v2.syncPush(b).catch(() => {}) } catch { /* */ } },
    })
  }

  // ── an invite opened in THIS vault: …/space?room=<id>#mk=<key> — keep it, take the key out of the address bar ─────────
  // ★ A HELD room's key is NEVER replaced by a link (security review, 2026-10-15): a crafted link with the right room and
  // a wrong key would have written that key over the real one — a room drawn blank for good. A NEW room is joined only
  // after the person says so (a link clicked elsewhere must not add Spaces silently).
  let joined = null
  const inv = linkParts(location.href)
  const invLink = inv ? location.href : ''
  if (inv) { try { history.replaceState(null, '', location.pathname.replace(/\/space$/, '/')) } catch { /* */ } } // the key leaves the address bar at once
  // A COLD TAP on a notification (push-sw.js opens the vault at ?room=…&tap=1): the page reads it in its welcome (`notifOpen`)
  const tapQ = vpush && !inv ? new URLSearchParams(location.search) : null
  const tapRoom = tapQ && tapQ.get('tap') === '1' ? String(tapQ.get('room') || '').slice(0, 120) : ''
  if (tapRoom) { try { history.replaceState(null, '', location.pathname) } catch { /* */ } }
  const confirmWith = (q) => (typeof screens.confirm === 'function' ? screens.confirm(q) : Promise.resolve(window.confirm(q.text ? q.title + '\n\n' + q.text : q.title)))
  async function joinInvite() {
    if (!inv || rooms.some((r) => r.room === inv.room)) { if (inv) joined = inv.room; return } // already held: open it, keep its key
    const ok = await confirmWith({ title: 'Join this Space?', text: 'Someone shared a Space with you. Join it on this device?', ok: 'Join', cancel: 'Not now' }).catch(() => false)
    if (!ok) return
    rooms = [{ room: inv.room, link: invLink, title: '', at: Date.now(), ...(/[#&]enc=1(?:&|$)/.test(invLink) ? { enc: true } : {}), ...(inv.split ? { split: true } : {}) }, ...rooms]; await saveRooms()
    pushEnclave()
    holdLink(worker, inv); seedIdentity(inv.room); noteRoom(inv.room)
    joined = inv.room
    emit({ ev: 'rooms', rooms: publicRooms() })
  }

  // ── the sign-in, kept and renewed here ────────────────────────────────────────────────────────────────────────────
  const keepSession = () => { write(st, KEYS.session, sdk.session); for (const r of rooms) seedIdentity(r.room); prefetchWorker() }
  let refreshTimer = null
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer)
    const s = sdk.session; if (!s || !s.exp) return
    refreshTimer = setTimeout(async () => { try { await sdk.refreshSession(); keepSession(); emit({ ev: 'session', keyId: sessionKeyId() }); scheduleRefresh() } catch { /* the next gated read asks to sign in — and once it lapses, the page is told (sync sweep 2026-10-28 #7: wb.vault.info said signed in after it expired) */ const at = (sdk.session && sdk.session.exp) || 0; refreshTimer = setTimeout(() => { if (!signedIn()) emit({ ev: 'signedOut', reason: 'expired' }) }, Math.max(0, at - Date.now()) + 1000) } }, Math.max(5000, s.exp - Date.now() - REFRESH_BEFORE_MS))
  }
  scheduleRefresh()
  let signingIn = null // one sign-in screen at a time, however often the page asks
  async function signIn() { if (!signingIn) signingIn = signInOnce().finally(() => { signingIn = null }); return signingIn }
  async function signInOnce() {
    if (signedIn()) return { email: sdk.session.email }
    if (typeof screens.signIn !== 'function') throw Object.assign(new Error('this vault has no sign-in screen'), { code: 'no_screen' })
    await screens.signIn({
      email: '', // never prefilled by the page (security review): the person types their own address
      sendCode: async (email) => { await sdk.signIn({ email }) },
      verify: async (email, code) => { await sdk.signIn({ email, code }); keepSession(); scheduleRefresh(); loadSiri(); loadBackup() },
    })
    if (!signedIn()) throw Object.assign(new Error('not signed in'), { code: 'sign_in_cancelled' })
    emit({ ev: 'signedIn', email: sdk.session.email, keyId: sessionKeyId() })
    return { email: sdk.session.email }
  }

  // ── the frame ────────────────────────────────────────────────────────────────────────────────────────────────────
  const frame = document.createElement('iframe')
  frame.src = pageUrl.href
  frame.title = o.title || 'App'
  frame.setAttribute('allow', 'clipboard-write; microphone')
  // No allow-top-navigation (security review): the page must not send the whole window — the vault — somewhere else.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals')
  frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;display:' + (frameHidden ? 'none' : 'block')
  ;(o.mount || document.body).append(frame)
  frameEl = frame
  const toPage = (msg) => { try { frame.contentWindow.postMessage({ ch: 'wbvault', ...msg }, pageOrigin) } catch { /* the page is gone */ } }
  const emit = (msg) => toPage({ t: 'event', ...msg })
  // what a direct client's error carries crosses too — status, reason, verdict — so a page reads a refusal the same in a vault
  // (sync sweep 11-08 #28: only the message and code crossed); plain data only, bounded
  const errExtra = (err) => {
    const o = {}
    if (err && Number.isInteger(err.status)) o.status = err.status
    if (err && typeof err.reason === 'string') o.reason = err.reason.slice(0, 500)
    if (err && err.verdict && typeof err.verdict === 'object') { try { const j = JSON.stringify(err.verdict); if (j.length <= 4000) o.verdict = JSON.parse(j) } catch { /* not plain data: left out */ } }
    return o
  }
  const refuse = (id, error, code, extra = {}) => toPage({ t: 'res', id, error, code, ...extra })

  const held = (room) => typeof room === 'string' && rooms.some((r) => r.room === room)
  let creates = [] // when this page last created Spaces (CREATE_LIMIT)
  let speechKeys = [] // when this page last asked for a speech key (SPEECH_LIMIT)

  // ── the account, through the vault's session ────────────────────────────────────────────────────────────────────────
  let _lockedOnce = false // move 3: one locking pass a launch (connections.lock)
  let conns = read(st, KEYS.connections, []) // [{ id, label, host, callKey, account }] — the callKeys never go to the page
  // ⛔ ANOTHER TAB OF THIS VAULT writes the same storage (state machines pass 9, K#1; vaultKeep.js tabStores): the three stores
  //   below were loaded once per tab, so a tab that had not seen an attach stamped it "removed here" at its next pass — gone on
  //   every device. Every write goes through put() (it is this tab's own); every look at the stores adopts what moved first.
  const tabs = tabStores(st, [KEYS.connections, KEYS.siri, KEYS.a2a])
  const put = (k, v) => { write(st, k, v); tabs.wrote(k) }
  function adoptOtherTab () {
    const moved = tabs.moved(); if (!moved.length) return
    if (moved.includes(KEYS.connections)) conns = read(st, KEYS.connections, [])
    const w = who(); if (!w) return
    if (moved.includes(KEYS.siri)) { try { sdk.siri.restore((read(st, KEYS.siri, {}) || {})[w] || null) } catch { /* a malformed copy: keep ours */ } }
    if (moved.includes(KEYS.a2a)) { try { sdk.a2a.restore((read(st, KEYS.a2a, {}) || {})[w] || null) } catch { /* as above */ } }
  }
  try { if (typeof addEventListener === 'function') addEventListener('storage', (e) => { if (e && (e.key === KEYS.connections || e.key === KEYS.siri || e.key === KEYS.a2a)) adoptOtherTab() }) } catch { /* no window (a test) */ }
  const saveConns = () => { put(KEYS.connections, conns); keepSoon() }
  // A CALL KEY WHOSE ATTACH ANSWER WAS LOST (sync sweep 2026-11-14 #5; state machines pass 9, N#7): the SDK keeps it PENDING in the store
  // set here while the answer is out (connections.js postWithPendingKey); a lost answer left a connection the account lists and no key
  // anywhere. Adopted when the account's list shows it (connections.list, below) — the rule the hosted vault uses (connPending.js).
  setPendingKeyStore({
    keep: (id, rec) => { const o = read(st, KEYS.connPending, {}) || {}; o[id] = { ...rec, at: Number(rec && rec.at) || Date.now() }; put(KEYS.connPending, Object.fromEntries(Object.entries(o).slice(-32))) },
    drop: (id) => { const o = read(st, KEYS.connPending, {}) || {}; if (id in o) { delete o[id]; put(KEYS.connPending, o) } },
  })
  const adoptPending = (listedIds, acct) => {
    const have = Object.fromEntries(conns.filter((c) => c.account === acct).map((c) => [c.id, true]))
    const r = adoptPendingKeys(read(st, KEYS.connPending, {}) || {}, listedIds, have)
    for (const [id, k] of r.adopt) conns = [{ id, label: k.label || '', host: k.host || '', callKey: k.callKey, account: acct }, ...conns.filter((c) => c.id !== id)]
    put(KEYS.connPending, r.pending)
    if (r.adopt.length) saveConns()
  }
  // Siri's state (the inbox private keys) is kept PER ACCOUNT: a second person signing in on this vault never gets the
  // first one's keys, and the first one's come back when they sign in again.
  const who = () => (signedIn() ? String(sdk.session.email || '').toLowerCase() : '')
  const saveSiri = () => { const w = who(); if (!w) return; const all = read(st, KEYS.siri, {}); all[w] = sdk.siri.state; put(KEYS.siri, all); keepSoon() }
  const saveA2A = () => { const w = who(); if (!w) return; const all = read(st, KEYS.a2a, {}); all[w] = sdk.a2a.state; put(KEYS.a2a, all); keepSoon() }
  // ── THE SAME THREE ON EVERY DEVICE OF THE ACCOUNT (vaultKeep.js; sync sweep 2026-11-11 P7): a second device listed this account's
  //   connections but could not use one (`not_in_vault`), and could not open Siri or an outside agent's message. Synced, sealed,
  //   through the account's index room — only while the backup is on (it is what derives that room). One pass at a time; a pass
  //   that finds another account signed in when it lands keeps nothing.
  let keepT = null, keepRun = null, keepAgain = 0, keepMoved = null
  const KEEP_AGAIN_MAX = 3 // passes in a row for a vault that changed while one was out; past it the minute's pass takes over
  function keepSoon (ms = 1500) { clearTimeout(keepT); keepT = setTimeout(() => { keepSync().catch(() => {}) }, ms) }
  async function keepSync () {
    if (keepRun) return keepRun
    keepRun = (async () => {
      const w = who()
      if (!w || !sdk.backup.enabled || !sdk.backup._s) return { ok: false, why: 'off' }
      const acct = await sdk._account().catch(() => '')
      if (!acct || who() !== w) return { ok: false, why: 'off' }
      const loc = await sdk.account._where() // { room, mk, master, app }: `app` (the app's account-store key) → the keep is also the app's xindex2 (vaultKeep.js, phase 4)
      try { await sdk.account._ensureRoom(loc) } catch (e) { return { ok: false, why: 'unreachable' } }
      if (who() !== w) return { ok: false, why: 'moved' } // signed out during that round trip (pass 9, K#2): a pass over the EMPTIED stores stamped every lane and Siri gone, on every device
      const allKeep = read(st, KEYS.keep, {}) || {}
      const prev = allKeep[w] || null
      // ⛔ WHAT IS KEPT AS `prev` AND WHAT IS APPLIED IS keepPass's WORD (vaultKeep.js; sync sweep 2026-11-12 #1 #2): the merged view
      //   only from a pass that saved while nothing changed here. It was recorded whatever the pass answered — after one failed
      //   save the next pass deleted the other devices' connections, Siri and outside agents on every device — and applied over
      //   a connection attached meanwhile.
      keepMoved = null
      const p = await keepPass({ loc, client: sdk._client, prev, read: () => { adoptOtherTab(); return { conns: conns.filter((c) => c.account === acct), siri: sdk.siri.state, a2a: sdk.a2a.state } },
        settle: (p) => { // in keepPass's own step, right after it looked at the stores: no attach or detach can land in between
          if (who() !== w || !p.record) return
          if (p.apply) applyKeep(acct, p.apply) // into the stores FIRST: were it to throw, `prev` stays what the stores hold
          const all2 = read(st, KEYS.keep, {}) || {}; all2[w] = p.record; write(st, KEYS.keep, all2)
        } })
      if (who() !== w) return { ok: false, why: 'moved' }
      const ch = keepMoved; keepMoved = null; if (ch) pushAfterApply(w, ch) // what the apply moved at the Sentinel's side (K#8)
      if (p.again && keepAgain < KEEP_AGAIN_MAX) { keepAgain++; keepSoon(300) } else if (!p.again) keepAgain = 0 // what changed meanwhile: now, not at the minute
      return p
    })()
    try { return await keepRun } finally { keepRun = null }
  }
  // ⛔ WHAT THE SENTINEL HOLDS FOLLOWS THE MERGED VIEW (state machines pass 9, K#8): a change pushes the device's WHOLE record,
  //   so of two devices that changed a lane (or Siri) inside one interval the later push won at the Sentinel — a removed agent's
  //   token granted again, a new one's revoked — and after the keep merged them nothing pushed the merged record. Now an apply
  //   that changed what the Sentinel is sent (the public halves, the token hashes, the aliases, the key) pushes it, after the
  //   pass. A merged Siri with no key is a setup deleted on another device: it is revoked here too (a copy pushed after that
  //   delete would have granted the old key again).
  const a2aSent = () => { try { return JSON.stringify(Object.entries(sdk.a2a._s.lanes).sort(([a], [b]) => (a < b ? -1 : 1)).map(([room, l]) => [room, l.handle, l.name, l.description, l.pub, l.peers.map((p) => [p.id, p.tokenHash, p.reply, !!p.job])])) } catch { return '' } }
  const siriSent = () => { try { const s = sdk.siri.state; return JSON.stringify([s.token, s.defaultRoom, Object.entries(s.rooms).sort(([a], [b]) => (a < b ? -1 : 1)).map(([r, v]) => [r, v.alias, v.label, v.pub])]) } catch { return '' } }
  function pushAfterApply (w, ch) { // after the pass, never inside it: the answer is the Sentinel's, the keep is already settled
    if (who() !== w) return
    if (ch.a2a) sdk.a2a._push().catch(() => { /* the next change, or the next apply that moves it, pushes again */ })
    if (ch.siri) {
      if (sdk.siri.state.token) sdk.siri._push().catch(() => { /* as above */ })
      else if (ch.hadKey) sdk.siri.revoke().then(() => saveSiri(), () => { /* as above */ })
    }
  }
  function applyKeep (acct, keep) { // the merged view into this vault — written straight to storage (no new stamp: it IS the merged state)
    const v = viewOfKeep(keep), w = who()
    const was = { a2a: a2aSent(), siri: siriSent(), hadKey: !!sdk.siri.state.token }
    conns = [...v.conns.map((c) => ({ ...c, account: acct })), ...conns.filter((c) => c.account !== acct)]
    put(KEYS.connections, conns)
    if (v.siri) { try { sdk.siri.restore(v.siri); const all = read(st, KEYS.siri, {}); all[w] = sdk.siri.state; put(KEYS.siri, all) } catch { /* a malformed copy: keep ours */ } }
    try { sdk.a2a.restore(v.a2a); const all = read(st, KEYS.a2a, {}); all[w] = sdk.a2a.state; put(KEYS.a2a, all) } catch { /* as above */ }
    keepMoved = { a2a: a2aSent() !== was.a2a, siri: siriSent() !== was.siri, hadKey: was.hadKey } // read by keepSync after the pass (K#8)
  }
  const loadSiri = () => { // and A2A's: the same rule
    const w = who()
    sdk.siri.restore(w ? (read(st, KEYS.siri, {}) || {})[w] || null : null)
    sdk.a2a.restore(w ? (read(st, KEYS.a2a, {}) || {})[w] || null : null)
    // and the account's INVITE KEY for this vault's app (sdkRekey.js): kept here, never shown to the page; published once per launch
    const inv = w ? (read(st, KEYS.invite, {}) || {})[w] || null : null
    if (inv) { try { sdk.invite.restore(inv) } catch { /* a malformed copy: the next sign-in publishes a fresh one */ } }
    if (signedIn()) { sdk._enrollInvite(); Promise.resolve(sdk._inviteP).then(saveInvite, () => {}) }
  }
  const saveInvite = () => { const w = who(); const v = sdk.invite.state; if (!w || !v) return; const all = read(st, KEYS.invite, {}); all[w] = v; write(st, KEYS.invite, all) }
  loadSiri()
  const a2aView = (room) => { const l = sdk.a2a._s.lanes[room]; return l ? { endpoint: sdk.a2a.endpoint, handle: l.handle, peers: l.peers.map(({ id, name, reply, job }) => ({ id, name, reply, ...(job ? { job: true } : {}) })) } : null }
  async function laneA2A(room, m, args) {
    const it = rooms.find((x) => x.room === room)
    const shim = new LaneA2A({ room, _sharedRoom: (it && it.lane) || null, _wb: sdk, on: () => {}, messages: [] })
    let result
    if (m === 'view') result = null
    else if (m === 'pull') {
      const c = sdk.a2a._s.lanes[room]
      if (!c) result = []
      else {
        const r = await sdk.a2a._plain('a2apull', { handle: c.handle })
        result = []
        for (const x of Array.isArray(r.items) ? r.items : []) { const o = await openItem(c, x); if (o) result.push({ taskId: x.taskId, n: x.n, m: o.m, peer: { id: o.peer.id, name: o.peer.name, reply: o.peer.reply, ...(o.peer.job ? { job: true } : {}) } }) }
      }
    } else if (m === 'ack') { const a = args[0] || {}; result = await sdk.a2a._plain('a2aack', { items: [{ taskId: String(a.taskId || ''), n: Number(a.n) || 0 }] }) }
    else if (m === 'reply') result = await shim.reply(args[0], args[1], args[2] || {})
    else if (m === 'enable' && !(it && it.lane)) throw Object.assign(new Error('vault: A2A reaches a private lane, and this Space is not one'), { code: 'not_a_lane' })
    else result = await shim[m](...args)
    // THE TOKEN STAYS IN THE VAULT (sync sweep 2026-11-14 #3): it is the outside agent's bearer for as long as it lives, so it is shown
    // once on the vault's own screen and the page gets the id only — as the Siri key (siriShortcut) and the hosted vault (vaultPeerTokens.js)
    if (m === 'addPeer' && result) {
      const v = a2aView(room), show = await screenFor('peerToken')
      if (show && result.token) await show({ name: String(args[0] || ''), token: result.token, ...(v && v.handle ? { cardUrl: cardUrlOf(v.endpoint, v.handle), mcpUrl: mcpUrlOf(v.endpoint, v.handle) } : {}) })
      result = { id: result.id, token: null, shown: !!(show && result.token) }
    }
    else if (result && typeof result === 'object' && 'cardUrl' in result) result = {}
    saveA2A()
    return { result, view: a2aView(room) }
  }
  // a signed webhook's path and a job agent's mark ride too (sweep 10-24 #5: dropped here, a webhook or job connection granted
  // from a vault reached its Spaces as a plain API) — neither is a secret (connectionEntry.js roomConnection / roomJob)
  const hookOf = (c) => ({ ...(c && typeof c.webhook === 'string' ? { webhook: c.webhook } : {}), ...(c && c.webhook && c.job && typeof c.job === 'object' ? { job: c.job } : {}) })
  const pub = (c) => (c && typeof c === 'object' ? { id: c.id, label: c.label || '', host: c.host || '', account: c.account || '', ...(c.mcp ? { mcp: true } : {}), ...hookOf(c) } : c)
  // The Shortcut KEY posts words into the person's Spaces for as long as it lives: it is shown only in the vault's own
  // screen (siri.showKey → screens.siriKey), never handed to the page (security review). The page learns that one exists.
  const siriShortcut = () => { const s = sdk.siri.shortcut; return { key: null, hasKey: !!s.key, endpoint: s.endpoint } }
  // A Space for the vault's own use: the SDK's own code (grant, Siri) over the worker, which holds the key and signs.
  const workerClient = { keyless: true }
  // never `stop`: the worker's op path calls client[op](room, mk, …), and spaceClient.stop(room, key) would post the ROOM KEY as
  // the stop key (sync sweep, 10-16 #11 — latent: nothing calls it here). The page's own stop goes through CALLS, keyless.
  // toolBook is the VAULT's own (space.connections.grant runs here, through roomAccount — toolBooks.js), never the page's: a page that
  // posted one wrote a Space's tool list with no confirm (sync sweep 11-18)
  const INTERNAL_OPS = [...PAGE_OPS, 'toolBook'].filter((op) => op !== 'stop')
  // ── A SPACE RE-KEYED IN PLACE (sdkRekey.js, https://witbitz.chat/docs/sdk-people.md#members): an op with the room's old key is answered
  // `stale_key`; the vault takes this account's grant (opened with ITS invite key — the page never sees either), hands the new key to
  // the worker and runs the op once more. The page hears { ev:'key', room, kind:'rekeyed'|'removed'|'pending' }.
  const keyWaits = new Map(), keyAdopting = new Map()
  const relinkRoom = (room, k) => { const it = rooms.find((x) => x.room === room); if (!it || !it.link) return; it.link = relink(it.link, k.userShare ? { userShare: k.userShare, commit: k.commit } : { mk: k.mk }); saveRooms(); noteRoom(room).catch(() => {}) }
  // WHAT A (RE)LOADED PAGE MUST KNOW AT ONCE (sync sweep 11-09, 11-08 #27 half fixed): followKey says a room's 'removed' /
  // 'pending' once, when it changes — a page that reloads never hears it again, so its new Space polled at full speed and
  // never knew it was removed. The welcome carries what is held now (a grant that merely could not be read is not news).
  const keyStatesNow = () => [...keyWaits].filter(([, w]) => w.why !== 'grant_unavailable').slice(-200).map(([room, w]) => ({ room, kind: w.why === 'removed' ? 'removed' : 'pending', ...(w.why !== 'removed' ? { reason: w.why } : {}) }))
  function followKey(room) {
    if (keyAdopting.has(room)) return keyAdopting.get(room)
    const w = keyWaits.get(room)
    if (w && Date.now() - w.at < 15000) return Promise.resolve(false)
    const p = (async () => {
      const g = await wcall({ t: 'op', op: 'grant', room, args: [] }).catch(() => null)
      const it0 = rooms.find((x) => x.room === room)
      const k = await openGrant(g, room, sdk.invite._key(), { gated: !!(it0 && /[#&]gate=email(?:&|$)/.test(String(it0.link || ''))) }) // a link Space: 'link_changed', never 'removed'
      if (k.removed || k.wait) {
        const why = k.removed ? 'removed' : k.wait
        const was = keyWaits.get(room); keyWaits.set(room, { at: Date.now(), why })
        if (why !== 'grant_unavailable' && (!was || was.why !== why)) emit({ ev: 'key', room, kind: k.removed ? 'removed' : 'pending', ...(k.wait ? { reason: k.wait } : {}) })
        return false
      }
      if (k.userShare) await wcall({ t: 'rememberSplit', room, userShare: k.userShare, commit: k.commit, ep: k.epoch })
      else await wcall({ t: 'remember', room, mk: k.mk, ep: k.epoch })
      keyWaits.delete(room); relinkRoom(room, k)
      emit({ ev: 'key', room, kind: 'rekeyed', epoch: k.epoch })
      return true
    })().catch(() => false).finally(() => keyAdopting.delete(room))
    keyAdopting.set(room, p)
    return p
  }
  sdk.invite._onRestore = () => keyWaits.clear() // a restored invite key: every Space waiting for one tries again at once
  // THE SERVER SAYS THIS ROOM IS CONFIDENTIAL (agent/tierGuard.mjs: `confidential_room`, or a poll's `tier: 'enclave'`): the
  // vault learns the tier from the answer, as the app does (l1.js learnTier) — `enc` came only from a `#enc=1` link or a
  // create, so a room joined by an older link was never woken before a member change (sync sweep backlog P2)
  const learnTier = (room, r) => {
    if (!room || !saysConfidential(r)) return
    const it = rooms.find((x) => x.room === room); if (!it || it.enc) return
    it.enc = true; saveRooms(); try { pushEnclave() } catch { /* the next op re-sends the snapshot */ }
  }
  const opHealed = async (op, room, args) => {
    const r = await wcall({ t: 'op', op, room, args })
    learnTier(room, r)
    if (!r || r.error !== 'stale_key' || op === 'grant' || op === 'rekey' || !(await followKey(room))) return r
    return wcall({ t: 'op', op, room, args })
  }
  for (const op of INTERNAL_OPS) workerClient[op] = (room, _mk, ...args) => opHealed(op, room, args)
  // A LANE ROOM IS OPENED AS A LANE (sync sweep, 10-16 #7): as a plain Space, lane.siri.collect posted Siri drops with no
  // bridge to its shared room and none of the lane's actions or links. Keyless both ways — the worker holds both keys.
  const roomSpace = (room) => {
    const it = rooms.find((x) => x.room === room)
    if (it && it.lane) return new Lane(workerClient, { room, mk: null, link: null, wb: sdk, live: false, poll: false, sharedRoom: it.lane, sharedMk: null })
    return new Space(workerClient, { room, mk: null, link: null, wb: sdk, live: false, poll: false })
  }
  const wop = (op, room, ...args) => opHealed(op, room, args)
  // ── a move (fork): the SDK's own fork(), run HERE over the worker — it needs the room's key (the new room's goes in the
  // notice, sealed to each keeper's device) and the session's signing key, both the vault's
  const keyedClient = { create: async (cfg, co = {}) => { const r = await wcall({ t: 'create', cfg, base: location.origin, returnMk: true, ...(co.split ? { split: true } : {}) }); return { room: r.room, mk: r.mk, links: [r.link], commit: r.commit, ...(co.split ? { userShare: linkParts(r.link).userShare } : {}) } } }
  for (const op of [...INTERNAL_OPS, 'carry', 'rekey', 'grant']) keyedClient[op] = (room, _mk, ...args) => wop(op, room, ...args) // rekey/grant: a member change in place, below — never a page op
  // ── a member change IN PLACE (sdkRekey.js): the SDK's own rule, run HERE over the worker, which makes and keeps the new key; the
  // person confirms in the vault's pixels (a page script alone cannot change who is in, or the key)
  async function inPlace(room, admission, rotate) {
    if (!held(room)) throw Object.assign(new Error('vault: this vault holds no Space ' + String(room).slice(0, 40)), { code: 'not_in_vault' })
    if (!signedIn()) throw Object.assign(new Error('vault: sign in first'), { code: 'sign_in_required' })
    const it = rooms.find((x) => x.room === room)
    const parts = linkParts(it.link) || {}
    const emails = rotate ? [] : (admission && Array.isArray(admission.emails) ? admission.emails : []).map((x) => String(x).slice(0, 80))
    const sp = new Space(keyedClient, { room, mk: parts.mk || null, link: it.link, wb: sdk, live: false, poll: false, gated: true, split: !!parts.split }) // a split room: no key here — the worker holds it
    // A SLEEPING CONFIDENTIAL SPACE (sweep 10-25 #1): the SDK wakes one before its first read only when its OWN enclave list
    // holds the room (sdkRekey changeable), and the vault keeps the tier in `rooms[].enc` — so wake it here and hand the worker
    // the fresh attestation (as the open does, below), or the read is refused and the person sees "couldn't read the members".
    if (it.enc) { try { await sdk._encWake(room, { tries: 8 }); pushEnclave() } catch { /* changeable's read says what is wrong */ } }
    // MAY THIS PERSON? before asking them (sweep 10-23 #21: the vault asked "Change the members of …?" and then refused not_admin)
    let cur = null
    try { cur = await changeable(sp, rotate ? 'rotateKey' : 'changeMembers') } catch (e) { sp.close(); throw e }
    // A ROLE CHANGE KEEPS THE KEY AND EVERYONE IN IT (sweep 10-24 #8; sdkRekey changeMembers `roles`): said as that, and no
    // `rekeyed` after it — "anyone else can no longer read" was not true
    // …decided as changeMembers decides it — the list after, hidden members counted (sweep 10-26 #3: the shown addresses alone
    // made a default Space's role change "anyone else can no longer read", and a dropped hidden member "its members stay the same")
    let plan = null
    try { plan = rotate ? null : await planMembers(sp, admission, cur && cur.cfg) } catch (e) { sp.close(); throw e }
    const roleOnly = !!(plan && plan.roles)
    const ok = await confirmWith(roleOnly
      ? { title: 'Change who manages ' + titleOf(room) + '?', text: 'Its members stay the same, and so does its key: only who may manage it changes.', ok: 'Change', cancel: 'Cancel' }
      : rotate
      ? { title: 'Change the key of ' + titleOf(room) + '?', text: 'Everyone in it gets the new key. A copy of the old key opens nothing written from now on.', ok: 'Change the key', cancel: 'Cancel' }
      : { title: 'Change the members of ' + titleOf(room) + '?', text: 'Its members will be: ' + (emails.slice(0, 6).join(', ') || 'only you') + (emails.length > 6 ? ' and ' + (emails.length - 6) + ' more' : '') + '. Anyone else can no longer read what is written from now on.', ok: 'Change', cancel: 'Cancel' }).catch(() => false)
    if (!ok) { sp.close(); throw Object.assign(new Error('cancelled'), { code: 'cancelled' }) }
    try {
      const r = rotate ? await rotateKey(sp) : await changeMembers(sp, admission)
      it.link = sp.shareLink; saveRooms(); noteRoom(room).catch(() => {})
      if (!r.roles) emit({ ev: 'key', room, kind: 'rekeyed', epoch: r.epoch })
      const { link: _l, ...out } = r // the link carries the key: the page asks for it with share()
      return out
    } finally { sp.close() }
  }
  // A Space no longer moves (2.3.0; the owner, 2026-10-23: "only in place"): members change in place (inPlace, above).
  async function fork() { throw Object.assign(new Error('vault: a Space no longer moves to a new room — members change in place (space.changeMembers)'), { code: 'use_change_members' }) }
  // ── following a move: the notice is read from the ROOM (never taken from the page — a page could forge one pointing
  // anywhere), judged with this vault's signing key by the rules the app and the SDK share (emailFork.js)
  async function follow(room, id) {
    if (!held(room)) throw Object.assign(new Error('vault: this vault holds no Space ' + String(room).slice(0, 40)), { code: 'not_in_vault' })
    if (!signedIn()) return { followed: false }
    const p = await readAllPages((since) => wop('pollSealed', room, undefined, since))
    const e = ((p && p.entries) || []).find((x) => x && x.kind === 'fork' && x.id === String(id || ''))
    if (!e) return { followed: false }
    const cfg = await wop('getConfig', room)
    // forkAuthority: in a room with no admins or owners, only a move SIGNED by its creator key is followed (the app's rule)
    const v = await judgeMove(e, { cfg, signPriv: sdk.session.sign.priv, room, forkAuthority: (cfg && cfg.forkAuthority) || null })
    if (!v) return { followed: false }
    if (v.refuse) return { refused: String(v.refuse) }
    const o = v.follow
    // the link the notice carries must BE the room and key it names — else a later restart would remember a key the
    // notice smuggled in for another (held) room (security review)
    const lp = linkParts(o.link)
    // a split-key room's link holds HALF a key and its commitment, never the key (sync sweep 10-15 #4: every split move
    // was refused here): the half must commit to the key the notice carries — and only the half is kept, as an invite's
    const linkOk = lp && lp.room === o.room && (lp.split ? !!lp.commit && lp.commit === (await keyCommit(o.mk).catch(() => '')) : lp.mk === o.mk)
    if (!linkOk) return { refused: 'the move\'s link does not match its room' }
    const govCfg = cfg || {}
    const authority = (govCfg.admins && (govCfg.admins.emails || []).length) || (govCfg.owners && (govCfg.owners.emails || []).length) || govCfg.forkAuthority
    // A CONFIDENTIAL move is refused BEFORE the person is asked (sync sweep, 10-18 #11: "Follow it there?" was asked, then refused)
    if (/[#&]enc=1(?:&|$)/.test(String(o.link || ''))) return { refused: 'a confidential move is not available in a vault yet', code: 'vault_unsupported' }
    if (!authority && !held(o.room)) { // nobody in this room holds the move: the person decides
      const ok = await confirmWith({ title: titleOf(room).replace(/^this Space$/, 'This Space') + ' moved to a new Space', text: 'Someone in it moved it. Follow it there?', ok: 'Follow', cancel: 'Not now' }).catch(() => false)
      if (!ok) return { followed: false }
    }
    if (held(o.room)) return { room: o.room } // followed already
    if (lp.split) holdLink(worker, lp); else worker.postMessage({ t: 'remember', room: o.room, mk: o.mk }); seedIdentity(o.room)
    if (v.needsGovCheck) {
      const gv = await checkNewRoomGov(() => wop('getConfig', o.room), e.gov, o.room) // a failed read is retried, and is not a mismatch (emailFork.checkNewRoomGov)
      if (gv !== 'keeps') { await wcall({ t: 'forget', room: o.room }).catch(() => null); return gv === 'unreadable' ? { refused: 'the new room could not be read yet — try again', code: 'unreadable' } : { refused: 'the new room\'s owners or admins are not what the move declared' } }
    }
    const was = rooms.find((x) => x.room === room)
    rooms = [{ room: o.room, link: o.link, title: (was && was.title) || '', at: Date.now(), ...(lp.split ? { split: true } : {}) }, ...rooms]; saveRooms(); noteRoom(o.room)
    emit({ ev: 'rooms', rooms: publicRooms() })
    return { room: o.room }
  }
  // ── the guest book: this vault's device in each EMAIL-GATED room it holds, so a move finds it (Space._announce's rule)
  const announced = new Set()
  async function announce(room) {
    if (!held(room) || !signedIn() || announced.has(room + '\n' + sdk.session.sign.pub)) return { announced: false }
    const cfg = await wop('getConfig', room).catch(() => null)
    if (!cfg || cfg.admission !== 'email') return { announced: false }
    announced.add(room + '\n' + sdk.session.sign.pub)
    // read back and announce again while the row (or the gate's record of it) is missing — two announces at once: the last wins
    const self = selfRow({ signPub: sdk.session.sign.pub })
    for (let i = 0; i < 3; i++) {
      const r = await wop('state', room, ROSTER_DOC).catch(() => null)
      if (!r || r.status !== 200) return { announced: i > 0 }
      const { roster, changed } = ensureSelf(r.state, self)
      if (!changed && !unseenIn(r.seen, self.id) && !entriesMissing(r.seen, self.id, room)) break // entries: one more announce per page, never retried
      await wop('state', room, ROSTER_DOC, roster).catch(() => null); announcedIn(room, self.id)
      await new Promise((res) => setTimeout(res, 200 + Math.floor(Math.random() * 600)))
    }
    return { announced: true }
  }
  const titleOf = (room) => { const it = rooms.find((x) => x.room === room); return it && it.title ? '“' + it.title + '”' : 'this Space' }
  // the device whose index entry names its key (spk), on an account on the service: signed out THERE too (accountCall's signOut)
  const revokesAtService = (id) => { const b = sdk.backup, d = sdk.account._devices && sdk.account._devices[id]; return !!(d && typeof d.spk === 'string' && d.spk && b._v2 && b.service === 'account' && b.enabled) }
  const confirmCall = async (ns, m, args, room) => {
    const a = args[0], q = {
      'connections.detach': { title: 'Remove this connection?', text: 'Every Space that uses it stops being able to.', ok: 'Remove' },
      'usernames.claim': { title: 'Take the username @' + String(a || '').replace(/^@/, '').slice(0, 40) + '?', text: (args[1] && args[1].publish) ? 'It will be listed, so people can find you by it.' : 'It is yours until you release it.', ok: 'Take it' },
      'usernames.release': { title: 'Release your username?', text: 'Someone else may take it.', ok: 'Release' },
      'siri.rotateKey': { title: 'Make a new Siri key?', text: 'The Shortcut stops working until you give it the new key.', ok: 'New key' },
      'siri.revoke': { title: 'Turn the Siri inbox off?', text: 'Siri stops delivering to every Space.', ok: 'Turn off' },
      'a2a.addPeer': { title: 'Let the outside agent “' + String(a || '').slice(0, 40) + '” reach this lane?', text: (args[1] && args[1].job === true) ? 'An agent that takes jobs: it reports here and reads no answer — its reports are told to you.' : (args[1] && args[1].reply === 'auto') ? 'Its messages will be answered by the assistant on its own, without asking you.' : 'You approve every answer before it is sent.', ok: 'Allow' }, // a job agent reads no answers (sweep 10-25 #9)
      'a2a.revoke': { title: 'Turn outside agents off?', text: 'Every lane\'s card and every agent\'s token stop working.', ok: 'Turn off' },
      'backup.remove': { title: 'Remove ' + titleOf(a) + ' from your account?', text: 'It goes from every device that keeps this account.', ok: 'Remove' },
      'account.forget': { title: 'Remove ' + titleOf(a) + ' from your account?', text: 'It goes from every device that keeps this account.', ok: 'Remove' },
      // on the account service it is revoked at once, after the emailed code (accountCall's signOut, 94c06f12b); else it is marked in
      // the index — either way it forgets the account the next time it is online (sync sweep 11-22 #17: it said "at its next sync")
      'account.signOut': { title: 'Sign that device out of your account?', text: (revokesAtService(a) ? 'It is signed out of your account at once — we email you a code to confirm — and forgets ' : 'It forgets your account and ') + 'your Spaces the next time it is online.', ok: 'Sign out' },
      'backup.signOutOthers': { title: 'Sign out all your other devices?', text: 'Every other device forgets your account and its Spaces the next time it opens. This device stays signed in. We email you a code to confirm.', ok: 'Sign them out' },
      'backup.newRecoveryCode': { title: 'Make a new recovery code?', text: 'Your current code stops working, and every other device is signed out. We email you a code to confirm, then show the new recovery code once.', ok: 'New code' },
      'backup.deleteAccount': { title: 'Delete your account?', text: 'Your account and its backup are deleted for good, and every device is signed out — this one too: it forgets your Spaces. We email you a code to confirm.', ok: 'Delete' },
      // an MCP server's chosen tools may run WITHOUT asking (`auto`; the SDK's recommended ones when none are named) — the prompt
      // says so instead of "always with your approval" (sweep 10-24 #7)
      'connections.grant': { title: 'Let the assistant in ' + titleOf(room) + ' use ' + (conns.find((c) => c.id === (a && a.id ? a.id : a)) || {}).label + '?', text: (conns.find((c) => c.id === (a && a.id ? a.id : a)) || {}).mcp && !(args[1] && Array.isArray(args[1].auto) && !args[1].auto.length) ? 'It can use this server\'s tools — some may run without asking you (the ones marked so) — and never sees the secret.' : 'It can call it — always with your approval — and never sees the secret.', ok: 'Allow' },
    }[ns + '.' + m]
    if (q && !(await confirmWith({ cancel: 'Cancel', ...q }).catch(() => false))) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
  }
  let askSeq = 0
  const asks = new Map()
  const askPage = (kind, data) => new Promise((res, rej) => {
    const id = ++askSeq
    const timer = setTimeout(() => { if (asks.delete(id)) rej(Object.assign(new Error('the page did not answer'), { code: 'vault_timeout' })) }, ASK_MS)
    asks.set(id, { res, rej, timer })
    toPage({ t: 'ask', id, kind, ...data })
  })
  // ── the BACKUP and the account INDEX: the vault's own (sdk.backup / sdk.account), over the Spaces this vault holds ─────
  // Every Space the vault holds is recorded (noteRoom); a room another device added comes in, one it dropped from the
  // account goes (fromBackup, after each sync). What the page sees is a VIEW — never a link, a key or the master secret.
  const accountView = () => {
    const b = sdk.backup, a = sdk.account
    return {
      enabled: b.enabled, format: b.format, service: b.service, deviceId: a.deviceId, // service: 'account' (the Witbitz account service) | 'legacy' | null
      rooms: b.rooms.map(({ room, kind, label, shared, archived }) => ({ room, kind, ...(label ? { label } : {}), ...(shared ? { shared } : {}), ...(archived ? { archived: true } : {}) })),
      devices: a.devices, links: a.links, lastError: a.lastError ? String(a.lastError.message || a.lastError).slice(0, 200) : null,
      erasure: sdk.erasure.available,
      gated: !!b.gated, // a restore and deleting the account need the emailed code as well (sync sweep 11-09 #24)
    }
  }
  const emitAccount = () => { handDownPushAcct().catch(() => {}); emit({ ev: 'account', view: accountView() }) }
  // THE ACCOUNT PUSH TAG (spaceClient pushAcctField; sync sweep 11-16 #14 — as our apps' notifications.js handDownPushAcct): every
  // device of the account derives one secret from its INDEX room key, so a turn from one tickles none of the others and an approval
  // reminder finds them. Here the index key is this page's (sdkAccount indexRoomOf), so the secret — a one-way derivation — goes to
  // the key worker. Only in a vault that sends notifications.
  async function handDownPushAcct() {
    if (!vpush) return
    const b = sdk.backup, m = b && b.enabled && b._s && b._s.master
    const secret = m ? await pushAcctSecretOf((await indexRoomOf(m)).mk) : ''
    if (secret === pushAcctSecret) return
    pushAcctSecret = secret
    try { worker.postMessage({ t: 'setPushAcct', secret }) } catch { /* the replay sends it to the next one */ }
  }
  // § 8.8: a signed-out device's push address leaves every Space this vault holds (op pushdrop — keyless; as our vault's withdrawPush)
  async function withdrawPushEverywhere(endpoints) {
    const eps = (endpoints || []).filter((x) => typeof x === 'string' && /^https:\/\//.test(x))
    let failed = 0
    for (const e of eps) for (const { room } of rooms) {
      if (/^tmp-/.test(room)) continue
      let ok = false
      try { const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'pushdrop', room, subscription: { endpoint: e } }) }); ok = r.status === 200 } catch { ok = false }
      if (!ok) failed++
    }
    return failed === 0
  }
  // ONE BACKUP PER ACCOUNT (security review): kept under the signed-in email ('' while nobody is signed in), so a second
  // person signing in on this vault never sees, saves to or syncs the first one's backup — it holds their room links.
  // SEALED ON DISK (vaultAtRest.js): opened once at start into memory, each account's write sealed alone (another account's entry
  // is carried over as it is on disk — another tab's write); another tab's change is opened again from the storage event.
  let backupMem = backupsAtStart
  const backups = () => ({ ...backupMem })
  try { if (typeof addEventListener === 'function') addEventListener('storage', (e) => { if (e && e.key === KEYS.backup) atRest.flushed().then(() => atRest.loadBackups(KEYS.backup)).then((b) => { backupMem = b }, () => {}) }) } catch { /* no window (a test) */ }
  let adopting = false
  sdk.backup.onState = (s) => { if (adopting) return; const w = who(), all = backups(); if (s) all[w] = s; else delete all[w]; backupMem = all; atRest.putBackup(KEYS.backup, w, s || null); emitAccount() }
  sdk.account.onChange = () => { fromBackup(); emitAccount(); keepSoon(200) }
  // another device signed this one out of the ACCOUNT (its index): the same wipe as the v2 path and a sign-out here. `reason: 'erased'`
  // (the account was deleted) reaches the page — our hosted vault says "Your account is deleted" (sync sweep 11-22 #6)
  sdk.account.onSignedOut = (e) => { const why = e && e.reason === 'erased' ? 'erased' : ''; const tell = () => emit({ ev: 'accountSignedOut', ...(why ? { reason: why } : {}) }); wipeSignedOut().then(tell, tell) }
  // ── THE WITBITZ ACCOUNT SERVICE (sdkBackupV2.js; account recovery v2, as our own apps since 2026-11-15): with a tenant, NEW accounts
  //    start there; an account already on the old store stays there; a restore asks it first. Its device keys: this origin's
  //    IndexedDB, one per account. A new recovery code is kept on disk (read back) before it is activated.
  const persistNow = async (state) => {
    const w = who()
    backupMem = { ...backupMem, [w]: state }
    await atRest.putBackup(KEYS.backup, w, state)
    const back = (await atRest.loadBackups(KEYS.backup))[w]
    return !!(back && back.v2 && back.v2.pending && state.v2 && state.v2.pending && back.v2.pending.master === state.v2.pending.master)
  }
  sdk.backup._v2 = o.accountService === false ? null : accountService({ tenant: o.tenant, ...(typeof o.accountService === 'string' && o.accountService ? { base: o.accountService } : {}), fetch: (...a) => fetch(...a), keyStore: idbKeyStore('wbvault-acct'), persistNow, onRevoked: () => accountStatus(true), afterSignOut: (address) => { if (roomPass) roomPass.renewNow(address) },
    // the endpoint once the subscription is KNOWN (vpush.ready) — not known within 15 s: undefined, and nothing is sent (Codex 11-16 #2)
    ...(vpush ? { pushEndpoint: async () => ((await Promise.race([vpush.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 15000))])) ? (vpush.endpoint() || null) : undefined), withdrawPush: withdrawPushEverywhere } : {}) }) // § 8.8, only where this vault sends notifications (sync sweep 11-16 #14)
  roomPass = makeRoomPassHolder({
    on: () => roomPassSwitchOn(st),
    account: () => { const b = sdk.backup, s = b && b._s; return b && b._v2 && b.enabled && s && s.v2 && s.v2.svc && s.v2.svc.acct ? { id: s.v2.svc.acct, ask: (email, sessionPub) => b._v2.roomPass(b, email, sessionPub), onRevoked: () => accountStatus(true) } : null },
  })
  // § 8.5 THE STATUS CHECK: at launch, on a return to the foreground (at most daily), at once after a refusal as signed out. A device
  // signed out elsewhere (or whose account was deleted) forgets the account here: its backup, and the Spaces it listed.
  let statusRun = null
  function accountStatus(force = false) {
    const b = sdk.backup
    if (statusRun || !b._v2 || !b._s || !b._s.v2) return statusRun
    const was = b.enabled
    statusRun = b._v2.status(b, { force, onSignedOut: async (gone) => {
      void gone // every held Space goes, not only the ones the account listed (the old rule left a Space made since on this device)
      await wipeSignedOut()
      emit({ ev: 'accountSignedOut' })
    } }).then(async (r) => {
      // a first code whose activation's answer was lost, adopted now: the account starts here as it does at launch (review)
      if (!was && b.enabled) { noteDeviceSpk(); sdk.account.start(); keepSoon(500); for (const x of rooms) await noteRoom(x.room) }
      // F-01: a new code that was SHOWN but never activated was just dropped — the person may have written it down (sync sweep
      // 11-16 #13; our apps' words, acctV2VaultWiring.js / acctV2Wiring.js). Not awaited: the check is not held by the card.
      if (r && r.pending === 'dropped') confirmWith({ title: 'Your new recovery code was not activated', text: 'The connection dropped before it was. Your PREVIOUS recovery code still works — make a new code again if you want to replace it.', ok: 'OK', cancel: 'Close' }).catch(() => {})
    }).catch(() => null).finally(() => { statusRun = null; emitAccount() })
    return statusRun
  }
  try { if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') accountStatus() }) } catch { /* no document (a test) */ }
  // this device's key on the account service, into its own index entry (sdkAccount.js `spk`), so another device can sign it out there
  function noteDeviceSpk () { const b = sdk.backup; if (b && b._v2 && typeof b._v2.deviceSpk === 'function') b._v2.deviceSpk(b).then((k) => { if (k) sdk.account._spk = k }).catch(() => {}) }
  function loadBackup() {
    sdk.account.stop(); sdk.account._devices = {}; sdk.account._loc = null
    adopting = true; try { sdk.backup._adopt(backups()[who()] || null) } finally { adopting = false }
    if (sdk.backup.enabled) { noteDeviceSpk(); sdk.account.start(); keepSoon(500) }
    emitAccount()
    accountStatus()
  }
  loadBackup()
  { const t = setInterval(() => { if (sdk.backup.enabled) keepSoon(0) }, 60_000); if (t && t.unref) t.unref() } // the other devices' changes: as often as the index
  async function eraseKey() { try { return await sdk.erasure._key() } catch { return null } }
  async function noteRoom(room) {
    const it = rooms.find((x) => x.room === room); if (!it) return
    if (sdk.backup.enabled) sdk.backup.add({ room: it.room, shareLink: it.link, _sharedRoom: it.lane || undefined }, it.title ? { label: it.title } : {})
    const k = await eraseKey() // the account's membership mark: another account's delete of this room is refused (sdkErase.js)
    if (k) wop('mark', room, await dropFor(k, room)).catch(() => null)
    sdk.erasure._seen({ room }) // and refile the erase list soon
  }
  async function dropRoom(room) {
    if (streaming.delete(room)) worker.postMessage({ t: 'streamClose', room })
    if (vpush) await vpush.drop(room).catch(() => {}) // off its notification list while the worker still holds its key
    await wcall({ t: 'forget', room }).catch(() => null)
    rooms = rooms.filter((x) => x.room !== room); saveRooms()
    emit({ ev: 'rooms', rooms: publicRooms() })
  }
  async function fromBackup() {
    if (!sdk.backup.enabled) return
    const inAccount = new Map(sdk.backup.rooms.map((b) => [b.room, b]))
    let added = false
    for (const b of inAccount.values()) {
      const p = linkParts(b.link); if (!p || p.room !== b.room) continue // a link that names another room is not taken in
      // a HELD room whose link this vault could not open from disk (its sealed key under a key it no longer has — vaultAtRest.js)
      // takes the account's: a key is never replaced by a link, but a room with none gets its own back
      const had = rooms.find((x) => x.room === b.room)
      if (had) { if (!had.link) { had.link = b.link; holdLink(worker, p); seedIdentity(b.room); added = true } continue }
      rooms.push({ room: b.room, link: b.link, title: b.label || '', at: Date.now(), ...(b.kind === 'lane' && b.shared ? { lane: b.shared } : {}), ...(/[#&]enc=1(?:&|$)/.test(b.link) ? { enc: true } : {}), ...(p.split ? { split: true } : {}) })
      holdLink(worker, p); seedIdentity(b.room); added = true
    }
    // a room the ACCOUNT dropped on another device (its tombstone is newer than this device's copy) is dropped here too
    const tomb = new Map(((sdk.backup._s && sdk.backup._s.tomb) || []).map((t) => [t.room, t.at]))
    for (const r of [...rooms]) if (!inAccount.has(r.room) && tomb.has(r.room) && tomb.get(r.room) > (r.at || 0)) await dropRoom(r.room)
    if (added) { saveRooms(); pushEnclave(); emit({ ev: 'rooms', rooms: publicRooms() }) }
  }
  // THE EMAILED CODE the account service asks for, in the vault's own screen (screens.emailCode; ours when the builder's has none):
  // `purpose` words it; the screen resolves the code, or rejects (cancelled)
  const emailCodeAsker = async (purpose, address) => {
    const screen = await screenFor('emailCode')
    if (!screen) throw Object.assign(new Error('this vault has no email-code screen'), { code: 'no_screen' })
    return async () => { const c = await screen({ email: typeof address === 'function' ? address() : address, purpose }); if (!c) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); return String(c).trim() }
  }
  const accountAddress = () => { const s = sdk.backup._s; return (s && s.v2 && s.v2.svc && s.v2.svc.address) || (s && s.email) || (signedIn() ? sdk.session.email : '') }
  async function backupCall(m, args) {
    const b = sdk.backup
    if (m === 'enable') {
      const recoveryCodeScreen = await screenFor('recoveryCode')
      if (!recoveryCodeScreen) throw Object.assign(new Error('this vault has no recovery-code screen'), { code: 'no_screen' })
      // ON THE ACCOUNT SERVICE the code is shown BEFORE it is activated (inside enable), after the emailed code; the account's
      // address is the signed-in one, or the person types it in the email-code screen
      let email = signedIn() ? sdk.session.email : ''
      let v2 = {}
      if (b._v2 && (!b._s || b._s.v2)) { // none yet, or one the service made whose first code did not go through (finished now)
        if (!email && !b._s) { const ask = await screenFor('emailCode'); email = ask ? String((await ask({ email: '', purpose: 'create' })) || '').trim() : ''; if (!email) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }) }
        v2 = { getCode: await emailCodeAsker('create', () => accountAddress() || email), showCode: (code) => recoveryCodeScreen({ code }) }
      }
      // a TYPED address goes to the service only: never enrolled as the old store's gate if the service refuses this vault (review)
      const r = await b.enable({ ...(signedIn() ? { email: sdk.session.email } : {}), ...(email && !signedIn() ? { address: email } : {}), ...v2 })
      if (b.enabled) noteDeviceSpk() // its key into its index entry now, not at the next launch (sync sweep 11-22 #16): until then a Sign out elsewhere only marked the index
      for (const x of rooms) await noteRoom(x.room)
      await b.save().catch(() => null)
      if (b.service !== 'account') await recoveryCodeScreen({ code: r.code }) // the old store: shown HERE, once; the page gets only that it is set up
      emitAccount()
      return { enabled: true }
    }
    if (m === 'restore') {
      const restoreScreen = await screenFor('restore')
      if (!restoreScreen) throw Object.assign(new Error('this vault has no restore screen'), { code: 'no_screen' })
      // the screen asks for the code (and, where the gate or the account service asks for it, the email and the emailed code) and
      // calls this; the account service's emailed code is asked through the same two calls (sdkBackupV2.js restoreBridge)
      const email = signedIn() ? sdk.session.email : ''
      const run = restoreBridge((q, getCode) => b.restore({ code: q.code, email: q.email, ticket: q.ticket, emailCode: q.emailCode, ...(b._v2 ? { getCode } : {}) }))
      await restoreScreen({ email, restore: async (q) => { await run(q) } })
      if (!b.enabled) throw Object.assign(new Error('not restored'), { code: 'cancelled' })
      noteDeviceSpk() // as after enable (sync sweep 11-22 #16)
      await fromBackup()
      emitAccount()
      accountStatus()
      return { rooms: accountView().rooms } // the rooms, as outside a vault (an array — a count made `.map` throw; sync sweep 11-09 #24); the view: no link, no key
    }
    if (m === 'remove') { b.remove(String(args[0] || '')); return {} }
    if (m === 'signOutOthers') { await b.signOutOthers({ getCode: await emailCodeAsker('signout', accountAddress) }); emitAccount(); return { ok: true } }
    if (m === 'newRecoveryCode') {
      const recoveryCodeScreen = await screenFor('recoveryCode')
      if (!recoveryCodeScreen) throw Object.assign(new Error('this vault has no recovery-code screen'), { code: 'no_screen' })
      await b.newRecoveryCode({ getCode: await emailCodeAsker('newcode', accountAddress), showCode: (code) => recoveryCodeScreen({ code }) }) // shown HERE, once
      emitAccount()
      return { ok: true }
    }
    // DELETE THE ACCOUNT — THIS DEVICE FORGETS IT AS A SIGN-OUT DOES (sync sweep 11-22 P7; the owner, 2026-11-22: "same way" as the app,
    // whose Delete my account wipes the device): it kept this device's Spaces and session, while a sign-out from elsewhere wiped them
    if (m === 'deleteAccount') { await b.deleteAccount({ getCode: await emailCodeAsker('delete', accountAddress) }); await wipeSignedOut(); emit({ ev: 'accountSignedOut', reason: 'erased' }); return { deleted: true } }
    return b[m]()
  }
  const watchedSections = new Set() // the account sections the page has asked about: their changes are sent to it
  async function accountCall(m, args) {
    const a = sdk.account
    if (m === 'sync') { const r = await a.sync(); await fromBackup(); await keepSync().catch(() => null); emitAccount(); return { ok: !!(r && r.ok), ...(r && r.signedOut ? { signedOut: true } : {}) } }
    if (m === 'start') { a.start(args[0] || {}); return {} }
    if (m === 'section') { // one of the account's optional sections, run here on the vault's account; only its own calls (get / set / remove / merge)
      const [name, op, ...rest] = args, all = a._sections || {}
      const sec = typeof name === 'string' && Object.prototype.hasOwnProperty.call(all, name) ? all[name] : null
      if (!sec || !sec._calls.includes(op)) throw Object.assign(new Error('vault: account.' + String(name).slice(0, 20) + '.' + String(op).slice(0, 20) + ' is not available to the page'), { code: 'vault_refused' })
      if (!watchedSections.has(name)) { watchedSections.add(name); sec.on('change', (value) => emit({ ev: 'accountSection', section: name, value })) } // another device's change reaches the page
      return sec[op](...rest.slice(0, 1))
    }
    if (m === 'usage') { const o = args[0] && typeof args[0] === 'object' ? args[0] : {}; return a.usage(o.month !== undefined ? { month: o.month } : {}) } // folded with the vault's usage key, which the page never holds
    if (m === 'stop') { a.stop(); return {} }
    if (m === 'forget') { const room = String(args[0] || ''); a.forget(room); if (held(room)) await dropRoom(room); emitAccount(); return {} }
    if (m === 'noteLink' || m === 'dropLink') { // a link between two lanes THIS vault holds — any other pair is not the page's to record
      const x = String(args[0] || ''), y = String(args[1] || '')
      if (!held(x) || !held(y)) throw Object.assign(new Error('vault: this vault holds no such lanes'), { code: 'not_in_vault' })
      if (m === 'noteLink') a._noteLink(x, y, Number.isFinite(+args[2]) ? +args[2] : undefined); else a._dropLink(x, y)
      emitAccount(); return {}
    }
    // archive / rename / signOut — the index is written soon after. signOut takes the DEVICE only: a page passed `reason: 'erased'`
    // behind the confirm and the other device was told its account was deleted (sync sweep 11-22 P7)
    if (m === 'signOut') a.signOut(args[0]); else a[m](...args)
    // SIGN OUT AT THE SERVICE TOO (our app's revokeAtService; sync sweep 11-19 P8): marking the index alone left the device signed in to
    // the account service until it next synced. A device whose entry names its key (spk) is revoked there as well — the email code first.
    if (m === 'signOut') {
      const b = sdk.backup, d = a._devices && a._devices[args[0]]
      if (revokesAtService(args[0])) {
        try { await b._v2.signOutDevice(b, { spk: d.spk, getCode: await emailCodeAsker('signout', accountAddress) }); emitAccount(); return { revoked: true } }
        catch (e) { emitAccount(); return { revoked: false, error: String((e && e.code) || 'failed').slice(0, 40) } } // marked in the index: it signs out at its next sync
      }
    }
    emitAccount()
    return {}
  }
  async function account(ns, m, ...args) {
    const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k)
    const spec = own(ACCOUNT_CALLS, ns) && own(ACCOUNT_CALLS[ns], m) ? ACCOUNT_CALLS[ns][m] : null
    if (!spec) throw Object.assign(new Error('vault: ' + String(ns).slice(0, 20) + '.' + String(m).slice(0, 30) + ' is not available to the page'), { code: 'vault_refused' })
    // the account service's own calls: refused BEFORE the person is asked to confirm (sync sweep 11-16 #15 — they confirmed, then
    // met not_on_service)
    if (ns === 'backup' && SERVICE_CALLS.has(m) && !(sdk.backup._v2 && sdk.backup.service === 'account' && sdk.backup.enabled)) throw Object.assign(new Error('witbitz: this call is for an account on the Witbitz account service, in a vault that names its tenant (wb.backup.service === \'account\')'), { code: 'not_on_service' })
    if (spec.confirm) await confirmCall(ns, m, args)
    if (ns === 'backup') return backupCall(m, args)
    if (ns === 'account') return accountCall(m, args)
    if (ns === 'siri' && m === 'shortcut') return siriShortcut()
    if (ns === 'siri' && m === 'showKey') {
      const s = sdk.siri.shortcut
      if (!s.key) throw Object.assign(new Error('no Siri key yet — enable Siri in a Space first'), { code: 'no_key' })
      const siriKeyScreen = await screenFor('siriKey')
      if (!siriKeyScreen) throw Object.assign(new Error('this vault has no Siri key screen'), { code: 'no_screen' })
      await siriKeyScreen({ key: s.key, endpoint: s.endpoint })
      return { shown: true }
    }
    const r = await sdk[ns][m](...args)
    if (ns === 'connections' && (m === 'attach' || m === 'finishConnect' || m === 'attachMcp' || m === 'finishMcp') && r && r.id) { conns = [{ id: r.id, label: r.label || '', host: r.host || '', callKey: r.callKey, account: r.account || '', ...(r.mcp ? { mcp: true } : {}), ...hookOf(r) }, ...conns.filter((c) => c.id !== r.id)]; saveConns(); return pub(r) }
    if (ns === 'connections' && m === 'detach') { conns = conns.filter((c) => c.id !== String(args[0] || '')); saveConns() }
    // GRANTABLE HERE (sync sweep 11-13 P7): the Sentinel lists every connection the account has, but a grant needs its callKey,
    // which only this vault's list holds (attached here, or kept from another device with the backup on) — the rest refuse
    // with not_in_vault. Each says which it is, so the page offers to grant only what will work.
    if (ns === 'connections' && m === 'list' && Array.isArray(r)) {
      const acct = await sdk._account()
      adoptPending(r.map((x) => x && x.id).filter(Boolean), acct) // a key whose attach answer was lost, now listed (#5)
      // MOVE 3: the old-form ones whose key this vault holds are locked under it (connWrap.js) — once a launch, in the background
      if (!_lockedOnce && r.some((x) => x && x.locked === false)) { _lockedOnce = true; sdk.connections.lock(Object.fromEntries(conns.filter((c) => c.account === acct && c.callKey).map((c) => [c.id, c.callKey]))).catch(() => { _lockedOnce = false }) }
      return r.map((x) => (x && typeof x === 'object' ? { ...x, grantable: conns.some((c) => c.id === x.id && c.account === acct) } : x))
    }
    if (ns === 'siri') { saveSiri(); if (m === 'rotateKey') return siriShortcut() }
    if (ns === 'a2a') saveA2A()
    return r
  }
  async function roomAccount(room, ns, m, ...args) {
    const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k)
    const spec = own(ROOM_ACCOUNT_CALLS, ns) && own(ROOM_ACCOUNT_CALLS[ns], m) ? ROOM_ACCOUNT_CALLS[ns][m] : null
    if (!spec) throw Object.assign(new Error('vault: space.' + String(ns).slice(0, 20) + '.' + String(m).slice(0, 30) + ' is not available to the page'), { code: 'vault_refused' })
    if (!held(room)) throw Object.assign(new Error('vault: this vault holds no Space ' + String(room).slice(0, 40)), { code: 'not_in_vault' })
    let c = null
    if (ns === 'connections' && m === 'grant') {
      const id = String(args[0] && typeof args[0] === 'object' ? args[0].id : args[0] || '')
      const acct = await sdk._account()
      c = conns.find((x) => x.id === id && x.account === acct) // only this account's own connections
      if (!c) throw Object.assign(new Error('vault: no connection ' + id.slice(0, 40) + ' attached in this vault'), { code: 'not_in_vault' })
    }
    if (ns === 'a2a' && m === 'setReply' && args[1] === 'auto') await confirmWith({ title: 'Let the assistant answer this agent on its own?', text: 'Its answers will go without asking you.', ok: 'Allow', cancel: 'Cancel' }).then((ok) => { if (!ok) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }) })
    if (spec.confirm) await confirmCall(ns, m, args, room)
    if (ns === 'a2a') return laneA2A(room, m, args)
    const sp = roomSpace(room)
    try {
      if (c) return await sp.connections.grant(c, args[1] || {})
      if (ns === 'siri' && m === 'collect') {
        const deliver = args[0] && args[0].deliver ? (text, meta) => askPage('siriDeliver', { room, text, meta }) : undefined
        const r = await sp.siri.collect(deliver ? { deliver } : {}); saveSiri(); return r
      }
      const r = await sp[ns][m](...args)
      if (ns === 'siri') { saveSiri(); if (r && typeof r === 'object' && 'key' in r) return { ...r, key: null, hasKey: !!r.key } } // the key stays in the vault (siri.showKey)
      return r
    } catch (e) { throw vaultSignInWords(e) } finally { sp.close() }
  }
  const mirrorOk = new Map() // lane room → true, once its Space was found not attested, or the lane attested too
  async function mirrorAllowed(lane) {
    if (mirrorOk.get(lane)) return
    const it = rooms.find((x) => x.room === lane), shared = it && it.lane
    if (!shared || typeof sdk._client.attestedRoom !== 'function') return
    const ask = async (r) => { try { if (isEncRoom(r)) await encReadyFor(r); return !!(await sdk._client.attestedRoom(r, null)) } catch { throw Object.assign(new Error('vault: whether this Space requires an attested app could not be read, so its lane is not copied to — try again'), { code: 'policy_unreadable' }) } }
    if ((await ask(shared)) && !(await ask(lane))) throw Object.assign(new Error('vault: this Space requires an attested app, so it is copied only into a lane that requires one too'), { code: 'attested' })
    mirrorOk.set(lane, true)
  }
  // ONE WIPE for every sign-out — the person's (CALLS.signOut) and one from another device (the account's status check / sync):
  // the session, the held Spaces' keys and the account's stores (Siri, outside agents, connections, backup) go, as our hosted
  // vault's wipeVaultAccount does (sync sweep 11-19/11-20 P7/P8: a remote sign-out kept them all, and the page could still reach
  // every Space). The page hears `accountSignedOut` / `signedOut`; a backup brings the Spaces back at the next sign-in.
  // ⛔ AS COMPLETE AS OURS (sync sweep 11-22 #3 #4; ours also reloads the page, so nothing stays in its memory either): each held Space
  //   is dropped as dropRoom drops one — the page's stream closed, off the notification list, its key forgotten by the worker,
  //   whose store reloaded every mk:/us: into the next worker (ours wipes that IndexedDB, vault-loader.js _idbWipe) — and what this
  //   vault held for the account in memory goes too: its connections (callKeys), its backup state (the next saveConns() / save wrote
  //   them back), this device's account-service key, the rooms waiting for a key.
  async function wipeSignedOut () {
    try { sdk.account.stop() } catch { /* not started */ }
    try { sdk.signOut() } catch { /* already */ }
    for (const room of streaming) { try { worker.postMessage({ t: 'streamClose', room }) } catch { /* the worker is replaced below */ } }
    streaming.clear() // the replay re-opened each one in the new worker, and onWorker forwarded its events to the page
    const held0 = rooms.map((r) => r.room)
    rooms = []
    if (vpush) await Promise.race([vpush.sync([]), new Promise((r) => setTimeout(r, WIPE_PUSH_MS))]).catch(() => {}) // while the worker still holds the keys
    await saveRooms()
    await wcall({ t: 'presenceQuery' }).catch(() => null) // which rooms the worker holds a key for (workerRooms) — the list may not name them all
    for (const room of new Set([...held0, ...workerRooms])) await wcall({ t: 'forget', room }).catch(() => null) // memory AND its store (awaited there)
    workerRooms = []
    failWaiting('signed out — try again') // what waits on the worker that goes (P8): never answered
    conns = []; backupMem = {}; _lockedOnce = false; pageUserToken = ''
    try { sdk.account._spk = null } catch { /* */ } // or the NEXT account's index entry carried this one's device key
    mirrorOk.clear(); keyWaits.clear()
    for (const k of Object.values(KEYS)) write(st, k, null)
    loadSiri(); loadBackup(); clearTimeout(refreshTimer); await startWorker()
    emit({ ev: 'rooms', rooms: publicRooms() }); emitAccount()
  }
  // WHAT A SIGN-OUT HAS TO FORGET (sync sweep 11-22 #7): a sign-in, live or expired; a held Space; a connection; a backup; any store
  const holdsAnything = () => signedIn() || rooms.length > 0 || conns.length > 0 || Object.keys(backupMem || {}).length > 0
    || Object.values(KEYS).some((k) => { const v = read(st, k, null); return v != null && (typeof v !== 'object' || (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) })
  const CALLS = {
    async userToken(t) { pageUserToken = typeof t === 'string' && t.length <= 4096 ? t : ''; return true },
    async op(op, room, ...args) {
      if (!PAGE_OPS.has(op)) throw Object.assign(new Error('vault: ' + op + ' is not available to the page'), { code: 'vault_refused' })
      if (!held(room)) throw Object.assign(new Error('vault: this vault holds no Space ' + String(room).slice(0, 40)), { code: 'not_in_vault' })
      if (op === 'stop') { if (isEncRoom(room) && !(await encReadyFor(room))) return { status: 503, ok: false, error: 'enclave_unreachable' }; return sdk._client.stop(room, String(args[0] || '').slice(0, 200)) } // a turn's stop: keyless, named by the turn's own random stop key — to the room's own tier (sweep 11-06 #3)
      // AN ATTESTED SPACE IS COPIED ONLY INTO AN ATTESTED LANE (sync sweep 2026-11-15 #5; the app's mirrorLoop.js, the SDK's openLane): the
      // page's lane mirror posts here — refused when the lane's Space requires an attested app and the lane does not; a failed read refuses
      if (op === 'mirror') await mirrorAllowed(room)
      if (op === 'turn' && args.length > 1) args[1] = null // the identity is the vault's (the worker signs with it), never the page's
      // the account's usage RECEIPT is the vault's too (it holds the usage key): set here, whatever the page sent (2026-10-23)
      if (op === 'turn') { const o = args[2] && typeof args[2] === 'object' ? { ...args[2] } : {}; delete o.receipt; const k = sdk.account && typeof sdk.account._usageKey === 'function' ? sdk.account._usageKey() : null; if (k) { try { o.receipt = await receiptFor(k, room) } catch { /* the turn goes without one */ } } args[2] = o }
      // what lets a Space SPEND is granted only through the vault's own calls, after the person says yes (security review):
      // a page's settings write may not carry a connection, a funding grant or the move authority
      if (op === 'setConfig' && args[0] && typeof args[0] === 'object' && ['connections', 'funding', 'forkAuthority', 'admins', 'owners'].some((k) => k in args[0])) throw Object.assign(new Error('vault: connections, funding and who manages a Space go through the vault (changeMembers asks the person first)'), { code: 'vault_refused' }) // admins/owners: a role change in place since 443e1e9d — a page must not make it in the person's name unasked (sweep 10-23 #4)
      const keyIn = (o) => o.bridgeMk != null || o.mk != null || o.identity != null
      for (const a of args) {
        if (!a || typeof a !== 'object') continue
        if (keyIn(a)) throw Object.assign(new Error('vault: a key or an identity is the vault\'s, not the page\'s'), { code: 'vault_refused' })
        if (a.bridgeRoom != null && !held(a.bridgeRoom)) throw Object.assign(new Error('vault: this vault holds no Space ' + String(a.bridgeRoom).slice(0, 40)), { code: 'not_in_vault' })
        // linked rooms (a lane's tell_lane): each one held here; the worker fills in its key by room
        if (a.links != null) {
          if (!Array.isArray(a.links) || a.links.some((l) => !l || typeof l !== 'object')) throw Object.assign(new Error('vault: links are Spaces named by id'), { code: 'invalid_argument' })
          if (a.links.some(keyIn)) throw Object.assign(new Error('vault: a key is the vault\'s, not the page\'s'), { code: 'vault_refused' })
          if (a.links.some((l) => !held(l.room))) throw Object.assign(new Error('vault: a linked room must be a Space this vault holds'), { code: 'not_in_vault' })
        }
      }
      const isEnc = rooms.some((x) => x.room === room && x.enc)
      if (isEnc && !sdk._enc.byRegion.size) await encAttest(room).catch(() => null) // first use of a confidential room this session
      // a confidential room whose enclave key is STALE (the enclave was replaced: bad_mkseal) or not in hand yet (it was
      // asleep): attest and ask once more — the SDK's healingClient rule; ONCE per op, through the same worker (reattestOnce)
      let r = await reattestOnce({ enc: isEnc, run: () => wcall({ t: 'op', op, room, args }), reattest: () => encAttest(room).then(() => true, () => false) })
      // THE SERVER SAYS IT IS CONFIDENTIAL (sweep 11-06 P7, the root of #2/#3): a page op on a room the vault took for a regular
      // one — an older unmarked link — learns the tier (learnTier, as opHealed does) and runs once more on the enclave
      if (!isEnc && saysConfidential(r)) { learnTier(room, r); if (await encReadyFor(room)) r = await wcall({ t: 'op', op, room, args }) }
      if (r && (r.status === 401 || r.status === 200) && r.error === 'stale_key' && await followKey(room)) r = await wcall({ t: 'op', op, room, args }) // the Space was re-keyed in place: the vault takes its grant (followKey) and asks again
      // a SLEEPING confidential Space reads no settings: wake it and read once more (sweep 11-07 #8 — the page cannot: its
      // _isEnclave() is always false in a vault, so space.safeMedia.refresh() failed until something else woke it)
      if (op === 'getConfig' && isEnc && r == null) { try { await sdk._encWake(room, { tries: 8 }); pushEnclave(); r = await wcall({ t: 'op', op, room, args }) } catch { /* null: the page says it could not read */ } }
      if (op === 'getConfig') r = configForPage(r)
      if (op === 'title' && r && typeof r.title === 'string') { const it = rooms.find((x) => x.room === room); const t = r.title.slice(0, 200); if (it && it.title !== t) { it.title = t; saveRooms() } }
      return r
    },
    async create(cfg, opts) { // opts { enclave, split }: the confidential tier, a split-key room; anything else is refused, never ignored
      if (opts !== undefined && opts !== null && (typeof opts !== 'object' || Object.keys(opts).some((k) => k !== 'enclave' && k !== 'split'))) throw Object.assign(new Error('vault: create takes { enclave, split } and nothing else'), { code: 'invalid_argument' })
      return makeRoom(cfg, null, { enclave: !!(opts && opts.enclave === true), split: !!(opts && opts.split === true) })
    },
  }
  async function makeRoom(cfg, lane, { enclave = false, split = false } = {}) {
    // SPLIT: the room's key is two halves — the link holds one, the builder's app-half function (/api/appshare on THIS
    // origin; spaces/templates/appshare) the other. A vault that serves none cannot make one (`appShare: true` says it does).
    if (split && !o.appShare) throw Object.assign(new Error('vault: this vault serves no app-half function — a split-key Space needs one at /api/appshare (startVault({ appShare: true }))'), { code: 'vault_unsupported' })
    if (split && enclave) throw Object.assign(new Error('vault: a split-key room is on the standard tier for now'), { code: 'tier_mismatch' })
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw Object.assign(new Error('vault: create takes a room config'), { code: 'invalid_argument' })
    const extra = Object.keys(cfg).filter((k) => !CREATE_FIELDS.has(k))
    if (extra.length) throw Object.assign(new Error('vault: not available in a vault: ' + extra.join(', ').slice(0, 80)), { code: 'vault_unsupported' })
    const now = Date.now(); creates = creates.filter((t) => now - t < CREATE_LIMIT.ms)
    if (creates.length >= CREATE_LIMIT.n) throw Object.assign(new Error('vault: too many new Spaces — wait a few minutes'), { code: 'rate_limited' })
    creates.push(now)
    if (cfg.direct !== undefined && (cfg.direct !== true || cfg.admission !== 'email')) throw Object.assign(new Error('vault: a direct chat is an email-gated Space'), { code: 'invalid_argument' })
    // Attest FIRST — loud on a configuration failure (no published claim: never mint a confidential room that pins
    // nothing), soft on a cold enclave (woken below) — then mint, wake, and hand the enclave its own sealed config.
    if (enclave) { await sdk._encAttestSoft(); pushEnclave() }
    const r = await wcall({ t: 'create', cfg, base: location.origin, ...(enclave ? { enclave: true } : {}), ...(split ? { split: true } : {}), ...(sdk.backup.enabled ? { delAsk: true } : {}) })
    const mark = (l, m) => l + (l.includes('#') ? '&' : '#') + m
    let link = cfg.admission === 'email' ? mark(r.link, 'gate=email') : r.link // a gated Space's invite says so (inviteLinks.js): the joiner knows to sign in
    if (enclave) link = mark(link, 'enc=1') // and a confidential one, or a fresh client cannot know its tier
    if (cfg && cfg.lanes === true) link = mark(link, 'lanes=1') // and one that gives every member a private assistant, as the direct SDK's (sync sweep 2026-10-29 #3)
    rooms = [{ room: r.room, link, title: '', at: Date.now(), ...(lane ? { lane } : {}), ...(enclave ? { enc: true } : {}), ...(split ? { split: true } : {}) }, ...rooms.filter((x) => x.room !== r.room)]; await saveRooms() // on disk (sealed) before the page hears of it
    seedIdentity(r.room); noteRoom(r.room)
    if (enclave) {
      pushEnclave()
      await sdk._encWake(r.room); pushEnclave()
      if (!(await sdk._encSealConfig(r.room, r.commit, r.configSealed))) throw Object.assign(new Error('vault: the new confidential Space could not be handed its configuration — nothing was sent to it'), { code: 'enclave_seal_failed' })
    }
    emit({ ev: 'rooms', rooms: publicRooms() })
    return { room: r.room }
  }
  Object.assign(CALLS, {
    async rooms() { return publicRooms() },
    // a short-lived speech key (dictation 'stt', reading aloud 'tts'), minted with this vault's sign-in — or the page's
    // user token (its backend vouched for the user). The page streams to the speech model itself, as outside a vault.
    async speechKey(kind, userToken) {
      if (kind !== 'stt' && kind !== 'tts') throw Object.assign(new Error('vault: stt or tts'), { code: 'invalid_argument' })
      const now = Date.now(); speechKeys = speechKeys.filter((t) => now - t < SPEECH_LIMIT.ms)
      if (speechKeys.length >= SPEECH_LIMIT.n) return { status: 429, error: kind + '_rate_limited', retryAfterS: Math.max(1, Math.ceil((SPEECH_LIMIT.ms - (now - speechKeys[0])) / 1000)) } // each key costs money: a page minting in a loop is stopped here — the server's own code and wait, so the page says "try again in N s" (sync sweep, 10-16)
      const id = signedIn() ? sdk.session.idToken : ''
      const ut = typeof userToken === 'string' ? userToken.slice(0, 4000) : ''
      if (!id && !ut) return { status: 401, error: 'signin_required' } // before the budget: a refusal mints nothing, so it spends nothing (sync sweep 10-19)
      speechKeys.push(now)
      return sdk._client[kind](id, ut)
    },
    fork,
    follow,
    announce,
    changeMembers: (room, admission) => inPlace(room, admission, false),
    rotateKey: (room) => inPlace(room, null, true),
    // a private lane of a Space this vault holds: a Space of the member's own, recorded as that Space's lane
    async createLane(shared, cfg, o) {
      if (!held(shared)) throw Object.assign(new Error('vault: this vault holds no Space ' + String(shared).slice(0, 40)), { code: 'not_in_vault' })
      const sh = rooms.find((x) => x.room === shared)
      // A TEMPORARY ROOM HAS NO LANE (as the direct SDK and the app — roomState isTempRoom; sync sweep backlog P7): a lane is a
      // durable room, and its copies of the room would outlive the wipe
      if (sh && sh.lane) throw Object.assign(new Error('vault: a private lane has no lane of its own — ask from its Space'), { code: 'lane_of_lane' }) // as the direct SDK (sweep P1)
      if (String(shared).startsWith('tmp-') || (sh && sh.temporary)) throw Object.assign(new Error('vault: a temporary room has no private lane — the lane is a durable room, and its copies of the room would outlive the wipe'), { code: 'temporary_room' })
      // A VERIFIED SPACE'S LANE ADMITS ITS ONE MEMBER, whatever the page sent (laneConfig.js laneInherits; sync sweep 10-16 #1):
      // the vault decides it, so a page cannot make an open lane of a verified Space.
      // A SLEEPING CONFIDENTIAL SPACE is woken first, as the members change does (inPlace): asleep, the relay refuses op policy
      // and wakes nothing, so the read below failed every time and "try again" never helped (sync sweep 2026-11-03 #2)
      if (sh && sh.enc) { try { await sdk._encWake(shared, { tries: 8 }); pushEnclave() } catch { /* the read below says what is wrong */ } }
      let scfg = null; try { scfg = await wop('getConfig', shared, { plainMark: true }) } catch { scfg = null }
      // a plain room: read, and it has no settings — never when the vault's own link for it says verified (gate=email)
      const plain = !!(scfg && scfg.plain === true) && !(sh && /[#&]gate=email(?:&|$)/.test(String(sh.link || ''))); if (scfg && scfg.plain === true) scfg = null
      // the placeholder a verified Space's settings read gives before the sign-in admits ({ admission:'email', gated:true },
      // no allow) is not its settings: read as such, the lane got none of its Space's tools (sync sweep 2026-10-29 #9; the app: roomSync gatedStub)
      // …and it says the Space IS verified: wait, whatever the link says — read as "no settings", a verified Space whose link
      // carries no gate=email mark (an old invite, a restored link) got an OPEN lane (sync sweep 2026-10-31 #1)
      if (gatedStub(scfg)) throw Object.assign(new Error(signedIn() ? "vault: this Space is verified and its settings open only to an admitted member — you are signed in, but its gate has not admitted " + String(sdk.session.email || 'this email') + " yet, so its private lane cannot be made as strict as it — ask an admin of the Space, then try again" : "vault: this Space is verified and its settings open only once you are signed in and admitted, so its private lane cannot be made as strict as it yet — sign in, then try again"), { code: 'lane_wait' }) // the words for who is asking: 'sign in' to someone signed in sent them in circles (sync sweep 11-09)
      // a settings read that FAILED waits too, whatever the link says: a verified Space with no gate=email mark (an old invite,
      // a restored link) read as "no settings" got an open lane (sync sweep 2026-11-02 #3) — the vault fails closed
      // a PLAIN room is told apart by the read itself (spaceClient getConfig plainMark): its lane is made as the SDK and the app
      // make it (sync sweep 2026-11-03 #3: an open room joined from elsewhere could never get one). Anything else waits.
      // …but a read REFUSED because this member was removed, or because the room was re-keyed, is not "try again": the settings
      // read answers null for both (spaceClient getConfig), so a removed member waited for ever (sync sweep 11-09, 11-04 P7). The
      // room's grant tells them apart: removed → said by name; a new key taken → read once more.
      if (!scfg && !plain) {
        const took = await followKey(shared).catch(() => false)
        if (took) { try { scfg = await wop('getConfig', shared, { plainMark: true }) } catch { scfg = null } if (scfg && scfg.plain === true) scfg = null }
        const w = keyWaits.get(shared)
        if (w && w.why === 'removed') throw Object.assign(new Error('vault: you are no longer a member of this Space, so it has no private lane for you'), { code: 'removed' })
      }
      if (!scfg && !plain) throw Object.assign(new Error("vault: this Space's settings could not be read, so its private lane cannot be made as strict as it yet — try again"), { code: 'lane_wait' })
      if (scfg && scfg.admission === 'email') {
        // the page asked for an OPEN lane (o.open, sdkVault): refused by name, never silently rewritten (sync sweep 10-19 #15)
        if (o && typeof o === 'object' && o.open === true) throw Object.assign(new Error("vault: this Space is verified, so its private lane must be too — an open lane would let anyone with its link read the member's private assistant. Omit `admission` to gate it to the signed-in member."), { code: 'lane_downgrade' })
        const inh = laneInherits(scfg, { email: signedIn() ? String(sdk.session.email || '').trim().toLowerCase() : '' })
        if (inh.wait) throw Object.assign(new Error('vault: this Space is verified, so its private lane is gated to you — sign in first'), { code: 'sign_in_required' })
        const { admins: _a, owners: _o, ...rest } = cfg && typeof cfg === 'object' ? cfg : {} // its one member only: no other admins or owners
        cfg = { ...rest, admission: 'email', allow: inh.gate.allow }
      }
      // AN ATTESTED SPACE (its owner policy requires an attested app): its lane is made only by the attested app (the Witbitz app on the
      // device) — refused here as the direct SDK refuses it
      // (privateLane, 'attested'); the vault made an ordinary lane of one (sync sweep 10-24, open until 10-26)
      let attested = false
      try { if (sh.enc) await encReadyFor(shared); attested = !!(await sdk._client.attestedRoom(shared, null)) } catch { throw Object.assign(new Error('vault: whether this Space requires an attested app could not be read, so its private lane waits — try again'), { code: 'lane_wait' }) } // a failed read is not 'not attested' (sync sweep 11-08) // op 'policy' is public: no room key rides (sweep 11-06 #2 — it went to the Lambda READABLE)
      if (laneInherits(scfg, { attested }).wait === 'attested') throw Object.assign(new Error('vault: this Space requires an attested app, so its private lane is made only by that app (the Witbitz app on the device), under the same rule — not by a vault'), { code: 'attested' })
      cfg = { ...(cfg && typeof cfg === 'object' ? cfg : {}), lane: true } // a lane says so in its own sealed settings (laneConfig.js; sync sweep 11-19 P1)
      return makeRoom(cfg, shared, { enclave: !!sh.enc, split: !!sh.split }) // a lane is on its Space's tier and key model — never a silent downgrade
    },
    account,
    roomAccount,
    async answer(id, out) { const w = asks.get(id); if (!w) return { ok: false }; asks.delete(id); clearTimeout(w.timer); if (out && out.error) w.rej(Object.assign(new Error(String(out.error).slice(0, 200)), { code: 'page_refused' })); else w.res(out && out.result); return { ok: true } },
    // a live stream for a held Space while the page shows it (on: true), or no longer (on: false)
    async stream(room, on) {
      if (!held(room)) throw Object.assign(new Error('vault: this vault holds no Space ' + String(room).slice(0, 40)), { code: 'not_in_vault' })
      if (on && !streaming.has(room)) { streaming.add(room); worker.postMessage({ t: 'streamOpen', room }) }
      else if (!on && streaming.has(room)) { streaming.delete(room); worker.postMessage({ t: 'streamClose', room }) }
      return { streaming: streaming.has(room) }
    },
    async share(room, opts = {}) {
      const it = rooms.find((x) => x.room === room)
      if (!it || !it.link) throw Object.assign(new Error('vault: no link for that Space'), { code: 'not_in_vault' })
      if (typeof screens.share !== 'function') throw Object.assign(new Error('this vault has no share screen'), { code: 'no_screen' })
      await screens.share({ link: it.link, title: String((opts && opts.title) || it.title || '') })
      return { shown: true }
    },
    signIn,
    // THE LOCK SHEET (a vault started with `lock: true`): the person turns the lock and storage protection on or off in the vault's
    // own pixels; the page gets only the outcome { available, on, protect } — it can neither turn either on nor off
    async lockSettings() {
      if (!vlock) throw Object.assign(new Error('vault: this vault has no lock — its builder starts it with startVault({ lock: true })'), { code: 'vault_unsupported' })
      if (vlock.locked()) throw Object.assign(new Error('vault: the vault is locked'), { code: 'vault_locked' }) // the page behind the lock cover must not uncover it (review, 2026-11-13)
      return (asking.lock ||= vlock.showSheet().finally(() => { asking.lock = null })) // one sheet at a time, however often the page asks
    },
    // NOTIFICATIONS on this device (a vault started with `push: true`): the person says yes or no in the vault's card — that click
    // is the gesture the browser's permission prompt needs; the page gets only { available, on }
    async notifications() {
      if (!vpush) throw Object.assign(new Error('vault: this vault sends no notifications — its builder starts it with startVault({ push: true })'), { code: 'vault_unsupported' })
      return (asking.push ||= notificationsOnce().finally(() => { asking.push = null })) // one card at a time
    },
    async signOut() {
      // the PERSON confirms in the vault's own pixels: a page script alone cannot sign them out (security review). Whatever the sign-in:
      // once it had expired this returned at once, and the Spaces, their keys and the page's reach all stayed (sync sweep 11-22 #7)
      if (!holdsAnything()) return { signedIn: false }
      if (!(await confirmWith({ title: 'Sign out?', text: 'This device forgets your Spaces and your account. Your backup brings them back when you sign in again' + (sdk.backup && sdk.backup.enabled ? '.' : ' — and backup is OFF here, so a Space only this device holds is lost.'), ok: 'Sign out', cancel: 'Cancel' }).catch(() => false))) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
      // SIGN OUT ENDS THE PAGE'S REACH (docs/sdk-vault-mode.md: "cannot reach rooms after the user signs out in the vault"; sync sweep
      // 11-20 P7/P8): the held Spaces' keys and the account's stores go too — kept, the page still reached every Space, and the next
      // account's backup took them in (noteRoom). Our hosted vault's wipe (vault-loader.js wipeVaultAccount) does the same.
      await wipeSignedOut(); emit({ ev: 'signedOut' }); return { signedIn: false } },
    async whoami() { return signedIn() ? { signedIn: true, email: sdk.session.email, keyId: sessionKeyId() } : { signedIn: false } },
    async forget(room) {
      if (!held(room)) return { forgotten: false }
      // removing a Space's key from this device can lose it for good (no other copy): the PERSON confirms it (security review)
      const it = rooms.find((x) => x.room === room)
      if (!(await confirmWith({ title: 'Remove ' + (it && it.title ? '“' + it.title + '”' : 'this Space') + ' from this device?', text: 'Without its invite link you cannot open it here again.', ok: 'Remove', cancel: 'Keep' }).catch(() => false))) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
      await dropRoom(room)
      if (sdk.backup.enabled) sdk.backup.remove(room) // and from the account, on every device
      return { forgotten: true }
    },
  })

  // the lock sheet and the notifications card: ONE at a time, however often the page asks (as the sign-in screen)
  const asking = { lock: null, push: null }
  async function notificationsOnce() {
    const on = vpush.view().on
    const ok = await confirmWith(on
      ? { title: 'Turn off notifications?', text: 'This device stops getting a nudge when someone posts in your Spaces.', ok: 'Turn off', cancel: 'Keep them' }
      : { title: 'Get notifications on this device?', text: 'A nudge when someone posts in your Spaces. What it says is sealed until it reaches this device.', ok: 'Turn on', cancel: 'Not now' }).catch(() => false)
    if (!ok) return vpush.view()
    const v = on ? await vpush.disable() : await vpush.enable(rooms.map((r) => r.room))
    emit({ ev: 'push', push: v })
    return v
  }

  const joining = joinInvite() // after the frame exists: the question shows over it
  let greeted = false
  window.addEventListener('message', async (e) => {
    if (e.origin !== pageOrigin || e.source !== frame.contentWindow) return // only the page this vault framed
    const d = e.data
    if (!d || d.ch !== 'wbvault') return
    if (d.t === 'hello') {
      toPage({ t: 'welcome', v: VAULT_PROTOCOL, tenant: o.tenant || '', endpoint, signedIn: signedIn(), email: signedIn() ? sdk.session.email : '', keyId: sessionKeyId(), rooms: publicRooms(), siri: siriShortcut(), account: accountView(), keyStates: keyStatesNow(), ...(vlock ? { lock: vlock.view() } : {}), ...(vpush ? { push: vpush.view() } : {}), ...(tapRoom && held(tapRoom) ? { notifOpen: tapRoom } : {}) }) // lock / push: only a vault that offers them says anything
      if (!greeted) { greeted = true; if (typeof screens.ready === 'function') try { screens.ready() } catch { /* */ } joining.then(() => { if (joined) emit({ ev: 'joined', room: joined }) }) }
      return
    }
    if (d.t !== 'call' || typeof d.id !== 'number') return
    const fn = Object.prototype.hasOwnProperty.call(CALLS, d.op) ? CALLS[d.op] : null
    if (!fn) return refuse(d.id, 'vault: unknown call ' + String(d.op).slice(0, 40), 'vault_refused')
    // a result's own words name the page's call too (wb.erasure.file's `skipped: 'signed out: wb.signIn first'` — sync sweep 2026-10-29 #10)
    const pageWords = (r) => (r && typeof r === 'object' && !Array.isArray(r) && typeof r.skipped === 'string' ? { ...r, skipped: r.skipped.replace(/\bwb\.signIn\b/g, 'wb.vault.signIn') } : r)
    try { toPage({ t: 'res', id: d.id, result: pageWords(await fn(...(Array.isArray(d.args) ? d.args : []))) }) }
    catch (err) { const code = (err && err.code) || 'vault_error'; let msg = String((err && err.message) || err); if (code === 'sign_in_required') msg = msg.replace(/\bwb\.signIn\b/g, 'wb.vault.signIn'); refuse(d.id, msg, code, errExtra(err)) } // the page signs in through the VAULT — its own SDK said wb.signIn, which the page refuses (sync sweep 2026-10-28 #6)
  })
  // the page never says hello: tell the person, in the vault's own pixels
  setTimeout(() => { if (!greeted && typeof screens.failed === 'function') try { screens.failed({ page: pageUrl.href }) } catch { /* */ } }, o.loadTimeoutMs || 20_000)

  if (vpush) vpush.start(rooms.map((r) => r.room)).catch(() => {}) // a device that turned notifications on: its subscription, kept current
  return { frame, rooms: publicRooms, signedIn, worker: () => worker, _sdk: sdk } // _sdk: tests stand a Sentinel in
}
