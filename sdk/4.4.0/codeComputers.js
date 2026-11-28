// codeComputers.js — the account's PAIRED COMPUTERS registry (docs/opencode-relay.md §3.1).
//
// A sealed `op:'state'` doc named 'computers' in the account's index room, beside 'index' and 'index2'. Every signed-in
// device reads it (roomSync.js) and hands the live entries to the Code section (codeView.js); the pairing tool
// (tools/opencode-pair.mjs) writes it from the computer. ONE merge rule for all of them, defined here:
//
//   { v: 1, computers: { <id>: { name, relay, secret, pairedAt, mod } | { removed: true, mod } } }
//
// Last-writer-wins PER ENTRY on `mod`; on a tie a removal wins. A removal is a tombstone that keeps no secret, so an
// unpair propagates instead of being re-added by a device that has not heard of it yet.
//
// ⚠ A separate doc on purpose: older builds strip unknown fields from index2.code and write it back; they never touch a
//   doc called 'computers', so they cannot unpair anyone.

import { takeCodeKey } from './codeCloudKeys.js' // a cloud computer's account-issued keys (validator)
import { normEgress } from './codeEgress.js' // what this computer may reach — validated here so a bad policy is refused where it was typed
import { gunzipB64 } from './compress.js' // a plain doc the computer wrote large arrives gzipped ({ z }) — confirmScannedComputer reads it

export const COMPUTERS_KEY = 'space:computers'
export const CLOUD_PICKS_MAX_BYTES = 800_000
export const COMPUTERS_DOC = 'computers'

const ID = /^[A-Za-z0-9_-]{8,64}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/
const okRelay = (u) => { try { const x = new URL(String(u)); return x.protocol === 'wss:' || (x.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(x.hostname)) } catch { return false } }
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0) // a real number — not true, not "0x10"
// Entry maps have NO prototype: an id is only ever data, even one spelled like a built-in ("constructor", "__proto__").
const dict = (src) => Object.assign(Object.create(null), src || {})

/** One entry → its canonical shape, or null when it is not usable. */
export function normEntry(e) {
  if (!e || typeof e !== 'object') return null
  const mod = num(e.mod)
  if (!mod) return null
  if (e.removed) return { removed: true, mod }
  if (typeof e.secret !== 'string' || !SECRET.test(e.secret) || !okRelay(e.relay)) return null
  return { name: Array.from(String(e.name || 'computer')).slice(0, 80).join(''), relay: String(e.relay), secret: e.secret, pairedAt: num(e.pairedAt) || mod, mod, ...deviceOf(e) } // cut by character, never mid-emoji
}
// A computer the account's service REGISTERED at pairing (witbitz-code 1.15.5+, through a giver on the new service) carries its
// device key and that service: `spk` (the key, b64url) and `svc` (the service's address) — together or not at all. A computer
// paired before, or through an account on the old service, has neither and is never judged by the service (signedOutIds).
const SPK = /^[A-Za-z0-9_-]{40,128}$/
const okSvc = (u) => { try { const x = new URL(String(u)); return String(u).length <= 200 && (x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(x.hostname))) } catch { return false } }
const deviceOf = (e) => (e && SPK.test(String(e.spk || '')) && okSvc(e.svc) ? { spk: String(e.spk), svc: String(e.svc) } : {})

/** Any doc (or nothing) → { v: 1, computers: {…} } with only well-formed entries. */
export function normRegistry(doc) {
  const out = { v: 1, computers: dict() }
  const src = doc && typeof doc === 'object' && doc.computers && typeof doc.computers === 'object' ? doc.computers : {}
  for (const [id, e] of Object.entries(src)) { if (!ID.test(id)) continue; const n = normEntry(e); if (n) out.computers[id] = n }
  return out
}

/** Merge two registries: per id the higher `mod` wins; a tie goes to the removal. Pure. */
export function mergeRegistry(a, b) {
  const x = normRegistry(a), y = normRegistry(b)
  const out = { v: 1, computers: dict(x.computers) }
  for (const [id, e] of Object.entries(y.computers)) {
    const cur = out.computers[id]
    if (!cur || e.mod > cur.mod || (e.mod === cur.mod && e.removed && !cur.removed)) out.computers[id] = e
  }
  return out
}

export const sameRegistry = (a, b) => JSON.stringify(sortKeys(normRegistry(a))) === JSON.stringify(sortKeys(normRegistry(b)))
function sortKeys(r) { const c = dict(); for (const id of Object.keys(r.computers).sort()) c[id] = r.computers[id]; return { v: 1, computers: c } }

/** The computers you can connect to, oldest pairing first: [{ id, name, relay, secret }]. */
export function liveComputers(reg) {
  return Object.entries(normRegistry(reg).computers)
    .filter(([, e]) => !e.removed)
    .sort((p, q) => p[1].pairedAt - q[1].pairedAt || (p[0] < q[0] ? -1 : 1))
    .map(([id, e]) => ({ id, name: e.name, relay: e.relay, secret: e.secret }))
}

/** Add or update one computer (the pairing tool's write). */
export function withComputer(reg, id, { name, relay, secret }, now = Date.now()) {
  const prev = normRegistry(reg).computers[id]
  const mod = Math.max(now, prev ? prev.mod + 1 : 0)
  return mergeRegistry(reg, { computers: dict({ [id]: { name, relay, secret, pairedAt: prev && !prev.removed ? prev.pairedAt : now, mod } }) })
}

/** Does this id still need its pairing written? A RESTORE from a key file (codeKeyFile.js) finds the removal's tombstone
 *  here — an entry, but one that keeps no secret — so "already known" must not be read as "nothing to write". */
export function needsPairing(reg, id) {
  const e = normRegistry(reg).computers[id]
  return !e || !!e.removed
}

/** Tombstone one computer (unpair / "Remove" in Settings). */
export function withoutComputer(reg, id, now = Date.now()) {
  const prev = normRegistry(reg).computers[id]
  return mergeRegistry(reg, { computers: dict({ [id]: { removed: true, mod: Math.max(now, prev ? prev.mod + 1 : 0) } }) })
}

// ── THE SCAN, CONFIRMED BY A DEVICE OF THE ACCOUNT (state machines pass 9, C#3, step b) ──────────────────────────────
// A paired computer writes only the PLAIN 'computers' doc (it holds no account key), and every app folds that doc in by
// `mod` — so a computer removed on the phone could write itself back live and be listed again, and nothing told a scan the
// person made from a self-revive. Now the device that GAVE the keys, told by the computer's report which computer it
// paired (deviceLink.js `cid`), copies exactly that entry into the SEALED list ('xcomputers'), with a `mod` over any
// tombstone or older entry this account holds for it. Only a holder of the account key can write there, which is the point:
// the sealed copy then says "a device of this account confirmed this computer". (Step c — the merge no longer letting a
// plain entry outrank a sealed tombstone — ships only once computers send their id, or a re-scanned computer stays hidden.)

/** The sealed list's write for a confirmed scan: `plainDoc`'s live entry for exactly `cid`, with a `mod` that beats what
 *  `knownDoc` (the account's list as this device reads it) holds for that id — a removal, or another pairing's entry — or
 *  null when the plain doc has no live entry for it. Pure. */
export function confirmedEntry(plainDoc, cid, knownDoc, dev = null) {
  if (!ID.test(String(cid || ''))) return null
  const e = normRegistry(plainDoc).computers[cid]
  if (!e || e.removed) return null
  const k = normRegistry(knownDoc).computers[cid]
  const mod = k && k.mod >= e.mod && (k.removed || k.secret !== e.secret) ? k.mod + 1 : e.mod
  // THE DEVICE KEY THE SERVICE JUST REGISTERED (`dev`: { spk, svc }, from this giver — never from the computer's own write): kept
  // in the sealed entry so a later sign-out takes it off the list (pruneSignedOutComputers). Its `mod` beats the plain entry and
  // whatever this account holds for it, so no copy without the key wins a tie (every merge keeps the one it has on a tie).
  const d = deviceOf(dev)
  if (d.spk) return { v: 1, computers: dict({ [cid]: { ...e, ...d, mod: Math.max(mod, e.mod, k ? k.mod : 0) + 1 } }) }
  return { v: 1, computers: dict({ [cid]: { ...e, mod } }) }
}

/** Confirm the computer a scan just paired. Three doors, each { status, state } like the account transport:
 *  `readKnown()` the account's list as this device reads it; `readPlain()` the PLAIN doc, raw; `write(doc)` the account
 *  store's sealed write (accountStores put: it merges per entry with what is there). → { ok, mod? , why? }. Never throws.
 *  Nothing is written when anything is unknown: a read that is not a 200, an entry missing or removed (logged). */
export async function confirmScannedComputer(cid, { readKnown, readPlain, write, dev = null, log = () => {} } = {}) {
  const no = (why) => { try { log('confirm ' + String(cid || '').slice(0, 64) + ': ' + why + ' — nothing written') } catch { /* */ } return { ok: false, why } }
  if (!ID.test(String(cid || ''))) return no('no computer named')
  try {
    const kr = await readKnown()
    if (!(kr && kr.status === 200)) return no('the account\'s list could not be read (' + ((kr && kr.status) || 0) + ')')
    const pr = await readPlain()
    if (!(pr && pr.status === 200)) return no('the computer\'s list could not be read (' + ((pr && pr.status) || 0) + ')')
    let plain = pr.state
    if (plain && typeof plain === 'object' && typeof plain.z === 'string') plain = await gunzipB64(plain.z)
    const doc = confirmedEntry(plain, cid, kr.state, dev)
    if (!doc) return no('the computer\'s list has no live entry for it')
    const wr = await write(doc)
    if (!(wr && wr.status === 200)) return no('the sealed write was refused (' + ((wr && wr.status) || 0) + ')')
    return { ok: true, mod: doc.computers[cid].mod }
  } catch (e) { return no(String((e && e.message) || e).slice(0, 120)) }
}

// ── A COMPUTER SIGNED OUT OF THE ACCOUNT LEAVES THE LIST (docs/TODO.md; the owner, 2026-11-17: "fix it") ─────────────────
// A computer paired for Code is one of the account's devices on the new service, and a sign-out from another device wipes it —
// but then it can no longer write the removal of its own entry, so it stayed listed until someone pressed Remove. A device of the
// account now asks the service, once per load, about the computers whose key it registered (`spk` + `svc`, confirmedEntry), and
// removes the ones the service says are signed out — the way a manual Remove does, so both copies and every device follow.
// ONLY an answer naming the key removes: 'revoked' (signed out) or 'not_ours' (no device of this account — asked of the same
// service it was registered on). 'active', 'provisional' (never signed out), a key missing from the answer, an answer from
// another service, no answer (offline, an error, an account on the old service) — the entry stays. No key, no question.
export const SIGNED_OUT = Object.freeze(['revoked', 'not_ours'])

/** The live computers the service can be asked about: [{ id, name, spk, svc }]. */
export function registeredComputers(reg) {
  return Object.entries(normRegistry(reg).computers).filter(([, e]) => !e.removed && e.spk && e.svc).map(([id, e]) => ({ id, name: e.name, spk: e.spk, svc: e.svc }))
}
/** The ids an answer ({ base, states }) signs out — only entries registered on `base`, only a state in SIGNED_OUT. Pure. */
export function signedOutIds(reg, answer) {
  if (!answer || typeof answer !== 'object' || typeof answer.base !== 'string' || !answer.base || !answer.states || typeof answer.states !== 'object') return []
  const st = answer.states
  return registeredComputers(reg).filter((c) => c.svc === answer.base && Object.prototype.hasOwnProperty.call(st, c.spk) && SIGNED_OUT.includes(st[c.spk])).map((c) => c.id)
}
/** One pass: `load()` the list, `ask(spks)` → { base, states } | null (throws = unknown), `remove(id)` each signed-out one
 *  (the manual Remove). → { asked, removed: [{ id, name }] , why? }. Never throws; nothing is removed on anything unknown. */
export async function pruneSignedOutComputers({ load = loadRegistry, ask, remove, log = () => {} } = {}) {
  const say = (line) => { try { log(line) } catch { /* */ } }
  const reg = load()
  const regd = registeredComputers(reg)
  if (!regd.length || typeof ask !== 'function' || typeof remove !== 'function') return { asked: 0, removed: [] }
  let answer = null
  try { answer = await ask([...new Set(regd.map((c) => c.spk))].slice(0, 50)) } catch (e) { say('computers: the account service did not answer (' + String((e && (e.code || e.message)) || e).slice(0, 80) + ') — the list stays as it is'); return { asked: regd.length, removed: [], why: 'unknown' } }
  if (!answer) return { asked: regd.length, removed: [], why: 'off' } // no account on the new service here
  const now = load() // what the list holds NOW: an entry re-paired (a new key) or removed meanwhile is not judged by the old answer
  const ids = signedOutIds(now, { base: answer.base, states: Object.fromEntries(Object.entries(answer.states || {}).filter(([spk]) => regd.some((c) => c.spk === spk))) })
  const removed = []
  for (const id of ids) {
    const c = regd.find((x) => x.id === id)
    try { await remove(id); removed.push({ id, name: c ? c.name : '' }); say('computers: "' + (c ? c.name : id) + '" was signed out of your account — taken off the list') } catch (e) { say('computers: could not take "' + (c ? c.name : id) + '" off the list (' + String((e && e.message) || e).slice(0, 80) + ')') }
  }
  return { asked: regd.length, removed }
}

// ── this device's cached copy (browser only) ─────────────────────────────────────────────────────────────────────
export function loadRegistry() { try { return normRegistry(JSON.parse(localStorage.getItem(COMPUTERS_KEY) || 'null')) } catch { return normRegistry(null) } }
export function saveRegistry(reg) { try { localStorage.setItem(COMPUTERS_KEY, JSON.stringify(normRegistry(reg))) } catch { /* private mode */ } }
/** Fold a remote copy into ours. Returns true when what this device holds changed. */
export function adoptRegistry(remote) {
  const cur = loadRegistry()
  const next = mergeRegistry(cur, remote)
  if (sameRegistry(cur, next)) return false
  saveRegistry(next)
  return true
}
export function removeComputerLocally(id, now = Date.now()) { saveRegistry(withoutComputer(loadRegistry(), id, now)) }

// ── CLOUD COMPUTERS (docs/cloud-computer.md §10.4) ──────────────────────────────────────────────────────────────────
// A cloud computer is listed in 'computers' like any paired one (a relay and a secret: its connector runs inside the
// enclave). What only this account may know about it lives in a SECOND sealed doc, 'cloudComputers', keyed by the same id:
//
//   { v: 1, cloud: { <id>: { workspace, half, key, tinfoil, github, grantKey, version, mod } | { removed: true, mod } } }
//
// `half` is the device's half of the workspace's disk key — lose it and the workspace cannot be opened again. `key`,
// `tinfoil` and `github` are the TrustedRouter key, Tinfoil key and GitHub token its agent uses — handed only to the
// host's Credential Sentinel, never to the cloud computer (docs/credential-sentinel.md §9). `grantKey` makes the keys that
// tag the Sentinel's asks and seal its log (codeSentinel.js). `version` is the newest saved workspace version this account has seen: a host
// offering an older one is refused. A separate doc for the same reason as above: an older build keeps only the fields it
// knows and would write the computers back without these. Same merge rule: last writer wins per entry, a removal on a tie.
export const CLOUD_KEY = 'space:cloud-computers'
export const CLOUD_DOC = 'cloudComputers'
const WORKSPACE = /^[a-z0-9]{20,40}$/
const HALF = /^[A-Za-z0-9+/]{43}=$/ // 32 bytes, base64

/**
 * ★ ONE LIST, ITERATED BY BOTH ALLOWLISTS, because "remember to edit both" has now failed three times for three
 *   different fields — the owner secret (2026-09-14), and the egress policy (2026-09-17), each shipping INERT with
 *   nothing failing loudly, each found late by comparing an artifact rather than by the test meant to catch it. A
 *   capitalised comment saying "add it in both places" was read and half-obeyed by two careful people on different
 *   days. So the second allowlist stops existing as a separate thing: `normCloudEntry` here and `cloudOf` in
 *   opencodeApp.js both walk THIS, and adding a cloud field is one edit in one place.
 *
 *   `take` returns the value to keep, or undefined to drop it. Dropping is always the safe direction: a field neither
 *   side can validate is absent, and absent means the strictest reading of whatever it controls.
 */
export const CLOUD_FIELDS = [
  { key: 'key', take: (v) => str400(v) },                                  // the TrustedRouter key its agent runs on
  { key: 'tinfoil', take: (v) => str400(v) || undefined },                 // optional: pictures and files for text-only models
  { key: 'venice', take: (v) => str400(v) || undefined },                  // optional: the zero-retention models (Venice) — an account-keyed computer's own
  { key: 'github', take: (v) => str400(v) || undefined },                  // optional: clone, push, pull requests
  { key: 'grantKey', take: (v) => (HALF.test(String(v)) ? String(v) : undefined) }, // makes the Sentinel's ask tags and log keys
  // The workspace's own secrets (codeCloud.js `newCloudSecrets`): `owner` is who it belongs to, on every call;
  // `recovery` is the one the KEY FILE carries, which only moves it to a new owner; `pendingMove` is an old recovery
  // secret a restore has not spent yet, kept until the move lands so a failed one can be tried again.
  { key: 'owner', take: (v) => (SECRET.test(String(v)) ? String(v) : undefined) },
  { key: 'recovery', take: (v) => (SECRET.test(String(v)) ? String(v) : undefined) },
  { key: 'pendingMove', take: (v) => (SECRET.test(String(v)) ? String(v) : undefined) },
  // What this computer may reach (codeEgress.js). ★ A POLICY THAT DOES NOT VALIDATE IS DROPPED, not kept and not
  // "corrected": dropped, it reads back as `none` — the strictest mode — so a doc corrupted in transit, or written by
  // a newer page, reaches NOTHING rather than something nobody chose.
  { key: 'egress', take: (v) => { const r = normEgress(v); return r.policy && r.policy.mode !== 'none' ? r.policy : undefined } },
  // The key the agent's browser is watched under (docs/cloud-computer.md § 12, spaces/public/browseSeal.js). It
  // rides the sealed BUNDLE to the enclave and stays here for the viewer, which derives the relay channel from it —
  // so the relay is told a hash and never the key. Same shape as the disk half: 32 bytes, base64.
  { key: 'browse', take: (v) => (HALF.test(String(v)) ? String(v) : undefined) },
  // PRIVATE BROWSING (2026-09-22, the anonymity work, point 4): the browser's profile — cookies, logins, history — is
  // wiped every time this computer opens and again when it closes, inside the enclave (browse.go), never as a page-side
  // promise. Absent = false: a computer made before this keeps its profile exactly as it did.
  { key: 'browsePrivate', take: (v) => (v === true ? true : undefined) },
  // THE ACCOUNT'S KEYS for this computer (codeCloudKeys.js, 2026-10-12): its id and the two private keys that open its sealed
  // keys and sign its status — what renews the Tinfoil cap each month. Absent on a computer made with pasted keys.
  { key: 'codeKey', take: takeCodeKey },
  // THE ACCOUNT'S CONNECTIONS this computer's agent may use (docs/cloud-computer-connections.md): picked here, none by
  // default (the owner, 2026-10-19). Each carries its callKey — the account's own material, which already rides the
  // account (store.js space:connectionKeys) — and the tools picked, with those that run without asking.
  { key: 'connections', take: takeCloudConnections },
  // The Witbitz GitHub App installation that replaces a pasted token: its connection id and callKey, and the GitHub login.
  { key: 'githubApp', take: (v) => { const r = takeConnRef(v); return r ? { ...r, login: String(v.login || '').slice(0, 100) } : undefined } },
  // CLOSED, FOR EVERY DEVICE (2026-11-07, the implicit-state-machine review): when the person closed it (ms). The closed mark was
  // the closing page's alone, so another device's open Code page saw "offline", took it for asleep and opened it again. A page
  // opens it by itself only for someone who used it AFTER this (opencodeApp.js mayAutoOpen); an Open tap always does.
  { key: 'closedAt', take: (v) => (Number.isFinite(v) && v > 0 && v < 1e14 ? Math.floor(v) : undefined) },
]
const str400 = (v) => (typeof v === 'string' && v.length <= 400 ? v : '')
const CONN_ID = /^[A-Za-z0-9_-]{8,64}$/, CALL_KEY = /^[A-Za-z0-9+/]{43}=$/, ACCT = /^[^\s@]{1,200}@[^\s@]{1,63}$/, TOOL_NAME = /^[A-Za-z0-9_.\-]{1,64}$/
// `held: 1` and no callKey: the hosted app's vault holds the key (vaultConnKeys.js); it is asked for at each open (codeCloud.js
// withCallKeys) and never saved here
function takeConnRef (v) {
  if (!v || typeof v !== 'object' || !ACCT.test(String(v.account || '')) || !CONN_ID.test(String(v.id || ''))) return null
  if (CALL_KEY.test(String(v.callKey || ''))) return { account: String(v.account), id: String(v.id), callKey: String(v.callKey) }
  return (v.held === 1 || v.held === true) && !v.callKey ? { account: String(v.account), id: String(v.id), held: 1 } : null
}
function takeCloudConnections (v) {
  if (!Array.isArray(v)) return undefined
  const out = []
  for (const c of v.slice(0, 32)) {
    const r = takeConnRef(c)
    if (!r || !c.mcp || !Array.isArray(c.mcp.tools)) continue
    const tools = c.mcp.tools.filter((t) => t && TOOL_NAME.test(String(t.name))).slice(0, 40).map((t) => ({
      name: String(t.name), title: String(t.title || '').slice(0, 120), description: String(t.description || '').slice(0, 1000),
      ...(t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema) && JSON.stringify(t.inputSchema).length <= 20000 ? { inputSchema: t.inputSchema } : {}),
    }))
    if (!tools.length) continue
    const auto = (Array.isArray(c.mcp.auto) ? c.mcp.auto : []).map(String).filter((n) => tools.some((t) => t.name === n))
    out.push({ ...r, label: String(c.label || '').slice(0, 80), host: String(c.host || '').slice(0, 253), mcp: { tools, auto } })
  }
  return out.length ? out : undefined
}

/** Copy every cloud field that survives its own validator from `src` onto `out`. Both allowlists end with this. */
export function takeCloudFields(src, out) {
  for (const f of CLOUD_FIELDS) {
    const v = f.take(src ? src[f.key] : undefined)
    if (v !== undefined) out[f.key] = v
  }
  return out
}

export function normCloudEntry(e) {
  if (!e || typeof e !== 'object') return null
  const mod = num(e.mod)
  if (!mod) return null
  if (e.removed) return { removed: true, mod }
  if (!WORKSPACE.test(String(e.workspace)) || !HALF.test(String(e.half))) return null
  const version = Number.isInteger(e.version) && e.version >= 0 ? e.version : 0
  return takeCloudFields(e, { workspace: e.workspace, half: e.half, version, mod })
}
export function normCloud(doc) {
  const out = { v: 1, cloud: dict() }
  const src = doc && typeof doc === 'object' && doc.cloud && typeof doc.cloud === 'object' ? doc.cloud : {}
  for (const [id, e] of Object.entries(src)) { if (!ID.test(id)) continue; const n = normCloudEntry(e); if (n) out.cloud[id] = n }
  return out
}
export function mergeCloud(a, b) {
  const x = normCloud(a), y = normCloud(b)
  const out = { v: 1, cloud: dict(x.cloud) }
  for (const [id, e] of Object.entries(y.cloud)) {
    const cur = out.cloud[id]
    if (!cur || e.mod > cur.mod || (e.mod === cur.mod && e.removed && !cur.removed)) out.cloud[id] = e
  }
  return out
}
export const sameCloud = (a, b) => {
  const s = (r) => { const c = dict(); for (const id of Object.keys(r.cloud).sort()) c[id] = r.cloud[id]; return JSON.stringify(c) }
  return s(normCloud(a)) === s(normCloud(b))
}
/** Add a cloud computer, or change one (a newer version). The version never goes down, whatever the caller passes. */
export function withCloud(reg, id, fields, now = Date.now()) {
  const prev = normCloud(reg).cloud[id]
  const live = prev && !prev.removed ? prev : null
  // ★ A FIELD SENT AS null IS REMOVED (the owner, 2026-11-18: "I tried to turn private off but couldn't"): a save is merged over
  //   the entry, so a field the page DELETED (Private off, the last Connection unpicked, GitHub disconnected) came back from it.
  const next = { ...(live || {}), ...fields, mod: Math.max(now, prev ? prev.mod + 1 : 0) }
  for (const [k, v] of Object.entries(fields || {})) if (v === null) delete next[k]
  if (live) next.version = Math.max(live.version, Number.isInteger(fields.version) ? fields.version : 0)
  return mergeCloud(reg, { cloud: dict({ [id]: next }) })
}
export function withoutCloud(reg, id, now = Date.now()) {
  const prev = normCloud(reg).cloud[id]
  if (!prev) return normCloud(reg)
  return mergeCloud(reg, { cloud: dict({ [id]: { removed: true, mod: Math.max(now, prev.mod + 1) } }) })
}
/** The live computers, each cloud one carrying what opening it needs: [{ id, name, relay, secret, cloud? }]. */
export function withCloudInfo(computers, cloudReg) {
  const cloud = normCloud(cloudReg).cloud
  return computers.map((c) => {
    const e = cloud[c.id]
    if (!e || e.removed) return c
    const { mod, ...part } = e
    return { ...c, cloud: part }
  })
}
// ⛔ A RECORD THAT NAMES A CONNECTION BY ID (`held: 1`) IS DROPPED BY ANY BUILD BEFORE THIS ONE: its takeConnRef wanted a callKey, so
//   an older device (Official behind Beta, the same account) loses the connection at load and its next save syncs the loss to every
//   device (review, 2026-11-14). This build READS such records (takeConnRef, codeCloud.js withCallKeys); nothing WRITES them until every
//   served hosted build reads them — turn this on once the hosted app's floor (spaces/channels-policy.json tenant.minVersion) is at or
//   above the release that carries this (docs/TODO.md § 4). Off: the Code bridge hands whole keys and records keep them, as before.
export const CLOUD_HELD_REFS = false
// A CLOUD COMPUTER'S SAVED CALLKEYS MOVE INTO THE VAULT (the hosted app; the owner, 2026-11-14: "Close the gaps"). A record saved
// before kept each picked connection's callKey whole; they are asked into the vault (`hold(keys)` → the ids it now holds under THAT
// key — store.js holdCallKeysInVault), and a record keeps `held: 1` only for those. The Code page asks for the keys at each open
// (codeCloud.js withCallKeys). No answer, or none held: the record stays whole. → how many computers changed.
export async function moveCloudCallKeys ({ hold, load = loadCloud, save = saveCloud, push = () => {} } = {}) {
  const refs = (e) => [...(Array.isArray(e.connections) ? e.connections : []), ...(e.githubApp ? [e.githubApp] : [])]
  const keys = {}
  for (const e of Object.values(load().cloud)) if (e && !e.removed) for (const c of refs(e)) if (c && c.callKey && !keys[c.id]) keys[c.id] = { callKey: c.callKey, account: c.account || '', label: c.label || '', host: c.host || '' }
  if (!Object.keys(keys).length) return 0
  let ids = []; try { ids = (await hold(keys)) || [] } catch { ids = [] }
  const held = new Set(ids); if (!held.size) return 0
  const strip = (c) => { if (!c || !c.callKey || !held.has(c.id) || keys[c.id].callKey !== c.callKey) return c; const { callKey: _k, ...rest } = c; return { ...rest, held: 1 } }
  let reg = load(), n = 0
  for (const [id, e] of Object.entries(reg.cloud)) {
    if (!e || e.removed) continue
    const patch = {}
    if (Array.isArray(e.connections) && e.connections.some((c) => strip(c) !== c)) patch.connections = e.connections.map(strip)
    if (e.githubApp && strip(e.githubApp) !== e.githubApp) patch.githubApp = strip(e.githubApp)
    if (Object.keys(patch).length) { reg = withCloud(reg, id, patch); n++ }
  }
  if (n) { save(reg); try { push() } catch { /* the next push carries it */ } }
  return n
}
export function loadCloud() { try { return normCloud(JSON.parse(localStorage.getItem(CLOUD_KEY) || 'null')) } catch { return normCloud(null) } }
export function saveCloud(reg) { try { localStorage.setItem(CLOUD_KEY, JSON.stringify(normCloud(reg))) } catch { /* private mode */ } }
export function adoptCloud(remote) {
  const cur = loadCloud()
  const next = mergeCloud(cur, remote)
  if (sameCloud(cur, next)) return false
  saveCloud(next)
  return true
}
