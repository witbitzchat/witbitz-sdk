// sdkVault.js — the SDK's side of a BUILDER-HOSTED VAULT (docs/sdk-vault-mode.md).
//
// A builder's page runs framed by a vault on another origin the builder also serves. The vault (vault-core.js) holds the
// room keys in its own worker; this page never does. Every room operation goes up as a message and its answer comes
// back — the page sends the room id and the operation, never a key, and gets back what the operation returns.
//
// The wire, on the `wbvault` channel, origin-pinned BOTH ways:
//   page → vault   { ch:'wbvault', t:'hello', v }            the handshake; the vault answers { t:'welcome', v, tenant, endpoint, signedIn, email, rooms }
//   page → vault   { ch:'wbvault', t:'call', id, op, args }   one request; the vault answers { t:'res', id, result } or { t:'res', id, error, code }
//   vault → page   { ch:'wbvault', t:'event', ev, ... }       rooms changed / joined / signed in or out / a room's stream
//   vault → page   { ch:'wbvault', t:'ask', id, kind, ... }   the vault needs the page's answer (a Siri drop for its deliver);
//                                                             the page replies with the call `answer(id, { result } | { error })`
// The page posts ONLY to the pinned vault origin (never '*') and accepts ONLY messages from that origin AND from the
// window that frames it — a page we did not write must not broadcast, and nothing else on the page may answer for the vault.
import { WORKER_OPS } from './workerClient.js'

export const VAULT_PROTOCOL = 1
const HELLO_MS = 8000          // the vault's welcome; past it the page is not in a vault (or the vault is not answering)
const CALL_MS = 120_000        // one operation; a turn can run a while — the vault answers when the server does
// …but a call that HOLDS A SCREEN for the person (a code from their mail, writing the recovery code down, a confirm) waits for
// them: at 120 s the page gave up with vault_timeout while the vault went on — a retried fork made a second room (sync sweep 10-22 #8)
const PERSON_MS = 15 * 60_000
const PERSON_OPS = new Set(['signIn', 'signOut', 'fork', 'follow', 'share', 'forget', 'changeMembers', 'rotateKey', 'account', 'roomAccount', 'lockSettings', 'notifications'])
// …and a call that may WAKE a confidential Space's enclave: a confidential create waits up to 45 × 8 s for it, a lane's create may
// wake it twice — past 120 s the page gave up while the vault went on, and a retry made a second room (sync sweep 11-04 P7)
const WAKE_MS = 15 * 60_000
const WAKE_OPS = new Set(['create', 'createLane'])

const isOrigin = (s) => typeof s === 'string' && /^https?:\/\/[^/?#]+$/.test(s)

/** Connect to the vault that frames this page. Resolves to a KEYLESS client the SDK's Space runs on, plus the vault's own
 *  calls (create, rooms, share, signIn, signOut). Rejects with `not_in_vault` when the page is not framed by that origin. */
export function connectVault({ vault, win = (typeof window !== 'undefined' ? window : null), helloMs = HELLO_MS } = {}) {
  const origin = String(vault || '').replace(/\/+$/, '')
  if (!isOrigin(origin)) return Promise.reject(Object.assign(new Error('witbitz: `vault` must be the vault\'s origin, e.g. https://vault.example.com'), { code: 'invalid_argument' }))
  if (!win || win.top === win) return Promise.reject(Object.assign(new Error('witbitz: this page is not framed by a vault — open the vault (' + origin + '), which opens this page inside it'), { code: 'not_in_vault' }))
  const top = win.top
  const waiting = new Map()
  const listeners = new Set()
  const askers = new Map() // kind → room → the page's handler for the vault's question
  const streams = new Map() // room → the handlers of every Space on this page showing it (the vault holds one socket per room)
  let seq = 0
  let welcome = null
  let onWelcome = null
  win.addEventListener('message', (e) => {
    if (e.origin !== origin || e.source !== top) return // only the vault that frames us
    const d = e.data
    if (!d || d.ch !== 'wbvault') return
    if (d.t === 'welcome') { welcome = d; if (onWelcome) onWelcome(d); return }
    if (d.t === 'res') {
      const w = waiting.get(d.id); if (!w) return
      waiting.delete(d.id); clearTimeout(w.timer)
      if (d.error) w.rej(Object.assign(new Error(String(d.error)), { code: d.code || 'vault_refused', status: d.status, ...(d.code === 'wrong_pin' && Number.isSafeInteger(d.next) && d.next >= 0 ? { next: d.next } : {}), ...(Array.isArray(d.unavailable) ? { unavailable: d.unavailable } : {}), ...(typeof d.reason === 'string' ? { reason: d.reason } : {}), ...(d.verdict && typeof d.verdict === 'object' ? { verdict: d.verdict } : {}) })); else w.res(d.result)
      return
    }
    if (d.t === 'ask' && typeof d.id === 'number') {
      const fn = (askers.get(d.kind) || new Map()).get(d.room)
      Promise.resolve().then(() => { if (!fn) throw new Error('nothing on this page takes ' + String(d.kind).slice(0, 30)); return fn(d) })
        .then((result) => call('answer', d.id, { result: result === undefined ? null : result }), (err) => call('answer', d.id, { error: String((err && err.message) || err || 'refused').slice(0, 200) })).catch(() => {})
      return
    }
    if (d.t === 'event' && d.ev === 'stream') { for (const fn of streams.get(d.room) || []) { try { fn(d) } catch { /* */ } } return }
    if (d.t === 'event') { for (const fn of listeners) { try { fn(d) } catch { /* a listener's error is its own */ } } }
  })
  const post = (msg) => top.postMessage({ ch: 'wbvault', ...msg }, origin)
  const call = (op, ...args) => new Promise((res, rej) => {
    const id = ++seq
    const timer = setTimeout(() => { if (waiting.delete(id)) rej(Object.assign(new Error('witbitz: the vault did not answer (' + op + ')'), { code: 'vault_timeout' })) }, PERSON_OPS.has(op) ? PERSON_MS : WAKE_OPS.has(op) ? WAKE_MS : CALL_MS)
    waiting.set(id, { res, rej, timer })
    try { post({ t: 'call', id, op, args }) } catch (err) { waiting.delete(id); clearTimeout(timer); rej(err) }
  })
  return new Promise((resolve, reject) => {
    const done = (w) => {
      clearTimeout(timer)
      // THE KEYLESS CLIENT: the same shape workerClient gives the Spaces app — each op takes (room, mk, …rest) and drops mk.
      const client = { keyless: true, vault: origin }
      for (const op of [...WORKER_OPS, 'sealed', 'exportSealed']) client[op] = (room, _mk, ...rest) => call('op', op, room, ...rest) // sealed/exportSealed: the stored ciphertext, for sealedProof
      client.stop = (room, key) => call('op', 'stop', room, key) // turn.abort(): stop the turn on the server — it needs no key, the vault sends it (sync sweep 10-15 #3)
      // SPEECH KEYS (dictation, reading aloud): minted by the vault with ITS sign-in; the idToken argument is the page's (none)
      client.stt = (_idToken, userToken) => call('speechKey', 'stt', userToken || '')
      client.tts = (_idToken, userToken) => call('speechKey', 'tts', userToken || '')
      // ROOM STREAMS: the socket lives in the vault's worker (it needs the key); the page gets its events. The worker
      // keeps the stream in step from the polls it runs, so the page's handle has nothing to sync.
      client.streamOpen = (room, onEvent, onState) => {
        const fn = (d) => { if (d.event) onEvent(d.event); else if ('up' in d && onState) onState(!!d.up) }
        let set = streams.get(room)
        if (!set) { set = new Set(); streams.set(room, set); call('stream', room, true).catch(() => { streams.delete(room) }) } // refused or not held: the Space keeps polling
        set.add(fn)
        return { stop: () => { if (set.delete(fn) && !set.size && streams.get(room) === set) { streams.delete(room); call('stream', room, false).catch(() => {}) } }, setGrants: () => {}, sync: () => {} }
      }
      const v = {
        origin, client, info: w,
        create: (cfg, opts) => call('create', cfg, ...(opts ? [opts] : [])), // opts { enclave }: dropping it would make a STANDARD Space where a confidential one was asked
        rooms: () => call('rooms'),
        share: (room, opts) => call('share', room, opts || {}),
        signIn: (opts) => call('signIn', opts || {}),
        signOut: () => call('signOut'),
        userToken: (t) => call('userToken', t), // per-user billing: the page's current token, handed over before an op that can spend
        whoami: () => call('whoami'),
        lockSettings: () => call('lockSettings'), // the vault's lock sheet (a vault started with `lock: true`): the person decides there; the page learns { available, on, protect }
        notifications: () => call('notifications'), // the vault's notifications card (`push: true`): the person decides; the page learns { available, on }
        forget: (room) => call('forget', room),
        createLane: (shared, cfg, o) => (o ? call('createLane', shared, cfg, o) : call('createLane', shared, cfg)), // o { open }: the page asked for an admission that is not a sign-in (refused in a verified Space)
        fork: (room, opts) => call('fork', room, opts),
        changeMembers: (room, admission) => call('changeMembers', room, admission), // a member change in place: the vault makes and keeps the new key (sdkRekey.js)
        rotateKey: (room) => call('rotateKey', room),
        follow: (room, id) => call('follow', room, id),
        announce: (room) => call('announce', room),
        account: (ns, m, ...a) => call('account', ns, m, ...a),
        roomAccount: (room, ns, m, ...a) => call('roomAccount', room, ns, m, ...a),
        onAsk: (kind, room, fn) => { if (!askers.has(kind)) askers.set(kind, new Map()); askers.get(kind).set(room, fn); return () => { const m = askers.get(kind); if (m && m.get(room) === fn) m.delete(room) } },
        on: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
      }
      resolve(v)
    }
    let stopped = false
    const timer = setTimeout(() => { stopped = true; reject(Object.assign(new Error('witbitz: the vault at ' + origin + ' did not answer — is this page framed by it?'), { code: 'not_in_vault' })) }, helloMs)
    if (welcome) return done(welcome)
    onWelcome = (w) => { onWelcome = null; done(w) }
    // the vault may still be starting its worker: say hello until it answers (or the wait ends)
    const hello = () => { if (welcome || stopped) return; try { post({ t: 'hello', v: VAULT_PROTOCOL }) } catch { /* */ } setTimeout(hello, 250) }
    hello()
  })
}
