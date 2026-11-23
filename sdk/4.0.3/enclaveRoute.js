// spaces/public/enclaveRoute.js — the CLIENT half of the enclave tier.
//
// For an enclave-tier Space, the turn runs inside a Nitro enclave, reached via the relaying Lambda. To make that
// operator-blind at INGRESS (the Lambda must never see mk), the client:
//   1. fetches the enclave's hardware attestation (op:'enclaveattest', relayed to the enclave),
//   2. VERIFIES + PINS it against the published measurement (verifyClaim: genuine AWS enclave, expected PCR0/PCR8, a
//      fresh nonce so it's THIS enclave now — not a replay), and
//   3. seals mk to the recipient key carried INSIDE the verified attestation, so only the measured image can open it.
// The Lambda then relays opaque bytes. Fail-closed: any verification failure throws and no mk is sent.
import { verifyClaim, checkPolicyText, enclaveClaim, pickArtifact } from './enclaveClaim.js'
import { sealMk, sealIdentity, mkAad, newNonce, sealNow, clockOffset, noteServerClock, MAX_CLOCK_OFFSET_MS } from './mkseal.js'

const b64uToBytes = (s) => {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, ''))
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

// The enclave attests its recipient public key as an SPKI (the P-256 ECDH key mk is sealed to). Import it as the JWK
// sealMk wants. Comes from the VERIFIED attestation doc, never a side channel.
async function spkiToJwk(spki) {
  const der = spki instanceof Uint8Array ? spki : b64uToBytes(spki)
  const key = await crypto.subtle.importKey('spki', der, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
  return crypto.subtle.exportKey('jwk', key)
}

/**
 * Verify a running enclave and return its attested recipient key (as a JWK) to seal mk to.
 * @param send  a function that POSTs a Space op and resolves the JSON — the SAME transport the ops use, so
 *              op:'enclaveattest' is relayed to the enclave. Must carry `enclave:true`.
 * @param claim the published enclave claim to pin against — a cert.json payload with an `.enclave` block
 *              ({ enclave: { pcrs:{0,…}, signingCert } }). Throws if the live enclave doesn't match.
 * @param root  optional pinned AWS Nitro root override (tests).
 * @param fetchPolicy  (url) → policy.json bytes; defaults to fetch(). Only consulted when the claim names a policy
 *              URL and the live doc reports PCR17. The text is believed ONLY if it measures to the LIVE PCR17.
 * → { recipientJwk, doc, attested }  where attested = { pcrs:{0,16?,17?}, policyVersion|null, policy|null, at } —
 *   the facts the Space's own acceptance check (enclaveAccept.js) decides on. A fetch that fails leaves the version
 *   UNKNOWN (a Space with a floor then refuses); a text that measures wrong REFUSES the whole attest.
 */
export async function attestEnclave({ send, claim, root, now, fetchPolicy, room } = {}) {
  // The enclave supervisor decodes the challenge with STANDARD base64 (infra/enclave/app/main.go base64.StdEncoding), so
  // the nonce MUST be standard base64 — a base64URL nonce whose random bytes happen to contain '-' or '_' mis-decodes
  // there, the NSM binds a different challenge, and the freshness check fails ~half the time. Send raw bytes as standard
  // base64; verify against those same bytes.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16))
  const nonce = btoa(String.fromCharCode(...nonceBytes)) // standard base64 (may contain '+', '/', '=')
  // `room`: the room this key will seal for. A room lives in ONE region (regions.js) and its enclave is that region's, so
  // the request names it and api.witbitz.chat forwards it there (agent/regionForward.mjs). Without it the answer is the
  // enclave of whichever region was asked — whose key the room's own enclave cannot open (docs/multi-region.md).
  const r = await send({ op: 'enclaveattest', enclave: true, nonce, ...(room ? { room } : {}) })
  const cose = r && r.doc
  if (!cose) throw new Error('enclave: no attestation document returned')
  // op:'enclaveattest' returns the COSE doc base64-encoded; verifyClaim/verifyAttestation want raw bytes.
  // T#2b (state machines pass 7): the chain is checked at the document's own time — it is fresh, it carries our nonce — so a
  // device clock that is off no longer refuses a genuine enclave; the device clock (with the offset already learned) must be
  // within a day of the enclave's, else the check fails naming the clock. The document's time then sets the seal clock
  // (mkseal.js): signed by the Nitro hardware and bound to our nonce, it is the enclave's own clock, not the relay's word.
  const { doc } = await verifyClaim(b64uToBytes(cose), claim, { nonce: nonceBytes, ...(root ? { root } : {}), now: now || (Date.now() + clockOffset()), atDocTime: true, clockBoundMs: MAX_CLOCK_OFFSET_MS })
  if (!now && Number.isFinite(doc.timestamp)) noteServerClock(doc.timestamp)
  if (!doc.publicKey) throw new Error('enclave: attestation carries no recipient key')
  const attested = await attestedFacts(doc, claim, fetchPolicy)
  return { recipientJwk: await spkiToJwk(doc.publicKey), doc, attested }
}

const defaultFetchPolicy = async (url) => {
  const r = await fetch(url, { cache: 'no-store', ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(10000) } : {}) }) // network-only, like the claim: a cached policy text is a stale one; BOUNDED — a server that holds the request open must not hang the attestation (2026-09-29)
  if (!r.ok) throw new Error(`enclave: policy text ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

/** The live triple + the policy version proven by the policy text (docs/enclave-room-acceptance.md §5). */
async function attestedFacts(doc, claim, fetchPolicy) {
  const pcrs = {}
  for (const k of ['0', '16', '17']) if (doc.pcrs && doc.pcrs[k]) pcrs[k] = String(doc.pcrs[k]).toLowerCase()
  const out = { pcrs, policyVersion: null, policy: null, at: Date.now() }
  let named = null
  try { named = enclaveClaim(claim) } catch { named = null }
  if (!named || !named.policy || !pcrs['17']) return out
  // Let the HARDWARE name the artifact before we go and fetch one. The claim may declare two policies across a repin
  // ({outgoing, incoming}), each at its own url; the entry whose digest extends to the LIVE PCR17 is the one actually
  // loaded. Selecting first is what lets the policy roll over — fetching a single declared url could only ever match
  // one side of the flip. No entry matches ⇒ version stays unknown, which is the honest answer, not entry 0.
  const chosen = await pickArtifact(named.policy, pcrs['17'])
  if (!chosen || !chosen.url) return out
  let bytes = null
  try { bytes = await (fetchPolicy || defaultFetchPolicy)(chosen.url) } catch { bytes = null } // unreachable ⇒ version unknown
  if (!bytes) return out
  const policy = await checkPolicyText(bytes, pcrs['17']) // wrong text ⇒ throws ⇒ no key returned
  return { ...out, policyVersion: policy.version, policy }
}

/** Seal mk (and optionally the sign-in identity) to the attested enclave key for ONE op, bound to room|op|ts|nonce.
 *  → the fields to send INSTEAD OF raw mk: { mkSealed, mkTs, mkNonce, enclave, [idSealed] }. */
export async function sealForEnclave(mk, recipientJwk, { room, op, idToken, from } = {}) {
  const ts = sealNow() // the enclave's clock, as far as this device knows it (mkseal.js, T#2)
  const nonce = newNonce()
  const aad = mkAad({ room, op, ts, nonce })
  const out = { enclave: true, mkSealed: await sealMk(mk, recipientJwk, aad), mkTs: ts, mkNonce: nonce }
  if (idToken || from) out.idSealed = await sealIdentity({ idToken, from }, recipientJwk, aad)
  return out
}
