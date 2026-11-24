// spaces/public/spaceFork.js — MEMBERSHIP CHANGE = ROOM FORK (docs/spaces-membership-fork.md).
//
// Adding or removing a member is ONE epoch operation (the MLS "commit advances an epoch, re-keys the group" shape):
// create a NEW room with the desired roster and a fresh key, carry the history you choose, and hand each keeper a
// forward pointer sealed so a removed party can't read it. Exclusion is STRUCTURAL — the removed member simply isn't in
// the new roster and never receives the new key; nothing has to *reach* them for them to be out (the one property a
// pushed `revoke` can't guarantee against a content-blind server).
//
// It reuses primitives we already have — `create` (new roster + fresh gk), `mirror` (ledger transfer), `sealTo` (the
// pointer) — so there is NO new trust machinery. Each keeper already holds an ECDSA P-256 SIGNING key whose public
// point is on the SAME curve as sealTo's ECDH, so the pointer is sealed to that existing key (spk-reuse). The room
// ROSTER (name→spk) is read from the ledger, where P0 stamps each verified member's spk. All crypto lives in
// entrySig.js / e2ee.js; this module is orchestration over the client transport.
//
// The FORK INITIATOR enters the new room by the SAME path as every other keeper (their own sealed pointer / the grant
// returned here) — so there is no privileged "owner identity", just N keepers who each reuse their signing key.
import { genKeypair, mintGrant, signEntry, attribute } from './entrySig.js'
import { sealTo, openBox } from './e2ee.js'
import { mirrorInBatches } from './spaceExport.js' // the whole history in slices of 25, as the lane mirror
import { roomRegion } from './regions.js' // a room's home region is in its id (docs/multi-region.md)
import { readAllPages } from './ledgerView.js'

async function readForkHistory(client, room, mk) {
  const poll = await readAllPages((since) => client.pollSealed(room, mk, undefined, since))
  if (poll.incomplete) throw Object.assign(new Error('history_incomplete'), { code: 'history_incomplete' })
  return poll
}

const GRANT_TTL_S = 400 * 24 * 3600 // long-lived member grant, matching createSoloIdentity
const enc = new TextEncoder()
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
// A stable hash over the sealed boxes → carried in the fork notice's signed `text`, so the signature BINDS the exact
// box set (a relay can't add/swap/drop a box without breaking attribution). Only the fields the box needs to open.
export const boxesHash = async (boxes) => b64u(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify((boxes || []).map((b) => ({ x: b.epk.x, y: b.epk.y, iv: b.iv, ct: b.ct }))))))
// A bare EC JWK (kty/crv/x/y[/d], no key_ops) — REQUIRED for spk-reuse: WebCrypto refuses to import an ECDSA key
// (key_ops ['sign']/['verify']) for ECDH deriveBits, so strip the op hints before sealTo/openBox.
export const bareEC = (jwk) => (jwk && jwk.x && jwk.y) ? { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ...(jwk.d ? { d: jwk.d } : {}) } : null
// Identity of an EC public key (its curve point) — for de-dup, removal matching, and agent exclusion.
export const jkey = (jwk) => (jwk && jwk.x && jwk.y) ? `${jwk.x}.${jwk.y}` : ''

/** Derive the room ROSTER from decrypted ledger entries: the distinct HUMAN members who posted a VERIFIED turn, each
 *  with their signing pubkey (spk, stamped by P0). The agent's own replies (self:true) carry no spk and are excluded;
 *  the agent re-attaches in the fork via the carried agentKeys, not a sealed pointer. Last spk wins per name (key
 *  rotation). `agentKeys` (optional) drops any 3rd-party agent that posted by key — it too re-attaches via agentKeys. */
export function deriveRoster(entries = [], agentKeys = []) {
  const agentSet = new Set((Array.isArray(agentKeys) ? agentKeys : []).map((e) => jkey(e && e.key)).filter(Boolean))
  const byName = new Map()
  for (const e of entries) {
    if (!e || e.self || e.verified !== true || !e.spk || !e.name) continue
    if (agentSet.has(jkey(e.spk))) continue // a 3rd-party agent, not a human keeper
    const prev = byName.get(e.name)
    // `attestedClient`: the server's stamp that a turn came from an attested app (docs/the-attested-client.md, step 5) — a
    // member keeps the mark once any of their turns carried it (the members sheet shows it; nothing else reads it)
    const attestedClient = (typeof e.attestedClient === 'string' && e.attestedClient) || (prev && prev.attestedClient) || undefined
    const attestedVersion = (typeof e.attestedClient === 'string' && Number.isInteger(e.attestedVersion) ? e.attestedVersion : undefined) ?? (prev && prev.attestedVersion)
    byName.set(e.name, { name: e.name, spk: e.spk, ...(attestedClient ? { attestedClient } : {}), ...(attestedClient && attestedVersion ? { attestedVersion } : {}) })
  }
  return [...byName.values()]
}

/** Fork a room to change its membership. `client` exposes { pollSealed, getConfig, create, mirror }.
 *  opts:
 *    self     {name, spk}   — the INITIATOR; always kept (so they can enter the fork even if they never posted). Required.
 *    remove   [name | {spk}]— members to drop (matched by name OR by spk). Their turns' history still rides along as
 *                             history unless `history:'forward'` (dropping past turns is REDACTION — a separate feature).
 *    add      [{name, spk}] — new members (each supplies a signing pubkey; the host provisions or they generate one).
 *    history  'full'|'forward' — carry the whole ledger (newcomers see everything) or nothing (forward-only). Default 'full'.
 *    base                  — optional endpoint base for create.
 *  Returns { room, mk, gk, selfGrant, keepers, pointers:[{name, spk, box}], links, carried }.
 *  gk PRIVATE is generated, used to mint every grant, then DISCARDED here (never returned or persisted) — like a
 *  room-invite key at create. `selfGrant` lets the initiator enter immediately without opening their own pointer. */
// `configPatch` (P2 fork-to-accept, docs/enclave-room-acceptance.md §3.3): fields merged over the carried config — accepting
// a new enclave build is a fork with NO member change and a widened `enclave` block. `enclave:true` mints the new epoch
// in the enclave tier; `onMinted(room)` fires BEFORE history is mirrored so the caller can mark the room (routing + the
// seal gate) and the mirror seals to the enclave under the NEW block.
export async function forkRoom(client, oldRoom, oldMk, { self, remove = [], add = [], history = 'full', epochKeys = {}, base, splitMint, configPatch = null, enclave = false, onMinted = null, attest = null } = {}) {
  if (!self || !self.name || !self.spk) throw new Error('forkRoom needs { self: { name, spk } } (the initiator)')
  // 1) roster + the old agent config (to carry the agent's behavior into the fork). A forked room carries its epoch's
  //    admitted roster in the config (authoritative, since membership only changes via a fork); an ORIGINAL room has
  //    none, so bootstrap it from the ledger (P0 spks). Reading the config roster avoids re-admitting a removed member
  //    whose carried history still holds their spk.
  const poll = await readForkHistory(client, oldRoom, oldMk)
  const old = (await client.getConfig(oldRoom, oldMk)) || {}
  const roster = (Array.isArray(old.roster) && old.roster.length)
    ? old.roster.filter((m) => m && m.name && m.spk)
    : deriveRoster(poll.entries || [], old.agentKeys)
  // 2) keepers = roster − removed (+ added), and ALWAYS the initiator (unless explicitly removed)
  const rmNames = new Set(remove.map((r) => (typeof r === 'string' ? r : r && r.name)).filter(Boolean))
  const rmKeys = new Set(remove.map((r) => (r && r.spk ? jkey(r.spk) : '')).filter(Boolean))
  const removed = (m) => rmNames.has(m.name) || rmKeys.has(jkey(m.spk))
  const keepers = roster.filter((m) => !removed(m))
  if (!removed(self) && !keepers.some((k) => jkey(k.spk) === jkey(self.spk))) keepers.push({ name: self.name, spk: self.spk })
  for (const a of add) if (a && a.name && a.spk && !keepers.some((k) => jkey(k.spk) === jkey(a.spk))) keepers.push({ name: a.name, spk: a.spk })
  // 3) fork: a fresh room with the carried config forced to the INVITE gate + a fresh gk (every grant chains to gk₂ →
  //    uniform peer-verification). keyModel is not in the sealed config, so create defaults to a solo (single-mk) room.
  const gk = await genKeypair()
  // stamp the resolved roster (name+spk per keeper) so the NEXT fork reads it authoritatively instead of re-deriving
  // from the ledger (whose carried history would otherwise re-admit a removed member); carry the fork AUTHORITY forward
  // (the old room's, or the initiator when none) so the same authority keeps forking and keepers can verify follows.
  // In LINK mode (P4, epoch-keyed) the fork records a `parent` pointer to the old room instead of re-sealing its ledger:
  // history is read BY REFERENCE up the chain, so a fork is O(1) regardless of ledger size. Full-history keepers receive
  // the ancestor epoch keys in their sealed pointer; a newly-ADDED member (not in the old roster) gets none → they read
  // only from this epoch forward (forward-only), for free.
  const linked = history === 'link'
  const cfg = { ...old, admission: 'invite', revoked: undefined, roster: keepers.map((k) => ({ name: k.name, spk: k.spk })), forkAuthority: old.forkAuthority || self.spk, ...(linked ? { parent: { room: oldRoom } } : { parent: undefined }) , ...(configPatch && typeof configPatch === 'object' ? configPatch : {}) }
  // SPLIT fork: mint the new room as a SPLIT-KEY room (each keeper holds the userShare; the app-half is sealed under K_eco)
  // so the fork PRESERVES the split-key property. splitMint(cfg, gkPub) → { room, mk, userShare, commit, links }.
  cfg.region = roomRegion(oldRoom) // the new room stays in the old one's region (regions.js)
  // AN ATTESTED ROOM MOVES AS ONE (docs/emulated-attested-rooms.md step 5; "rotate on removal"): `attest` = { room, level,
  // accept } from the caller, who marked `room` before anything exists. The new room gets its OWN signed rule (a rule names one
  // room — the old one's is dropped) and the old room's accepted versions; the key goes only to the keepers' sealed pointers.
  if (attest) { delete cfg.ownerPolicy; cfg.room = attest.room; cfg.requireApp = attest.level; if (attest.accept) cfg.attestAccept = attest.accept }
  const minted = splitMint ? await splitMint(cfg, gk.pub) : await client.create(cfg, { ...(base ? { base } : {}), gk: gk.pub, ...(enclave ? { enclave: true } : {}) })
  const room = minted.room, mk = minted.mk, links = minted.links || null
  if (typeof onMinted === 'function') await onMinted(room, cfg)
  const forkUserShare = splitMint ? (minted.userShare || null) : null, forkCommit = splitMint ? (minted.commit || null) : null
  // the ancestor keys a full-history keeper needs to read the whole chain from this room down to the root: the old
  // room's key + whatever ancestors the forker already holds (accumulated across prior forks).
  const chainKeys = linked ? { ...(epochKeys || {}), [oldRoom]: oldMk } : null
  const oldSpks = new Set(roster.map((m) => jkey(m.spk))) // who was already a member → entitled to full history
  // 4) mint a grant per keeper under gk₂, seal a forward pointer to each keeper's EXISTING spk (spk-reuse), then let
  //    gk.priv fall out of scope (never persisted). The initiator's grant is returned for immediate navigation.
  const exp = Math.floor(Date.now() / 1000) + GRANT_TTL_S
  let selfGrant = null
  const pointers = []
  for (const k of keepers) {
    const grant = await mintGrant(gk.priv, { name: String(k.name).slice(0, 24), room, exp, spk: k.spk })
    if (jkey(k.spk) === jkey(self.spk)) selfGrant = grant
    const ek = (linked && oldSpks.has(jkey(k.spk))) ? chainKeys : undefined // existing keeper → full history via chain; added member → forward-only
    const keyF = forkUserShare ? { split: true, userShare: forkUserShare, commit: forkCommit } : { mk } // SPLIT: the pointer carries the userShare (not mk) → the keeper joins split, reconstructing via the tenant app-half
    const plain = JSON.stringify({ v: 1, kind: 'space-fork', from: oldRoom, room, ...keyF, gk: gk.pub, name: k.name, grant, ...(ek ? { epochKeys: ek } : {}) })
    pointers.push({ name: k.name, spk: k.spk, box: await sealTo(plain, bareEC(k.spk)) })
  }
  // 5) carry history: full → the whole decrypted ledger, re-sealed under mk₂ (deduped by id server-side); link → by
  //    reference (parent chain, no re-seal); forward → nothing. Drop prior 'fork' control entries either way — they're
  //    forwarding notices for OTHER epochs, not history, and carrying them would make the poll loop follow a stale fork.
  let carried = 0
  // Data entries ride as DATA (`carry: 'fork'`), so the new room's store holds the same rows (agent/spaceService.mjs
  // sanitizeMirrorEntry); without the marker the server keeps every mirrored entry as a text line.
  const entries = (poll.entries || []).filter((e) => e && e.kind !== 'fork').map((e) => (e.kind === 'data' && Array.isArray(e.ops) ? { ...e, carry: 'fork' } : e))
  if (history === 'full' && entries.length) carried = await mirrorInBatches((r, m, es) => client.mirror(r, m, es), room, mk, entries)
  return { room, mk, gk: gk.pub, selfGrant, keepers, pointers, links, carried, historyTotal: history === 'full' ? entries.length : 0, ...(forkUserShare ? { split: true, userShare: forkUserShare, commit: forkCommit } : {}), ...(linked ? { parent: oldRoom, selfEpochKeys: chainKeys } : {}) }
}

/** Read a room's FULL history across the epoch chain (P4). Reads this room's native ledger, then — if it records a
 *  `parent` and the caller holds that epoch's key — recurses into the parent, oldest-first. A reader missing an ancestor
 *  key simply stops there (forward-only from that epoch). Past epochs are immutable sealed history, so this is a one-shot
 *  read on entry; the live poll loop still handles only the current epoch. `epochKeys` maps room → mk for each ancestor. */
export async function readEpochChain(client, room, mk, epochKeys = {}, depth = 0) {
  const poll = await readForkHistory(client, room, mk)
  const here = ((poll && poll.entries) || []).filter((e) => e && e.kind !== 'fork')
  if (depth >= 64) return here // cycle / runaway guard
  const cfg = await client.getConfig(room, mk).catch(() => null)
  const parent = cfg && cfg.parent && cfg.parent.room
  if (parent && epochKeys && epochKeys[parent]) {
    const older = await readEpochChain(client, parent, epochKeys[parent], epochKeys, depth + 1)
    return [...older, ...here]
  }
  return here
}

/** A keeper opens a sealed fork pointer with their SIGNING private key (spk-reuse: re-imported for ECDH via bareEC).
 *  Returns the payload { room, mk, gk, grant, name, from } addressed to this key, or null (not for this key / tamper). */
export async function openForkPointer(box, signPrivJwk) {
  try {
    const pt = await openBox(box, bareEC(signPrivJwk))
    if (!pt) return null
    const o = JSON.parse(pt)
    return (o && o.kind === 'space-fork' && o.room && (o.mk || (o.split && o.userShare)) && o.grant) ? o : null // accept a SPLIT pointer (userShare instead of mk)
  } catch { return null }
}

/** Publish the sealed forward pointers into the OLD room as a `fork` control entry, so keepers (incl. those offline at
 *  fork time) discover them on their next poll. `identity` = the INITIATOR's { name, sign:{priv}, grant } — the notice
 *  is SIGNED over `text: 'fork:<boxes-hash>'` (binding the exact box set) and carries the grant, so a keeper can verify
 *  it came from the room's fork authority (followFork) rather than an mk-holder forging a fork to a room they control.
 *  The boxes are opaque to non-keepers (a removed member sees a list of unopenable boxes). Reuses the mirror transport. */
export async function postForkPointers(client, oldRoom, oldMk, pointers, identity) {
  if (!identity || !identity.sign || !identity.sign.priv || !identity.grant) throw new Error('postForkPointers needs the initiator identity { name, sign:{priv}, grant }')
  const boxes = (pointers || []).map((p) => p.box).filter(Boolean)
  if (!boxes.length) return { status: 200, added: 0 }
  const ts = Date.now()
  const id = `fork:${ts}`
  const name = String(identity.name || 'someone').slice(0, 24)
  const text = 'fork:' + (await boxesHash(boxes)) // in the SIGNED entry-core → the signature binds the box set
  const { sig } = await signEntry(identity.sign.priv, { room: oldRoom, author: name, ts, kind: 'fork', id, text })
  const entry = { kind: 'fork', id, ts, author: name, from: name, name, text, sig, grant: identity.grant, boxes }
  const r = await client.mirror(oldRoom, oldMk, [entry])
  return { ...r, id } // `id` lets the initiator suppress auto-following their OWN notice
}

/** Decide whether to AUTO-FOLLOW a `fork` control entry, and if so return the pointer addressed to THIS device.
 *  Defenses, in order: (1) the boxes must match the signed hash (integrity); (2) the notice must attribute to a genuine
 *  old-room member via `oldGk` (authenticity); (3) that member's spk must equal the room's `forkAuthority` when one is
 *  set (the hijack gate — only the authority may move the room). Then open the box addressed to `signPrivJwk`. Returns
 *  the pointer { room, mk, gk, grant, name } or null (not a valid/authorized fork, or not addressed to this key).
 *  `now` is epoch SECONDS. A legacy room without a forkAuthority still requires a genuine-member signature when oldGk
 *  is known; an open room (no gk) has an empty roster, so no meaningful fork is produced or followed. */
export async function followFork(entry, signPrivJwk, { oldGk, room, forkAuthority, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!entry || entry.kind !== 'fork' || !Array.isArray(entry.boxes) || !entry.boxes.length) return null
  if (String(entry.text || '') !== 'fork:' + (await boxesHash(entry.boxes))) return null // (1) integrity
  if (oldGk) { // (2) authenticity + (3) authority
    if (!entry.grant || !entry.sig) return null
    const core = { room, author: entry.name, ts: entry.ts, kind: 'fork', id: entry.id, text: entry.text, sig: entry.sig }
    const a = await attribute(core, entry.grant, oldGk, { room, now })
    if (!a.ok) return null
    if (forkAuthority && jkey(a.spk) !== jkey(forkAuthority)) return null
  } else if (forkAuthority) {
    return null // an authority is required but the notice can't be attributed (no gk) → refuse
  }
  for (const box of entry.boxes) {
    const p = await openForkPointer(box, signPrivJwk)
    if (p) return p
  }
  return null
}
