// spaces/public/reqEnvelope.js — the client's half of the SEALED REQUEST ENVELOPE (docs/confidential-path-sweep-2026-11-05.md,
// option A; the enclave's half is agent/reqEnvelope.mjs). A confidential room's request is sealed WHOLE to the enclave's
// attested recipient key, with a one-time ANSWER KEY inside; the enclave seals its answer under that key, so the Space
// Lambda and the enclave's parent host carry ciphertext both ways.
//
// Readable outside (option A — what the front needs to route, mark changes and attach its hints): op, room, the sign-in
// token, the device key id, a lane's shared room, a decision's yes/no, and that a state call WRITES. Nothing else.
// Option B (sealsIdentity): the sign-in token goes inside too (docs/confidential-identity-option-b.md).
// Used only when the LIVE enclave's measured policy says it opens envelopes (env SEALED_REQUESTS = '1').
import { sealMk, mkAad, newNonce, sealNow } from './mkseal.js'

/** Ops that carry no content (or that the Lambda itself answers): they stay as they are. Everything else is sealed. */
export const PLAIN_OPS = new Set(['create', 'pollsealed', 'blob', 'policy', 'touch', 'purge', 'drop', 'pushdrop', 'user',
  'enclaveattest', 'wake', 'changes', 'changesub', 'changemark', 'attest-accept', 'deviceverify', 'receipts', 'receiptsack',
  // the Lambda answers these itself (agent/enclaveRelay.mjs FRONT_OPS): sealed, it could not read them — device enrollment in an
  // attested confidential room failed (sweep 11-06 #5). spaces/test/frontOpsPlain.test.mjs holds FRONT_OPS ⊆ PLAIN_OPS.
  'attest-enroll', 'device-verify', 'device-verify-result',
  // report: what a member CHOSE to show Witbitz (agent/reportOp.mjs — stored and mailed to reports@, never the enclave); the
  // Lambda must read it, so sealed to the enclave it never arrived from a confidential room (CI 2026-11-07, frontOpsPlain)
  'report'])

/** Does this live enclave open envelopes? `attested` is the room's attested facts (enclaveRoute.attestedFacts): the policy
 *  text measured to the live PCR17, so the front can neither fake nor strip the answer. */
/** → true (it opens them) · false (its verified policy says it does not: an older build) · null (UNKNOWN — not attested, or
 *  the policy text could not be fetched). UNKNOWN is never read as "no": whoever serves the policy file could otherwise
 *  switch the envelope off by failing that one fetch (security review, 2026-11-05). The client refuses a content op then. */
export const opensEnvelopes = (attested) => {
  if (!attested || !attested.policy || typeof attested.policy !== 'object') return null
  return !!(attested.policy.env && attested.policy.env.SEALED_REQUESTS === '1')
}

/** OPTION B (docs/confidential-identity-option-b.md): does this live enclave take WHO YOU ARE from inside the envelope (env
 *  SEALED_IDENTITY = '1')? Then the sign-in token rides inside, with the hints the device fetched from op `idextras`, and the
 *  reads that carry a token (a verified room's) go sealed too. Unknown → false: the token stays outside, as under option A
 *  (no content is exposed by that — only who; the content switch is opensEnvelopes, which never reads unknown as no). */
export const sealsIdentity = (attested) => !!(attested && attested.policy && attested.policy.env && attested.policy.env.SEALED_IDENTITY === '1')

/** The content-free ops that carry a sign-in on a verified room, and that the front relays without reading it — sealed under
 *  option B so the token is not readable. An open room's read carries no token and stays plain (the asleep read serves it). */
export const IDENTITY_PLAIN_OPS = new Set(['pollsealed', 'blob', 'policy', 'purge', 'attest-accept'])
/** What the front reads on a sealed read: the cursor (its first-read tier mark) and the change inbox (the drawer's follow). */
const READ_OUTSIDE = ['sinceEtag', 'sinceCount', 'changeInbox']

/** Does `body` carry a sign-in token (top level or in its message)? */
export const carriesIdentity = (body) => !!(body && (typeof body.idToken === 'string' || (body.message && typeof body.message === 'object' && typeof body.message.idToken === 'string')))

const b64 = (u) => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s) }
const unb64 = (s) => Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0))
const answerAad = ({ room, op, nonce }) => new TextEncoder().encode(`witbitz-answer|v1|${room}|${op}|${nonce}`)

/** The readable outside of an envelope: only what the front reads. */
function outsideOf (body, identity) {
  const o = { op: body.op, room: body.room, enclave: true }
  if (!identity && typeof body.idToken === 'string') o.idToken = body.idToken
  if (body.op === 'pollsealed' || body.op === 'blob') for (const k of READ_OUTSIDE) if (body[k] !== undefined) o[k] = body[k]
  if (typeof body.bridgeRoom === 'string') o.bridgeRoom = body.bridgeRoom
  if (body.op === 'decide' && typeof body.approve === 'boolean') o.approve = body.approve
  if (body.op === 'state' && body.patch !== undefined) o.patch = null // a WRITE (agent/changeFeed.mjs changeIntent) — the patch itself is inside
  // A READ'S device key id too (docs/confidential-attested-rooms.md step 1, 2026-11-08): the front adds that device's enrolment
  // evidence, which the enclave needs to check the read's proof. The proof itself stays inside; the enclave takes nothing else from out here.
  const ra = body.readAttestation && typeof body.readAttestation === 'object' ? body.readAttestation.attestation : null
  // …and its PLATFORM (sync sweep 11-10 #2): a Windows key's record is under win.<keyId> — the front looks there only when told the
  // platform, so a Windows device's sealed reads and turns reached the enclave with no evidence and were refused. Not a secret.
  const plat = (x) => (typeof x.platform === 'string' && /^[a-z]{2,16}$/.test(x.platform) ? { platform: x.platform } : {})
  if (ra && typeof ra === 'object' && typeof ra.keyId === 'string') o.readAttestation = { attestation: { keyId: ra.keyId, ...plat(ra) } }
  const m = body.message
  if (m && typeof m === 'object') {
    const stub = {}
    if (!identity && typeof m.idToken === 'string') stub.idToken = m.idToken
    // the device key id stays outside even under option B: the front adds the enrolled device's evidence from its store, and
    // that store is where a revoked device is struck off (only rooms that require an approved device send one)
    if (m.attestation && typeof m.attestation === 'object' && typeof m.attestation.keyId === 'string') stub.attestation = { keyId: m.attestation.keyId, ...plat(m.attestation) }
    if (Object.keys(stub).length || !identity) o.message = stub
  }
  return o
}

/** Seal `body` (the request as it would have been sent) into an envelope. → { outer, answer } — send `outer`; keep `answer`
 *  to open the reply. */
export async function sealRequest (body, publicJwk, { identity = false, extras = null } = {}) {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const ts = sealNow(), nonce = newNonce() // the enclave's clock as far as known (mkseal.js, T#2)
  const inner = { ...body, answerKey: b64(key) }
  if (identity && extras && typeof extras === 'object') { // option B: the front's hints, which the device fetched (op idextras)
    if (Array.isArray(extras.userHints) && extras.userHints.length) inner.userHints = extras.userHints
    if (extras.issuerCfg && typeof extras.issuerCfg === 'object') inner.issuerCfg = extras.issuerCfg
    if (Array.isArray(extras.boundHints) && extras.boundHints.length) inner.boundHints = extras.boundHints.slice(0, 4) // the room-pass cutoff's word (agent/reqEnvelope.mjs INSIDE_OK_FIELDS; sync sweep 2026-11-16 #6)
  }
  delete inner.op; delete inner.room; delete inner.enclave
  const envSealed = await sealMk(JSON.stringify(inner), publicJwk, mkAad({ room: body.room, op: body.op + ':env', ts, nonce }))
  return { outer: { ...outsideOf(body, identity), envSealed, envTs: ts, envNonce: nonce }, answer: { key, aad: answerAad({ room: body.room, op: body.op, nonce }) } }
}

/** Open a reply. A sealed answer → the enclave's response object; a reply with no sealed answer (the Lambda's own: warming,
 *  relay failure, a refusal before the enclave) → itself. A sealed answer that does not open → an error, never a guess. */
//
// ⛔ A SEALED REQUEST ACCEPTS ONLY A SEALED ANSWER (security review, 2026-11-05): the front holds no key, so an answer it made up
// must never pass for the enclave's. Without a sealed answer, only a bare REFUSAL is taken — a failure status, ok:false, a few
// short fields (the Lambda's own: enclave_warming, a relay failure, a front refusal, a transport error) — and nothing else
// from it. With a sealed answer, nothing from outside is merged in but the HTTP status.
const REFUSAL_FIELDS = ['error', 'reason', 'detail']
export async function openAnswer (reply, answer) {
  const status = reply && Number.isInteger(reply.status) ? reply.status : 0
  const sa = reply && reply.sealedAnswer
  if (!sa || typeof sa !== 'object') {
    if (status >= 200 && status < 300) return { status: 502, ok: false, error: 'answer_unsealed', reason: 'the answer to a sealed request came back unsealed — not from the enclave' } // never a 200: a success it is not (sweep 11-06 #1)
    const out = { status, ok: false }
    for (const k of REFUSAL_FIELDS) if (reply && typeof reply[k] === 'string') out[k] = reply[k].slice(0, 300)
    if (reply && reply.warming === true) out.warming = true
    if (reply && reply.confidential === true) out.confidential = true // the front's tier mark — it only ever ADDS the mark
    if (reply && Number.isFinite(reply.now)) out.serverNow = reply.now // an envelope_* refusal carries the enclave's clock (T#2): post() may retry once with it
    // ⛔ a bare 5xx with no code is a CUT-OFF (the API gateway's 30 s on a long confidential turn), not a refusal: the Lambda
    //   runs on and stores the reply. Marked 'refused', every long turn read "Not sent" (the owner, 2026-11-11) — left codeless,
    //   turnVerdict reads it 'pending' and the poll delivers it, as for a standard room
    if (!out.error && !(status >= 500)) out.error = 'refused'
    return out
  }
  try {
    const k = await crypto.subtle.importKey('raw', answer.key, 'AES-GCM', false, ['decrypt'])
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sa.iv), additionalData: answer.aad }, k, unb64(sa.ct))
    const inner = JSON.parse(new TextDecoder().decode(pt))
    // as call() does: { status, ...data } — plus the front's `confidential` mark on a first read (enclaveRelay probeConfidential):
    // it only ever ADDS the mark, and a forged one makes the page treat the room MORE carefully, never less
    return { status, ...(inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : {}), ...(reply.confidential === true ? { confidential: true } : {}) }
  } catch { return { status, ok: false, error: 'answer_unopenable', reason: 'the enclave\'s answer could not be opened on this device' } }
}
