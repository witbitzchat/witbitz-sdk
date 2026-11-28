// spaces/public/enclaveAccept.js — does THIS Space accept the enclave that just attested? (docs/enclave-room-acceptance.md)
//
// The claim in /enclave-claim.json says what the PLATFORM currently runs. A confidential Space carries its own
// mk-sealed `enclave` block saying what IT accepts: `follow` (the platform's pins, but never a policy older than
// the floor) or `pin` (exactly one of the builds its owner verified). This file is the comparison — a pure function
// over (room block, live attestation, platform claim) with no I/O, so the main thread and the mk-kernel worker run
// the SAME decision right where mk is sealed, and it is testable in isolation.
//
// Rules that are easy to get wrong, stated once:
//  • a build is a TRIPLE {kernel, payload, policy}; the room accepts triples, never a cross product of stages;
//  • an absent stage is never a wildcard, in either direction — a monolith pin does not accept a two-stage kernel
//    (which could load ANY payload), and a two-stage pin does not accept a monolith with the same PCR0;
//  • an UNKNOWN policy version is not above the floor;
//  • no attestation ⇒ refused. Nothing here ever accepts by default.

const HEX48 = /^[0-9a-f]{96}$/
const MODES = new Set(['follow', 'pin'])
const STAGES = [['kernel', '0'], ['payload', '16'], ['policy', '17']]

const hex = (v, what) => {
  const h = String(v).toLowerCase()
  if (!HEX48.test(h)) throw new Error(`enclave acceptance: ${what} is not a SHA-384 hex digest`)
  return h
}
const version = (v, what) => {
  if (v === undefined || v === null) return 0
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`enclave acceptance: ${what} must be a non-negative integer`)
  return v
}

/** The {kernel, payload?, policy?} a live attestation (or a claim) measures — only the stages actually present. */
export function tripleOf(att) {
  const p = (att && att.pcrs) || {}
  const t = {}
  for (const [name, idx] of STAGES) if (p[idx]) t[name] = String(p[idx]).toLowerCase()
  return t
}

export const sameTriple = (a, b) => STAGES.every(([name]) => (a[name] || null) === (b[name] || null))

/** Normalise a room's `enclave` block. `null`/`undefined` ⇒ null = a pre-P2 room (follow, no floor). Throws on garbage. */
export function parseAcceptance(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') throw new Error('enclave acceptance: block must be an object')
  if (!MODES.has(raw.mode)) throw new Error(`enclave acceptance: unknown mode ${JSON.stringify(raw.mode)}`)
  const minPolicyVersion = version(raw.minPolicyVersion, 'minPolicyVersion')
  const accepted = Array.isArray(raw.accepted) ? raw.accepted.map((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`enclave acceptance: accepted[${i}] is not an object`)
    const out = { kernel: hex(e.kernel, `accepted[${i}].kernel`) }
    if (e.payload !== undefined && e.payload !== null) out.payload = hex(e.payload, `accepted[${i}].payload`)
    if (e.policy !== undefined && e.policy !== null) out.policy = hex(e.policy, `accepted[${i}].policy`)
    out.policyVersion = version(e.policyVersion, `accepted[${i}].policyVersion`)
    out.label = String(e.label || '').slice(0, 64)
    out.at = typeof e.at === 'number' ? e.at : 0
    return out
  }) : []
  if (raw.mode === 'pin' && !accepted.length) throw new Error('enclave acceptance: a pinned Space that accepts nothing can never seal its key')
  return { mode: raw.mode, minPolicyVersion, accepted }
}

/**
 * The decision. → { ok:true, matched } or { ok:false, reason, live, floor }
 *   reason ∈ no_attestation | no_platform_claim | kernel | payload | policy | floor | not_accepted
 * `cfg` may be null (pre-P2 room ⇒ follow, no floor). `attested` = { pcrs:{0,16?,17?}, policyVersion? } from the LIVE
 * doc; `platform` = the parsed claim { pcrs } (only consulted in follow mode).
 */
export function acceptsMeasurement(cfg, attested, platform) {
  const c = parseAcceptance(cfg) || { mode: 'follow', minPolicyVersion: 0, accepted: [] }
  const live = tripleOf(attested)
  if (!live.kernel) return { ok: false, reason: 'no_attestation', live }
  const pv = attested && typeof attested.policyVersion === 'number' ? attested.policyVersion : null
  if (c.minPolicyVersion > 0 && !(pv !== null && pv >= c.minPolicyVersion)) return { ok: false, reason: 'floor', live, floor: c.minPolicyVersion, policyVersion: pv }
  if (c.mode === 'pin') {
    const matched = c.accepted.find((e) => sameTriple(e, live))
    return matched ? { ok: true, matched, live } : { ok: false, reason: 'not_accepted', live }
  }
  // follow: the platform's current pins, stage by stage — the first differing stage names the reason.
  // ⛔ A STAGE PIN MAY BE A SET (2026-09-29, a builder: `enclave_not_accepted (payload)`). A repin publishes
  // {outgoing, incoming} so the instance still on the old build keeps working while the new one comes up; this used to
  // run tripleOf() over the claim, whose String() turned the list into ONE string "0ad2…,8721…" that no live build can
  // equal — every follow-mode Space was refused for exactly the window a rollover exists to make safe.
  const want = pinSetsOf(platform)
  if (!want.kernel.length) return { ok: false, reason: 'no_platform_claim', live }
  for (const [name] of STAGES) {
    const ok = want[name].length ? want[name].includes(live[name] || '') : !live[name] // no pin for a stage ⇒ the live build must not have one either, as before
    if (!ok) return { ok: false, reason: name, live, platform: want }
  }
  return { ok: true, matched: { ...live }, live }
}

/** The platform claim's pins as a LIST per stage — a single string or a rollover set, lower-cased. */
function pinSetsOf(att) {
  const p = (att && att.pcrs) || {}
  const t = {}
  for (const [name, idx] of STAGES) t[name] = (Array.isArray(p[idx]) ? p[idx] : (p[idx] ? [p[idx]] : [])).map((v) => String(v).toLowerCase())
  return t
}

// ── THE USER'S ACCEPTED BUILDS (the owner, 2026-10-11: "Accept this build should be only from the user perspective. It is
// a per user choice. No fork at all." → "Block until accepted", "Per account (all devices)"). ─────────────────────────
// Which enclave builds a person trusts is THEIR choice, not the room's: their account keeps a list of accepted builds
// (trustedBuilds.js syncs it), and their app seals a confidential room's key only to a build that is (1) published by
// Witbitz (the claim's pins — a build the platform does not publish is never accepted) and (2) on that list. A new
// build blocks this person until they accept it; nothing about the room changes and no other member is affected.
// The room's sealed `enclave` block (above) is no longer written and no longer gates anything.

/** A list of accepted builds → [{ kernel, payload?, policy?, at }] (garbage dropped, never thrown on). */
export function parseTrusted(raw) {
  const out = []
  for (const e of Array.isArray(raw) ? raw : []) {
    try {
      if (!e || typeof e !== 'object') continue
      const t = { kernel: hex(e.kernel, 'kernel') }
      if (e.payload) t.payload = hex(e.payload, 'payload')
      if (e.policy) t.policy = hex(e.policy, 'policy')
      t.at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : 0
      if (!out.some((x) => sameTriple(x, t))) out.push(t)
    } catch { /* an entry this build cannot read is skipped, never trusted */ }
  }
  return out
}

/** Two lists → their union (a build accepted on any device of the account stays accepted). */
export const mergeTrusted = (a, b) => parseTrusted([...parseTrusted(a), ...parseTrusted(b)])

/** The list with the live build added (accepting it). Throws without a verified attestation. */
export function trustBuild(list, attested, at = Date.now()) {
  const t = tripleOf(attested)
  if (!t.kernel) throw new Error('enclave acceptance: accepting a build needs a verified attestation')
  const cur = parseTrusted(list)
  return cur.some((e) => sameTriple(e, t)) ? cur : [...cur, { ...t, at }]
}

/**
 * Does THIS USER accept the live build? → { ok:true, matched, live } or { ok:false, reason, live }
 *   reason ∈ no_attestation | no_platform_claim | kernel | payload | policy (not published by Witbitz)
 *          | unknown (the user's list has not loaded yet) | not_accepted (published, but this user has not accepted it)
 * `trusted` undefined = not loaded yet: refused, never "accepted by default".
 */
export function userVerdict(trusted, attested, platform) {
  const pub = acceptsMeasurement(null, attested, platform) // published by the platform, stage by stage (a rollover's set counts)
  if (!pub.ok) return pub
  if (trusted === undefined) return { ok: false, reason: 'unknown', live: pub.live }
  return parseTrusted(trusted).some((e) => sameTriple(e, pub.live)) ? { ok: true, matched: pub.live, live: pub.live } : { ok: false, reason: 'not_accepted', live: pub.live }
}

/**
 * The seal-time gate — what `mkPub(room)` calls on the main thread AND in the mk-kernel worker, right where mk is about
 * to be sealed to the enclave key. → `key` iff this user accepts the live build; `null` when there is no key yet (the
 * client's own fail-closed "key unavailable" path); otherwise THROWS `enclave_not_accepted` carrying the verdict, so the
 * caller can say what to do (accept the build) instead of a generic "key unavailable".
 */
export function gatedKey({ key, trusted, attested, platform, room } = {}) {
  if (!key) return null
  const verdict = userVerdict(trusted, attested, platform)
  if (verdict.ok) return key
  const err = new Error(`enclave_not_accepted: you have not accepted the enclave build this Space runs on (${verdict.reason})`)
  err.code = 'enclave_not_accepted'; err.verdict = verdict; err.room = room || null
  throw err
}

/** The platform-only gate (the SDK's default, builds: 'published' — sdkBuilds.js): the build must be published by Witbitz. */
export function publishedKey({ key, attested, platform, room } = {}) {
  if (!key) return null
  const verdict = acceptsMeasurement(null, attested, platform)
  if (verdict.ok) return key
  const err = new Error(`enclave_not_accepted: the enclave that attested is not a build Witbitz publishes (${verdict.reason})`)
  err.code = 'enclave_not_accepted'; err.verdict = verdict; err.room = room || null
  throw err
}

// ---- tools OUTSIDE the enclave (P3 phase 2, docs/enclave-two-stage-launch.md) --------------------------------------
// A tool the turn calls out to (read_file → Tinfoil's document enclave) is DECLARED in the measured policy's env —
// `TOOL_<NAME>=<root>:<repo>@<host><path>` — so it is under PCR17 like every other statement the enclave is held to:
// a `pin` Space refuses a build whose declaration changed (different policy digest), a `follow` Space shows it on
// /trust, and the payload REFUSES to call an endpoint the policy does not name. `root` is the trust anchor the
// payload verifies the endpoint against before any byte leaves (only `tinfoil` today: AMD SEV-SNP + Sigstore
// provenance of `repo`). Hosts are lower-case, portless — exactly what the egress allowlist matches on.
//
// Two roots: `tinfoil:<owner/repo>@host/path` (AMD SEV-SNP + Sigstore provenance of `repo`) and, for Witbitz's own
// KEYLESS tools enclave (write_pdf, fetch_url — docs/enclave-two-stage-launch.md), `nitro:<pcr0>/<n>.<pcrN>@host/path`:
// the AWS Nitro image (PCR0, 96 hex) AND the one tool blob the bytes go to (PCR<n>, locked at boot from the blob's
// digest — n ≥ 18, one register per tool). The payload fetches a fresh-nonce attestation, checks BOTH registers
// against the AWS root, and pins the TLS session to the key the document carries. Naming the tool's register rather
// than the manifest's means a rebuilt write_pdf blob does not change what a fetch_url Space is pinned to.
const TOOL_ROOTS = new Set(['tinfoil', 'nitro'])
const TOOL_DECL = /^([a-z][a-z0-9-]*):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(\/[A-Za-z0-9_./-]*)$/
const NITRO_REPO = /^([0-9a-f]{96})\/(1[89]|2[0-9]|3[01])\.([0-9a-f]{96})$/ // <pcr0>/<n>.<pcrN>, n in 18..31 (0-17 are the image's own)

/** `tinfoil:owner/repo@host/path` → { root, repo, host, path }; `nitro:<pcr0>/<n>.<pcrN>@host/path` → the same plus
 *  { pcr0, pcrIndex, pcrDigest }; null for anything the payload must not act on. */
/** A TOOLS-ENCLAVE ROLLOVER (docs/reproducible-enclave.md, 2026-11-07): one TOOL_* may name SEVERAL builds of one nitro tool,
 *  space-separated — the same host and path, each its own PCR0 + register — so the turn accepts whichever of them serves while
 *  the tools box moves to a new image (the old one until it is gone, the new one from its first answer). → [decl, …]: one for
 *  an ordinary value; [] when any part does not parse, roots are mixed, or the builds name different hosts or paths.
 *  ⚑ An app or SDK released before this reads a several-build value as one it cannot parse (trustRoom: "undeclarable"): a
 *  rollover is short and is narrowed back to one build. */
export function parseToolDecls(s) {
  const parts = String(s || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) { const d = parseToolDecl(parts[0] || ''); return d ? [d] : [] }
  const ds = parts.map((p) => parseToolDecl(p))
  if (ds.some((d) => !d || d.root !== 'nitro')) return []
  if (new Set(ds.map((d) => d.host + d.path)).size !== 1) return []
  return ds
}
export function parseToolDecl(s) {
  const m = TOOL_DECL.exec(String(s || '').trim())
  if (!m || !TOOL_ROOTS.has(m[1])) return null
  const d = { root: m[1], repo: m[2], host: m[3], path: m[4] }
  if (d.root !== 'nitro') return d
  const n = NITRO_REPO.exec(d.repo)
  if (!n) return null
  return { ...d, pcr0: n[1], pcrIndex: Number(n[2]), pcrDigest: n[3] }
}
