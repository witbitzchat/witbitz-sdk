// backupRecord.js — THE BACKUP RECORD'S RULES, pure (docs/sdk-account-format-plan.md, phase 1). The account's backup is one
// sealed record in the vault (accountRecord.js says whose it is); these are the rules that build what a device puts in it and
// what a restore takes back out. They lived inside backup.js's gatherBackup and applyBackup, next to the page's storage; here
// they take state in and give state out — no storage, no DOM, no page state — so the SDK restores through the same rules.
// backup.js reads the device, calls them and writes what they say; what the app writes and applies is unchanged
// (spaces/test/accountFormatGolden.test.mjs holds it).
import { vaultOwner } from './accountRecord.js'
import { mergeRoomDefaults } from './roomDefaultPrefs.js'

const noAttested = () => false

/** A backup's tombstones, kept to the shape store.js writes ({ room: at }) — a blob is data from storage, not trusted shape. */
export function cleanTombstones (t) {
  const out = {}
  if (!t || typeof t !== 'object' || Array.isArray(t)) return out
  for (const r of Object.keys(t)) if (typeof r === 'string' && r && r.length <= 200) out[r] = Number(t[r]) || 1
  return out
}

/** THE ORPHAN RULE: every room whose key is on this device belongs in the backup, not just the ones on the list. The list is
 *  bounded, and a Space that fell off it used to be absent from every backup while it went on working here — gone for good
 *  with the device. `storageKeys` = the names this device's storage holds; a name under `prefixes.mk` (a normal room's key)
 *  or `prefixes.us` (a split room's share) whose room is not on `recents` gets a minimal row: the KEY is what matters. Never
 *  titled with the raw room id (it would show as "sp-…" in the drawer). */
export function orphanRows (recents, storageKeys, { mk, us }) {
  const listed = new Set((recents || []).map((r) => r && r.room).filter(Boolean))
  const orphans = []
  for (const k of storageKeys || []) {
    let rm = null
    if (k && k.indexOf(mk) === 0) rm = k.slice(mk.length)
    else if (k && k.indexOf(us) === 0) rm = k.slice(us.length)
    if (rm && !listed.has(rm)) { orphans.push({ room: rm, title: '', at: 0 }); listed.add(rm) }
  }
  return orphans
}

/** The record a device backs up, from what it holds. `recents` + `orphans` are the rooms (an ATTESTED room — `isAttested` —
 *  stays on its device: neither its row nor its key); `keyOf(room)` is one room's key entry as this device holds it.
 *  An empty `name` never blanks a backed-up one (mergeBackups' {...remote,...local} would let '' win), so it is left out;
 *  `code` is the escrowed recovery code (security-neutral: whoever holds the master has the account already). `extra` is
 *  what ANOTHER store holds for the account (backup.js setAccountFieldSource: the hosted vault reads the framed app's copy) —
 *  a field this record already has wins; its contacts only where this device has none; its room defaults merged in. */
export function recordOf ({
  at = Date.now(), recents = [], orphans = [], isAttested = noAttested, keyOf = () => ({}), tombstones = {}, name = '',
  contacts = [], pipesRoom = null, msgsRoom = null, indexRoom = null, inviteKey = null, acctKey = null, code = '',
  connectionKeys = {}, connGone = null, siri = null, a2a = null, defaultRoom = null, extra = {},
} = {}) {
  const all = recents.concat(orphans).filter((r) => !(r && r.room && isAttested(r.room)))
  const keys = {}
  for (const r of all) {
    if (!r || !r.room) continue
    keys[r.room] = keyOf(r.room)
  }
  const out = { v: 1, at, ...(Object.keys(tombstones).length ? { tombstones } : {}), ...(name ? { name } : {}), recents: all, keys, contacts, ...(pipesRoom ? { pipesRoom } : {}), ...(msgsRoom && msgsRoom.room && msgsRoom.mk ? { msgsRoom } : {}), ...(indexRoom ? { indexRoom } : {}), ...(inviteKey ? { inviteKey } : {}), ...(acctKey ? { acctKey } : {}), ...(code ? { code } : {}), ...(Object.keys(connectionKeys).length ? { connectionKeys } : {}), ...(connGone && Object.keys(connGone).length ? { connGone } : {}), ...(siri ? { siri } : {}), ...(a2a ? { a2a } : {}) }
  if (defaultRoom) out.defaultRoom = defaultRoom
  for (const [f, v] of Object.entries(extra)) if (!(f in out)) out[f] = v
  if (Array.isArray(extra.contacts) && extra.contacts.length && !(out.contacts || []).length) out.contacts = extra.contacts // the vault's page has no address book of its own (mergeBackups unions contacts, so an empty list never blanked one)
  const mergedDefaults = mergeRoomDefaults(out.defaultRoom, extra.defaultRoom); if (mergedDefaults) out.defaultRoom = mergedDefaults
  return out
}

/** What a restore of record `p` writes on this device, as data — or null when `p` is not an account record of `app` (each
 *  app opens only its own vault's record: accountRecord.js vaultOwner, both directions). `local` = this device's state (or a
 *  function that reads it, called only for a record this app opens): { tombstones, recents, isAttested, myName, msgsRoom,
 *  pipesRoom, indexRoom, acctKey, inviteKey, code }.
 *  → { tombstones (the account's deletes, adopted), newTombstones (it grew: save it), add (rows restored), recents (the list
 *    to save, or null), fills ([{ room, slot: 'mk'|'us'|'spc'|'model'|'gate'|'id'|'sign', value }] — each written ONLY where
 *    this device holds none), name, msgsRoom, pipesRoom, indexRoom, acctKey, inviteKey, code (each null/'' = keep this
 *    device's), and defaultRoom, contacts, connectionKeys + connGone, siri, a2a (merged into this device's own) }. */
export function applyPlan (p, local = {}, { app = 'spaces' } = {}) {
  if (!p || !Array.isArray(p.recents)) return null
  if (vaultOwner(p) !== app) return null
  const L = (typeof local === 'function' ? local() : local) || {}
  const mine = L.tombstones || {}, cur = L.recents || [], isAttested = L.isAttested || noAttested
  // ⚑ A DELETE MUST SURVIVE A RESTORE. The blob is a snapshot, so one taken BEFORE a delete still carries that room's key and
  // its recents row — restoring it handed the key back to a Space the user destroyed. Checked for BOTH halves: the device's
  // deletes and the account's (the record carries them), and a resurrected row is as wrong as a resurrected key.
  const tomb = { ...cleanTombstones(p.tombstones), ...mine }
  const have = new Set(cur.map((r) => r.room))
  const add = p.recents.filter((r) => r && r.room && !have.has(r.room) && !tomb[r.room])
  const fills = []
  const fill = (room, slot, value) => { if (value != null) fills.push({ room, slot, value }) }
  for (const rm of Object.keys(p.keys || {})) {
    const e = p.keys[rm]; if (!e || tomb[rm]) continue
    // SPLIT room → userShare + commit (NEVER an mk); normal room → mk. (tenant-split-key-dualstore.md)
    if (isAttested(rm)) { /* an ATTESTED room's key is never written at rest (docs/emulated-attested-rooms.md): the caller keeps it in memory */ }
    else if (e.split && e.userShare) { fill(rm, 'us', e.userShare); fill(rm, 'spc', e.commit) }
    else { fill(rm, 'mk', e.mk) }
    fill(rm, 'model', e.model); fill(rm, 'gate', e.gate); fill(rm, 'id', e.id); fill(rm, 'sign', e.sign)
  }
  const ptr = (x, held) => (x && x.room && x.mk && !held ? x : null) // a room minted on another device is adopted, never over this one's
  return {
    tombstones: tomb, newTombstones: Object.keys(tomb).length > Object.keys(mine).length,
    add, recents: add.length ? cur.concat(add).sort((a, b) => (b.at || 0) - (a.at || 0)) : null,
    fills,
    name: p.name && !L.myName ? p.name : '', // a name typed here is never replaced; a waiting name prompt is answered
    msgsRoom: ptr(p.msgsRoom, L.msgsRoom), pipesRoom: ptr(p.pipesRoom, L.pipesRoom), indexRoom: ptr(p.indexRoom, L.indexRoom),
    acctKey: p.acctKey && p.acctKey.priv && !L.acctKey ? p.acctKey : null, // the account signing key: adopted, never clobbering a local one
    inviteKey: p.inviteKey && p.inviteKey.boxPriv && !L.inviteKey ? p.inviteKey : null, // invites sealed to your boxPub open here too
    code: typeof p.code === 'string' && p.code && !L.code ? p.code : '', // the escrowed recovery code → a passkey/link recovery can Show it
    defaultRoom: p.defaultRoom, contacts: p.contacts, connectionKeys: p.connectionKeys, connGone: p.connGone, siri: p.siri, a2a: p.a2a,
  }
}
