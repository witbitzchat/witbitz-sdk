// awsKey.js — THE PERSON'S AWS KEY, on the device (docs/aws-keys.md; control-plane/src/lib/awsKeys.mjs). One minted, capped key per
// person per app for the AWS a Witbitz service spends for them — a cloud computer's hours and disk first. The device makes an
// Ed25519 pair; only the PUBLIC half goes to the server (POST /v1/spaces/aws-keys with the account's sign-in). The private half
// stays with the person: in the account's sealed document `awskey` (accountStores.js seals it under the account key, so every
// device of the account signs with the same key), or the vault's, in vault mode. A service is asked with a signed call.
//
// Pure: `fetchImpl` and the store ({ get(), put(rec) }) are given; no DOM, no localStorage.

import { creditsNumber, creditsOf, creditsText } from './credits.js' // what a person sees is credits (100 = $1)

export const AWS_KEYS_API = 'https://api.witbitz.chat/v1/spaces/aws-keys'
export const AWS_KEY_DOC = 'awskey' // the account document (sealed: 'xawskey')

const b64u = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
/** The message the device signs = awsKeys.mjs signedMessage (v1, kept for reference) / signedMessageV2. */
export const signedMessage = (op, keyId, ts) => `wbaws-v1|${op}|${keyId}|${ts}`
// State machines pass 7: every signed call carries a fresh nonce the server accepts once — a captured call cannot be sent again.
export const signedMessageV2 = (op, keyId, ts, nonce) => `wbaws-v2|${op}|${keyId}|${ts}|${nonce}`

const coded = (code, message, extra = {}) => Object.assign(new Error(message || code), { code, ...extra })
const isRec = (r) => !!r && typeof r === 'object' && typeof r.keyId === 'string' && r.signPriv && typeof r.signPub === 'string'

/** A fresh pair: { signPub (raw, base64url), signPriv (JWK) }. Throws 'no_ed25519' where the browser lacks it. */
export async function newAwsKeyPair () {
  let k
  try { k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) } catch { throw coded('no_ed25519', 'This browser cannot make the key (it lacks Ed25519) — update it, or use another device.') }
  return { signPub: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))), signPriv: await crypto.subtle.exportKey('jwk', k.privateKey) }
}

/** { keyId, ts, nonce, sig } for one op, signed with the person's key. */
export async function signAws (rec, op, now = Date.now()) {
  if (!isRec(rec)) throw coded('no_aws_key', 'this account has no AWS key yet')
  const ts = Math.floor(now / 1000)
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)))
  const k = await crypto.subtle.importKey('jwk', rec.signPriv, { name: 'Ed25519' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, k, new TextEncoder().encode(signedMessageV2(op, rec.keyId, ts, nonce))))
  return { keyId: rec.keyId, ts, nonce, sig: b64u(sig) }
}

async function post (fetchImpl, url, body) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let j = null
  try { j = await r.json() } catch { /* not JSON */ }
  if (!r.ok) { const e = (j && j.error) || {}; throw coded(e.code || 'http_' + r.status, e.message || `the AWS key service answered ${r.status}`, { status: r.status }) }
  return (j && j.data) || j
}

/**
 * The account's AWS key, minted the first time. With one already in the sealed document, that one (no call). Two devices minting
 * at once: the second is refused (aws_key_exists) and takes the first's from the document. A key the server has but no
 * document holds (the record was lost) → 'aws_key_lost': replacing it is the person's choice (`replace: true`).
 * opts: { token (sign-in), store: { get, put }, app?: 'regular' | 'vaulted', replace?, fetchImpl?, api? }
 */
// approve(signPub) → { statement, sig } (account recovery v2, § 8.8): an active device's approval of the new key — required
// by the mint once the account signed devices out; omitted otherwise.
export async function ensureAwsKey ({ token, store, app = '', replace = false, approve = null, fetchImpl = (...a) => fetch(...a), api = AWS_KEYS_API } = {}) {
  const have = await store.get()
  if (isRec(have) && !replace) return have
  const pair = await newAwsKeyPair()
  let out
  try {
    const v2 = approve ? await approve(pair.signPub) : null
    out = await post(fetchImpl, api, { idToken: token, signPub: pair.signPub, ...(app ? { app } : {}), ...(replace ? { replace: true } : {}), ...(v2 ? { v2 } : {}) })
  } catch (e) {
    if (e.code !== 'aws_key_exists') throw e
    const again = await store.get()
    if (isRec(again)) return again
    throw coded('aws_key_lost', 'This account has an AWS key, but no device record holds it. Replacing it keeps this month\'s spending.')
  }
  const rec = { v: 1, keyId: out.keyId, signPub: pair.signPub, signPriv: pair.signPriv, tier: out.tier, capUsd: out.capUsd, at: Date.now() }
  await store.put(rec)
  return rec
}

/** { live, tier, month: { usd, capUsd, byKind }, resetsAt } — or { live: false, why }. */
export async function awsKeyStatus (rec, { fetchImpl = (...a) => fetch(...a), api = AWS_KEYS_API, now = Date.now() } = {}) {
  return post(fetchImpl, api + '/status', await signAws(rec, 'status', now))
}

/** The month as a row of Settings → Your usage (the owner, 2026-10-24: "It should be under usage"): { label, value, note } —
 *  "Cloud computers", "46 of 5,000 credits", "starts again on 1 November". The key is general (docs/aws-keys.md), but cloud computers
 *  are all that charge it today. null = no row. */
export function awsUsageRow (st) {
  if (!st || typeof st !== 'object') return null
  if (st.live === false) return st.why === 'paused' ? { label: 'Cloud computers', value: 'paused', note: '' } : null
  const m = st.month || {}
  const usd = Number(m.usd), cap = Number(m.capUsd)
  if (!Number.isFinite(usd) || !(cap > 0)) return null
  let when = ''
  try { when = st.resetsAt ? 'starts again on ' + new Date(st.resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }) : '' } catch { when = '' }
  const note = [st.tier === 'free' ? 'the free allowance' : '', usd >= cap ? 'used up' : '', when].filter(Boolean).join(' · ')
  return { label: 'Cloud computers', value: `${creditsNumber(creditsOf(usd))} of ${creditsText(creditsOf(cap))}`, note } // credits (100 = $1); the key keeps dollars
}

/** Revoke with the device's signature (the sign-in route is the account's, for a device that lost the record). */
export async function revokeAwsKey (rec, { fetchImpl = (...a) => fetch(...a), api = AWS_KEYS_API, now = Date.now() } = {}) {
  return post(fetchImpl, api + '/revoke', await signAws(rec, 'revoke', now))
}
