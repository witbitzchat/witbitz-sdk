// chatLock.js — THE CHAT LOCK'S CORE (docs/chat-lock-plan.md; the owner, 2026-11-24: "a pin — not faceid", "It can be a different
// pin per room", "Every device with the same pin", "Hidden entirely", "Never delete, slow down", then "Lighter lock everywhere").
// A LIGHT lock: it hides a Space or a Code session and asks for its PIN before showing it, on every device of the account. Keys,
// the backup and the sync are untouched — whoever holds the account's data can read the chat without the PIN; the lock is about
// what the app shows. Pure: no DOM, no network.
//
// The synced doc `chat-locks` (sealed in the account's index room like every account doc):
//   { v: 1, locks: { <lockId>: { at, kind: 'room' | 'code', target, salt, pin, title? } | { at, gone: true } } }
//   target: a room id, or '<computerId>/<sessionId>'; pin: the PIN's fingerprint (pinIdFor) under its salt.
// Per lock the later edit wins; a removal is a tombstone, so an older copy cannot bring a lock back. One salt per account in
// practice (saltsOf), so a typed PIN is stretched once however many chats it is checked against.
import { b64url, ub64 } from './accountSeal.js'

export const PBKDF2_ITERS = 600_000
export const CHAT_LOCKS_DOC = 'chat-locks'
export const LOCKS_MAX = 500
const enc = new TextEncoder()
const LOCK_ID = /^lk_[A-Za-z0-9_-]{22}$/
const SALT = /^[A-Za-z0-9_-]{22}$/
const PIN_ID = /^[A-Za-z0-9_-]{43}$/
const KINDS = new Set(['room', 'code'])

export const validPin = (pin) => typeof pin === 'string' && /^\d{4,12}$/.test(pin)
export const isLockId = (s) => typeof s === 'string' && LOCK_ID.test(s)
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n))
export const newLockId = () => 'lk_' + b64url(rnd(16))
export const newSalt = () => b64url(rnd(16))
export const codeTarget = (computer, sid) => String(computer) + '/' + String(sid)

/** The PIN stretched with a salt → 32 raw bytes. Slow on purpose (PBKDF2_ITERS); `iters` only for tests. */
export async function stretchPin (pin, salt, iters = PBKDF2_ITERS) {
  if (!validPin(pin)) throw new Error('chat lock: a PIN is 4 to 12 digits')
  const km = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: ub64(salt), iterations: iters }, km, 256))
}
/** The PIN's fingerprint: HMAC(stretched PIN, 'chatlock-pin'), base64url. The same PIN on two chats gives the same one. */
export async function pinIdFor (stretched) {
  const k = await crypto.subtle.importKey('raw', stretched, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('chatlock-pin'))))
}

// ── the synced doc ──
const okAt = (n) => Number.isSafeInteger(n) && n >= 0
function cleanEntry (e) {
  if (!e || typeof e !== 'object' || !okAt(e.at)) return null
  if (e.gone === true) return { at: e.at, gone: true }
  if (!KINDS.has(e.kind) || typeof e.target !== 'string' || !e.target || e.target.length > 300) return null
  if (typeof e.salt !== 'string' || !SALT.test(e.salt) || typeof e.pin !== 'string' || !PIN_ID.test(e.pin)) return null
  return { at: e.at, kind: e.kind, target: e.target, salt: e.salt, pin: e.pin, ...(typeof e.title === 'string' && e.title ? { title: e.title.slice(0, 200) } : {}) }
}
export function cleanChatLocks (doc) {
  if (!doc || typeof doc !== 'object' || doc.v !== 1 || !doc.locks || typeof doc.locks !== 'object') return null
  const locks = {}
  for (const [id, e] of Object.entries(doc.locks)) {
    if (!isLockId(id)) continue
    const c = cleanEntry(e)
    if (c) locks[id] = c
    if (Object.keys(locks).length >= LOCKS_MAX * 2) break // live + tombstones
  }
  const tries = cleanTriesMap(doc.tries)
  return { v: 1, locks, ...(Object.keys(tries).length ? { tries } : {}) }
}
// THE WRONG-PIN COUNT, SYNCED (the owner, 2026-11-24: "why can't the tries be synced"): one entry per device in the doc; the
// account's count is their sum, so a wait set on one device holds on every other, and a second device brings no fresh tries.
const DEV = /^[A-Za-z0-9_-]{1,64}$/
function cleanTriesMap (m) {
  const out = {}
  for (const [d, t] of Object.entries(m && typeof m === 'object' ? m : {})) {
    if (!DEV.test(d) || !t || typeof t !== 'object') continue
    const fails = Math.max(0, t.fails | 0), at = Number(t.at) || 0, next = Number(t.next) || 0
    if (fails || next) out[d] = { fails, at, next }
    if (Object.keys(out).length >= 64) break
  }
  return out
}
const later = (a, b) => (a.at !== b.at ? (a.at > b.at ? a : b) : (JSON.stringify(a) >= JSON.stringify(b) ? a : b))
/** Per lock, the later edit wins (equal clocks: a fixed order, so every device lands on the same doc). */
export function mergeChatLocks (a, b) {
  a = cleanChatLocks(a); b = cleanChatLocks(b)
  if (!a) return b
  if (!b) return a
  const locks = {}
  for (const id of new Set([...Object.keys(a.locks), ...Object.keys(b.locks)])) {
    const x = a.locks[id], y = b.locks[id]
    locks[id] = !x ? y : !y ? x : later(x, y)
  }
  const tries = {} // per device, the entry that moved last
  for (const d of new Set([...Object.keys(a.tries || {}), ...Object.keys(b.tries || {})])) {
    const x = (a.tries || {})[d], y = (b.tries || {})[d]
    tries[d] = !x ? y : !y ? x : (Math.max(y.at, y.next) > Math.max(x.at, x.next) ? y : x)
  }
  return { v: 1, locks: Object.fromEntries(Object.keys(locks).sort().map((k) => [k, locks[k]])), ...(Object.keys(tries).length ? { tries: Object.fromEntries(Object.keys(tries).sort().map((k) => [k, tries[k]])) } : {}) }
}
const nextAt = (doc, now) => Math.max(now, ...Object.values((doc && doc.locks) || {}).map((e) => e.at + 1))
export function addLock (doc, lockId, { kind, target, salt, pin, title }, now = Date.now()) {
  const d = cleanChatLocks(doc) || { v: 1, locks: {} }
  if (!isLockId(lockId)) throw new Error('chat lock: a lock id')
  if (!d.locks[lockId] && liveLocks(d).length >= LOCKS_MAX) throw new Error('chat lock: too many locked chats')
  const e = cleanEntry({ at: nextAt(d, now), kind, target, salt, pin, title })
  if (!e) throw new Error('chat lock: a kind, a target, a salt and a PIN')
  return { ...d, locks: { ...d.locks, [lockId]: e } }
}
export function dropLock (doc, lockId, now = Date.now()) {
  const d = cleanChatLocks(doc) || { v: 1, locks: {} }
  return { ...d, locks: { ...d.locks, [lockId]: { at: nextAt(d, now), gone: true } } }
}
/** The locks in force: [{ lockId, at, kind, target, salt, pin }]. */
export const liveLocks = (doc) => Object.entries((cleanChatLocks(doc) || { locks: {} }).locks).filter(([, e]) => !e.gone).map(([lockId, e]) => ({ lockId, ...e }))
export const saltsOf = (doc) => [...new Set(liveLocks(doc).map((l) => l.salt))]
export const lockOfTarget = (doc, kind, target) => liveLocks(doc).find((l) => l.kind === kind && l.target === target) || null

// ── wrong PINs: slowed, never a deletion (the owner: "Never delete, slow down") ──
// Counted on this device. None to wait for the first 5 in a row; then 1 min, 5 min, 15 min, 1 h, then a day per try. The count
// drains one every 6 hours — a right PIN does not reset it, so knowing one chat's PIN does not hide guesses at another's.
export const FREE_TRIES = 5, DRAIN_MS = 6 * 3600e3
const WAITS = [60e3, 300e3, 900e3, 3600e3], DAY = 86400e3
export const waitFor = (fails) => (fails <= FREE_TRIES ? 0 : WAITS[fails - FREE_TRIES - 1] ?? DAY)
const cleanTries = (t) => ({ fails: Math.max(0, (t && t.fails) | 0), at: Number((t && t.at)) || 0, next: Number((t && t.next)) || 0 })
export function drainTries (t, now = Date.now()) {
  const x = cleanTries(t)
  if (!x.fails) return { ...x, at: now }
  const n = Math.floor((now - x.at) / DRAIN_MS)
  return n > 0 ? { ...x, fails: Math.max(0, x.fails - n), at: x.at + n * DRAIN_MS } : x
}
/** → the time the next PIN may be tried (0 = now). */
export const tryAfter = (t, now = Date.now()) => { const x = cleanTries(t); return x.next > now ? x.next : 0 }
/** A wrong PIN: → the new count ({ fails, at, next }). */
export function wrongTry (t, now = Date.now()) {
  const x = drainTries(t, now)
  const fails = x.fails + 1, w = waitFor(fails)
  return { fails, at: x.fails ? x.at : now, next: w ? now + w : 0 }
}

// ── the account's count, from the doc ──
/** The account's wrong tries now (each device's count drained, summed) and the time the next PIN may be tried (0 = now). */
export function accountTries (doc, now = Date.now()) {
  const m = (cleanChatLocks(doc) || {}).tries || {}
  let fails = 0, next = 0
  for (const t of Object.values(m)) { fails += drainTries(t, now).fails; if (t.next > now) next = Math.max(next, t.next) }
  return { fails, next }
}
/** A wrong PIN on device `dev`: → the doc with its count moved; the wait comes from the ACCOUNT's total. */
export function wrongTryIn (doc, dev, now = Date.now()) {
  const d = cleanChatLocks(doc) || { v: 1, locks: {} }
  const mine = drainTries((d.tries || {})[dev], now), total = accountTries(d, now).fails - drainTries((d.tries || {})[dev], now).fails + mine.fails + 1
  const w = waitFor(total)
  return { ...d, tries: { ...(d.tries || {}), [dev]: { fails: mine.fails + 1, at: mine.fails ? mine.at : now, next: w ? now + w : 0 } } }
}


/** Act only on the listed locks. A target is complete once its removal and the lock update both succeed. */
export async function deleteLockedTargets(targets, { stillLocked, removeTarget, removeLock }) {
  const outcomes = []
  for (const { lockId, kind, target } of targets) {
    let deleted = false
    try {
      if (await stillLocked(lockId, kind, target) && await removeTarget(kind, target)) {
        await removeLock(lockId, kind, target)
        deleted = true
      }
    } catch { /* record the failure and keep the other targets independent */ }
    outcomes.push({ lockId, kind, target, deleted })
  }
  return outcomes
}
