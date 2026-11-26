// store.js — local data-persistence layer (Verified-Client Phase 1). Recents, contacts, the hidden
// room pointers (pipes/index/invite), the name, and lanes flags — all localStorage. saveRecents's
// durability+sync side effects (queueBackup/scheduleIndexPush) are INJECTED via setRecentsSaveHook.
import { lsGet } from './util.js'
import { normA2A, mergeA2ARecords } from './a2aCore.js'
import { unionMarks, mergeSiriRooms, siriKeyOf, siriDefaultOf, mergeByMarks, canon } from './keptMerge.js' // Siri's and the connection keys' merge rules, shared with the vault keep (C3)
import { state, isTempRoom } from './roomState.js'

let _onSave = () => {}
export const setRecentsSaveHook = (fn) => { _onSave = fn }

export const RECENTS_KEY = 'space:recents'
// MEMORY-FIRST (2026-08-31): iOS can kill the storage process behind a LIVE PWA (memory pressure / low power) — from
// that moment localStorage reads return EMPTY while the page keeps running, and the drawer 'vanished' mid-session
// (relaunch reads fine again). Once we've seen data, memory is the source of truth; writes write-through. An empty
// read can never erase a populated in-memory list.
// ⛔ BUT MEMORY MUST NOT HIDE ANOTHER WRITER (e2e 2026-11-24: a second direct chat vanished from the list). The list has more than one
//   writer — the app's other pages (the Assistant panel, `?panel=1`, runs its own copy of this module), a second copy of this module
//   under another address, the hosted app's store — and memory-first returned THIS copy's old list for good: its next mutateRecent
//   saved it back, and a Space another writer had just added was gone. So the stored text is checked on every read: unchanged → the
//   same objects (callers that hold a row still see edits to it); changed → read again. Memory answers only when storage cannot be
//   read, or reads back EMPTY while memory has rooms — the dead storage process this was made for.
let _recMem = null, _recRaw = null
export const loadRecents = () => {
  let raw = null
  try { raw = localStorage.getItem(RECENTS_KEY) } catch { return _recMem || [] }
  if (raw !== null && raw === _recRaw && _recMem) return _recMem
  let v = null
  try { v = JSON.parse(raw || '[]') } catch { return _recMem || [] }
  if (!Array.isArray(v)) return _recMem || []
  if (!v.length) return _recMem || v // empty while memory has rooms: the storage process died (above) — never an erase
  _recMem = v; _recRaw = raw
  return v
}
// ★★ THE LIST IS THE WHOLE ROSTER, NOT A "RECENTS" MENU (the owner, 2026-10-06: "Why do we have the cap?"). It began as a
//    most-recently-opened list (24, then 60 — hidden lanes and negotiations ate 2–3 slots per Space), and then the drawer
//    became where every Space lives while the index room became the account's roster of ALL of them. The two disagreed:
//    the roster knew 204 rooms, the drawer could show 60, and the index sync re-added the other ~144 every 10 s only for
//    this slice to cut them again (a drawer redraw and an index push each time). A room outside the cap came back as a
//    fresh entry without its flags, and the first-message heuristic renamed it (roomTitle.js). Every chat app keeps the
//    full conversation list locally and lets the VIEW handle size; an entry here is ~200 bytes, so a thousand rooms are
//    ~200 KB in a 5 MB store. RECENTS_MAX is a bound against runaway growth, not a menu length — the vault's room-list
//    seed (vault-loader.js) uses the same number.
export const RECENTS_MAX = 1000
export const saveRecents = (l) => { _recMem = l.slice(0, RECENTS_MAX); _recRaw = JSON.stringify(_recMem); try { localStorage.setItem(RECENTS_KEY, _recRaw) } catch { /* private mode / dead storage process — memory carries the session */ } _onSave() /* blob = durability; index room = live cross-device sync */ }
export const recentOf = (r) => loadRecents().find((x) => x.room === r) || null
// Edit ONE recents entry in place and persist — the single write path for pin/archive/title/lineage stamps.
export function mutateRecent(r, fn) { const list = loadRecents(); const it = list.find((x) => x.room === r); if (it) { fn(it); saveRecents(list) } }
// Durable "this invite was already processed" set — the dedup the append-only invite inbox needs. loadRecents can't
// be that dedup (the cap evicts old rooms) and l1.hasMk can't either (the worker's presence mirror races a cold
// realm's boot), so without this every poll re-added evicted rooms + re-announced them ("New Space from an invite").
// Per-device, like recents: a fresh device's empty set correctly lets all its invites materialize once.
export const INV_SEEN_KEY = 'space:inv-seen'
export const invSeen = (room) => { try { return JSON.parse(localStorage.getItem(INV_SEEN_KEY) || '[]').includes(room) } catch { return false } }
export const markInvSeen = (room) => { try { const a = JSON.parse(localStorage.getItem(INV_SEEN_KEY) || '[]'); if (!a.includes(room)) { a.push(room); localStorage.setItem(INV_SEEN_KEY, JSON.stringify(a.slice(-500))) } } catch { /* private mode */ } }
export const PIPES_ROOM_KEY = 'space:pipes-room'
export const pipesRoomPtr = () => { try { return JSON.parse(localStorage.getItem(PIPES_ROOM_KEY) || 'null') } catch { return null } }
export const setPipesRoomPtr = (p) => { try { localStorage.setItem(PIPES_ROOM_KEY, JSON.stringify(p)) } catch { /* */ } }
// THE MESSAGE ROOM (docs/room-messages.md): the account's third hidden room, beside the index and the pipes rooms —
// where one room leaves a message for another, for whichever of your devices runs it (roomMail.js).
export const MSGS_ROOM_KEY = 'space:msgs-room'
export const msgsRoomPtr = () => { try { return JSON.parse(localStorage.getItem(MSGS_ROOM_KEY) || 'null') } catch { return null } }
export const setMsgsRoomPtr = (p) => { try { localStorage.setItem(MSGS_ROOM_KEY, JSON.stringify(p)) } catch { /* */ } }
export const MAIL_HANDLED_KEY = 'space:mail-handled' // the message ids THIS device ran (roomMail dedupe), newest last
export const INDEX_ROOM_KEY = 'space:index-room'
export const indexRoomPtr = () => { try { return JSON.parse(localStorage.getItem(INDEX_ROOM_KEY) || 'null') } catch { return null } }
export const setIndexRoomPtr = (p) => { try { localStorage.setItem(INDEX_ROOM_KEY, JSON.stringify(p)) } catch { /* */ } }
export const INVITE_KEY = 'space:invitekey'
export const inviteKeyPtr = () => { try { return JSON.parse(localStorage.getItem(INVITE_KEY) || 'null') } catch { return null } }
export const setInviteKey = (v) => { try { localStorage.setItem(INVITE_KEY, JSON.stringify(v)) } catch { /* */ } }
// The ACCOUNT SIGNING KEY (device-key access groundwork). ONE keypair per account: its private half signs a short-lived
// certificate for each enrolled device, and the server holds only the PUBLIC half (gate record `acct_pk`) — so the
// server can verify a certificate from ANY device while holding no device list and no device count. Rides the backup
// blob exactly like inviteKey (which already carries boxPriv), so it restores with the account and every device that
// restores can mint certificates. Nothing verifies these yet.
// BACKUP PAUSED (vault only): the equivalent of the non-vault app's "turn off backup on this device" — this device STOPS
// pushing its account state (index/pipes rooms) to the server while keeping the master + keys, so Spaces still work; new
// changes stay local until backup is turned back on. Room CONTENT (messages) is the room mechanism, not backup, so it
// keeps syncing. Per-device flag on the app origin (the app is what gates the pushes); the vault's B&R sheet toggles it.
export const BACKUP_PAUSED_KEY = 'space:backup-paused'
export const backupPaused = () => { try { return localStorage.getItem(BACKUP_PAUSED_KEY) === '1' } catch { return false } }
export const setBackupPausedFlag = (on) => { try { on ? localStorage.setItem(BACKUP_PAUSED_KEY, '1') : localStorage.removeItem(BACKUP_PAUSED_KEY) } catch { /* */ } }
export const ACCT_KEY = 'space:acctkey'
export const acctKey = () => { try { return JSON.parse(localStorage.getItem(ACCT_KEY) || 'null') } catch { return null } }
export const setAcctKey = (v) => { try { localStorage.setItem(ACCT_KEY, JSON.stringify(v)) } catch { /* */ } }
export const lanesKey = (r) => 'space:lanes:' + r
// THE SPACES THE CLOUD DEVICE KEEPS ALWAYS ON — a fact of the ACCOUNT (the owner, 2026-11-22: "We need to know in every device which
// rooms are always on"): the Space's own row in the account's room list carries it (`alwaysOn`, with its clock `alwaysOnAt`; synced by
// accountIndexDoc.js like a pin). The device of yours that hands a Space to the cloud device, or takes it back, sets it; every device
// refuses what a kept Space cannot have — people, private rooms, links — and the Spaces list shows it. It used to be a list on ONE device
// (`space:cd-kept`, from the card's last answer): another device could link a kept Space. That list is dropped when the card next reads
// what the device runs (adoptCloudKept, below).
const CD_KEPT_OLD = 'space:cd-kept'
export const isCloudKept = (r) => !!r && !!((recentOf(r) || {}).alwaysOn)
/** Set or clear a Space's always-on mark in the account's room list (→ synced to every device). Only a change is written. */
export function setAlwaysOn (r, on, now = Date.now()) {
  if (!r || isCloudKept(r) === !!on) return false
  mutateRecent(r, (it) => { it.alwaysOn = !!on; it.alwaysOnAt = now })
  return isCloudKept(r) === !!on
}
/** The cloud device was signed out (here, or from the hosted vault's account screen): no Space is kept any more. */
export function clearAlwaysOn (now = Date.now()) { for (const r of loadRecents()) if (r && r.alwaysOn) setAlwaysOn(r.room, false, now) }
/** The cloud device answered which Spaces it holds (its card): a Space it runs is kept, so its mark is set (a Space kept before the
 *  mark existed arrives here). A Space it does NOT hold keeps its mark: that is the card's warning to show (the device let it go, or
 *  was signed out) — never a silent change. The old one-device list is dropped. */
export function adoptCloudKept (rooms, now = Date.now()) {
  for (const r of new Set((rooms || []).filter((x) => typeof x === 'string'))) setAlwaysOn(r, true, now)
  try { localStorage.removeItem(CD_KEPT_OLD) } catch { /* */ }
}
export const KEPT_NO_LINKS = 'Your cloud device keeps this Space always on, and it takes only a Space with no private lane of its own. Stop keeping it always on first (⋯ → Assistant → Always on).'
export const KEPT_NO_PEOPLE = 'Your cloud device keeps this Space always on, and it takes only a Space that is yours alone. Stop keeping it always on first (⋯ → Assistant → Always on).'
export const wantsLanes = (r) => { try { return localStorage.getItem(lanesKey(r)) === '1' } catch { return false } }
export const CONTACTS_KEY = 'space:contacts'
export function normContact(c) {
  if (!c || typeof c !== 'object') return null
  if (c.kind === 'agent') {
    const id = String(c.id || '').trim().slice(0, 64); const fn = String(c.fn || c.name || '').trim().slice(0, 80)
    if (!id || !fn) return null
    return { kind: 'agent', id, fn, persona: String(c.persona || '').slice(0, 4000), agentName: String(c.agentName || fn).trim().slice(0, 80), ...(c.model ? { model: String(c.model).slice(0, 40) } : {}), ...(c.color ? { color: String(c.color).slice(0, 16) } : {}), ...(c.at ? { at: +c.at || 0 } : {}), deleted: !!c.deleted } // `deleted` = a TOMBSTONE for a removed assistant; ALWAYS present so the LWW merge (Object.assign) can clear it on a revive
  }
  // A PERSON is addressed by an email, a public "@username" (docs/spaces-usernames.md §5), or both. The username is
  // stored WITHOUT the "@" and only when it is one; a row with neither address is not a contact.
  const email = (typeof c.email === 'string' && c.email.indexOf('@') > 0) ? c.email.trim().toLowerCase() : ''
  const username = (typeof c.username === 'string' && /^[a-z0-9][a-z0-9_]{2,29}$/.test(String(c.username).trim().toLowerCase().replace(/^@/, ''))) ? String(c.username).trim().toLowerCase().replace(/^@/, '') : ''
  if (!email && !username) return null
  return { kind: 'person', fn: typeof c.fn === 'string' ? c.fn.trim().slice(0, 80) : '', ...(email ? { email } : {}), ...(username ? { username } : {}), ...(typeof c.handle === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c.handle) ? { handle: c.handle } : {}), ...(c.tel ? { tel: String(c.tel).slice(0, 40) } : {}), ...(c.at ? { at: +c.at || 0 } : {}), deleted: !!c.deleted } // `deleted` = a TOMBSTONE for a removed person; `at` gives persons LWW so a delete/edit survives the union merge
}
// The one key a contact is deduped and merged by: an agent by id, a person by email, else by "@username".
export const contactKey = (c) => c && (c.kind === 'agent' ? 'a:' + c.id : (c.email || (c.username ? '@' + c.username : undefined)))
// ONE PERSON, ONE ROW (the owner, 2026-10-25: "I have duplicated contact of <a person>" — "@alice" twice and
// "alice@example.com · @alice"). A row is keyed by ONE address (contactKey: the email, else the @username), so a copy
// that knew only the @username — another device's, or one an edit re-keyed without a tombstone — came back as a second row on
// every sync. Rows that share an email or a username are one person: every address any of them knew (rememberContacts' rule),
// the newest edit's name and phone (an older one fills a gap), deleted only when the newest of them is a deletion. Read and
// write both pass through it, so a stored duplicate heals and a synced one never lands.
export function dedupePeople(list) {
  if (!Array.isArray(list)) return []
  const idx = [], parent = []
  list.forEach((c, i) => { if (c && c.kind === 'person') { idx.push(i); parent[i] = i } })
  if (idx.length < 2) return list
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const owner = new Map()
  for (const i of idx) {
    const c = list[i]
    for (const k of [c.email && 'e:' + c.email, c.username && 'u:' + c.username]) {
      if (!k) continue
      if (owner.has(k)) parent[find(i)] = find(owner.get(k)); else owner.set(k, i)
    }
  }
  const groups = new Map()
  for (const i of idx) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(list[i]) }
  if (groups.size === idx.length) return list
  const merged = new Map() // group root → the one row
  for (const [r, g] of groups) {
    if (g.length === 1) { merged.set(r, g[0]); continue }
    const by = g.slice().sort((a, b) => (b.at || 0) - (a.at || 0)) // newest first
    const pick = (f) => (by.find((c) => c[f]) || {})[f]
    const out = { kind: 'person', fn: pick('fn') || '' }
    for (const f of ['email', 'username', 'handle', 'tel']) { const v = pick(f); if (v) out[f] = v }
    const at = by[0].at || 0; if (at) out.at = at
    out.deleted = !!by[0].deleted
    merged.set(r, out)
  }
  const out = [], placed = new Set()
  list.forEach((c, i) => {
    if (!(c && c.kind === 'person')) { out.push(c); return }
    const r = find(i); if (placed.has(r)) return
    placed.add(r); out.push(merged.get(r)) // the person where its first row was
  })
  return out
}
export function loadContacts() { try { const a = JSON.parse(lsGet(CONTACTS_KEY) || '[]'); return Array.isArray(a) ? dedupePeople(a.map(normContact).filter(Boolean)) : [] } catch { return [] } }
export function saveContacts(list) {
  try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(dedupePeople(list).slice(0, 1000))) } catch { /* private mode */ }
  try { dispatchEvent(new Event('wb-contacts-changed')) } catch { /* no window */ } // the names on messages follow People (senderNames.js)
}
// ── CODE-section settings (opencode server URL, password, model, agent) — a per-account personal component, synced in the
//    sealed 'index2' doc of the account's index room exactly like contacts (roomSync.js), so every device of the account
//    connects to the same local server. The password rides too, end-to-end encrypted (owner's decision, 2026-09-12).
//    Last-writer-wins on `mod`: only an edit someone MADE stamps it, so a device that merely holds a copy never outranks it.
export const CODE_KEY = 'space:code'
const CODE_FIELDS = ['base', 'pass', 'model', 'agent']
// `models`: the model chosen for each PAIRED COMPUTER, {computerId: ref}. `model` above is the single direct server's; with
// computers each has its own (a model one of them lacks fails every turn there), and this map is how that choice follows
// the account to its other devices. Omitted when empty, so settings from before it are byte-identical.
const CODE_MODEL_ID = /^[A-Za-z0-9_-]{1,64}$/
function normCodeModels(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const o = {}
  for (const [k, v] of Object.entries(m)) {
    if (Object.keys(o).length >= 32) break
    if (CODE_MODEL_ID.test(k) && typeof v === 'string' && v && v.length <= 256) o[k] = v
  }
  return Object.keys(o).length ? o : null
}
export function normCodeSettings(s) {
  if (!s || typeof s !== 'object') return null
  const o = {}
  for (const f of CODE_FIELDS) o[f] = typeof s[f] === 'string' ? s[f].slice(0, 2048) : ''
  const models = normCodeModels(s.models)
  if (models) o.models = models
  o.mod = Number.isFinite(+s.mod) ? +s.mod : 0
  return o
}
export function loadCodeSettings() { try { return normCodeSettings(JSON.parse(lsGet(CODE_KEY) || 'null')) } catch { return null } }
export function saveCodeSettings(s) { const n = normCodeSettings(s); if (!n) return null; try { localStorage.setItem(CODE_KEY, JSON.stringify(n)) } catch { /* private mode */ } return n }
/** The synced copy to adopt over `cur` (normalised), only when it is strictly NEWER — else null. Pure; mergeCodeSettings stores it. */
export function newerCodeSettings(cur, incoming) {
  const inc = normCodeSettings(incoming)
  if (!inc || !inc.mod) return null
  if (cur && cur.mod >= inc.mod) return null
  return inc
}
/** Adopt a synced copy only if it is strictly NEWER. Returns true when the local settings changed. */
export function mergeCodeSettings(incoming) {
  const inc = newerCodeSettings(loadCodeSettings(), incoming)
  if (!inc) return false
  saveCodeSettings(inc)
  return true
}
/** Same values (mod ignored; the model map compared by content, not key order) — so re-saving what is already there never
 *  stamps a new edit or pushes, while a different model for one computer does. */
const codeModelsKey = (m) => JSON.stringify(Object.entries(normCodeModels(m) || {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
export const sameCodeSettings = (a, b) => !!a && !!b && CODE_FIELDS.every((f) => (a[f] || '') === (b[f] || '')) && codeModelsKey(a.models) === codeModelsKey(b.models)

// ── Connection callKeys (docs/standing-sentinel.md §3.8): { [id]: { callKey, label, host, account } } — the page's half of
// a connection the account attached. NEVER the secret (that is inside the Sentinel; normalisation drops any other field).
// They ride the ACCOUNT the way contacts do — the index2 doc across live devices, the blob backup for a restore — so a
// second phone can add an attached connection to a Space without re-attaching. Union by id, LOCAL WINS: ids are random
// per attach, so a detached id is simply dead (the sheet lists from the Sentinel and uses a key only for an id it still
// has) — harmless at the Sentinel, but the dead key came back on every device (below).
// ⛔ A DETACH IS RECORDED (the C3 review, 2026-11-13; the owner: "an added optional field, not a format change"). With no mark,
//   a device still holding a detached key put it back: the index push's pre-read merged the remote copy in before writing, a
//   restore filled it, and every device had it again. Now `connGone: { id: at }` rides NEXT TO the keys — `space:connectionKeys:gone`
//   here, a field of its own in index2 and the backup — and an entry may carry `at` (when it was attached here). The keep's rule
//   (keptMerge.js mergeByMarks): an entry is off when a mark is as new or newer (an entry with no `at` is older than any mark);
//   a re-attach after the mark wins. An older app ignores both: its normalisation keeps four fields and never reads `connGone`.
//   No marks (no one has detached since) → exactly the old union.
export const CONNKEYS_KEY = 'space:connectionKeys'
export const CONNGONE_KEY = 'space:connectionKeys:gone' // under the keys' own prefix: durable in the hosted app (durableStore.js) as they are
const CONN_ID = /^[A-Za-z0-9_-]{1,64}$/
// ⚑ IN THE HOSTED APP THE VAULT HOLDS THE CALLKEYS (docs/vault-core-convergence-review.md §7.5; the owner, 2026-11-13, decision 3):
//   the app keeps a STUB per connection — { callKey: '', label, host, account, at?, held: 1 } — and the vault (vaultConnKeys.js)
//   fills a grant or an index2 write by id. A stub only ever comes from the vault, and only for an id it then holds.
const isHeldStub = (k) => (k.held === 1 || k.held === true) && (k.callKey == null || k.callKey === '')
function vaultConnStore () { try { const s = globalThis.__wbAppStoreState; return s && s.active && s.connKeys && typeof s.ask === 'function' ? s : null } catch { return null } }
export function connKeysInVault () { return !!vaultConnStore() }
export function normConnectionKeys(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
  const out = {}
  const s = (v) => (typeof v === 'string' ? v.slice(0, 256) : '')
  for (const [id, k] of Object.entries(o)) {
    if (Object.keys(out).length >= 64) break
    if (!CONN_ID.test(id) || !k || typeof k !== 'object') continue
    const held = isHeldStub(k)
    if (!held && (typeof k.callKey !== 'string' || !k.callKey || k.callKey.length > 256)) continue
    const at = Number(k.at)
    out[id] = { callKey: held ? '' : k.callKey, label: s(k.label), host: s(k.host), account: s(k.account), ...(Number.isFinite(at) && at > 0 ? { at } : {}), ...(held ? { held: 1 } : {}) }
  }
  return out
}
/** The whole keys only (no stub). */
export const fullConnectionKeys = (o) => Object.fromEntries(Object.entries(normConnectionKeys(o)).filter(([, k]) => !!k.callKey))
/** Each id `held` holds under the SAME callKey (or a stub already) → a stub; everything else as it is. Pure. */
export function stubConnectionKeys (o, held = {}) {
  const out = {}
  for (const [id, k] of Object.entries(normConnectionKeys(o))) {
    const h = held && held[id]
    out[id] = h && h.callKey && (!k.callKey || k.callKey === h.callKey) ? { ...k, callKey: '', held: 1 } : k
  }
  return normConnectionKeys(out)
}
export function loadConnectionKeys() { try { return normConnectionKeys(JSON.parse(lsGet(CONNKEYS_KEY) || 'null')) } catch { return {} } }
export function saveConnectionKeys(o) { const n = normConnectionKeys(o); try { localStorage.setItem(CONNKEYS_KEY, JSON.stringify(n)) } catch { /* private mode */ } if (vaultConnStore() && Object.values(n).some((k) => k.callKey)) setTimeout(() => { holdConnectionKeysInVault() }, 0); return n }
// THE HOSTED APP'S HALF: the vault said it keeps the callKeys (appStore.js: its `appLsRes` carried `connKeys`) — then a key written
// here WHOLE (an attach, a key from an older vault) is asked into the vault, and stubbed only for the ids it answers it holds.
// An older vault (no `connKeys`), a vault that does not answer, or none: the keys stay whole, as before. Never lost.
let _holding = null
export function holdConnectionKeysInVault (ms = 8000) {
  const s = vaultConnStore(); if (!s) return Promise.resolve(0)
  if (_holding) return _holding
  const full = fullConnectionKeys(loadConnectionKeys()); if (!Object.keys(full).length) return Promise.resolve(0)
  _holding = s.ask('connKeysHold', { keys: full }, null, ms).then((r) => {
    const held = {}; for (const id of (Array.isArray(r && r.held) ? r.held : [])) if (full[id]) held[id] = full[id]
    if (!Object.keys(held).length) return 0
    const cur = loadConnectionKeys(); const next = stubConnectionKeys(cur, held) // only an entry still under the key the vault took
    const n = Object.keys(held).filter((id) => cur[id] && cur[id].callKey === held[id].callKey).length
    if (n) { try { localStorage.setItem(CONNKEYS_KEY, JSON.stringify(next)) } catch { /* the whole key stays */ } }
    return n
  }, () => 0).finally(() => { _holding = null })
  return _holding
}
/** The keys with their callKeys, for a use that needs them in hand (the Code bridge, codeConnectionsBridge.js): a stub's key is
 *  asked of the vault, kept in memory only. */
export async function connectionKeysForUse (ms = 8000) {
  const cur = loadConnectionKeys(), s = vaultConnStore()
  const want = Object.keys(cur).filter((id) => !cur[id].callKey)
  if (!s || !want.length) return cur
  try {
    const r = await s.ask('connKeysGet', { ids: want }, null, ms); const got = fullConnectionKeys(r && r.keys)
    const out = { ...cur }; for (const id of want) if (got[id]) { const { held: _h, ...k } = cur[id]; out[id] = { ...k, callKey: got[id].callKey } }
    return out
  } catch { return cur }
}
/** Ask the vault to hold these whole keys ({ id: { callKey, label, host, account } }) → the ids it now holds under THAT key (only
 *  those may be stubbed). No vault that keeps them → []. */
export async function holdCallKeysInVault (keys, ms = 8000) {
  const s = vaultConnStore(), full = fullConnectionKeys(keys); if (!s || !Object.keys(full).length) return []
  try { const r = await s.ask('connKeysHold', { keys: full }, null, ms); return (Array.isArray(r && r.held) ? r.held : []).filter((id) => full[id]) } catch { return [] }
}
/** Just these ids' whole keys, for a use that needs them in hand for a moment (a create that seals a room's settings in this page,
 *  a cloud computer's grant) — asked of the vault, never stored here. Not held there → not in the answer. */
export async function heldCallKeys (ids, ms = 8000) {
  const s = vaultConnStore(); const want = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && CONN_ID.test(x)))].slice(0, 64)
  if (!s || !want.length) return {}
  try { const r = await s.ask('connKeysGet', { ids: want }, null, ms); return fullConnectionKeys(r && r.keys) } catch { return {} }
}
/** A room's settings about to be sealed IN THIS PAGE (a create — space.js createRoom): each entry with no callKey (a stub the vault
 *  answered a settings read with) takes the vault's key, by id. One it cannot fill is LEFT OUT (as fillIndex does): a dead entry is
 *  never sealed into a new room. Pure when nothing is a stub. */
export async function fillHeldConnections (cfg) {
  const list = cfg && Array.isArray(cfg.connections) ? cfg.connections : null
  const want = list ? list.filter((e) => e && !e.callKey && typeof e.id === 'string').map((e) => e.id) : []
  if (!want.length) return cfg
  const got = await heldCallKeys(want)
  const next = list.map((e) => { if (e && !e.callKey && got[e.id]) { const { held: _h, ...rest } = e; return { ...rest, callKey: got[e.id].callKey } } return e }).filter((e) => !e || e.callKey)
  const { connections: _c, ...rest } = cfg
  return next.length ? { ...rest, connections: next } : rest
}
// THE VAULT MINTS A NEW CONNECTION'S CALLKEY (connections.js setCallKeyMinter; vaultConnKeys.js mint/settle/adopt): only where the
// vault said `connMint`. null from seal → the page mints its own, as before.
const b64bytes = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)))
export const vaultCallKeyMinter = {
  async seal ({ spki, nonce, payload, id, rec }) {
    const s = vaultConnStore(); if (!s || !s.connMint) return null
    let r = null; try { r = await s.ask('connSeal', { conn: id, spki: b64bytes(spki), nonce: b64bytes(nonce), payload, rec: rec || {} }, null, 8000) } catch { return null }
    if (!r || !r.sealed || typeof r.sealed.ct !== 'string') return null
    return { sealed: r.sealed, settle: (ok, as = {}) => s.ask('connSettle', { conn: id, ok: !!ok, as }, null, 8000).then((x) => !!(x && x.held)) }
  },
  /** Move 3 (connWrap.js): a connection whose key the vault holds is locked at the Sentinel — the vault answers the proof and the
   *  sealed key; the key itself never enters this frame. → { mac, keySealed } | null */
  async wrapProof ({ id, nonce, spki }) {
    const s = vaultConnStore(); if (!s || !s.connMint) return null
    let r = null; try { r = await s.ask('connWrap', { conn: id, nonce, spki: b64bytes(spki) }, null, 8000) } catch { return null }
    return r && r.ok && typeof r.mac === 'string' && r.keySealed && typeof r.keySealed.ct === 'string' ? { mac: r.mac, keySealed: r.keySealed } : null
  },
  /** The account's list was read: the vault adopts the pending keys it shows → [[id, { label, host, account }]] (the page keeps stubs). */
  async adopt (ids) {
    const s = vaultConnStore(); if (!s || !s.connMint) return []
    try { const r = await s.ask('connAdopt', { ids: (ids || []).slice(0, 256) }, null, 8000); return Array.isArray(r && r.adopted) ? r.adopted.filter((x) => Array.isArray(x) && typeof x[0] === 'string') : [] } catch { return [] }
  },
}
// a launch whose copy still holds whole keys (written before this, or while the vault was away): asked in once, after the launch
try { if (vaultConnStore()) setTimeout(() => { holdConnectionKeysInVault() }, 3000) } catch { /* */ }
/** The removal marks { id: at } — valid ids, the newest MAX_MARKS (keptMerge.js unionMarks). */
export function normConnGone(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
  return unionMarks(Object.fromEntries(Object.entries(o).filter(([id]) => CONN_ID.test(id))), null)
}
export function loadConnGone() { try { return normConnGone(JSON.parse(lsGet(CONNGONE_KEY) || 'null')) } catch { return {} } }
export function saveConnGone(o) { const n = normConnGone(o); try { if (Object.keys(n).length) localStorage.setItem(CONNGONE_KEY, JSON.stringify(n)); else localStorage.removeItem(CONNGONE_KEY) } catch { /* private mode */ } return n }
/** The marks as a doc's added field — `{ connGone }`, or nothing while no one has detached (index2 and the backup unchanged). */
export const connGoneField = (g = loadConnGone()) => (Object.keys(g).length ? { connGone: g } : {})
/** Two copies ({ keys, gone }) into one — `cur` (this device's) wins what both hold while it outlives the marks; the marks of
 *  both, the newer per id. Pure; mergeConnectionKeys and backupMerge.js use it. */
export function mergeConnectionRecords(cur, inc) {
  const gone = unionMarks(normConnGone(cur && cur.gone), normConnGone(inc && inc.gone))
  const keys = normConnectionKeys(mergeByMarks(normConnectionKeys(cur && cur.keys), normConnectionKeys(inc && inc.keys), gone))
  return { keys, gone }
}
// A call key whose grant / finish answer is still out (connections.js postWithPendingKey — state machines pass 9, N#7): this device's
// alone (never synced — the device that sent it is the one that can adopt it), sealed on a protected device (protectedLocal.js).
export const CONN_PENDING_KEY = 'space:connPending'
export function loadPendingConnectionKeys() { try { const o = JSON.parse(lsGet(CONN_PENDING_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {} } catch { return {} } }
export function savePendingConnectionKeys(o) { try { if (o && Object.keys(o).length) localStorage.setItem(CONN_PENDING_KEY, JSON.stringify(o)); else localStorage.removeItem(CONN_PENDING_KEY) } catch { /* private mode */ } }
// stamped `at`: newer than a mark this device holds for the id, so a re-attach after a detach wins everywhere
export function rememberConnectionKey(id, k, now = Date.now()) { return saveConnectionKeys({ ...loadConnectionKeys(), [id]: { ...k, at: Math.max(now, (loadConnGone()[id] || 0) + 1) } }) }

// ── The Siri inbox (docs/siri-inbox.md): { token, defaultRoom, rooms: { [room]: { alias, label, pub:{x,y}, priv:{jwk}, at } } }.
// The TOKEN is the Shortcut's key (its hash is what the Sentinel holds); each opted-in Space's INBOX KEYPAIR lives here
// and nowhere else — the public half goes to the Sentinel, the private half opens the drops on this account's devices.
// It rides the ACCOUNT exactly as the connection keys do (index2 across live devices, the blob backup for a restore):
// union by room, the NEWER entry (its `at`) winning a Space both copies hold; the token follows `rev`, the default the merge's rule
// (keptMerge.js mergeSiriRooms; sync sweep 2026-11-14 P8).
export const SIRI_KEY = 'space:siri'
const SIRI_ROOM = /^[A-Za-z0-9_:.-]{4,120}$/, JWK_COORD = /^[A-Za-z0-9_-]{43}$/
export const normSiriAlias = (a) => String(a == null ? '' : a).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 32)
export function normSiri(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { token: '', defaultRoom: '', rooms: {} }
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
  const rooms = {}
  // ⛔ A REMOVAL IS RECORDED (state machines pass 9, K#3): `gone: { [room]: at }` — a Space taken off Siri — and `rev`, bumped
  //   by "Delete Siri setup". Union-with-local-wins brought both back from the account's other device, and the next push
  //   restored the deleted Shortcut key with every alias.
  const gone = Object.fromEntries(Object.entries(o.gone && typeof o.gone === 'object' && !Array.isArray(o.gone) ? o.gone : {}).filter(([r, at]) => SIRI_ROOM.test(r) && Number(at) > 0).map(([r, at]) => [r, Number(at)]).sort((x, y) => y[1] - x[1]).slice(0, 64))
  for (const [room, r] of Object.entries(o.rooms && typeof o.rooms === 'object' ? o.rooms : {})) {
    if (Object.keys(rooms).length >= 64) break
    if (!SIRI_ROOM.test(room) || !r || typeof r !== 'object') continue
    const alias = normSiriAlias(r.alias), pub = r.pub && typeof r.pub === 'object' ? r.pub : null, priv = r.priv && typeof r.priv === 'object' ? r.priv : null
    // a HELD room (the hosted vault keeps its private half — vaultAcctSecrets.js, review § 7.6): no priv here, `held: 1`
    const held = !priv && (r.held === 1 || r.held === true)
    if (!alias || !pub || !JWK_COORD.test(String(pub.x)) || !JWK_COORD.test(String(pub.y)) || (!held && (!priv || !JWK_COORD.test(String(priv.d))))) continue
    const at = Number(r.at) || 0
    if (gone[room] && at <= gone[room]) continue // taken off Siri after this entry was made (K#3)
    rooms[room] = { alias, label: s(r.label, 80), pub: { x: pub.x, y: pub.y }, ...(held ? { held: 1 } : { priv: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, d: priv.d } }), at }
  }
  const token = /^[A-Za-z0-9_-]{20,200}$/.test(String(o.token || '')) ? String(o.token) : ''
  const tokenHash = !token && /^[A-Za-z0-9+/]{43}=$/.test(String(o.tokenHash || '')) ? String(o.tokenHash) : '' // the vault holds the Shortcut key itself
  const defaultRoom = typeof o.defaultRoom === 'string' && rooms[o.defaultRoom] ? o.defaultRoom : ''
  const rev = Number.isInteger(o.rev) && o.rev > 0 ? o.rev : 0
  return { token, ...(tokenHash ? { tokenHash } : {}), defaultRoom, rooms, ...(Object.keys(gone).length ? { gone } : {}), ...(rev ? { rev } : {}) }
}
/** Two copies of the record into one — the NEWER entry wins a Space both hold (a tie: `cur`, this device's); a REMOVAL in either wins (pass 9, K#3):
 *  a Space taken off Siri (`gone[room]`, newer than the entry) and a deleted setup (`rev`: the copy with the higher one
 *  decides the Shortcut key, an empty one included). Pure; mergeSiri and backupMerge.js both use it. */
export function mergeSiriRecords(cur, inc) {
  // the rules are the vault keep's too (keptMerge.js, vault-core convergence C3); this function keeps only the app's format
  const a = normSiri(cur), b = normSiri(inc)
  const gone = unionMarks(a.gone, b.gone, Infinity) // normSiri keeps the newest 64
  const token = siriKeyOf(a, b)
  const tokenHash = token ? '' : siriKeyOf({ rev: a.rev, token: a.tokenHash }, { rev: b.rev, token: b.tokenHash })
  const rooms = mergeSiriRooms(a.rooms, b.rooms, gone) // the newer entry (a tie: local) — and never one a mark took off
  // a held stub never beats a whole copy of the SAME key (an older device's record still carries it)
  for (const [r, e] of Object.entries(rooms)) { const o = [a.rooms[r], b.rooms[r]].find((x) => x && x.priv && x.pub.x === e.pub.x && x.pub.y === e.pub.y); if (e.held && o) rooms[r] = o }
  // the other copy's default when this one's is gone (C3 — the keep's rule: it was blanked)
  return normSiri({ token, tokenHash, defaultRoom: siriDefaultOf(rooms, a.defaultRoom, b.defaultRoom), rooms, gone, rev: Math.max(a.rev || 0, b.rev || 0) })
}
export function loadSiri() { try { return normSiri(JSON.parse(lsGet(SIRI_KEY) || 'null')) } catch { return normSiri(null) } }
export function saveSiri(o) { const n = normSiri(o); try { localStorage.setItem(SIRI_KEY, JSON.stringify(n)) } catch { /* private mode */ } try { dispatchEvent(new CustomEvent('wb-siri-changed')) } catch { /* no window (the SDK, tests) */ } return n } // the change event: the iPhone app's Siri list follows (siriHeld.js syncSiriToNative)
export const siriConfigured = (o = loadSiri()) => !!((o.token || o.tokenHash) && Object.keys(o.rooms).length)
/** Union a synced/restored copy in — the newer entry per Space (mergeSiriRecords). Returns true on a change. */
export function mergeSiri(incoming) {
  const inc = normSiri(incoming); if (!inc.token && !Object.keys(inc.rooms).length && !inc.gone && !inc.rev) return false
  const cur = loadSiri()
  const next = mergeSiriRecords(cur, inc)
  if (JSON.stringify(next) === JSON.stringify(cur)) return false
  saveSiri(next); return true
}
// ── A2A into a member's private lanes (docs/a2a-lanes.md): { lanes: { [laneRoom]: { handle, name, description, pub:{x,y},
// priv:{jwk}, peers: [{ id, name, tokenHash, reply, created }] } } }. Each lane's INBOX KEYPAIR lives here and nowhere else
// (the public half goes to the Sentinel, the private half opens what outside agents sent); a peer's TOKEN is shown once and
// only its hash is kept. It rides the ACCOUNT exactly as the Siri record does: union by lane, the NEWER copy leading (a2aCore.js).
export const A2A_KEY = 'space:a2a'
export { normA2A } // a2aCore.js — the record's rules, shared with the SDK (docs/sdk-convergence.md 8c)
export function loadA2A() { try { return normA2A(JSON.parse(lsGet(A2A_KEY) || 'null')) } catch { return normA2A(null) } }
export function saveA2A(o) { const n = normA2A(o); try { localStorage.setItem(A2A_KEY, JSON.stringify(n)) } catch { /* private mode */ } return n }
export const a2aConfigured = (o = loadA2A()) => Object.keys(o.lanes).length > 0
/** Union a synced/restored copy in — the NEWER copy leads per lane (a tie: local), and a lane both copies hold (the same inbox, `handle`) gains the
 *  agents only the other copy has. ★ Agents were never merged (the owner, 2026-10-19: Grok Bot's results "I did not receive
 *  it"): an agent let in on one device never reached a device that already had the lane, and that device dropped its
 *  messages as a removed agent's. An agent removed on one device can come back from an older copy — inert: removing it
 *  revoked its token at the Sentinel and its intake address. Returns true on a change. */
export function mergeA2A(incoming) {
  const inc = normA2A(incoming); if (!Object.keys(inc.lanes).length && !inc.gone) return false
  const cur = loadA2A()
  const next = mergeA2ARecords(cur, inc) // a2aCore.js: union, the newer copy leads, and a REMOVAL in either copy wins over a listing in the other (pass 9, K#3)
  if (JSON.stringify(next) === JSON.stringify(cur)) return false
  saveA2A(next); return true
}
/** A DETACH (connectionsSheet.js drop, after the Sentinel revoked it): the mark first — newer than the entry, and recorded even
 *  when this device never held the key (attached elsewhere) — then the key. */
export function forgetConnectionKey(id, now = Date.now()) {
  const cur = loadConnectionKeys()
  if (CONN_ID.test(String(id))) saveConnGone(unionMarks(loadConnGone(), { [id]: Math.max(now, ((cur[id] && cur[id].at) || 0) + 1) }))
  if (!(id in cur)) return cur; const rest = { ...cur }; delete rest[id]; return saveConnectionKeys(rest)
}
/** Merge a synced/restored copy in (index2's `connections` + `connGone`, the backup's `connectionKeys` + `connGone`) — LOCAL WINS
 *  per id, and a mark from either copy takes off an older entry. Returns true when anything changed. With no marks on either
 *  side this is the old union: true exactly when a new id landed. */
export function mergeConnectionKeys(incoming, incomingGone) {
  const cur = loadConnectionKeys(), curGone = loadConnGone()
  // a stub is usable only beside the vault that holds its key (the hosted app): anywhere else one that slipped into a synced copy is left out
  const inc = connKeysInVault() ? incoming : fullConnectionKeys(incoming)
  const next = mergeConnectionRecords({ keys: cur, gone: curGone }, { keys: inc, gone: incomingGone })
  const keysMoved = canon(next.keys) !== canon(cur), goneMoved = canon(next.gone) !== canon(curGone)
  if (goneMoved) saveConnGone(next.gone) // the marks before the keys: a stop between leaves a mark, never a revived key
  if (keysMoved) saveConnectionKeys(next.keys)
  return keysMoved || goneMoved
}
/** Another copy of the address book folded into `list` — union by address (contactKey); a newer edit or tombstone wins
 *  (assistants on equal time too); an older copy only fills a missing name. Pure: → { list (new rows), changed }. */
export function mergeContactLists(list, incoming) {
  const out = list.map((c) => (c && typeof c === 'object' ? { ...c } : c)); const byKey = new Map(out.map((c) => [contactKey(c), c])); let changed = false
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const c = normContact(raw); if (!c) continue; const k = contactKey(c); const ex = byKey.get(k)
    if (!ex) { out.push(c); byKey.set(k, c); changed = true }
    else if (c.kind === 'agent') { if ((c.at || 0) >= (ex.at || 0)) { Object.assign(ex, c); changed = true } } // adopt a newer saved-assistant edit (LWW)
    else if ((c.at || 0) > (ex.at || 0)) { Object.assign(ex, c); changed = true } // person LWW: a newer edit / tombstone wins (equal-or-older at-less persons fall through to fill-name)
    else if (c.fn && !ex.fn) { ex.fn = c.fn; changed = true } // learned a name for a known address
  }
  return { list: out, changed }
}
export function mergeContacts(incoming) { // restore/merge from a backup/index room — union; also fills missing names
  if (!Array.isArray(incoming) || !incoming.length) return
  const { list, changed } = mergeContactLists(loadContacts(), incoming)
  if (changed) saveContacts(list)
}
// Fold a fork chain (membership changes = epochs of ONE Space, docs/spaces-membership-fork.md) into a single entry — the
// LATEST epoch. Rooms with no epochRoot (originals / un-forked) pass through unchanged. Older epochs drop out of the list
// (reachable later via "earlier versions"); the newest carries the Space forward.
export function foldEpochs(list) {
  const best = new Map(); const singles = []
  for (const r of (Array.isArray(list) ? list : [])) {
    if (r == null) continue
    if (r.epochRoot == null) { singles.push(r); continue }
    const prev = best.get(r.epochRoot)
    if (!prev || (r.epoch || 0) > (prev.epoch || 0)) best.set(r.epochRoot, r)
  }
  return [...singles, ...best.values()]
}
// ── PERSONAL AGENT — JOINT LEDGER (docs/spaces-personal-agent.md) ─────────────────────────────────────────────────────
// The set of YOUR rooms whose agents share ONE memory. On a turn in any of them this device attaches the OTHER set-rooms'
// keys ({room,mk,label}) so the runtime folds their recent entries into the agent's context (server-gated by
// PERSONAL_AGENT_LINKS). Inert until you add ≥2 rooms; the reply still needs your approval. `space:pa`=1 reveals the toggle.
export const AGENT_LINKS_KEY = 'space:agentlinks'
export const personalAgentUI = () => { try { return localStorage.getItem('space:pa') === '1' } catch { return false } }
export const agentLinks = () => { try { const a = JSON.parse(localStorage.getItem(AGENT_LINKS_KEY) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }
export const inAgentLinks = (r) => agentLinks().includes(r)
export const toggleAgentLink = (r) => { const s = new Set(agentLinks()); s.has(r) ? s.delete(r) : s.add(r); try { localStorage.setItem(AGENT_LINKS_KEY, JSON.stringify([...s].slice(0, 24))) } catch { /* */ } }
export const saveName = (n) => { state.myName = String(n || '').trim().slice(0, 24); try { localStorage.setItem('space:myname', state.myName) } catch { /* */ } }
/** A name learned from the account — the backup or the account's room list — not typed here: saved, and a "What's your name?"
 *  already waiting is answered with it (nameGate.nameArrived, wired in space.js; the owner, 2026-10-25: "Why is your name still
 *  required after restore?"). */
export const adoptName = (n) => {
  const v = String(n || '').trim(); if (!v || state.myName) return false
  saveName(v)
  try { if (typeof dispatchEvent === 'function' && typeof CustomEvent === 'function') dispatchEvent(new CustomEvent('wb-name-arrived', { detail: { name: state.myName } })) } catch { /* */ }
  return true
}

// The offline chat cache's per-room key (moved from space.js, verified-client split step 50).
export const chatKey = (r) => 'chat:' + r
// Put a room at the top of recents (URL/title kept if not given); temp rooms never enter durable recents (moved, step 50).
// ★ EVERYTHING ELSE ON THE ENTRY IS KEPT. This rebuilt the entry as {room, url, title, at} on every room open, dropping
//   titleAt / titled / llmTitled / archived / pinned and their stamps: a rename lost its time (so the index sync's
//   last-writer-wins let any other device's older name win — the rename "never" arrived) and its llmTitled flag (so the
//   auto-titler ran again on open and overwrote the rename seconds later). The owner: "The rename sometimes appears only
//   after a few seconds and sometimes never at all — the name in the header."
export function upsertRecent({ room, url, title, at = Date.now() }) {
  if (!room || isTempRoom(room)) return // temp rooms are NOT in durable recents — they live in the shreddable temp INDEX room (the durable index holds only a pointer). This is what stops a wiped temp room resuming as a BLANK.
  const list = loadRecents()
  const prev = list.find((r) => r.room === room)
  const rest = list.filter((r) => r.room !== room)
  rest.unshift({ ...(prev || {}), room, url: url || (prev && prev.url) || (location.pathname + location.search + location.hash), title: title || (prev && prev.title) || 'Space', at })
  saveRecents(rest)
}
// This device's member id for widgets that want to skip "navigate to yourself" (localStorage, minted once; moved, step 50).
export function meId() {
  try { let id = localStorage.getItem('space:me'); if (!id) { id = 'm-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('space:me', id) } return id } catch { return 'm-anon' }
}

// A crossing that is APPROVED comes back to the lane through the mirror, as an ordinary "from the shared room"
// entry. That is the "draft replaced by the sent message" behaviour for free — but it arrives indistinguishable from
// anything else said in the room, when it is the one message you authored. Remember what crossed so the mirrored
// copy can be rendered as the crossing it is. Per-room, capped, and text-keyed because the mirror re-ids entries.
export const crossedKey = (r) => 'space:crossed:' + r
export const crossedList = (r) => { try { return JSON.parse(localStorage.getItem(crossedKey(r)) || '[]') } catch { return [] } }
// The server sends the crossing as PLAIN prose (agent/spaceBridge.mjs toPlainProse — this is a copy, held equal by
// spaces/test/crossedPlain.test.mjs), so a draft with Markdown or a link came back as different text and was never
// recognised as yours (sync sweep, 2026-10-10). Both sides are compared in that form.
export function plainProse(s) {
  return String(s == null ? '' : s)
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .trim()
}
export const rememberCrossed = (r, text) => {
  const t = plainProse(text); if (!t) return
  try { localStorage.setItem(crossedKey(r), JSON.stringify([...crossedList(r).filter((x) => x !== t), t].slice(-50))) } catch { /* */ }
}
export const wasCrossed = (r, text) => { const t = plainProse(text); return !!t && crossedList(r).some((x) => x === t || plainProse(x) === t) }

// ── deleted-Space tombstones ────────────────────────────────────────────────────────────────────────────────────────
// A delete is a TOMBSTONE, not a local forget: it rides the index doc to your other devices (roomSync publishes
// `{deleted:true}`, which wins over any live entry) and it BLOCKS RESURRECTION — a stale device, an old backup or a
// late sync must never bring a deleted Space back. It lives HERE rather than in roomSync because backup.js needs it
// too and roomSync already imports backup.js; reading it from the lower layer avoids the cycle.
const TOMBSTONE_KEY = 'space:tombstones'
export const loadTombstones = () => { try { return JSON.parse(localStorage.getItem(TOMBSTONE_KEY) || '{}') } catch { return {} } }
export const saveTombstones = (t) => { try { localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(t)) } catch { /* private mode */ } }
export const tombstoneRoom = (r) => { const t = loadTombstones(); if (!t[r]) { t[r] = Date.now(); saveTombstones(t) } }
export const isTombstoned = (r) => { try { return !!loadTombstones()[r] } catch { return false } }

