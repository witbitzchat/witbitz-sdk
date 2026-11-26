// vaultEnclaveHandoff.js — THE RULES FOR HANDING A VAULT'S ROOM-KEY WORKER THE CONFIDENTIAL TIER (docs/vault-core-convergence-review.md,
// option C, C2). Our hosted vault (vault-loader.js) and the builders' vault (vault-core.js) each told the same l1-worker which enclave
// key to seal to and which rooms are confidential, with their own code — and five bugs came out of the two copies:
//   sync sweep 2026-11-06 #2 #3 (the core) — only the worker knew a room was confidential: the vault's own client sent a Space's
//     key READABLE and a Stop to the standard tier → `enclaveReady`, `saysConfidential`.
//   sync sweep 2026-11-09 #1 (ours) — a recreated worker's confidential list was EMPTY, so a room's key went out unsealed → the
//     held `snapshot()` a replay sends (the core now sends it FIRST, before the open, as ours does before any key).
//   sync sweep 2026-11-10 #1 (ours) — the worker got each frame's OWN list and replaces its list on every message: a panel's older
//     list took a new confidential Space off → `offer()` returns the UNION, and that is what the worker is sent.
//   state machines pass 8 R#1 (ours), pass 9 X#1 — a panel's older key over the main app's newer one; then the first key frozen →
//     the NEWER attestation wins whoever sends it, equal/unknown times → the main app (enclaveSnapshotMerge.js).
// The worker REPLACES its enclave state with each `{ t:'enclave', key, attested, keys, acceptance, rooms }` (l1-worker.js), so a vault
// must only ever send it the whole held state. What stays each vault's own is WHO attests and whom it believes: ours, its trusted
// frames (the person's accepted builds); the core, itself (its page is untrusted) and exactly the builds Witbitz publishes.
//
// createEnclaveHandoff({ trust }) → h
//   trust 'sender'    (ours) the builds the worker trusts are the senders' accepted lists, unioned (the person's list, per frame)
//         'published' (the core) exactly the live builds of the held region keys that the claim each carries names
//                     (enclaveAccept.acceptsMeasurement — the SDK's 'published' rule); a sender's list never counts
//   h.offer(snap, { fromMain })  merge a sender's snapshot into what is held → the message to send the worker (a copy)
//   h.mark(rooms)                add confidential rooms (the union only grows) → true when it grew
//   h.has(room) · h.rooms()      the union
//   h.snapshot()                 the held message, a copy (no sender's id or extra fields) — what a replay sends
//   h.known                      anything offered or marked yet
// enclaveReady({ confidential, hasKey, attest, mark }) → may this room be called on the enclave by a client the vault drives
// reattestOnce({ enc, run, reattest }) → one op: a missing/stale enclave key re-attests ONCE and runs the same sealed call again
import { mergeEnclaveSnapshot } from './enclaveSnapshotMerge.js'
import { acceptsMeasurement } from './enclaveAccept.js'

const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {})
const list = (a) => (Array.isArray(a) ? a.filter((r) => typeof r === 'string' && r) : [])

/** The live builds of a snapshot's region keys that the published claim each key carries names (attested.platform). */
export function publishedBuilds (snap) {
  const out = []
  for (const e of Object.values(obj(snap && snap.keys))) {
    const att = e && e.attested
    if (!e || !e.key || !att) continue
    const a = acceptsMeasurement(null, att, att.platform)
    if (a.ok && a.live) out.push(a.live)
  }
  return out
}

export function createEnclaveHandoff ({ trust = 'sender' } = {}) {
  if (trust !== 'sender' && trust !== 'published') throw new Error('createEnclaveHandoff: trust is sender or published')
  let held = null // the merged snapshot, without the room union
  const rooms = new Set()
  const copy = () => {
    const h = held || {}
    const keys = {}
    for (const [region, e] of Object.entries(obj(h.keys))) keys[region] = e && typeof e === 'object' ? { ...e } : e
    const acc = obj(h.acceptance)
    return {
      t: 'enclave',
      key: h.key ?? null,
      attested: h.attested ?? null,
      keys,
      acceptance: Array.isArray(acc.trusted) ? { ...acc, trusted: acc.trusted.slice() } : { ...acc },
      rooms: [...rooms],
    }
  }
  return {
    get known () { return !!held || rooms.size > 0 },
    offer (snap, { fromMain = true } = {}) {
      const s = obj(snap)
      for (const r of list(s.rooms)) rooms.add(r)
      const m = mergeEnclaveSnapshot(held, { ...s, rooms: [] }, !!fromMain)
      held = { key: m.key, attested: m.attested, keys: m.keys, acceptance: trust === 'published' ? { trusted: publishedBuilds(m) } : m.acceptance }
      return copy()
    },
    mark (rs) { const n = rooms.size; for (const r of list(rs)) rooms.add(r); return rooms.size > n },
    has: (room) => rooms.has(room),
    rooms: () => [...rooms],
    snapshot: copy,
  }
}

/** The server says this room is confidential: the front's `confidential_room` refusal, or a (keyless) answer's `tier: 'enclave'`
 *  (agent/tierGuard.mjs; spaceClient's own tierRefusal answers the same). */
export const saysConfidential = (r) => !!(r && typeof r === 'object' && (r.error === 'confidential_room' || r.tier === 'enclave'))
/** The enclave was replaced (or restarted): what was sealed to its key no longer opens. */
export const staleEnclaveKey = (r) => !!(r && typeof r === 'object' && (r.status === 401 || r.status === 200) && r.error === 'bad_mkseal')
/** The worker refused to seal: no enclave key in hand for this room (spaceClient keyFields) — nothing was sent. */
export const noEnclaveKey = (err) => /enclave key unavailable/i.test(String(err && err.message))

/** A client the VAULT drives (not the worker) is marked confidential only once the enclave key is in hand: a marked room with no
 *  key would send its key readable (sweep 11-06 #2 #3). Attests when the key is missing; never marks a standard room. */
export async function enclaveReady ({ confidential, hasKey, attest, mark }) {
  if (!confidential) return false
  if (!hasKey()) { try { await attest() } catch { return false } }
  if (!hasKey()) return false
  mark()
  return true
}

/** One op on a room: a confidential room whose enclave key is missing or stale re-attests ONCE and runs the SAME call again —
 *  through the same worker, so the room's key is sealed or not sent; there is no other path to fall back to. A standard room's
 *  answer and errors pass through untouched. */
export async function reattestOnce ({ enc, run, reattest }) {
  let tried = false
  const heal = async () => {
    if (!enc || tried) return false
    tried = true
    try { return !!(await reattest()) } catch { return false }
  }
  let r
  try { r = await run() } catch (err) {
    if (!(noEnclaveKey(err) && await heal())) throw err
    r = await run()
  }
  if (staleEnclaveKey(r) && await heal()) r = await run()
  return r
}
