// roomDelete.js — an ACCOUNT can delete the rooms it created (docs/user-erasure.md). At create, the page sends
// `delCommit = sha256(delete secret)`; the secret is HMAC(account secret, 'witbitz-room-delete:' + room) and only this
// account's devices can derive it, so a member who joined can never delete someone else's room. The account secret is the
// usage key's (usageReceipts.js) — it rides the account index, and a key that lost a convergence race is kept as retired,
// so a deletion tries every kept key.
import { loadUsageKey, loadOldUsageKeys, newUsageKey, saveUsageKey, dropFor } from './usageReceipts.js'

const enc = new TextEncoder()
const b64u = (u8) => { let x = ''; for (const b of u8) x += String.fromCharCode(b); return btoa(x).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const ub64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
export const DELETE_URL = 'https://api.witbitz.chat/v1/spaces/rooms/delete'

export function deletionConfirmed(result) {
  const body = result?.body
  return !!result?.ok && (body?.tombstoned === true || (body?.deleted === true && !body.queued && !body.pending))
}

export async function delSecretFor (key, room) {
  const k = await crypto.subtle.importKey('raw', ub64u(key.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('witbitz-room-delete:' + room))))
}
export async function delCommitOf (secret) { return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(secret)))) }

/** The commitment a create carries — minting the account key on the spot if this device has none yet (a brand-new
 *  account creates its index room before any sync). Never throws: a create without a commitment still goes. */
export async function delCommitFor (room, { load = loadUsageKey, mint = async () => saveUsageKey(await newUsageKey()) } = {}) {
  try { const key = load() || await mint(); return key ? await delCommitOf(await delSecretFor(key, room)) : null } catch { return null }
}

/** Delete a room this account created. Tries the current key, then retired ones. → { ok, status, body }
 *  A 200 may be `{ queued: true }` — the server answers on its one-row check and deletes in the background: NOT deleted yet.
 *  `check: true` asks only whether THIS account's tombstone is down (`{ deleted: true, tombstoned: true }`) and queues nothing —
 *  Delete my account confirms a queued room with it before it erases the account key (state machines pass 9, 9·S#1). */
export async function deleteOwnRoom (room, { keys = [loadUsageKey(), ...loadOldUsageKeys()].filter(Boolean), dropKeys = [], fetchImpl = (...a) => fetch(...a), check = false, reviewPolicy = false, reviewedPolicy, reviewedEtag, url = DELETE_URL } = {}) { // dropKeys: other keys this account leaves traces with (the SDK's usage key — sync sweep 11-08 #3)
  let last = { ok: false, status: 0, body: { error: 'no_account_key' } }
  // every drop this account holds in the room (current + retired keys): the server refuses only for OTHER accounts' traces
  const drops = []; for (const k of [...keys, ...dropKeys]) { try { const d = await dropFor(k, room); if (!drops.includes(d)) drops.push(d) } catch { /* */ } }
  for (const key of keys) {
    const delSecret = await delSecretFor(key, room)
    if (reviewedEtag !== undefined && !check) {
      const probe = await deleteOwnRoom(room, { keys: [key], dropKeys: [...keys, ...dropKeys], fetchImpl, check: true, reviewedEtag, url })
      if (probe.status === 404) { last = probe; continue }
      if (probe.body?.deleted === true) return probe
      if (probe.status !== 200 || !probe.body?.guardedCleanup || !reviewedPolicy || reviewedPolicy !== probe.body?.policyVersion) return { ok: false, status: probe.status === 200 ? 409 : probe.status, body: { error: 'cleanup_unconfirmed' } }
    }
    let r = null
    try { r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, confirm: room, delSecret, drops, ...(reviewedEtag !== undefined ? { reviewedEtag, reviewedPolicy } : {}), ...(reviewPolicy ? { reviewPolicy: true } : {}), ...(check ? { check: true } : {}) }) }) } catch { return { ok: false, status: 0, body: { error: 'unreachable' } } }
    const body = await r.json().catch(() => ({}))
    last = { ok: r.status === 200, status: r.status, body }
    if (r.status !== 404) return last // 200 done · 207 partly (call again) · 409 shared (others used it: leave it) · anything else: stop and say so
  }
  return last
}

/** LEAVING A VERIFIED ROOM (agent/roomLeave.mjs): what this account hands over as it goes — its marks in the room (`drops`, every
 *  kept key's) and the room's delete secrets it can derive (`dels`; only the creator's matches the room's commitment). */
export async function leaveHandover (room, { keys = [loadUsageKey(), ...loadOldUsageKeys()].filter(Boolean), dropKeys = [] } = {}) {
  const drops = [], dels = []
  for (const k of [...keys, ...dropKeys]) { try { const d = await dropFor(k, room); if (!drops.includes(d)) drops.push(d) } catch { /* */ } }
  for (const k of keys) { try { const s = await delSecretFor(k, room); if (!dels.includes(s)) dels.push(s) } catch { /* */ } }
  return { drops: drops.slice(0, 16), dels: dels.slice(0, 8) }
}

/** The LAST ONE OUT deletes the room with what every leaver handed over (op `leave` answered `last`): each handed-over delete
 *  secret is tried with all the handed-over marks; the server's own checks still run (another account's mark → 409 shared). */
export async function deleteHandedOver (room, { drops = [], dels = [] } = {}, { fetchImpl = (...a) => fetch(...a), url = DELETE_URL, check = false } = {}) {
  let last = { ok: false, status: 0, body: { error: 'no_delete_secret' } }
  for (const delSecret of dels) {
    let r = null
    try { r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, confirm: room, delSecret, drops, ...(check ? { check: true } : {}) }) }) } catch { return { ok: false, status: 0, body: { error: 'unreachable' } } }
    const body = await r.json().catch(() => ({}))
    last = { ok: r.status === 200, status: r.status, body }
    if (r.status !== 404) return last
  }
  return last
}

/** Leave a room on the way out of an account: `post(handover)` sends op `leave`; a verified room whose last member this was is then
 *  deleted. → { left, deleted?, last? } — never throws (a room that is not verified, or a server without the op, just stays). */
// A CONFIDENTIAL Space's enclave may be asleep: `leave` wakes it (agent/enclaveRelay.mjs) and the answer is `enclave_warming` until
// it is up — asked again for up to LEAVE_WARM_TRIES × LEAVE_WARM_MS (an enclave wakes in 1–6 min; sweep 11-18 #1). Still asleep after
// that → `{ warming: true }`, which Delete my account reports as not finished (run it again), never as left.
export const LEAVE_WARM_TRIES = 40, LEAVE_WARM_MS = 10_000
const warmingAnswer = (r) => { const b = (r && (r.body || r)) || {}; return b.error === 'enclave_warming' || b.warming === true }
export async function leaveAndMaybeDelete (room, { post, handover = leaveHandover, del = deleteHandedOver, sleep = (ms) => new Promise((res) => setTimeout(res, ms)), tries = LEAVE_WARM_TRIES } = {}) {
  let r = null
  let h; try { h = await handover(room) } catch { return { left: false } }
  for (let i = 0; ; i++) {
    try { r = await post(h) } catch { return { left: false } }
    if (!warmingAnswer(r)) break
    if (i + 1 >= tries) return { left: false, warming: true }
    await sleep(LEAVE_WARM_MS)
  }
  const b = (r && (r.body || r)) || {}
  if (r?.status === 409 && b.error === 'not_verified_room') return { left: false, unverified: true }
  if (r?.status !== 200 || b.left !== true) return { left: false }
  if (b.last !== true) return { left: true }
  if (b.lapses === true) return { left: true, last: true, lapses: true }
  const handed = { drops: b.drops || [], dels: b.dels || [] }
  let result = await Promise.resolve().then(() => del(room, handed)).catch(() => null)
  if (result?.ok && result.body?.queued && !deletionConfirmed(result)) {
    for (let i = 0; i < tries; i++) {
      await sleep(LEAVE_WARM_MS)
      result = await Promise.resolve().then(() => del(room, handed, { check: true })).catch(() => null)
      if (deletionConfirmed(result) || (result && ![0, 200, 503].includes(result.status))) break
    }
  }
  return { left: true, last: true, deleted: deletionConfirmed(result) }
}
