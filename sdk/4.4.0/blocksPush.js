// blocksPush.js — NO NOTIFICATION FROM A PERSON YOU BLOCKED (docs/report-and-block.md §4 (b); the owner, 2026-11-16: "Do b+c").
// The service worker shows a push without the app running and holds no list of yours, so the page leaves it one: `blocks:sw` in
// the 'spaces' idb the worker reads (in the hosted app, the VAULT's — its worker shows the notification), an array of HASHES of the
// blocked proofs a push can carry (agent/notif.mjs seals the writer's key `k` and, in a verified room, their `u` in the preview):
//   'u:' + @username         a person blocked by their username
//   's:' + room + '|' + sid  the key that signed in that room — a key-only block, or a key this device has SEEN carry a blocked
//                            email (a message never carries the email — the room's record maps key → email, blockView.js)
// A hash, not the names: a stolen disk reads no list of whom you blocked. The worker hashes what the push carried the same way
// (sw-notif-core wbxBlockedSender) and, on a match, shows the notification silently and closes it at once (iOS requires one).
// A push it cannot open (no preview key — "Show message preview" off on a protected device) is shown as before.
import { readBlocks } from './blocks.js'

export const BLOCKS_SW_KEY = 'blocks:sw'
const LEARNED_KEY = 'space:blocks:keys' // { email: ['room|sid', …] } — keys seen writing for a BLOCKED email (blockView noteBlockedKey)
const PER_EMAIL = 20, MAX_EMAILS = 200

const enc = new TextEncoder()
/** The worker's hash of one proof — sw-notif-core.js wbxBlockToken MUST stay byte-identical (a test asserts it). */
export async function blockToken (s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))))
  let b = ''; for (let i = 0; i < 16; i++) b += d[i].toString(16).padStart(2, '0')
  return b
}

const readLearned = () => { try { const o = JSON.parse(localStorage.getItem(LEARNED_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {} } catch { return {} } }

/** A message of a BLOCKED email was drawn with the key that signed it: that key, in that room, is theirs (for the worker). */
export function noteBlockedKey (email, room, sid) {
  if (!email || !room || !sid) return false
  const l = readLearned(), e = String(email).toLowerCase(), k = room + '|' + sid
  const was = Array.isArray(l[e]) ? l[e] : []
  if (was.includes(k)) return false
  const next = { ...l, [e]: [k, ...was].slice(0, PER_EMAIL) }
  const keys = Object.keys(next); if (keys.length > MAX_EMAILS) for (const x of keys.slice(0, keys.length - MAX_EMAILS)) if (x !== e) delete next[x]
  try { localStorage.setItem(LEARNED_KEY, JSON.stringify(next)) } catch { return false }
  return true
}

/** The proofs a push can be matched on, for the live blocks → sorted, unique token list. */
export async function blockTokens (list = readBlocks(), learned = readLearned()) {
  const raw = new Set()
  for (const b of list) {
    if (!b || b.gone) continue
    if (b.user) raw.add('u:' + b.user)
    if (b.room && b.sid) raw.add('s:' + b.room + '|' + b.sid)
    if (b.email && Array.isArray(learned[b.email])) for (const k of learned[b.email]) raw.add('s:' + k)
  }
  return [...new Set(await Promise.all([...raw].map(blockToken)))].sort()
}

/** `store(tokens|null)` writes where this device's worker reads (null = remove it); `keep()` false = a locked device that keeps
 *  nothing clear for its worker (protection on, previews off — its pushes cannot be opened anyway). */
export function makeBlocksMirror ({ store, keep = () => true }) {
  let last = '', chain = Promise.resolve()
  const run = async () => {
    let on = true; try { on = !!keep() } catch { on = true }
    const tokens = on ? await blockTokens() : null
    const sig = JSON.stringify(tokens)
    if (sig === last) return
    await store(tokens && tokens.length ? tokens : null)
    last = sig
  }
  return () => (chain = chain.then(run, run).catch(() => {}))
}
