// splitKeyClient.js — the CLIENT half of the tenant split-key model (docs/tenant-split-key-design.md).
//
// mk = userShare ⊕ appShare. The user's kernel keeps `userShare` (a normal keyring entry — custody/recovery unchanged,
// §5.1); an allowlisted ORIGIN serves `appShare` (unsealed from the platform's opaque blob with the ecosystem key
// K_eco); this module COMBINES the two and verifies commit(mk) before trusting it (§6.4 — refuse a crafted appShare).
//
// It holds NO secrets: the tenant-authed transport (`tenantPost`) and the origin's K_eco custody (`origin.privateJwk`)
// are INJECTED, so the same code runs in a Node test, a browser page, or a tenant backend. In production `tenantPost`
// reaches /tenant-space (the tenant key → the /v1 authorizer → the §4b gate); K_eco lives with the tenant/origin, never
// the platform. Pure composition over e2ee.js primitives — no new crypto.
import { newKey, splitKey, combineShares, commit, seal, open, sealTo, openBox } from './e2ee.js'

/** wrap(K_eco, origin.pub) for each allowed origin → the ecoWraps map (the CRYPTO allowlist). Each is an opaque box only
 *  that origin's private key opens; the platform stores them and can open none. `originPubs` = { originId: publicJwk }. */
export async function wrapKEco(K_eco, originPubs = {}) {
  const wraps = {}
  for (const id of Object.keys(originPubs)) wraps[id] = JSON.stringify(await sealTo(K_eco, originPubs[id]))
  return wraps
}

/** CREATE a split-key room: mint mk → split → seal appShare under K_eco → tenant `create` (authed transport injected).
 *  Returns { room, mk, userShare, commit }. The caller persists `userShare` on the user keyring; the tenant keeps K_eco.
 *  `extra` folds in the normal create fields (configSealed, gk, …). `originPubs` seeds the per-origin K_eco wraps. */
export async function createSplitRoom({ room, mk, K_eco, originPubs = {}, extra = {}, tenantPost }) {
  if (!K_eco) throw new Error('createSplitRoom needs K_eco')
  if (typeof tenantPost !== 'function') throw new Error('createSplitRoom needs an authed tenantPost')
  mk = mk || newKey()
  const c = await commit(mk)
  const { shareA: userShare, shareB: appShare } = splitKey(mk)
  const appShareSealed = JSON.stringify(await seal(appShare, { eco: K_eco }))
  const ecoWraps = await wrapKEco(K_eco, originPubs)
  const r = await tenantPost('create', { room, commit: c, appShareSealed, ecoWraps, ...extra })
  if (!r || r.status !== 200) throw new Error('createSplitRoom failed: ' + (r && (r.error || r.status)))
  return { room, mk, userShare, commit: c }
}

/** CREATE a split-key room in the L1-vault model: the client mints mk + splits, keeps `userShare`, and hands the RAW
 *  `appShare` to the tenant BACKEND (which seals it under K_eco + creates the room — the client never holds K_eco).
 *  `tenantPost('create', {room, commit, appShare, configSealed?})` → `/api/appshare {op:'create'}`. Returns
 *  { room, mk, userShare, commit }; the caller persists `userShare` (space:us:) + `commit` (space:spc:), NEVER `mk`. */
export async function createSplitViaBackend({ room, mk, config, gk, roomKind, split = true, gated, tenantPost, delCommit, owner = null }) { // owner: { ownerPolicy, roomAuth, attestAccept? } — a room that requires an app (space.js createSplitLocal)
  if (!room) throw new Error('createSplitViaBackend needs a room id')
  if (typeof tenantPost !== 'function') throw new Error('createSplitViaBackend needs an authed tenantPost')
  mk = mk || newKey()
  const c = await commit(mk)
  const extra = config ? { configSealed: JSON.stringify(await seal(JSON.stringify(config), { room: mk })) } : {}
  // `roomKind` (clear) is stamped by the tenant for inventory; `split` chooses the key model — split-key rooms carry the
  // appShare (cross-tenant-isolated, sealed under K_eco by the backend), a PLAIN tenant room omits it (attributed, not split).
  // `gated` (clear) is the email-admission marker: the admission + allow-list ride SEALED in the config (the platform can't
  // read who's allowed), but the server needs this cleartext flag to refuse the KEYLESS reads (pollsealed/blob) of a gated room.
  const body = { room, commit: c, ...extra, ...(gk ? { gk } : {}), ...(roomKind ? { roomKind } : {}), ...(gated ? { gated: true } : {}), ...(delCommit ? { delCommit } : {}), ...(owner && owner.ownerPolicy && owner.roomAuth ? { ownerPolicy: owner.ownerPolicy, roomAuth: owner.roomAuth, ...(owner.attestAccept ? { attestAccept: owner.attestAccept } : {}) } : {}) } // gk: the room invite PUBLIC key, so per-member turns are attribution-verifiable (a membership fork mints a fresh gk)
  let userShare
  if (split) { const s = splitKey(mk); userShare = s.shareA; body.appShare = s.shareB }
  const r = await tenantPost('create', body)
  if (!r || r.status !== 200) throw new Error('createSplitViaBackend failed: ' + (r && (r.error || r.status)))
  return { room, mk, commit: c, ...(split ? { userShare } : {}), ...(extra.configSealed ? { configSealed: extra.configSealed } : {}) } // configSealed surfaced so an ENCLAVE room can also seal it into the ENCLAVE's own record (the tenant copy isn't what the enclave turn reads)
}

/** RECONSTRUCT mk from the user's `userShare` (held by the L1 vault) + an ALREADY-UNWRAPPED `appShare` (served by the
 *  tenant/origin, which did the K_eco unwrap — the vault never holds K_eco, or it could reconstruct mk alone). Verifies
 *  commit(mk) (§6.4). Returns mk, or null (fail-closed). This is the vault-side half of the combine; the tenant-side half
 *  (fetch appShareSealed → unwrap with K_eco → appShare) lives in the tenant backend. */
export async function reconstructMk({ userShare, appShare, expectedCommit }) {
  if (!userShare || !appShare) return null
  const mk = combineShares(userShare, appShare)
  if (!mk) return null
  if (expectedCommit && (await commit(mk)) !== expectedCommit) return null // never trust an unverified combine
  return mk
}

/** OPEN a split-key room. The `origin` (holding a K_eco wrap) unwraps K_eco → appShare; combine with the user's
 *  `userShare` → mk; verify commit(mk) against the room's registered commitment (§6.4). `origin` = { id, privateJwk }.
 *  Returns { room, mk } on success, or { room, mk:null, error } — a null mk is always fail-closed (never a wrong key). */
export async function openSplitRoom({ room, userShare, origin, tenantPost }) {
  if (typeof tenantPost !== 'function') throw new Error('openSplitRoom needs an authed tenantPost')
  const r = await tenantPost('appshare-get', { room })
  if (!r || r.status !== 200) return { room, mk: null, error: (r && (r.error || r.status)) || 'appshare_get_failed' }
  const wrap = r.ecoWraps && r.ecoWraps[origin && origin.id]
  if (!wrap) return { room, mk: null, error: 'no_wrap_for_origin' }
  let K_eco
  try { K_eco = await openBox(JSON.parse(wrap), origin.privateJwk) } catch { K_eco = null }
  if (!K_eco) return { room, mk: null, error: 'unwrap_failed' } // this origin's wrap is gone/invalid → dead (migration)
  let appShare
  try { appShare = await open(JSON.parse(r.appShareSealed), { mk: K_eco }) } catch { appShare = null }
  if (!appShare) return { room, mk: null, error: 'appshare_undecodable' }
  const mk = combineShares(userShare, appShare)
  if (!mk) return { room, mk: null, error: 'combine_failed' }
  if ((await commit(mk)) !== r.commit) return { room, mk: null, error: 'commit_mismatch' } // §6.4 — never trust an unverified combine
  return { room, mk }
}
