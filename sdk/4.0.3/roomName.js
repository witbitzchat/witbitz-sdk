// spaces/public/roomName.js — A ROOM'S NAME, as every client reads it: the app (roomTitle.js, messageRender.js, unread.js)
// and the SDK (witbitz-sdk.js) import this one module, so a device and a builder's page can never disagree on a name.
//
// The name is an ENTRY in the room's log — { kind:'title', title, manual | auto, name, ts } — appended by op:'title' when a
// member renames the room (`set`) or a new name is generated (agent/spaceService.mjs). It reaches every device on every
// path a message takes. THE RULE: the room is called by the title entry with the LATEST ts (the server's clock), ties
// going to the one later in the log — so every device holding the same entries names the room the same, whatever order
// it read or rendered them in (an older page loaded later never wins). A title entry has no `text`: it is never chat.
export const TITLE_KIND = 'title'
export const TITLE_MAX = 80

/** A name as the server stores it: control characters and runs of whitespace folded, trimmed, ≤ TITLE_MAX. */
export function cleanTitle(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
}

export function isTitleEntry(e) {
  return !!e && e.kind === TITLE_KIND && typeof e.title === 'string' && cleanTitle(e.title) !== ''
}

/** The room's name from its entries: { title, manual, by, ts, id } of the newest title entry, or null when there is none. */
export function latestTitle(entries) {
  let best = null, bestTs = -Infinity
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!isTitleEntry(e)) continue
    const ts = Number(e.ts) || 0
    if (ts >= bestTs) { best = e; bestTs = ts } // >= : a tie goes to the later entry
  }
  return best ? { title: cleanTitle(best.title), manual: !!best.manual, by: String(best.name || ''), ts: bestTs, id: best.id } : null
}

/** The line a rename shows in the conversation (a generated name shows nothing). */
export function renameLine(e) {
  return `${String((e && e.name) || 'Someone').slice(0, 80)} renamed this Space to “${cleanTitle(e && e.title)}”`
}

/** The name a room's shared `title` doc gives — the fallback for a room with no title entry yet: { title, manual, at } | null. */
export function titleFromDoc(d) {
  const title = d && d.state ? cleanTitle(d.state.title) : ''
  return title ? { title, manual: !!d.state.manual, at: Number(d.state.at) || 0 } : null
}

/** Send a rename: `ops.title(name, by)` = op:'title' with `set` (the server appends it to the log and writes the doc).
 *  A server that does not take `set` yet answers without `set: true`; then `ops.writeDoc(state, summary)` writes the
 *  shared doc alone, as renames did before. → { took: true } when the room's log took it; { took: false, refused,
 *  reason } when the room refused it (only its admins may rename it); { took: false, unavailable } when nothing answered or
 *  the server failed (nothing stored — send it again); { took: false } after the doc-only fallback (an older server). */
export async function sendRename(ops, name, by) {
  const title = cleanTitle(name); if (!title) return { took: false, refused: 'bad_request', reason: 'a name is 1–80 characters' }
  let r = null
  try { r = await ops.title(title, by || '') } catch { r = null }
  if (r && r.status === 200 && r.set) return { took: true }
  if (r && r.status === 403) return { took: false, refused: r.error || 'not_admin', reason: r.reason || '' }
  // No answer, or the server/enclave failed (0, 5xx): NOT an older server — nothing was stored. Say so; the caller resends
  // (the app keeps renamePending, the SDK throws `unavailable`). Writing the doc here would report a rename that never landed.
  if (!r || !r.status || r.status >= 500) return { took: false, unavailable: true, reason: (r && r.error) || '' }
  try { await ops.writeDoc({ title, manual: true, at: Date.now() }, title) } catch { /* the caller keeps its name */ }
  return { took: false }
}

/** May `email` rename a room whose sealed config is `cfg`? Where it has owners or admins, only they; otherwise anyone —
 *  the server's rule (op:'title' set), the same one a move follows (emailFork.js mayMove). */
export function mayRename(cfg, email) {
  if (isDirect(cfg)) return false // nobody renames a direct chat: each side sees the other person's name
  const lc = (v) => (Array.isArray(v) ? v : []).map((x) => String(x).trim().toLowerCase())
  const owners = lc(cfg && cfg.owners && cfg.owners.emails), admins = lc(cfg && cfg.admins && cfg.admins.emails)
  const me = String(email || '').trim().toLowerCase()
  return !(owners.length || admins.length) || (!!me && (owners.includes(me) || admins.includes(me)))
}

// ── WHICH NAMES A ROOM GETS (the owner, 2026-10-08) ──────────────────────────────────────────────────────────────────────
// ALONE (you and the assistant, a private lane): the name follows the conversation — generated, revisited as the subject
//   drifts — until you rename it; a name set by hand is never revisited. A GROUP (two or more people): named by hand at
//   creation (a mandatory field), renamed by the room's admins where it has them and by anyone in a regular room; a
//   rename is a line in the chat and a notification. No name is generated for a group: the one it had when it became a
//   group stays until someone renames it. A DIRECT CHAT with one person (`direct: true` in its sealed config — a verified
//   room of exactly two): each side sees the OTHER person's name; nobody renames it and no name is generated for it. One
//   per pair (directChat.js).

/** A LANE COPY — a line mirrored from the linked shared room — and not this room's own. Its id is `sh:…`. An imported
 *  chat, a device-carried fork, a recreate-from-export and server-carried history also arrive through op 'mirror' with
 *  `source: 'shared'`, and they ARE this room's own history (sync sweep, 2026-10-10). The one rule for the app's render,
 *  the agent's label and every count of people. */
export const isLaneCopy = (e) => !!e && e.source === 'shared' && String(e.id == null ? '' : e.id).startsWith('sh:') && !(e.carried && typeof e.carried === 'object')

// One person, one key: their EMAIL where any of their entries shows it (a row carries it, a message does not), else
// the NAME they write under — so a post and a row are one person (sync sweep, 2026-10-10), and so are two names that one
// email wrote under. Never the signing key: each device has its own, and a phone and a laptop counted as two. Two people
// who share a name and show no email read as one here; in a verified room the ROSTER decides instead (`invited`).
function personKeyer(entries) {
  const emailOf = new Map()
  for (const e of entries) if (e && e.name && e.email) emailOf.set(String(e.name), String(e.email).toLowerCase())
  return (e) => { const em = e.email ? String(e.email).toLowerCase() : (e.name ? emailOf.get(String(e.name)) : ''); return em ? 'e:' + em : (e.name ? 'n:' + String(e.name) : '') }
}

/** The people who have written in the room — never the assistant: each by their email where any entry shows it, else
 *  by the name they write under. Lane copies of the shared room's lines and generated names are not this room's people. */
export function peopleIn(entries) {
  const who = new Set()
  const list = Array.isArray(entries) ? entries : []
  const personKey = personKeyer(list)
  for (const e of list) {
    if (!e || e.self || e.sys || isLaneCopy(e) || e.kind === 'fork') continue
    if (e.kind === TITLE_KIND && !e.manual) continue
    const id = personKey(e)
    if (id) who.add(id)
  }
  return who
}

/** May a name be GENERATED for this room? Only while one person is in it (`invited`: a verified room's roster size,
 *  which counts people who have not written yet) and nobody has named it by hand — in its log or in its doc. */
export function mayAutoName(entries, doc, { invited = null, direct = false } = {}) {
  if (direct) return false // a direct chat is named by the other person, on each side
  if (doc && doc.state && doc.state.manual) return false
  const t = latestTitle(entries); if (t && t.manual) return false
  // A verified room KNOWS who is in it (its roster): that number answers, whatever the log's names say (the owner's
  // "roster first" rule, asyncTurn.mjs). The log is counted only where no roster number exists.
  if (Number.isInteger(invited) && invited > 0) return invited <= 1
  return peopleIn(entries).size <= 1
}

/** The push a rename sends: who did it, and what they did (renameLine, without the name in front). */
export function renamePreview(e) {
  return { who: String((e && e.name) || 'Someone').slice(0, 80), preview: `renamed this Space to “${cleanTitle(e && e.title)}”` }
}

// ── DIRECT CHATS ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Is the room whose sealed config is `cfg` a direct chat with one person? */
export const isDirect = (cfg) => !!(cfg && cfg.direct === true)
/** After a member change, is it still a chat between two? A third person, or a whole domain, makes it a group: its sealed
 *  `direct` goes, so it gets a name and no longer reads as one person (the sync sweep, 10-13 #10 — it stayed direct, titled
 *  by "the other person" when there were two). `allow` = the sealed list ({ emails, mh, domains }). */
export const staysDirect = (allow) => {
  const a = allow || {}, n = (k) => (Array.isArray(a[k]) ? a[k].filter(Boolean).length : 0)
  return !n('domains') && n('emails') + n('mh') + n('hidden') + n('users') <= 2 // users: a legacy room's @username entries are people (rosterCount counts them; agent/roomRekey.mjs holds the same rule)
}

/** The OTHER person of a direct chat, from its sealed allow-list (only these two can post — the gate checks it): an email,
 *  or { username, handle } for someone added by @username. `me` = this member's verified email. null when it is not a
 *  two-person room this member is in. */
export function directPeer(cfg, me) {
  if (!isDirect(cfg)) return null
  const mine = String(me || '').trim().toLowerCase()
  const allow = (cfg && cfg.allow) || {}
  const emails = (Array.isArray(allow.emails) ? allow.emails : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean)
  const users = (Array.isArray(allow.users) ? allow.users : []).filter((u) => u && u.username)
  // ★ ADDED BY @USERNAME (sync sweep 10-13): that person is on the list only as a HASH of their handle (allow.hidden — the
  //   creator's device seals no username), so their own email is not in `emails` and the chat had no readable peer on their
  //   side. A device that read this sealed config passed the room's gate, so with exactly one hidden entry and one listed
  //   email, that email is the other person. (The creator's other devices still cannot read the hash — their recent names it.)
  // stored as `allow.mh` (spaceClient create — sync sweep 11-08 #36: this read `allow.hidden`, which no config carries, so the
  // @username member's side never had a peer); `hidden` is kept as a second name
  const hidden = [...new Set([...(Array.isArray(allow.mh) ? allow.mh : []), ...(Array.isArray(allow.hidden) ? allow.hidden : [])].filter(Boolean))]
  if (mine && !emails.includes(mine)) return (hidden.length === 1 && emails.length === 1 && !users.length) ? { email: emails[0] } : null
  const others = emails.filter((e) => e !== mine)
  if (others.length === 1 && !users.length) return { email: others[0] }
  if (!others.length && users.length === 1) return { username: String(users[0].username).toLowerCase(), ...(users[0].handle ? { handle: String(users[0].handle) } : {}) }
  return null
}

/** The key a person is filed under (contacts.js / address.js): the lowercased email, or "@" + the username. */
export const peerKey = (peer) => (peer && peer.email ? String(peer.email).toLowerCase() : (peer && peer.username ? '@' + String(peer.username).toLowerCase() : ''))

/** What a direct chat is called on this side: the name you saved for the person, else their @username, else their email. */
export function directTitle(peer, contactName = '') {
  const n = cleanTitle(contactName)
  if (n) return n
  if (peer && peer.username) return '@' + peer.username
  return peer && peer.email ? String(peer.email) : ''
}

