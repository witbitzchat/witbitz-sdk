// spaces/public/enclaveClaim.js — check a running enclave against what we published about it.
//
// The attestation verifier (nitroVerify.js) answers "is this a genuine AWS enclave, and what does it measure?".
// It cannot answer "is it the enclave Witbitz said it would be" — that needs something published in advance to
// compare against. That something is the `enclave` block of /cert.json, and this file is the comparison.
//
// ★ THE POINT OF PUBLISHING THE SIGNING CERTIFICATE. A cert.json that just asserts `pcr8: "abc…"` is a number you
// have to take on faith. Publishing the signing CERTIFICATE instead means you derive that number yourself and check
// ours against it — so a Witbitz that lied about PCR8 is caught by arithmetic rather than by trust. `verifyClaim`
// recomputes it and refuses a claim whose stated PCR8 doesn't match its own certificate.
//
// PCR0/1/2 have no such shortcut: they come from rebuilding the image (see docs/reproducible-enclave.md, and
// infra/enclave/build-eif.sh which reproduces them). PCR8 is the one measurement checkable from a published artifact
// alone, which is exactly why it is worth having even once PCR0 is reproducible.

import { MAX_PIN_SET, acceptedSet, toHex, verifyAttestation } from './nitroVerify.js'

const b64ToBytes = (b64) => {
  const bin = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Accept a certificate as DER bytes or a PEM string. */
function certToDer(cert) {
  if (cert instanceof Uint8Array) return cert
  if (cert instanceof ArrayBuffer) return new Uint8Array(cert)
  const s = String(cert || '')
  const m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(s)
  const body = m ? m[1] : s
  const der = b64ToBytes(body)
  if (der.length < 64) throw new Error('enclave: certificate is too short to be real')
  return der
}

/**
 * A PCR is a TPM-style register: it starts at zero and is "extended" with a measurement. nitro-cli builds each one
 * with a single extend of a single blob, which reduces to this:
 *
 *     PCR = SHA384( 48 zero bytes ‖ SHA384(measured bytes) )
 *
 * (from aws-nitro-enclaves-image-format, `EifHasher::tpm_extend_finalize_reset`: hash the accumulated data, then
 * hash `initial_digest ‖ that`.)
 */
export async function tpmExtendOnce(bytes) {
  const inner = new Uint8Array(await crypto.subtle.digest('SHA-384', bytes))
  const buf = new Uint8Array(48 + inner.length) // initial digest is 48 zero bytes for SHA-384
  buf.set(inner, 48)
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-384', buf)))
}

/**
 * The PCR8 an enclave signed with this certificate must report.
 *
 * ⚠ DERIVED FROM AWS'S SOURCE, NOT YET CONFIRMED AGAINST REAL HARDWARE. `nitro-cli build-enclave --signing-certificate`
 * measures the DER of that certificate; AWS's own documentation instead calls PCR8 "the SHA384 hash of the signing
 * certificate's fingerprint", which does NOT match the code and has confused others (aws-nitro-enclaves-cli#446).
 * We follow the code. Until an EIF is actually signed, treat this as unverified: `infra/enclave/build-eif.sh`
 * compares this function's output to what nitro-cli reports and FAILS the build on a mismatch, so the first real
 * signed build is the thing that confirms it — loudly, rather than by a wrong constant sitting in cert.json.
 */
export async function expectedPcr8(cert) {
  return tpmExtendOnce(certToDer(cert))
}

const HEX48 = /^[0-9a-f]{96}$/

/** Pull the `enclave` block out of a parsed cert.json payload, rejecting anything malformed. Returns null when the
 *  deployment simply has no attested tier — which is not an error, and must never be reported as a failed check. */
export function enclaveClaim(payload) {
  const e = payload && typeof payload === 'object' ? payload.enclave : null
  if (!e || typeof e !== 'object') return null
  const pcrs = {}
  for (const k of ['0', '1', '2', '8', '16', '17']) {
    const v = e.pcrs && e.pcrs[k]
    if (v === undefined) continue
    // §ROLLOVER-SET: a claim may pin {outgoing, incoming} so the PUBLISHED claim keeps verifying both images while a
    // new payload rolls out. Same capped grammar as the verifier; every member is still a real digest.
    const list = acceptedSet(v, `PCR${k}`)
    for (const h of list) if (!HEX48.test(h)) throw new Error(`enclave: PCR${k} in cert.json is not a SHA-384 hex digest`)
    pcrs[k] = Array.isArray(v) ? list : list[0]
  }
  if (!Object.keys(pcrs).length) throw new Error('enclave: the claim names no PCRs, so it constrains nothing')
  if (!pcrs['0']) throw new Error('enclave: a claim without PCR0 does not pin the image')
  const stages = enclaveStages(e.stages, pcrs)
  return { pcrs, stages, signingCert: e.signingCert || null, recipe: e.recipe || '', moduleId: e.moduleId || '', payload: artifactBlock(e.payload, 'payload'), policy: artifactBlock(e.policy, 'policy') }
}

/**
 * P2 (docs/enclave-room-acceptance.md): the claim may also NAME the two loaded artifacts — `payload: {sha384, source}`
 * and `policy: {sha384, version, url}` — so a reader can fetch the turn code / the policy text and check them against
 * the PCR16/PCR17 the live enclave reports (checkPolicyText). Optional; validated when present. `version` is the
 * policy's monotonic release number, the thing a Space's floor is compared to.
 */
function artifactBlock(b, name) {
  if (b === undefined || b === null) return null
  // A SET, for the same reason `pcrs` takes one: across a repin the live enclave may be running EITHER artifact, and
  // each entry carries its OWN url so both policy texts can be served at once. An array in ⇒ an array out; a bare
  // object still reads back as an object, so every claim written before this keeps its exact shape.
  if (Array.isArray(b)) {
    if (!b.length) throw new Error(`enclave: ${name} names an empty set — that is not a check`)
    if (b.length > MAX_PIN_SET) throw new Error(`enclave: ${name} names ${b.length} artifacts; at most ${MAX_PIN_SET} (a rollover is {outgoing, incoming})`)
    return b.map((one) => oneArtifact(one, name))
  }
  return oneArtifact(b, name)
}

/** Validate ONE artifact entry — the shape this file has always required. */
function oneArtifact(b, name) {
  if (!b || typeof b !== 'object') throw new Error(`enclave: ${name} must be an object`)
  const sha384 = String(b.sha384 || '').toLowerCase()
  if (!HEX48.test(sha384)) throw new Error(`enclave: ${name}.sha384 is not a SHA-384 hex digest`)
  const out = { sha384 }
  if (name === 'payload') {
    if (b.source !== undefined && typeof b.source !== 'string') throw new Error('enclave: payload.source must be a URL string')
    out.source = b.source || ''
  } else {
    if (!Number.isInteger(b.version) || b.version < 0) throw new Error('enclave: policy.version must be a non-negative integer')
    if (b.url !== undefined && typeof b.url !== 'string') throw new Error('enclave: policy.url must be a URL string')
    out.version = b.version
    out.url = b.url || ''
  }
  return out
}

/** The artifact block as a LIST, whichever shape the claim used. One place decides that, so no caller has to. */
export function artifactList(a) {
  return a == null ? [] : (Array.isArray(a) ? a : [a])
}

/** Pick the artifact the HARDWARE says is loaded: the entry whose sha384 extends to the LIVE PCR. Returns null when
 *  none matches — which is the honest answer, not a reason to fall back to entry 0.
 *
 *  ★ THIS IS THE POINT OF THE SET. Before it, the reader fetched `policy.url` — the single declared URL — and then
 *  checked the text against the live PCR17. Across a repin that check could only ever pass for ONE of the two live
 *  payloads, so the policy could not roll over and the flip needed a window in which the served text was wrong for
 *  whatever was actually running. Selecting by the live PCR first inverts it: the hardware names the artifact, and
 *  only then do we go and fetch it. */
export async function pickArtifact(a, livePcrHex) {
  const want = String(livePcrHex || '').toLowerCase()
  if (!want) return null
  for (const one of artifactList(a)) {
    if (one && one.sha384 && (await extendOfDigest(one.sha384)) === want) return one
  }
  return null
}

const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)))

/** The PCR a single extend of a blob with THIS sha384 yields — the same arithmetic as tpmExtendOnce, from the digest. */
async function extendOfDigest(sha384hex) {
  const buf = new Uint8Array(96)
  buf.set(hexToBytes(sha384hex), 48)
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-384', buf)))
}

/**
 * Believe a fetched policy.json ONLY if it measures to the PCR17 the LIVE enclave reported. This is how the client
 * renders "policy v3, egress: …" from text served by the origin without trusting the origin's prose: the number the
 * hardware signed decides which text is real. → the parsed policy { version, egress, … }.
 */
export async function checkPolicyText(bytes, livePcr17) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const got = await tpmExtendOnce(u8)
  if (!livePcr17 || got !== String(livePcr17).toLowerCase()) throw new Error(`enclave: the policy text does not measure to the live PCR17 (${got.slice(0, 12)}… vs ${String(livePcr17 || '').slice(0, 12)}…)`)
  let p
  try { p = JSON.parse(new TextDecoder().decode(u8)) } catch { throw new Error('enclave: policy text is not JSON') }
  if (!p || typeof p !== 'object' || !Number.isInteger(p.version) || p.version < 0) throw new Error('enclave: policy.version must be a non-negative integer')
  return { ...p, egress: Array.isArray(p.egress) ? p.egress.map(String) : [] }
}

/**
 * Two-stage measured launch (docs/enclave-two-stage-launch.md): PCR0 pins only the KERNEL image; the turn code the
 * kernel loads at boot is measured into PCR16 and its policy.json into PCR17. A claim that DECLARES `stages` promises
 * the reader that both were checked — so declaring it without pinning both is refused, otherwise a kernel-only pin
 * would read as a full check. The indices are fixed (16/17 are what the loader extends) and stated in the claim only
 * so a reader can see them without reading the loader.
 */
function enclaveStages(st, pcrs) {
  if (st === undefined || st === null) return null
  if (typeof st !== 'object') throw new Error('enclave: stages must be an object')
  if (st.payload !== 16) throw new Error('enclave: stages.payload must be 16 (the PCR the loader extends with the turn payload)')
  if (st.policy !== 17) throw new Error('enclave: stages.policy must be 17 (the PCR the loader extends with policy.json)')
  if (!pcrs['16']) throw new Error('enclave: the claim declares a payload stage but pins no PCR16 — the turn code would go unchecked')
  if (!pcrs['17']) throw new Error('enclave: the claim declares a policy stage but pins no PCR17 — the policy would go unchecked')
  return { payload: 16, policy: 17 }
}

/**
 * Verify an attestation document against a published claim.
 * → { ok, doc, checked: {...} } or throws with the reason.
 *
 * `nonce` is strongly recommended: without it this proves the enclave we described existed, not that it is the one
 * on the other end of this connection. The caller decides, but the honest panel should never present a nonce-less
 * result as "you are talking to the attested enclave".
 */
export async function verifyClaim(cose, payload, { now = Date.now(), nonce = null, maxAgeMs = 0, root, atDocTime = false, clockBoundMs = 0 } = {}) {
  const claim = enclaveClaim(payload)
  if (!claim) throw new Error('enclave: cert.json makes no enclave claim')

  // Recompute PCR8 from the published certificate BEFORE trusting the number next to it. If they disagree, the
  // published document is internally inconsistent and nothing downstream of it means anything.
  let derived = null
  if (claim.signingCert) {
    derived = await expectedPcr8(claim.signingCert)
    if (claim.pcrs['8'] && !acceptedSet(claim.pcrs['8'], 'PCR8').includes(derived)) {
      throw new Error(`enclave: cert.json states PCR8 ${[claim.pcrs['8']].flat().join(' or ')} but its own signing certificate yields ${derived}`)
    }
  }
  // Prefer the DERIVED value: it is the one the reader can reproduce.
  const expectedPCRs = { ...claim.pcrs, ...(derived ? { 8: derived } : {}) }
  // Same discipline for the named artifacts: a policy/payload digest that does not extend to the PCR pinned next to
  // it makes the claim internally inconsistent — refuse before the wire is consulted.
  for (const [name, idx] of [['policy', '17'], ['payload', '16']]) {
    const a = claim[name]
    if (!a || !claim.pcrs[idx]) continue
    const pinned = acceptedSet(claim.pcrs[idx], `PCR${idx}`)
    // EVERY entry, not just the first: a rollover that names an artifact nothing pins is a claim nobody can satisfy.
    for (const one of artifactList(a)) {
      const ext = await extendOfDigest(one.sha384)
      if (!pinned.includes(ext)) throw new Error(`enclave: the claim's ${name} sha384 ${one.sha384.slice(0, 12)}… yields PCR${idx} ${ext.slice(0, 12)}…, not the ${pinned.map((h) => h.slice(0, 12) + '…').join(' or ')} it pins`)
    }
  }

  const doc = await verifyAttestation(cose, { now, nonce, maxAgeMs, expectedPCRs, ...(root ? { root } : {}), ...(atDocTime ? { atDocTime, clockBoundMs } : {}) })
  if (claim.moduleId && doc.moduleId !== claim.moduleId) {
    throw new Error(`enclave: module ${doc.moduleId} is not the ${claim.moduleId} named in cert.json`)
  }
  return {
    ok: true,
    doc,
    checked: {
      pcrs: Object.keys(expectedPCRs).map(Number).sort((a, b) => a - b),
      pcr8Derived: !!derived,
      stages: claim.stages,
      fresh: !!nonce,
      policyDigest: !!(claim.policy && claim.pcrs['17']),
    },
  }
}
