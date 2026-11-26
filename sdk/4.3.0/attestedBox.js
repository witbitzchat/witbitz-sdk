// attestedBox.js — THE ATTESTED BOX: how an attested room's key reaches a new member (docs/the-attested-client.md § The
// attested backup — "Invites go INTO the attested backup, never in a link"; docs/emulated-attested-rooms.md step 4). General
// over KINDS (attestedRooms.js): each kind has its own box — an ECDH key pair and an inbox — beside the account's ordinary
// invite box (inviteEnroll.js), published in the same directory row under its own APP slot (`spaces.<kind>`). Its PRIVATE half
// is kept on the device under its own name and travels only in that kind's attested backup — never in the regular backup or
// the room list (neither knows this key exists). An invite to an attested room is sealed to the invitee's box OF THAT KIND,
// carries no link, and is opened only by a device whose bridge serves the kind. A member with no such app gets nothing.

export const boxApp = (kind) => 'spaces.' + kind // the directory slot (agent/spaceHandler.mjs dirSlot: one row, one slot per app)
const KEY = (kind) => 'space:attestedBox:' + kind
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function loadBox (kind) { try { const b = JSON.parse(localStorage.getItem(KEY(kind)) || 'null'); return b && b.boxPub && b.boxPriv && b.inbox ? b : null } catch { return null } }
export function saveBox (kind, box) { try { localStorage.setItem(KEY(kind), JSON.stringify({ boxPub: box.boxPub, boxPriv: box.boxPriv, inbox: box.inbox })) } catch { /* private mode */ } }
/** This device's box for `kind`: the one it has, else a new one (the caller pulls the kind's backup FIRST, so every device
 *  of the account adopts one box instead of each minting its own). */
export async function ensureBox (kind, { genRecipientKey }) {
  const have = loadBox(kind); if (have) return have
  const kp = await genRecipientKey()
  const box = { boxPub: kp.publicJwk, boxPriv: kp.privateJwk, inbox: b64u(crypto.getRandomValues(new Uint8Array(18))) }
  saveBox(kind, box)
  return box
}
/** Publish the box in the account's directory row (the same proof as the ordinary slot: a sign-in whose blinded email IS the
 *  handle). → { ok } | { ok:false, reason }. */
export async function publishBox (kind, { box, handle, idToken, client, scope = '' }) {
  if (!box || !handle || !idToken || !client) return { ok: false, reason: 'bad_args' }
  const r = await client.dirPut(handle, { boxPub: box.boxPub, inbox: box.inbox }, idToken, scope, boxApp(kind))
  return r && r.status === 200 ? { ok: true } : { ok: false, reason: 'dir_put_failed:' + (r ? r.status : 'net') }
}
