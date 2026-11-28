// Tier-2 invite — SEND (docs/spaces-email-invite.md; by username: docs/spaces-usernames.md §5). Resolve the invitee's
// ADDRESS — an email (via the blinded OPRF, so the email never leaves the device) or a public "@username" (via the
// registry, which answers the account's handle) — to the SAME directory slot, wrap THIS room's key to the recipient's
// boxPub (an anonymous sealed box), and drop it in their inbox. The server only ever sees a blinded lookup or a public
// name, and an anonymous ciphertext landing in some inbox — never the email, the room, or the key.
import { resolveHandle, usernameSlotApp } from './inviteEnroll.js' // ⛔ THIS address: the vault sets the hosted app's directory scope on it (setDirScope); its build leaves a plain './inviteEnroll.js' plain = a second, unscoped copy, and every invitee was looked up in the regular app's directory (2026-11-17; vaultModuleOneAddress.test.mjs)
import { validUsername } from './address.js'
import { sealTo } from './e2ee.js'

/** The invitee's directory handle for `{ email } | { username }`. Returns `{ handle }` or `{ reason }`:
 *  `no_user` = no such username (distinct from an enrolled-or-not email — a name is either claimed or it is not).
 *  Throws only if the OPRF/DLEQ round-trip fails. */
export async function resolveInvitee({ email, username, app, scope }, client) {
  if (username !== undefined && username !== null && username !== '') {
    const u = validUsername(username)
    if (!u) return { reason: 'bad_args' }
    // the slot of THIS app: an attested kind's box, else — in a scoped app (the hosted app) — its own slot under the global
    // handle (inviteEnroll.js enrollUsernameSlot), never the regular app's default one
    const slot = app || (scope === undefined ? usernameSlotApp() : scope) || undefined
    const r = await client.userResolve(u, slot)
    if (!r || r.status === 404) return { reason: 'no_user' }
    if (r.status !== 200) return { reason: 'resolve_failed:' + (r ? r.status : 'net') }
    const entry = r.entry && r.entry.boxPub && r.entry.inbox ? r.entry : null
    if (!entry && slot) return { reason: 'not_enrolled' } // no slot for this app: they have not opened it — never another app's inbox
    const handle = typeof r.handle === 'string' && r.handle ? r.handle : null // §12: absent for a member who closed the email door
    if (!entry && !handle) return { reason: 'not_enrolled' }
    return { ...(handle ? { handle } : {}), ...(entry ? { entry } : {}) } // the resolve carries the invite slot itself (docs/spaces-usernames.md §10)
  }
  if (!email) return { reason: 'bad_args' }
  return { handle: await (scope === undefined ? resolveHandle(email, client) : resolveHandle(email, client, scope)) } // blinded — the email never leaves the device
}

/** The invitee's invite slot — the lookup alone, nothing sent. → { ok: true, entry } | { ok: false, reason }: `not_enrolled` (never
 *  signed in to Spaces — no slot), `no_user` (no such username), `no_entry` / `resolve_failed:…` (could not tell). New Space uses it
 *  to refuse people who are not on Spaces (the owner, 2026-11-21: "You cannot create a room for a person that is not registered"). */
export async function findInvitee({ email, username, app, scope }, client) {
  if ((!email && !username) || !client) return { ok: false, reason: 'bad_args' }
  const who = await resolveInvitee({ email, username, app, scope }, client)
  if (!who.handle && !who.entry) return { ok: false, reason: who.reason }
  // By @username the slot came with the resolve — the EMAIL lookup is never asked, so a member who closed that door is
  // still reachable by the name they chose to be public. By email: the lookup, which answers 404 for a closed door too.
  const g = who.entry ? { status: 200, entry: who.entry } : await client.dirGet(who.handle, app ? { app } : undefined)
  if (!g || g.status === 404) return { ok: false, reason: 'not_enrolled' }
  if (g.status !== 200 || !g.entry || !g.entry.boxPub || !g.entry.inbox) return { ok: false, reason: 'no_entry' }
  return { ok: true, entry: g.entry }
}

// Returns { ok:true } or { ok:false, reason }. `not_enrolled` = the recipient has never opened Spaces, so there is no
// slot to seal to (the UI should say "ask them to open Spaces once"); `no_user` = that username does not exist.
export async function sendInvite({ email, username, room, mk, title, from, gate, link, client, direct, app, scope, kind, us = null, spc = '' }) { // app/kind: an ATTESTED room's invite goes to the invitee's box for that kind (attestedBox.js), never with a link
  // A SPLIT room has NO mk to deliver — the self-contained `link` carries the userShare (#us=) instead, so accept when
  // EITHER an mk or a link is present. (`mk` is still delivered for a plain room, and as a v1 fallback field below.)
  // AN ATTESTED SPLIT ROOM (the hosted app's — 2026-11-24, every attested invite there failed bad_args): no mk and no link, the user
  // share and its commitment instead — only into an attested kind's box (an ordinary split room's invite is its link)
  if (us && !kind) return { ok: false, reason: 'bad_args' }
  if ((!email && !username) || !room || (!mk && !link && !us) || !client) return { ok: false, reason: 'bad_args' }
  const f = await findInvitee({ email, username, app, scope }, client)
  if (!f.ok) return f
  const g = { entry: f.entry }
  // Seal the self-contained LINK (room+mk+gate+lanes in ONE grammar) as the source of truth the recipient reverse-parses,
  // so no field is ever hand-dropped again (that was the "synced, can't open" bug — the gate marker went missing). room/mk
  // /gate are ALSO carried for now so a not-yet-updated recipient (a v1 reader) still works during rollout.
  const box = await sealTo(JSON.stringify({ v: 2, ...(link ? { link } : {}), room, ...(mk ? { mk } : {}), ...(us ? { us: String(us), ...(spc ? { spc: String(spc) } : {}) } : {}), ...(gate ? { gate } : {}), title: title || '', from: from || '', ...(kind ? { kind } : {}), ...(direct ? { direct: String(direct).slice(0, 254) } : {}), at: Date.now() }), g.entry.boxPub)
  const r = await client.drop(g.entry.inbox, box)
  if (r && r.status === 200) return { ok: true }
  if (r && r.status === 507) return { ok: false, reason: 'inbox_full' }
  return { ok: false, reason: 'drop_failed:' + (r ? r.status : 'net') }
}
