// M3 — Configurable Space: build a Space from a CONFIG (docs/configurable-space-m3.md). Generalizes the shared-presence
// KEY MODEL — 1-of-1 (solo) / 2-of-2 (couple) / k-of-n (team) — so ONE engine serves any small private AI Space, not
// just couples. The config is to a Space what the manifest is to an agent: { keyModel, agent(persona), tools,
// presence }. This module handles the KEY part (mint + distribute + reassemble); the agent/tools/presence are config
// fields the engine (spaceService) reads. A Space's capabilities are just TOOLS (declaredTools) — already config, no
// separate "actions" concept; the only async-Space addition is delegatedAuthority (approve-then-execute + audit).
import { newKey, splitKey, combineShares, commit } from './e2ee.js'
import { shamirSplit, shamirCombine } from './shamir.js'
import { newRoomId } from './regions.js'

const enc = (s) => encodeURIComponent(String(s))

/** Normalize a keyModel → { k, n }. '1-of-1' → {1,1} (solo); '2-of-2' → {2,2} (couple); { k, n } → a k-of-n team. */
export function normalizeKeyModel(km) {
  if (km == null || km === '1-of-1') return { k: 1, n: 1 }
  if (km === '2-of-2') return { k: 2, n: 2 }
  if (km && Number.isInteger(km.k) && Number.isInteger(km.n) && km.k >= 1 && km.k <= km.n) return { k: km.k, n: km.n }
  throw new Error('bad keyModel')
}

/** Build a Space from a config. Mints mk, distributes it per the key model, returns { room, commit, keyModel:{k,n},
 *  links[] }. Each link carries the room (query, server-visible) + ONE piece in the FRAGMENT — a share (`#s=`), or, for
 *  1-of-1, mk itself (`#mk=`). mk is DISCARDED (reconstructable from the shares); the server stores only commit(mk). */
export async function createConfiguredSpace(config = {}, { base = '' } = {}) {
  const { k, n } = normalizeKeyModel(config.keyModel)
  // A SOLO room may be made with a key the caller derived (the SDK's account index, sdkAccount.js: every device holding
  // the account derives the same room and key, so two devices can never make two indexes). Any other model mints.
  const mk = (n === 1 && typeof config.mk === 'string' && config.mk.length >= 40) ? config.mk : newKey()
  // `region`: the room's HOME region (regions.js, docs/multi-region.md) — the caller decides: a lane takes its shared room's,
  // a moved room keeps its own, a new Space takes its creator's; the account's own rooms (index, pipes) pass none and stay
  // in the default region. Never sealed into the config — it is in the id.
  const room = config.room || newRoomId(config.region)
  const c = await commit(mk)
  const link = (frag) => `${String(base).replace(/\/+$/, '')}/space?room=${enc(room)}#${frag}`
  let links
  if (n === 1) {
    links = [link(`mk=${enc(mk)}`)] // solo: the single member's link carries mk (like the gift today)
  } else if (k === 2 && n === 2) {
    const { shareA, shareB } = splitKey(mk) // couple: XOR 2-of-2 (the simplest, perfect case)
    links = [link(`s=${enc(shareA)}`), link(`s=${enc(shareB)}`)]
  } else {
    links = shamirSplit(mk, k, n).map((s) => link(`s=${enc(s)}`)) // team: Shamir k-of-n
  }
  return { room, commit: c, keyModel: { k, n }, links }
}

/** Assemble the room key from the present members' pieces, per the config's key model, verified against the commitment.
 *  `pieces` = the shares from present members (or [mk] for solo). Returns mk, or null if the threshold isn't met / the
 *  reconstruction doesn't match the commit (the room stays sealed). */
export async function assembleConfiguredKey(pieces, config, expectedCommit) {
  const { k, n } = normalizeKeyModel(config && config.keyModel)
  const arr = Array.isArray(pieces) ? pieces.filter(Boolean) : pieces ? [pieces] : []
  let mk = null
  if (n === 1) mk = arr[0] || null // solo: the piece IS mk
  else if (k === 2 && n === 2) mk = arr.length >= 2 ? combineShares(arr[0], arr[1]) : null
  else mk = arr.length >= k ? shamirCombine(arr) : null // team: need ≥ k
  if (mk == null) return null
  // §6.4 (tenant-split-key-design.md): a MULTI-SHARE reconstruction (n > 1: couple/team) is only trustworthy once checked
  // against the room's registered commitment. Refuse to return a combined key with no commit to verify it — the solo case
  // (n === 1: the link IS mk) is exempt, since a wrong link simply fails AES-GCM downstream, not a silent wrong-key.
  if (n > 1 && !expectedCommit) return null
  if (expectedCommit && (await commit(mk)) !== expectedCommit) return null
  return mk
}

/** Read a Space link → { room, share?, mk? } (room from the query; share/mk from the fragment). */
export function parseConfiguredLink(url) {
  try {
    const u = new URL(url)
    // The fragment is `<space-params>?<identity-params>` — a member link appends `?gk=…&gt=…&sk=…` (see entrySig
    // appendIdentity) after `#mk=…`/`#s=…`. Parse ONLY the part before that first `?`, or `mk`/`s` would swallow the
    // whole identity blob (`mk=<key>?gk=…`) and fail to base64-decode → the invite lands on the create screen. Identity
    // is read separately (readIdentity, from after the `?`).
    const raw = (u.hash || '').replace(/^#/, '')
    const q = raw.indexOf('?')
    const frag = new URLSearchParams(q >= 0 ? raw.slice(0, q) : raw)
    return { room: u.searchParams.get('room') || '', share: frag.get('s') || '', mk: frag.get('mk') || '' }
  } catch {
    return { room: '', share: '', mk: '' }
  }
}
