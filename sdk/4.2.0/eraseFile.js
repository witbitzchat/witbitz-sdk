// eraseFile.js — FILE THIS ACCOUNT'S DELETE LIST WITH THE SENTINEL, for this app's tenant (docs/user-erasure.md E3).
// If the person leaves and the app's tenant deletes them, no device of theirs is there to read the account index. So the
// device keeps, sealed to the attested standing Sentinel and filed under THIS app's tenant only, what the account may
// delete: per room, the creator's delete secret(s) and the account's drops. A secret deletes only a room this account
// CREATED (the server checks its commitment) and only if nobody else used it (409 shared) — so listing every room the
// account knows is safe, and the device need not decide which it made. Tenant apps only; nothing leaves when unchanged.
import { delSecretFor } from './roomDelete.js'
import { loadUsageKey, loadOldUsageKeys, dropFor } from './usageReceipts.js'

export const FILED = 'space:erasefiled'
export const CT_BUDGET = 560_000 // the Lambda keeps 600 KB of a sealed field; base64 + GCM ≈ 1.34 × the JSON
const EVERY_MS = 6 * 3600_000 // refile an unchanged list at most this often (a new Sentinel boot keeps the store; this is belt and braces)
const ROOM = /^(?:sp|tmp)-[0-9a-z-]{1,48}$/

async function fingerprint (s) { const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); return Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('') }

/** The record the Sentinel takes (erase.mjs grant). `rooms` newest first; trimmed to fit the sealed-field budget. */
export async function eraseRecordFor ({ account, tenant, rooms, keys, dropKeys = [] }) { // dropKeys: other keys this account leaves traces with (the SDK's usage receipts — sync sweep 11-08 #3)
  const items = []
  let size = 0
  for (const room of [...new Set(rooms)].filter((r) => ROOM.test(r))) {
    const secrets = [], drops = []
    for (const k of keys) { secrets.push(await delSecretFor(k, room)); drops.push(await dropFor(k, room)) }
    for (const k of dropKeys) { const d = await dropFor(k, room); if (!drops.includes(d)) drops.push(d) }
    const it = { room, secrets: secrets.slice(0, 4), drops: drops.slice(0, 8) }
    size += JSON.stringify(it).length + 1
    if (size * 1.34 > CT_BUDGET) break
    items.push(it)
  }
  return { account, tenant, items }
}

/**
 * deps: { tenant, account, rooms: [room] (newest first), post, auth, attest, seal, ls, now, force }
 * → { filed: bool, rooms, skipped? }
 */
export async function fileEraseList ({ tenant, account, rooms, post, auth = {}, attest, seal, ls = globalThis.localStorage, now = Date.now(), force = false, keys = [loadUsageKey(), ...loadOldUsageKeys()].filter(Boolean), dropKeys = [], stillOurs = null }) {
  if (!tenant || !account || !keys.length) return { filed: false, skipped: 'not a tenant app, not signed in, or no account key yet' }
  const rec = await eraseRecordFor({ account, tenant, rooms, keys, dropKeys })
  const fp = await fingerprint(JSON.stringify([tenant, account, rec.items.map((i) => [i.room, i.secrets, ...(dropKeys.length ? [i.drops] : [])])]))
  let prev = null; try { prev = JSON.parse(ls.getItem(FILED) || 'null') } catch { /* */ }
  if (!force && prev && prev.fp === fp && now - prev.at < EVERY_MS) return { filed: false, skipped: 'unchanged', rooms: rec.items.length }
  if (!force && prev && prev.failAt && now - prev.failAt < EVERY_MS) return { filed: false, skipped: 'backing off after a failure' } // e.g. a Sentinel that does not know the op yet
  // ⛔ A WITHDRAWN LIST STAYS WITHDRAWN (state machines pass 7, F#10): the account was deleted on another device, which withdrew
  //   the list (filed it empty); this device, never wiped, filed its full list again at its next change or refile. `stillOurs()`
  //   asks whether the account still stands (the SDK: its backup was not deleted) — asked only when something would be filed.
  if (stillOurs && !(await Promise.resolve().then(stillOurs).catch(() => true))) return { filed: false, skipped: 'the account was deleted' }
  try {
    const { nonce, key } = await attest({ post, auth })
    const r = await post({ op: 'sentinel', sentinel: { mode: 'erasegrant', sealed: await seal(key, nonce, rec) }, ...auth })
    if (!r || r.error || r.ok === false) throw new Error('the Sentinel did not take the list (' + ((r && (r.error || r.reason)) || 'no answer') + ')')
  } catch (e) {
    try { ls.setItem(FILED, JSON.stringify({ ...(prev || {}), failAt: now })) } catch { /* */ }
    throw e
  }
  try { ls.setItem(FILED, JSON.stringify({ fp, at: now })) } catch { /* */ }
  return { filed: true, rooms: rec.items.length }
}
