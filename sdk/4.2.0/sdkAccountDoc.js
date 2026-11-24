// sdkAccountDoc.js — the SDK's live account index IN THE SPACES APP'S FORMAT (docs/sdk-account-format-plan.md phase 3; the
// owner, 2026-11-13: "yes. Do 1-5"). The SDK keeps its index in its DERIVED room (sdkAccount.js indexRoomOf), and there it now
// also keeps the app's `xindex` doc, built by the app's own rules (accountIndexDoc.js), sealed under the app's account-store
// key. Pure: the SDK's view ({ rooms[], tomb[], links[], devices{}, usage, usageOld }) ↔ the app's doc, both ways.
//
// TRANSLATE, DO NOT DROP (§4.1): a room's entry is the app's ({ mk, title, titleAt, manual, at, archived, archivedAt, pinned,
// pinnedAt }) plus what only the SDK reopens a room with — `link`, `kind`, a lane's `shared`, a label the app's title cannot
// hold, a split room's ASSEMBLED key (decision 5). A forgotten room is `forgot: <at>` — the SDK's RE-OPENABLE mark — never the
// app's final `deleted` (decision 4). Devices: { name, seenAt, out } ↔ { label, lastSeenAt } + `signouts`; `sdk` (the release a
// device runs) rides along. Entries the SDK cannot read (no link, no mark) are carried over as they were.
import { indexDoc, indexRoomEntry } from './accountIndexDoc.js'
import { keyInLink } from './accountRecord.js'
import { normUsageKey } from './usageReceipts.js'

export const APP_DOC = 'xindex' // the app's sealed 'index' (accountStores.js SEALED)
const ERASED_MARK = '@erased' // = devices.js ERASED_MARK: Delete my account's pseudo-entry in the index's sign-outs
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0)
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {})

/** The SDK's view → the app's `xindex` doc. `prev`: the doc as read (its fields the SDK does not own are kept). */
export function toAppIndex ({ rooms = [], tomb = [], links = [], devices = {}, usage, usageOld = [] } = {}, prev = null) {
  const p = obj(prev), map = {}
  for (const r of rooms) {
    if (!r || !r.room || typeof r.link !== 'string' || !r.link) continue
    const mk = keyInLink(r.link) || (typeof r.mk === 'string' ? r.mk : '')
    const at = num(r.at), e = indexRoomEntry({ room: r.room, title: r.label || '', titleAt: at, renamed: !!r.label, at, archived: !!r.archived, archivedAt: at }, obj(p.rooms)[r.room] || undefined, mk ? { mk } : {}) // prev: the app's per-field rules, and the "always on" mark it keeps (sync sweep 2026-11-23 #13 — every SDK write dropped it)
    map[r.room] = { ...e, link: r.link, kind: r.kind === 'lane' ? 'lane' : 'space', ...(r.kind === 'lane' && r.shared ? { shared: r.shared } : {}), ...(r.label && e.title !== r.label ? { label: r.label } : {}) }
  }
  for (const t of tomb) if (t && t.room) map[t.room] = { ...(map[t.room] || {}), forgot: Math.max(num(t.at), num((map[t.room] || {}).forgot)) || 1 }
  for (const [room, e] of Object.entries(obj(p.rooms))) if (!(room in map) && e && typeof e === 'object' && !e.link && !e.forgot) map[room] = e
  // SIGN-OUTS ARE CARRIED, NOT REBUILT (sync sweep 11-18): the app's marks ride here too — `@erased` (Delete my account: every other
  // device signs out) and `@moved` — and a device the SDK's view does not list. Rebuilt from the SDK's devices alone, an SDK write
  // between the app's mark and the index's deletion dropped it. A mark only grows (the later time wins).
  // A DEVICE SIGNED OUT BECAUSE THE ACCOUNT WAS DELETED (`outWhy: 'erased'`) is the app's ERASED mark too (sync sweep 11-22 #8): the
  // app reads only the mark (devices.js remoteSignoutReason — a stamp no newer than it is 'erased'), so an app device of an account
  // deleted through the SDK said "signed out remotely".
  const devs = {}, signouts = {}
  let erasedAt = 0
  for (const [id, at] of Object.entries(obj(p.signouts))) if (num(at)) signouts[id] = at
  for (const [id, d] of Object.entries(obj(devices))) {
    if (!d || typeof d !== 'object') continue
    const { name, seenAt, out, ...rest } = d
    devs[id] = { ...rest, ...(name !== undefined ? { label: name } : {}), ...(seenAt !== undefined ? { lastSeenAt: seenAt } : {}) }
    if (num(out)) signouts[id] = Math.max(out, num(signouts[id]))
    if (num(out) && rest.outWhy === 'erased') erasedAt = Math.max(erasedAt, signouts[id])
  }
  if (erasedAt) signouts[ERASED_MARK] = Math.max(erasedAt, num(signouts[ERASED_MARK]))
  const u = normUsageKey(usage)
  return { ...indexDoc({ rooms: map, devices: devs, signouts, name: typeof p.name === 'string' ? p.name : '', seen: p.seen, vseen: p.vseen, inviteKey: p.inviteKey, usageKey: u, usageKeysOld: (usageOld || []).map(normUsageKey).filter(Boolean), pipesRoom: p.pipesRoom, msgsRoom: p.msgsRoom }),
    ...(Array.isArray(links) && links.length ? { links } : {}) }
}

/** The app's `xindex` doc (as the SDK wrote it) → the SDK's view; an empty view for none. */
export function fromAppIndex (doc) {
  const d = obj(doc), rooms = [], tomb = []
  for (const [room, e] of Object.entries(obj(d.rooms))) {
    if (!e || typeof e !== 'object') continue
    if (num(e.forgot)) tomb.push({ room, at: e.forgot })
    if (typeof e.link !== 'string' || !e.link || e.deleted) continue
    const label = e.label !== undefined ? e.label : (e.manual && e.title ? e.title : undefined)
    rooms.push({ room, ...(num(e.at) ? { at: e.at } : {}), ...(e.archived ? { archived: true } : {}), link: e.link, kind: e.kind === 'lane' ? 'lane' : 'space',
      ...(label ? { label } : {}), ...(e.kind === 'lane' && e.shared ? { shared: e.shared } : {}), ...(typeof e.mk === 'string' && e.mk && e.mk !== keyInLink(e.link) ? { mk: e.mk } : {}) })
  }
  // …and the app's ERASED mark is the SDK's reason (#8): an SDK device whose stamp is no newer than the mark was signed out by Delete my
  // account in the app — its onSignedOut hears { reason: 'erased' }, as when the SDK deleted it
  const devices = {}, so = obj(d.signouts), erased = num(so[ERASED_MARK])
  for (const [id, e] of Object.entries(obj(d.devices))) {
    if (!e || typeof e !== 'object') continue
    const { label, lastSeenAt, ...rest } = e
    devices[id] = { ...rest, ...(label !== undefined ? { name: label } : {}), ...(lastSeenAt !== undefined ? { seenAt: lastSeenAt } : {}), ...(num(so[id]) ? { out: so[id] } : {}), ...(num(so[id]) && erased >= so[id] ? { outWhy: 'erased' } : {}) }
  }
  return { rooms, tomb, links: Array.isArray(d.links) ? d.links : [], devices, usage: normUsageKey(d.usageKey), usageOld: (Array.isArray(d.usageKeysOld) ? d.usageKeysOld : []).map(normUsageKey).filter(Boolean) }
}

const stable = (x) => (Array.isArray(x) ? '[' + x.map(stable).join(',') + ']' : x && typeof x === 'object' ? '{' + Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}' : JSON.stringify(x))
/** The same doc, its write time and key order aside (the app's sameDoc rule) — an unknown doc is never the same. */
export const sameAppIndex = (a, b) => !!(a && b) && stable({ ...a, at: 0 }) === stable({ ...b, at: 0 })
