// accountRecord.js — the account record a backup seals, one format for the Spaces app and the SDK (docs/sdk-convergence.md,
// phase 6; the owner, 2026-10-05: "Can we support both (legacy is the current sdk)").
//
// THE FORMAT is the Spaces app's: { v: 1, at, recents: [{ room, title, at, … }], keys: { room: { mk | userShare+commit, … } },
// … }. A builder app's record carries `app: 'sdk'` and, per room, what the SDK needs to reopen it (the link, lane or space,
// its shared room, archived) — extra fields the app's own reader ignores.
// LEGACY is the SDK's original record ({ kind: 'witbitz-sdk-rooms', rooms: [{ room, link, kind, … }] }): still read, and
// still written for a backup that has it, until the builder asks to upgrade (wb.backup.upgrade()).
//
// ⛔ ONE FORMAT, NOT ONE ACCOUNT. Each app keeps its own vault (its own master secret and recovery code). vaultOwner() says
// whose a record is, and each side opens only its own: a builder's page must never open a Witbitz account's backup (it
// would hold the key to every Space the person has), and the Spaces app never imports a builder app's rooms.
export const LEGACY_SDK_KIND = 'witbitz-sdk-rooms'
export const SDK_APP = 'sdk'
const APP_ADDRESS = /^https?:\/\/[^/\s]+$/ // an origin, as appIdentity.backupApp reads a backup's `app`

/** 'sdk' (a builder app's vault) · 'spaces' (the Witbitz account) · null (not an account record). */
export function vaultOwner (doc) {
  if (!doc || typeof doc !== 'object') return null
  if (doc.kind === LEGACY_SDK_KIND) return SDK_APP
  if (doc.v === 1 && Array.isArray(doc.recents)) {
    const app = typeof doc.app === 'string' ? doc.app : ''
    // An ADDRESS is a Spaces app's own stamp (appIdentity.js stampFor, since 7c4b9b1d) — which Spaces app is
    // backupMismatch's question, not this one. Read as the owner it refused every tagged restore (sweep, 2026-10-14).
    if (!app || APP_ADDRESS.test(app)) return 'spaces'
    return app // 'sdk', or an owner neither side knows: refused by both
  }
  return null
}

/** The whole key a room's link carries in its fragment (`#mk=…`, before a member's identity after the first `?` — as
 *  spaceConfig.parseConfiguredLink reads it), or '' — a SPLIT link (`#us=…`) carries half a key, so none. */
export function keyInLink (link) {
  const s = String(link || ''); const h = s.indexOf('#')
  if (h < 0) return ''
  const raw = s.slice(h + 1); const q = raw.indexOf('?')
  try { return new URLSearchParams(q >= 0 ? raw.slice(0, q) : raw).get('mk') || '' } catch { return '' }
}

/** The SDK's room list → the account record (the app's format, marked as the SDK's). */
// `inviteKey`: the account's invite key for this app (sdkRekey.js) — the Spaces app's own field, so a restored device follows a
// Space re-keyed in place.
// PHASE 2 (docs/sdk-account-format-plan.md, 2026-11-13), ADDED fields only — every older SDK reads `recents[].link` and ignores
// the rest: `keys[room].mk` for EVERY room (its link's key; a split room's ASSEMBLED key, as before — never the app's share +
// commit), `tombstones` ({ room: at }, the app's shape) for the SDK's forget marks of rooms the record does NOT hold (a room
// opened again after a forget is not deleted — the SDK's `tomb` stays its own, re-openable mark), and `indexRoom` ({ room, mk },
// the app's pointer) = the SDK's derived index room (sdkAccount.js indexRoomOf).
export function recordFromRooms ({ rooms = [], tomb, email, inviteKey, indexRoom, app = SDK_APP, at = Date.now() } = {}) {
  const recents = []; const keys = {}
  for (const r of rooms) {
    if (!r || !r.room || !r.link) continue
    recents.push({ room: r.room, title: r.label || '', at: r.at || 0, link: r.link, kind: r.kind === 'lane' ? 'lane' : 'space',
      ...(r.shared ? { shared: r.shared } : {}), ...(r.archived ? { archived: true } : {}) })
    const mk = keyInLink(r.link) || r.mk // the link's own key first: a separate copy of a plain room's key may be stale
    if (mk) keys[r.room] = { mk }
  }
  const held = new Set(recents.map((r) => r.room)); const tombstones = {}
  for (const t of Array.isArray(tomb) ? tomb : []) if (t && typeof t.room === 'string' && t.room && !held.has(t.room) && Number.isFinite(t.at)) tombstones[t.room] = Math.max(tombstones[t.room] || 0, t.at)
  return { v: 1, app, at, recents, keys, ...(Array.isArray(tomb) && tomb.length ? { tomb } : {}), ...(email ? { email } : {}), ...(inviteKey && inviteKey.boxPriv ? { inviteKey } : {}),
    ...(Object.keys(tombstones).length ? { tombstones } : {}), ...(indexRoom && typeof indexRoom.room === 'string' && indexRoom.room && typeof indexRoom.mk === 'string' && indexRoom.mk ? { indexRoom: { room: indexRoom.room, mk: indexRoom.mk } } : {}) }
}

/** Either format → the SDK's room list [{ room, link, kind, label?, shared?, archived?, mk?, at? }]. `mk` only where the link
 *  is not the key (a split room) — a record from phase 2 on carries every room's key, and the SDK's state keeps what it did. */
export function roomsOfRecord (doc) {
  if (!doc || typeof doc !== 'object') return []
  if (doc.kind === LEGACY_SDK_KIND) return Array.isArray(doc.rooms) ? doc.rooms : []
  if (!Array.isArray(doc.recents)) return []
  const keys = doc.keys && typeof doc.keys === 'object' ? doc.keys : {}
  return doc.recents.filter((r) => r && r.room && r.link).map((r) => ({
    room: r.room, ...(r.at ? { at: r.at } : {}), ...(r.archived ? { archived: true } : {}), link: r.link,
    kind: r.kind === 'lane' ? 'lane' : 'space', ...(r.title ? { label: r.title } : {}), ...(r.shared ? { shared: r.shared } : {}),
    ...(keys[r.room] && keys[r.room].mk && !keyInLink(r.link) ? { mk: keys[r.room].mk } : {}),
  }))
}

/** A record's forget marks as the SDK keeps them ([{ room, at }]): its `tomb`, and any room only in the app-shaped
 *  `tombstones` — the newer `at` of the two. A legacy record has `tomb` only. */
export function tombOfRecord (doc) {
  if (!doc || typeof doc !== 'object') return []
  const at = new Map()
  for (const t of Array.isArray(doc.tomb) ? doc.tomb : []) if (t && typeof t.room === 'string' && t.room && Number.isFinite(t.at)) at.set(t.room, Math.max(at.get(t.room) || 0, t.at))
  const ts = doc.tombstones && typeof doc.tombstones === 'object' && !Array.isArray(doc.tombstones) ? doc.tombstones : {}
  for (const [room, t] of Object.entries(ts)) if (room && Number.isFinite(t)) at.set(room, Math.max(at.get(room) || 0, t))
  return [...at].map(([room, t]) => ({ room, at: t }))
}
