// codeCloud.js — open a CLOUD COMPUTER from the Code page (docs/cloud-computer.md §3, §10.4).
//
// A cloud computer is your own Nitro enclave running OpenCode and the Witbitz connector, on a host that runs only while
// it is used. Once it is open it is reached like any paired computer — the sealed relay (codeTransport.js). Opening it is
// what this file does, the same steps infra/cloud-computer/device.mjs proved on hardware:
//
//   open    the controller (POST /v1/cloud-computer, your account's sign-in token) starts the host if it is asleep and
//           hands the workspace a blank enclave — or says the workspace is already running (then there is nothing to do).
//           It carries this page's two fresh nonces, so the same answer brings both attestations below
//   attest  the enclave's attestation over a fresh nonce, checked against AWS's root and the PUBLISHED image measurement
//           (PCR0, pinned below). A host that is not running that image fails here, before anything is sent to it.
//   sentinel the host's Credential Sentinel's attestation too, pinned to ITS published image (docs/credential-sentinel.md §9)
//   grant   your keys — TrustedRouter, and Tinfoil and GitHub when saved — sealed to the SENTINEL, bound to this cloud
//           computer's channel key (from its attestation). The cloud computer never receives a key.
//   seal    the device half of the workspace key, the relay pairing and the Sentinel's channel pin, sealed to the cloud
//           computer (ECDH P-384 → HKDF(salt = nonce) → AES-GCM, the nonce as associated data)
//   assign  the enclave opens the workspace (or, the first time, creates it) and starts OpenCode and the connector —
//           sent with the grant in ONE call (handover): the controller assigns only once the Sentinel took the grant
//
// The controller and the host see none of what is sealed. What they could still do is refuse, or offer an older saved
// version — the account keeps the newest version it has seen and the enclave refuses anything older.

import { cloudKeyStatus, mintCloudKeys } from './codeCloudKeys.js' // an account-keyed cloud computer's status at each opening; a pasted-key one's move
import { verifyAttestation } from './nitroVerify.js'
import { sealTo } from './sealShare.js'
import { trustedSentinelPins } from './connections.js' // the standing Sentinel builds this device trusts — named in the grant (below)
import { RELAY_URL, newRelaySecret } from './codeRelay.js'
import { sentinelKeys } from './codeSentinel.js'
import { normEgress, egressHash } from './codeEgress.js' // what this computer may reach: one reading, three destinations

export const CLOUD_API = 'https://api.witbitz.chat/v1/cloud-computer'
// The published cloud-computer image. A rollover lists two: the outgoing and the incoming measurement.
// ★ p1n IS THE FIRST MEASUREMENT IN THIS FILE THAT ANYONE COULD CHECK. Every pin above it was a one-shot artifact of
//   its own build's clock: nitro-cli measures file mtimes, and until 83a33432 every apt-get, mkdir, useradd and tar at
//   build time wrote the moment of the build into the image. Two people rebuilding the same commit got different
//   numbers, and nobody — including us — could verify one. p1n reproduced across two --no-cache builds on each of two
//   machines with different umasks, in both directions, to the last digit (docs/cloud-computer.md § 11).
//   p1j's 40f3f1bf is dropped here, and leaves the KMS policy only AFTER this is deployed: the other order breaks
//   anything still running it, this order means nothing can be launched with it before the key stops opening for it.
// ★ p1o IS p1n PLUS THE AGENT'S BROWSER (docs/cloud-computer.md § 12): Chromium + KasmVNC's X server under uid 1001,
//   the publisher, browse.go's CDP gate. +437,671,570 B on the image (+34 %), the Sentinel's sources untouched.
//   Reproduced against itself on the host (two --no-cache builds, gate exit 0); the cross-machine row was NOT run for
//   this tag — there was no second machine, and launching one was declined as its own decision (§ 11, the cycle doc).
//   Built at c3181136, epoch 1789695180 — the same epoch master's tip gives today, so a rebuild at the tip reproduces it.
// ★ p1p MOVES THIS NUMBER WITH THE CLOUD IMAGE'S CONTENT BYTE-IDENTICAL TO p1o — `ccvm.eif` is 1,711,586,406 bytes in
//   both. Nothing in the agent's image changed: the whole of p1p is the Sentinel answering `mayReach`, so the parent can
//   let a Custom workspace reach the hosts its owner sealed. The measurement moved because `SOURCE_DATE_EPOCH` is ONE
//   value for the whole build and stamps every member's mtime — the same coupling that restamped the SENTINEL at p1o,
//   now seen in the other direction. Per-image epochs remain the fix, and until they land NEITHER number is a usable
//   stop condition on its own; the check that holds is the file-by-file tarball diff.
export const CLOUD_PCR0 = [
  '9b76ca93221300bce9ced817ea8e4a4f21edc6db1953d50deefe4360ec40247c5a6683c62be34a96cb7a5c602e236238', // p3h — a cloud computer finds its tools among up to 1000 connection tools, as a Space does (906bee0d9); built at 5f7849f6
  '9db6dec3a85f9f06565fc5175f0a6f4f64c9c3abd6da3b274b1bd78ae863991c9cbbeaa91db0380d04149e18f59217f8', // p3g — the connector relays GET /session/<id> (c24423b76); the cloud Sentinel carries the provider broker, Gmail through Nylas and the emulated rooms' removal; built at 11113057, reproduced twice on the host, 2026-11-22.
]
// The published Credential Sentinel image.
// ★ A NEW KERNEL MOVES THIS ONE TOO, with an untouched sentinel userland: PCR0 measures kernel and ramdisk together
//   and make-eif.sh builds both images against the same blobs. Forgetting it would leave every cloud computer unable
//   to reach its own credentials.
// ★ THIS ONE MOVED FOR A REASON THAT IS NOT THE KERNEL, which is worth recording because the last two cycles held it
//   as a stop condition. The kernel is the same bzImage; `ccsentinel` hashes identical to p1h and p1i; the Dockerfile
//   is identical. The ONLY file that differs in the sentinel image is `sentinel.mjs`, and the only difference in it is
//   the registry broker (toRegistry / decideRegistry / stripRegistryAuth). Verified by diffing p1i's sentinel.tgz
//   against p1j's file by file, not by assuming the change I made was the change that landed.
// ★ p1k MOVED THIS ONE WITH NOT A LINE OF SENTINEL CODE CHANGED, and the reason is worth reading before anyone treats
//   a moved Sentinel measurement as evidence of a change. esbuild writes each module's path into the bundle relative to
//   the CWD IT WAS RUN FROM, so p1j (built from one directory) and p1k (built from another) differ in those strings and
//   nowhere else: `git log -- sentinel/` is empty across the two, ccsentinel and the Dockerfile hash identically, the
//   kernel is the same bzImage, and normalising the path prefixes makes the two bundles hash the same.
//   The cause is fixed in build-image.sh (the build runs from the repo root, with a guard), so this is a ONE-TIME move
//   from a rendering nobody chose to the reproducible one — and it was taken deliberately rather than avoided, because
//   the alternative was leaving a pinned measurement that the committed build script cannot reproduce.
//   ⛔ RETRACTED (2026-09-17, same day): the "control" cited here — rebuilding p1j from its stored artifacts and getting
//      both pins back — was a CACHE HIT. docker build found every layer present and returned the existing image, so
//      nitro-cli measured an image built nine hours earlier. The pipeline is NOT known to be deterministic; in fact the
//      build does not reproduce against itself on one machine, because nitro-cli measures file mtimes and every
//      apt-get/mkdir/tar at build time writes the clock in. ✅ TRUE OF EVERY MEASUREMENT ABOVE p1n AND NO LONGER TRUE
//      OF p1n: make-eif.sh now builds twice with --no-cache and records nothing unless both agree, and p1n cleared that
//      gate on two machines. So the outgoing pins here are historical numbers nobody can re-derive, and the incoming
//      ones are checkable — which is the difference this file exists to assert. docs/cloud-computer.md § 11.
// ★ p1o MOVED THIS ONE WITH THE SENTINEL'S SOURCES UNTOUCHED, and the reason can be said in one sentence: SOURCE_DATE_EPOCH
//   is ONE value for the whole build and tarball() stamps it as every member's mtime, so an epoch moved by a CLOUD-image
//   change (the browser) restamps the Sentinel's tarball too — ccsentinel, sentinel.mjs and its Dockerfile are IDENTICAL
//   to p1n's, file by file; only the mtimes differ. The fix is per-image epochs (build-image.sh, not yet done); until it
//   lands, "SENTINEL_PCR0 must not move" is NOT a usable stop condition, and the check that holds is the file-by-file diff.
// ★★ AND THIS NUMBER WENT BACKWARDS, WHICH IS THE POINT. p1s carries PER-IMAGE EPOCHS (build-image.sh): the Sentinel's
//   is derived from the last commit touching ITS OWN inputs, so it is 1789761669 — p1p's — and the measurement came
//   back to p1p's `abad1ca9…`, byte for byte, after four cycles of moving for changes in the OTHER image. p1q's and
//   p1r's Sentinel numbers were noise: the sources were identical each time, and only the shared stamp differed.
//   ⚑ So "SENTINEL_PCR0 must not move when the Sentinel did not change" is a usable stop condition again — the check
//   that caught the esbuild-cwd leak, and which caught nothing for four cycles because the number always moved.
export const SENTINEL_PCR0 = [
  'b6a8a6425aa579008cfa8aa91d6875912c6422b52433a55b77db22c434d04c58a02e8fddd2c8187c9e2730232dbe5c14', // p3h — the cloud role's tool search over 1000 connection tools (cloudConnections.mjs listedTools / searchCall, 906bee0d9)
  '9e65d851f3310493333912a1ee8c41f4da88b19d35479c2006121f4da0194fbbdb92b133cd9dcdf415d75104fcce8bfe', // p3g — the provider broker (7aa158d3f, 3036c488f), Gmail through Nylas (cd1db0ade…), the emulated rooms' removal (d4f35a74f); reproduced twice on the host, 2026-11-22.
]
export const GRANT_TTL_MS = 24 * 3600_000
export const PUSH_PATTERN = 'witbitz/*'

const enc = new TextEncoder()
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s) }
const unb64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const b32 = 'abcdefghijklmnopqrstuvwxyz234567'
const b64u = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * The two secrets a workspace belongs to (docs/cloud-computer.md step 3). Ownership used to follow the EMAIL, so an
 * address that changed — or an allowlist that dropped one — locked a person out of their own files.
 *   · `owner` stays in the account alone and rides every ordinary call: it is who this workspace belongs to.
 *   · `recovery` goes in the KEY FILE too (codeKeyFile.js), and buys one thing — moving the workspace to a new owner,
 *     spending itself in the act. It is never accepted as the way in.
 * Neither reaches the host: the controller hashes both and stores opaque hex.
 */
export const newCloudSecrets = () => ({ owner: b64u(crypto.getRandomValues(new Uint8Array(32))), recovery: b64u(crypto.getRandomValues(new Uint8Array(32))) })

/** A new cloud computer's entry: a relay pairing like any computer's, plus what only this account holds about it. */
export function newCloudComputer({ name = 'Cloud computer', key = '', tinfoil = '', github = '', browsePrivate = false } = {}) {
  const id = 'cloud-' + b64(crypto.getRandomValues(new Uint8Array(12))).replace(/\+/g, '-').replace(/\//g, '_')
  const workspace = Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => b32[b & 31]).join('')
  return {
    id, name: String(name).trim().slice(0, 80) || 'Cloud computer', relay: RELAY_URL, secret: newRelaySecret(),
    cloud: {
      workspace, half: b64(crypto.getRandomValues(new Uint8Array(32))), key: String(key).trim(), version: 0,
      tinfoil: String(tinfoil).trim(), github: String(github).trim(), grantKey: b64(crypto.getRandomValues(new Uint8Array(32))),
      // The browse key: minted here, sealed into the bundle, kept for the viewer. Never in the Sentinel's grant —
      // the Sentinel holds what the agent must never see, and this is what the machine needs to act (§ 12).
      browse: b64(crypto.getRandomValues(new Uint8Array(32))),
      ...(browsePrivate ? { browsePrivate: true } : {}), // absent unless chosen, so older entries are untouched
      ...newCloudSecrets(),
    },
  }
}

/**
 * Close a cloud computer: a last save, then the enclave is terminated (the host's revoke drops its Sentinel grants with
 * it). Used when one is REMOVED, so a running enclave does not go on until its idle timeout — and, by the same rule,
 * never allowed to hold the removal up: no token, a refusal, no answer, a service that hangs → false, and the caller
 * removes anyway (the idle timeout is the backstop). Never throws.
 * @returns {Promise<boolean>} whether the service took it
 */
export async function closeCloud(computer, { token, fetchImpl = fetch, api = CLOUD_API, waitMs = 8000 } = {}) {
  const c = computer && computer.cloud
  if (!c || !c.workspace) return false
  const give = new Promise((r) => setTimeout(() => r(false), waitMs)) // the person is waiting on this: give up early
  const close = (async () => {
    let t = null
    try { const got = await token(); t = typeof got === 'string' ? got : (got && got.token) || null } catch { t = null }
    if (!t) return false
    try {
      const r = await fetchImpl(api, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify({ action: 'close', workspace: c.workspace, ...(c.owner ? { owner: c.owner } : {}) }) })
      return r.status === 200
    } catch { return false }
  })()
  return Promise.race([close, give])
}

/** DELETE MY ACCOUNT (accountEraseUi.js; the owner, 2026-11-17: "We should delete everything we can"): the workspace's every
 *  object in S3, gone — not Remove (which keeps them, so a key file can restore). The controller closes an open one first and
 *  answers 409 while it is still saving, 202 while a long purge goes on. → { ok, why? } */
export async function destroyCloud(computer, { token, fetchImpl = fetch, api = CLOUD_API, tries = 30, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const c = computer && computer.cloud
  if (!c || !c.workspace) return { ok: true }
  for (let i = 0; i < tries; i++) {
    let r, j = {}
    try {
      r = await fetchImpl(api, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ action: 'destroy', workspace: c.workspace, ...(c.owner ? { owner: c.owner } : {}) }) })
      j = await r.json().catch(() => ({}))
    } catch { return { ok: false, why: 'the cloud computer service did not answer' } }
    if (r.status === 200 && j.destroyed) return { ok: true }
    if (r.status === 403) return { ok: true } // no longer this account's (moved to another owner): not ours to delete
    if (r.status === 202 || r.status === 409 || r.status === 503) { await sleep(Math.min(Number(j.retryMs) || 2000, 10_000)); continue }
    return { ok: false, why: 'cloud computer ' + r.status + (j.error ? ' (' + j.error + ')' : '') }
  }
  return { ok: false, why: 'your cloud computer is still closing — run Delete my account again in a few minutes' }
}

/** What the person sees while a step runs. */
export const CLOUD_STEPS = {
  requesting: 'Opening your cloud computer…',
  starting: 'Waking your cloud computer — about a minute when it was asleep…', // only when the host says it is starting
  verifying: 'Checking your cloud computer and its key guard run the published Witbitz images…',
  opening: 'Opening your workspace…',
  connecting: 'Connecting to your cloud computer…',
}

export class CloudError extends Error {
  constructor(message, { status = 0, code = '' } = {}) { super(message); this.status = status; this.code = code }
}

/**
 * Move a workspace to a NEW owner — what a key file's recovery secret buys, and all it buys. Two ways to prove the right
 * to do it, and the service decides which applies: the RECOVERY secret from a key file (break-glass, after a removal or
 * an account lost), or being the current owner already (rotating a file that was lost or leaked, and how a workspace
 * made before any of this adopts an owner of its own). It spends the old secrets either way.
 *
 * ★ Write the new secrets into the account BEFORE calling this. If the move lands and the page dies before saving, the
 *   old key file is already dead and the new secrets were never kept — the workspace would be lost for the sake of an
 *   ordering. The caller keeps the old recovery secret alongside until this returns, so a failure can be tried again.
 * @returns {Promise<true>} throws CloudError otherwise — `code: 'open'` when the workspace is open right now
 */
export async function rebindCloud(computer, { token, fetchImpl = fetch, api = CLOUD_API, recovery = '', newOwner = '', newRecovery = '' } = {}) {
  const c = computer && computer.cloud
  if (!c || !c.workspace) throw new CloudError('this is not a cloud computer')
  if (!newOwner || !newRecovery) throw new CloudError('moving a workspace needs its new secrets')
  let t = null
  try { const got = await token(); t = typeof got === 'string' ? got : (got && got.token) || null } catch { t = null }
  if (!t) throw new CloudError('sign in with your email to bring this workspace back', { code: 'no_token' })
  let r, out
  try {
    r = await fetchImpl(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t },
      body: JSON.stringify({ action: 'rebind', workspace: c.workspace, newOwner, newRecovery, ...(c.owner ? { owner: c.owner } : {}), ...(recovery ? { recovery } : {}) }),
    })
    out = await r.json().catch(() => ({}))
  } catch { throw new CloudError('the cloud computer service did not answer') }
  if (r.status === 200) return true
  // 409 has two shapes and both are things a person can act on: the workspace is open (close it), or someone else is
  // moving it at this moment (wait). Neither is a failure of the file.
  if (r.status === 409) throw new CloudError(/being moved/.test(String(out.error || '')) ? 'that workspace is being moved right now — try again in a moment' : 'that workspace is open right now — close it on the device that has it open, then try again', { status: 409, code: 'open' })
  if (r.status === 403) throw new CloudError('that key file does not open this workspace — it may already have been used', { status: 403, code: 'refused' })
  throw new CloudError(out.error || `the cloud computer service said ${r.status}`, { status: r.status, code: out.error || '' })
}

/**
 * Spend a restore's pending move, if it has one. A key file brings a workspace back by MOVING it to this account, and
 * that move may not land at once — the device is offline, or the workspace is still open elsewhere. The account keeps
 * the old recovery secret (`pendingMove`) until it does, so this is simply tried again: at the restore, and before
 * every opening after it. Until it lands, the workspace still belongs to whoever had it, and an open would be refused.
 * @returns {Promise<boolean>} whether there was a move to make (it threw if there was one and it failed)
 */
export async function spendPendingMove(computer, { move = rebindCloud, ...opts } = {}) {
  const c = computer && computer.cloud
  if (!c || !c.pendingMove) return false
  if (!c.owner || !c.recovery) throw new CloudError('this computer has no secrets of its own to move its workspace to')
  await move(computer, { ...opts, recovery: c.pendingMove, newOwner: c.owner, newRecovery: c.recovery })
  return true
}

/**
 * Open a cloud computer so its connector comes online on the relay.
 * @param {{ id, name, relay, secret, cloud: { workspace, half, key, version } }} computer
 * @param {object} o
 * @param {() => Promise<string|{ token: string|null, reason?: string }|null>} o.token — the account's sign-in token, asked of
 *   the app once per opening and again only when the service does not accept it; `reason` says why there is none
 * @param {(step: keyof CLOUD_STEPS) => void} [o.onStep]
 * @returns {Promise<{ live: boolean, version: number, grantKey?: string }>} `version`: the workspace version now open, and a
 *   `grantKey` made here for an older entry that had none — both to keep in the account
 */
// ★★ A NEW PUBLISHED IMAGE IS FOLLOWED, NOT REFUSED — in the SDK (docs/sdk-cloud-computers.md phase 1). An SDK version is
//    immutable, so its pins would go stale at the next image cycle and every app on it would lose its cloud computers (the
//    Sentinel's lesson, connections.js verifyFollowing). Witbitz publishes the live set at /cloud-claim.json (held equal to
//    the pins below by test, network-only in both workers); `follow` reads it on a PCR0 mismatch and accepts an image named
//    there — at once (`auto`) or when the person says yes (`ask(pcr0, role)`). The app passes none: its pins move with it.
export const CLOUD_CLAIM_URL = 'https://witbitz-spaces.pages.dev/cloud-claim.json'
const PCR = /^[0-9a-f]{96}$/
export async function publishedCloudPins (fetchImpl = (u, o) => fetch(u, o), url = CLOUD_CLAIM_URL) {
  try {
    const r = await fetchImpl(url, { cache: 'no-store' })
    if (!r || !r.ok) return { cc: [], sentinel: [] }
    const c = await r.json()
    const list = (v) => (Array.isArray(v) ? v.filter((x) => PCR.test(String(x))) : [])
    return { cc: list(c && c.pcr0), sentinel: list(c && c.sentinelPcr0) }
  } catch { return { cc: [], sentinel: [] } }
}
// ★★ A PIN MISMATCH IS USUALLY A STALE PAGE (codeCloudStale.js): the app passes its build and a reload, and a mismatch on a
//    page older than the published build reloads it once. Without them (the SDK, a test) a mismatch means what it says.
export async function openCloud(computer, { token, aws = null, onStep = () => {}, onSession = () => {}, onGitHub = () => {}, fetchImpl = fetch, verify = verifyAttestation, api = CLOUD_API, pcr0 = CLOUD_PCR0, sentinelPcr0 = SENTINEL_PCR0, waitMs = 600_000, now = () => Date.now(), pageBuild = '', reload = () => {}, publishedBuild = async () => null, follow = null } = {}) {
  const c = computer && computer.cloud
  if (!c || !c.workspace || !c.half) throw new CloudError('this is not a cloud computer')
  if (!c.key) throw new CloudError('no TrustedRouter key is saved for this cloud computer', { code: 'no_key' })
  const until = now() + waitMs

  // One token for the whole opening: a host that is starting answers 503 for a minute, and asking the app on every retry
  // turned one slow refresh into "sign in with your email" (the owner's report).
  let held = null
  const tokenNow = async (fresh) => {
    if (!held || fresh) {
      const t = await token()
      held = typeof t === 'string' ? { token: t, reason: '' } : { token: (t && t.token) || null, reason: (t && t.reason) || '' }
    }
    if (!held.token) throw new CloudError(`sign in with your email to use cloud computers${held.reason ? ` (${held.reason})` : ''}`, { code: 'no_token' })
    return held.token
  }
  let askedAgain = false
  async function call(body) {
    let sent = false
    for (;;) {
      // ⚑ A RETRY SIGNS AGAIN (2026-11-14): the AWS key's admission carries a one-time nonce the server takes once, and the
      // loop below resends while a host wakes (503 "starting") or the network blips — the same admission came back "this
      // signed request was already used". Every send after the first takes a fresh one (none to give → sent without).
      if (sent && body && body.aws) { const { aws: _used, ...rest } = body; body = await admitted(rest) }
      sent = true
      const t = await tokenNow(false)
      let r, out
      try {
        // The workspace's own owner rides every call. An entry without one is from before secrets existed: the service
        // falls back to the email hash, exactly as it always did.
        // ⛔ A CALL THAT NEVER ANSWERS ENDS (2026-11-08, docs/state-machines.md I16 / C#13): there was no timeout — after iOS froze and
        //   resumed the page the request could hang for good, the opening stayed "Waking…" and retry could not replace it until a reload.
        //   60 s per call; the loop above retries within `until`, as for a network error.
        r = await fetchImpl(api, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify(c.owner ? { ...body, owner: c.owner } : body), ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) } : {}) })
        out = await r.json().catch(() => ({}))
      } catch {
        if (now() > until) throw new CloudError('the cloud computer service did not answer')
        await sleep(3000); continue
      }
      if (r.status === 503 && out.state && now() < until) { onStep('starting'); await sleep(Math.min(Math.max(out.retryMs || 3000, 1000), 10_000)); continue }
      // A 401 WITH A CODE is the AWS key's (controller.mjs AWS_REFUSAL: unauthorized / not_found), not the sign-in's — it said
      // "your sign-in was not accepted" for a key signature the page had mangled (2026-11-14), and signing in again changed nothing.
      if (r.status === 401 && out.code) throw new CloudError(`your AWS key was not accepted: ${out.error || out.code}`, { status: 401, code: out.code })
      if (r.status === 401 && !askedAgain) { askedAgain = true; await tokenNow(true); continue } // once more, with a fresh one
      if (r.status === 401) throw new CloudError(`your sign-in was not accepted${out.reason ? ` (${out.reason})` : ''} — sign in again with your email`, { status: 401, code: 'no_token' })
      if (r.status === 429 && out.code === 'aws_limit') throw new CloudError(`this month's cloud computer allowance is used${out.resetsAt ? ` — it starts again on ${String(out.resetsAt).slice(0, 10)}` : ''}`, { status: 429, code: 'aws_limit' })
      if (r.status !== 200 || out.error) throw new CloudError(out.error || `the cloud computer service said ${r.status}`, { status: r.status, code: out.code || out.error || '' })
      return out
    }
  }
  // THE PERSON'S AWS KEY PAYS FOR THE HOURS (docs/aws-keys.md): the app signs an admission for each call that spends — the
  // open and the handover — and the private half never enters this page. No key (an app without it) = the call as before.
  const admitted = async (body) => { let a = null; try { a = aws ? await aws() : null } catch { a = null } return a && a.keyId ? { ...body, aws: a } : body }

  onStep('requesting')
  let create = c.version === 0
  const nonces = { cc: crypto.getRandomValues(new Uint8Array(32)), sentinel: crypto.getRandomValues(new Uint8Array(32)) }
  // ★ ONE READING OF THE POLICY, FOR ALL THREE PLACES IT GOES: the open request (which the host authenticates and uses
  //   for its own coarse list), the sealed bundle (the enclave's copy, enforced there and reported in its story), and
  //   the grant (the Sentinel's copy, which decides GitHub). Reading the stored doc three times would be three chances
  //   to disagree, and a workspace attesting `trusted` while its grant said `none` is a story that is not quite true.
  //   A policy that does not validate is a REFUSAL here, not a fallback: the person is looking at the setting.
  const eg = normEgress(c.egress)
  if (eg.error) throw new CloudError(`this computer's network setting cannot be used (${eg.error})`, { code: 'egress' })
  const policy = eg.policy
  const openBody = () => ({ action: 'open', workspace: c.workspace, create, egressMode: policy.mode, ...(create && c.recovery ? { recovery: c.recovery } : {}), attest: { cc: b64(nonces.cc), sentinel: b64(nonces.sentinel) } })
  let opened
  try {
    opened = await call(await admitted(openBody()))
  } catch (e) {
    // Made before, but this account never heard back that it was (the page closed mid-way): open it instead.
    if (!(create && e.status === 409)) throw e
    create = false
    opened = await call(await admitted(openBody()))
  }
  const alreadyOpen = !!opened.live
  if (!alreadyOpen && !create && opened.version < c.version) {
    throw new CloudError(`the host offered an older copy of your workspace (version ${opened.version}; this account has seen ${c.version}) — refused`, { code: 'rollback' })
  }

  onStep('verifying')
  // Both attestations below run in parallel and both fail on a stale page: the published build is read once and the
  // reload asked for once per open, whichever of the two arrives first.
  let livePromise = null, reloadAsked = false
  const staleAgainst = async () => { livePromise = livePromise || publishedBuild(fetchImpl); const live = await livePromise; return live && live !== pageBuild ? live : null }
  // A PUBLISHED newer image (above, publishedCloudPins): read once per open; each pin tried on its own (a verifier refuses a set
  // of three); accepted at once (`auto`) or on the person's yes. null = not published, the usual refusal follows.
  let claimPromise = null
  const followed = async (docB64, nonce, pins, role) => {
    claimPromise = claimPromise || publishedCloudPins(follow.fetch || fetchImpl, follow.claimUrl || CLOUD_CLAIM_URL)
    const claim = await claimPromise
    for (const p of (role === 'sentinel' ? claim.sentinel : claim.cc).filter((x) => !pins.includes(x))) {
      let doc = null
      try { doc = await verify(unb64(docB64), { nonce, maxAgeMs: 120_000, expectedPCRs: { 0: [p] } }) } catch { continue }
      if ((typeof follow.auto === 'function' && follow.auto()) || (typeof follow.ask === 'function' && await follow.ask(p, role))) return doc
      throw new CloudError('you did not accept the new Witbitz image, so nothing was sent to your cloud computer', { code: 'declined' })
    }
    return null
  }
  // The attestation the open answer brought, or — from a controller without it, or one that failed there — asked for alone.
  const attested = async (op, nonce, brought, pins, role) => {
    const docB64 = typeof brought === 'string' && brought ? brought : (await call({ action: 'op', workspace: c.workspace, cid: opened.cid, req: { op, nonce: b64(nonce) } })).doc
    let doc = null, failure = null
    try { doc = await verify(unb64(docB64), { nonce, maxAgeMs: 120_000, expectedPCRs: { 0: pins } }) } catch (e) { failure = e }
    const reason = failure ? String((failure && failure.message) || failure).split('\n')[0] : ''
    if (!doc && follow && /PCR0/i.test(reason)) doc = await followed(docB64, nonce, pins, role)
    if (!doc) {
      if (/PCR/i.test(reason) && pageBuild && pageBuild.indexOf('__') !== 0) {
        const live = await staleAgainst()
        if (live) {
          if (!reloadAsked) { reloadAsked = true; reload(live) } // once per open; reloadForBuild is once per target build besides
          throw new CloudError(`this page is an older build (${pageBuild}) than the one published (${live}) and does not know the image your cloud computer now runs — reloading the page`, { code: 'stale' })
        }
      }
      const what = role === 'sentinel' ? 'its key guard (the Credential Sentinel) is not running the published Witbitz image' : 'it is not running the published Witbitz image'
      throw new CloudError(`${what}, so nothing was sent to it (` + reason + ')', { code: 'attestation' })
    }
    let said = null
    try { said = JSON.parse(new TextDecoder().decode(doc.userData || new Uint8Array(0))) } catch { /* below */ }
    if (!said || said.role !== role || !/^[0-9a-f]{64}$/.test(String(said.tls))) throw new CloudError(`the ${role} attestation does not name its channel key, so nothing was sent to it`, { code: 'attestation' })
    const key = await crypto.subtle.importKey('spki', doc.publicKey, { name: 'ECDH', namedCurve: 'P-384' }, false, [])
    return { nonce, key, tls: said.tls }
  }
  const brought = (opened.attest && typeof opened.attest === 'object') ? opened.attest : {}
  const [cc, sentinel] = await Promise.all([
    attested('attest', nonces.cc, brought.cc, pcr0, 'cloud-computer'),
    attested('attest-sentinel', nonces.sentinel, brought.sentinel, sentinelPcr0, 'sentinel'),
  ])

  // ★★ AN ENCLAVE THAT IS ALREADY OPEN STOPS HERE — but it stops here, AFTER attestation, and not before it.
  //   It used to return the moment the controller said `live`, which cost two things. The small one: this page
  //   connected to a running enclave having verified NOTHING about it, while the cold path refuses anything whose
  //   PCR0 is not pinned. The large one: the session handle — cid, attested key, browse nonce — is minted by
  //   `assign`, and assign only runs on the cold path, so free browsing worked on exactly ONE page-load: the one
  //   that opened the computer. A reload, a second device, or any reconnect had no handle and the sheet refused
  //   with "this computer was not opened by this page". The owner hit it as "it refuses to open the web"
  //   (2026-09-21) on a computer that had been up for hours.
  //   ⚑ Same lesson as the browse key a week earlier, one notch further in: a capability that only reaches
  //     computers created after it shipped is not shipped — and this one only reached the page-load that opened it.
  if (alreadyOpen) {
    // The nonce, from an op that does NOT re-assign: the workspace is live and its policy is sealed. Authenticated
    // by the device half, exactly as the free-browsing ask itself is (vm/main.go opBrowseNonce).
    try {
      const sealed = await sealTo(cc.key, crypto.getRandomValues(new Uint8Array(32)), { deviceHalf: c.half })
      const out = await call({ action: 'op', workspace: c.workspace, cid: opened.cid, ...(c.owner ? { owner: c.owner } : {}), req: { op: 'browse-nonce', sealed } })
      if (out && out.nonce) onSession({ cid: opened.cid, enclaveKey: cc.key, browseNonce: out.nonce })
    } catch (e) {
      // ⛑ NOT FATAL, and deliberately so: an enclave still running the outgoing image has no browse-nonce op, and
      //    refusing to reconnect to it would be a worse failure than the one this fixes. The handle is simply
      //    absent, which is exactly where this path was before — and the sheet already says so in words.
    }
    // ⛑⛑ ALWAYS, AND ON EVERY PATH THROUGH HERE. The opener starts each opening at step 'starting' and only moves
    //    when a step arrives (cloudOpener: `const entry = { step: 'starting' }`), so a path that stops emitting them
    //    leaves the page saying "Waking your cloud computer — about a minute when it was asleep…" about a computer
    //    that is open and serving. I made this conditional when the nonce fetch went in, so the HAPPY path was the
    //    one that went quiet (2026-09-21). The step is the product telling the owner where it got to; it is not
    //    bookkeeping for the success case to skip.
    onStep('connecting')
    return { live: true, version: c.version }
  }

  onStep('opening')
  // Your keys go to the Sentinel only, bound to THIS cloud computer's channel key.
  const grantKey = c.grantKey || b64(crypto.getRandomValues(new Uint8Array(32)))
  // ★ AND THE BROWSE KEY, MINTED HERE FOR AN OLDER ENTRY — exactly as grantKey is, and for the same reason. It was
  //   minted only in newCloudComputer (2026-09-18), so every computer made before that morning carried none, the
  //   bundle said `browse: undefined`, browse.go reported `offered: false`, and the agent's browser was silently
  //   unavailable on it FOREVER with no way for the owner to tell (the row is deliberately quiet when not running).
  //   A feature that only reaches computers created after it shipped is not shipped. It is a random 32 bytes the page
  //   keeps — nothing derives from it and nothing remembers an older one — so minting it late is safe, and the account
  //   keeps it through the same `save(computer, patch)` the grant key uses.
  const browseKey = c.browse || b64(crypto.getRandomValues(new Uint8Array(32)))
  const grant = {
    id: 'grant_' + b64(crypto.getRandomValues(new Uint8Array(12))).replace(/\+/g, '-').replace(/\//g, '_'),
    source: 'session', computer: computer.id, workspace: c.workspace, peer: cc.tls,
    credentials: { tr: c.key, ...(c.tinfoil ? { tinfoil: c.tinfoil } : {}), ...(c.venice ? { venice: c.venice } : {}), ...(c.github ? { github: c.github } : {}) },
    ...(c.codeKey ? { accountKeys: true } : {}), // the account's keys: the Sentinel lets them spend only Witbitz's models (from its next image)
    // THE ACCOUNT'S CONNECTIONS picked for this computer, and the GitHub App installation (docs/cloud-computer-connections.md):
    // sealed to the Sentinel with their callKeys, which it spends through the standing Sentinel — never a service's token.
    ...(Array.isArray(c.connections) && c.connections.length ? { connections: c.connections } : {}),
    ...(c.githubApp ? { githubApp: { account: c.githubApp.account, id: c.githubApp.id, callKey: c.githubApp.callKey } } : {}),
    // THE STANDING SENTINEL'S PINS (docs/standing-sentinel.md § step 1d (ii)): the cloud computer's Sentinel attests the standing one
    // against these itself, then seals each connection's callKey to it for that call — so the standing Sentinel can keep the
    // connection locked under the key instead of holding it. This device's trusted builds: a newer one it accepted by its release first.
    ...((Array.isArray(c.connections) && c.connections.length) || c.githubApp ? { standing: trustedSentinelPins() } : {}),
    // ★ THE SAME `policy` OBJECT THE BUNDLE GETS, not a second reading of the stored doc. The Sentinel and the enclave
    //   enforce independently, which is the point — but they must enforce the SAME policy, and two `normEgress` calls
    //   are two chances to disagree (witbitz-1c). Derived once above; both copies are that one result.
    // ★ THE CUSTOM HOSTS RIDE THE GRANT, and this is the whole road behind "Hosts I choose". The parent forwards only
    //   {kms, code-relay} in every mode and refuses to hold a per-workspace list — rightly, since that would hand the
    //   operator every person's hosts, and host.py is not measured anyway. So the SEALED grant carries the list to the
    //   Sentinel, which is measured and pinned, and the parent asks it yes/no per host at dial time
    //   (docs/cloud-computer-egress.md § "Hosts I choose has no road behind it"). Same shape as the bundle's `egress`
    //   above and from the same `policy` object, so the two enforcers cannot disagree about what was chosen.
    rules: { github: { pushPattern: PUSH_PATTERN }, egress: policy.mode === 'custom' ? { mode: policy.mode, hosts: policy.hosts } : { mode: policy.mode } },
    keys: await sentinelKeys(grantKey),
    expires: now() + GRANT_TTL_MS,
  }
  const sealedGrant = await sealTo(sentinel.key, sentinel.nonce, grant)
  const sealed = await sealTo(cc.key, cc.nonce, {
    deviceHalf: c.half,
    index: `index-${create ? 1 : opened.version}`,
    minVersion: Math.max(c.version, 1),
    repo: '',
    pairing: { name: computer.name, computerId: computer.id, secret: computer.secret, relay: computer.relay },
    sentinel: sentinel.tls,
    // github: GitHub CONNECTED (the app or a token) — the enclave lets the agent reach GitHub's hosts in every mode, still only
    // through the Sentinel's broker (vm/policy.go; the owner, 2026-11-18: "GitHub when connected"). An older image ignores it.
    ...(c.githubApp && c.githubApp.login ? { githubLogin: String(c.githubApp.login).slice(0, 39) } : {}), // git's name when the app's token cannot say who (vm/stub.go setGitIdentity)
    egress: { ...(policy.mode === 'custom' ? { mode: policy.mode, hosts: policy.hosts } : { mode: policy.mode }), ...(c.github || c.githubApp ? { github: true } : {}) },
    // ★ The browse key goes in the BUNDLE and never in the grant above. The split is the product claim: the
    // Sentinel holds what the agent must never see (credentials); the cloud computer holds what it needs to act.
    // A browse key is the second kind — putting it in the grant would make the Sentinel a party to every frame.
    // Minted above when the entry had none, so a computer made before this shipped gains it on its next open.
    // `private` rides the bundle so the ENCLAVE wipes the profile at open and close (browse.go) — a page-side wipe
    // would be a promise about a machine the page cannot reach. Absent = the profile persists, as it always has.
    browse: { key: browseKey, relay: computer.relay || RELAY_URL, ...(c.browsePrivate ? { private: true } : {}) },
    create,
  })
  const refusedGrant = (g) => new CloudError(`the key guard refused the grant (${(g && g.error) || 'no reason'})`, { code: 'grant' })
  let assigned
  try {
    const out = await call(await admitted({ action: 'handover', workspace: c.workspace, cid: opened.cid, grant: sealedGrant, assign: sealed }))
    if (!out.granted || !out.granted.ok) throw refusedGrant(out.granted)
    if (out.granted.github) { try { onGitHub(out.granted.github) } catch { /* a notice, never the opening's failure */ } } // the GitHub token, tested once by the Sentinel (github.mjs checkGitHubToken)
    assigned = out.assigned || {}
  } catch (e) {
    if (!(e.status === 400 && /unknown action/.test(e.message))) throw e
    // A controller from before handover: the same two steps, one call each.
    const granted = await call({ action: 'op', workspace: c.workspace, cid: opened.cid, req: { op: 'grant', sealed: sealedGrant } })
    if (!granted.ok) throw refusedGrant(granted)
    if (granted.github) { try { onGitHub(granted.github) } catch { /* */ } }
    assigned = await call({ action: 'op', workspace: c.workspace, cid: opened.cid, req: { op: 'assign', sealed } })
  }
  onStep('connecting')
  // ★ THE SESSION HANDLE GOES OUT THROUGH A CALLBACK, NOT THE RETURN VALUE. What openCloud RETURNS is merged into the
  //   account's sealed entry, and `normCloudEntry` is an allowlist — a new field there is either dropped silently or
  //   persisted when it must not be. This handle is good for exactly one opening (the cid dies with the enclave, the
  //   nonce is spent on first use), so it lives in the page's memory and nowhere else.
  onSession({ cid: opened.cid, enclaveKey: cc.key, browseNonce: assigned.browseNonce || '' })
  return { live: false, version: Number.isInteger(assigned.version) ? assigned.version : opened.version, ...(c.grantKey ? {} : { grantKey }), ...(c.browse ? {} : { browse: browseKey }) }
}

/**
 * Free browsing: open the whole web for the browser THE OWNER IS HOLDING, or close it again
 * (docs/cloud-computer-free-browsing.md).
 *
 * ★★ WHAT AUTHENTICATES THIS IS THE DEVICE HALF, NOT THE ENVELOPE. Sealing to the enclave proves nothing — it
 * derives against the enclave's PUBLISHED key, so anyone who can reach the service can seal a payload it will open.
 * The half is the secret only this account holds, the enclave compares it in constant time against the one the
 * assign carried, and a one-time nonce stops the service replaying a widen it saw once. Same shape as `assign`,
 * for the same reason.
 *
 * ★ It REFUSES unless the controls are already held. Free browsing is what take-over buys; a page that could open
 * the web without one would be offering Full with extra steps, which is the thing the owner struck.
 *
 * @param session the handle openCloud handed to `onSession` for THIS opening
 * @returns {Promise<{nonce: string, egress: object, browse: object}>} the next nonce, and the enclave's own story
 */
export async function setCloudFreeBrowsing(computer, session, on, { token, fetchImpl = fetch, api = CLOUD_API } = {}) {
  const c = computer && computer.cloud
  if (!c || !c.workspace || !c.half) throw new CloudError('this is not a cloud computer')
  if (!session || !session.cid || !session.enclaveKey || !session.browseNonce) {
    throw new CloudError('this computer was not opened by this page — reopen it before opening the web', { code: 'no_session' })
  }
  const nonce = crypto.getRandomValues(new Uint8Array(32))
  const sealed = await sealTo(session.enclaveKey, nonce, { deviceHalf: c.half, nonce: session.browseNonce, free: !!on })
  const t = await token()
  const r = await fetchImpl(api, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (typeof t === 'string' ? t : (t && t.token)) },
    body: JSON.stringify({ action: 'op', workspace: c.workspace, cid: session.cid, ...(c.owner ? { owner: c.owner } : {}), req: { op: 'browse-policy', sealed } }),
  })
  const out = await r.json().catch(() => ({}))
  // ⛑ A SPENT NONCE IS STILL SPENT ON A REFUSAL, and the enclave hands the next one back with the error — so the
  //    handle is updated before throwing, or a refused ask (no browser, controls not held, a second tab) would leave
  //    this page unable to try again with the reason fixed.
  if (out && out.nonce) session.browseNonce = out.nonce
  if (Number(r.status) >= 400 || out.error) throw new CloudError(out.error || `the computer refused (${r.status})`, { code: 'free_browsing' })
  return { nonce: out.nonce, egress: out.egress, browse: out.browse }
}

/** Seal a bundle to the enclave's attested key — sealShare.js, shared with connections.js (one writer of that wire). */
export { sealTo }

/** Where a new session starts on a cloud computer: its workspace, the folder that is saved. */
export const CLOUD_HOME = '/work'

/**
 * One opening at a time per cloud computer, and a pause after a failure so a page that keeps seeing it offline does
 * not keep asking. The page calls ensure() whenever its cloud computer is offline; retry() is a tap on the error.
 *
 * ★ `allow` IS WHAT STOPS A FORGOTTEN TAB BILLING ALL NIGHT. A cloud computer closes itself after 30 minutes unused,
 *   and a Code page that is merely OPEN notices it go offline within seconds and opens it again — so the machine never
 *   stops, and a phone left on a bedside table cost a day's compute before anybody looked (2026-09-16). `ensure` is
 *   automatic and therefore asks first; `retry` is a person tapping and never does.
 */
/**
 * ONE OPENING, with what it must keep: a restored workspace's pending move spent first, the account keys' signed status (it
 * renews the Tinfoil cap at a month change, or mints one that failed), then openCloud — and what the opening brings back that
 * the entry must keep (a newer version, a grant key, a browse key) handed to `save(computer, patch)`. Rejects when the opening
 * fails: cloudOpener (the app) turns that into its callbacks; the SDK (sdkComputers.js) lets it reach the builder.
 */
// A CONNECTION'S CALLKEY IS ASKED AT OPEN, NOT KEPT (the owner, 2026-11-14: "Close the gaps"): in the hosted app the vault holds the
// account's callKeys (vaultConnKeys.js), so a computer's saved record names a connection by id (`held: 1`) and this asks the app for
// the keys (`callKeys(ids)` → { id: { callKey } }) for this one grant — they are sealed to the Sentinel and never saved. One the app
// does not answer is left out of this opening (the agent cannot spend it), and the rest open as before. A record with keys: as before.
export async function withCallKeys (computer, callKeys) {
  const c = computer && computer.cloud; if (!c) return computer
  const conns = Array.isArray(c.connections) ? c.connections : []
  const want = [...conns.filter((x) => x && !x.callKey).map((x) => x.id), ...(c.githubApp && !c.githubApp.callKey ? [c.githubApp.id] : [])].filter(Boolean)
  if (!want.length) return computer
  let got = {}; try { got = (typeof callKeys === 'function' && (await callKeys(want))) || {} } catch { got = {} }
  const keyOf = (id) => { const k = got[id]; const v = k && typeof k === 'object' ? k.callKey : k; return typeof v === 'string' && v ? v : '' }
  const fill = (x) => { if (!x || x.callKey) return x; const k = keyOf(x.id); if (!k) return null; const { held: _h, ...rest } = x; return { ...rest, callKey: k } }
  const next = { ...c, connections: conns.map(fill).filter(Boolean) }
  if (!next.connections.length) delete next.connections
  if (c.githubApp && !c.githubApp.callKey) { const g = fill(c.githubApp); if (g) next.githubApp = g; else delete next.githubApp }
  return { ...computer, cloud: next }
}

export async function openCloudComputer (computer, { open = openCloud, move = rebindCloud, renew = cloudKeyStatus, mint = mintCloudKeys, onKeysRefused = () => {}, token, aws = null, save = () => {}, openOpts = {}, callKeys = null } = {}) {
  // A workspace restored from a key file has to come over to this account before it can be opened at all; if that did not
  // land at the restore, it is finished here. Its failure IS the opening's failure, and says why far better than the 403 an
  // unmoved workspace would answer with.
  if (computer.cloud.pendingMove) { await spendPendingMove(computer, { token, move }); save(computer, { pendingMove: '' }) }
  // A PASTED-KEY COMPUTER MOVES TO THE ACCOUNT'S KEYS (the owner, 2026-11-20: "Move to account keys"): one made before 2026-10-12
  // ran on keys pasted at creation, so it never had a Venice key — the zero-retention models are the account's alone. At its next
  // opening it is given its own keys from the account, as a new one is, and stops using the pasted ones (a GitHub token stays).
  // A refusal (three computers already, not signed in) leaves it on the pasted keys, opening as before.
  if (!computer.cloud.codeKey && mint) {
    const got = await (async () => {
      let t = null
      try { const g = await token(); t = typeof g === 'string' ? g : (g && g.token) || null } catch { t = null }
      return t ? mint({ computerId: computer.id, name: computer.name, idToken: t }) : null
    })().catch(() => null)
    // ⚑ SAID, NOT SILENT (the owner's phone, 2026-11-20: three computers already, so the move was refused and the zero-retention
    //   models kept answering "no key … close it and open it again" — which could never help). Not signed in says nothing.
    if (got && !got.ok && got.reason) { try { onKeysRefused(got.reason) } catch { /* a notice, never the opening's failure */ } }
    if (got && got.ok) {
      const patch = { key: got.tr, codeKey: got.codeKey, tinfoil: got.tinfoil || null, venice: got.venice || null } // null removes a pasted one (withCloud)
      computer = { ...computer, cloud: { ...computer.cloud, ...patch } }
      save(computer, patch)
    }
  }
  // ACCOUNT KEYS (codeCloudKeys.js): a signed status first, as a laptop's connector does at start. Never holds the opening up.
  if (computer.cloud.codeKey) {
    const st = await renew(computer.cloud.codeKey).catch(() => null)
    for (const f of ['tinfoil', 'venice']) { // a key minted (or sent again) server-side after the computer was made
      if (st && st[f] && st[f] !== computer.cloud[f]) { computer = { ...computer, cloud: { ...computer.cloud, [f]: st[f] } }; save(computer, { [f]: st[f] }) }
    }
  }
  const r = await open(await withCallKeys(computer, callKeys), { token, aws, ...openOpts }) // the keys for this grant only — never saved
  const patch = {}
  if (r && Number.isInteger(r.version) && r.version > (computer.cloud.version || 0)) patch.version = r.version
  if (r && r.grantKey) patch.grantKey = r.grantKey
  if (r && r.browse) patch.browse = r.browse // an older entry that had no browse key: kept, or the viewer link changes every open
  if (Object.keys(patch).length) save(computer, patch)
  return r
}

export const CALL_TIMEOUT_MS = 60_000 // one call to the cloud computer service (openCloud's call): longer than its slowest answer, shorter than forever
export function cloudOpener({ open = openCloud, move = rebindCloud, renew = cloudKeyStatus, mint = mintCloudKeys, onKeysRefused = () => {}, token, aws = null, callKeys = null, stale = {}, save = () => {}, onStep = () => {}, onSession = () => {}, onGitHub = () => {}, onDone = () => {}, onError = () => {}, allow = () => true, onHeld = () => {}, cooldownMs = 60_000, now = () => Date.now() } = {}) {
  const busy = new Map() // id → { step, promise }
  const failedAt = new Map()
  const ensure = (computer, { auto = true } = {}) => {
    if (!computer || !computer.cloud) return null
    const id = computer.id
    if (busy.has(id)) return busy.get(id).promise
    if (failedAt.has(id) && now() - failedAt.get(id) < cooldownMs) return null
    // Held back, not failed: nothing is wrong and nothing is retried on a timer. The page says so and waits for a tap.
    if (auto && !allow(computer)) { onHeld(computer); return null }
    const entry = { step: 'starting', promise: null }
    busy.set(id, entry)
    entry.promise = openCloudComputer(computer, { open, move, renew, mint, onKeysRefused: (why) => onKeysRefused(computer, why), token, aws, save, callKeys, openOpts: { ...stale, onStep: (s) => { entry.step = s; onStep(computer, s) }, onSession: (h) => onSession(computer, h), onGitHub: (v) => onGitHub(computer, v) } })
      .then((r) => { failedAt.delete(id); onDone(computer, r) }, (e) => { failedAt.set(id, now()); onError(computer, e) })
      .finally(() => { busy.delete(id) })
    return entry.promise
  }
  return {
    ensure,
    retry: (computer) => { if (computer) failedAt.delete(computer.id); return ensure(computer, { auto: false }) },
    step: (id) => (busy.has(id) ? busy.get(id).step : ''),
  }
}
