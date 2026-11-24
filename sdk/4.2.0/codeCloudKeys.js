// codeCloudKeys.js — A CLOUD COMPUTER'S MODEL KEYS FROM THE SPACES ACCOUNT, as a paired laptop's are (docs/code-account-keys.md;
// the owner, 2026-10-12, on the New cloud computer sheet: "Why do we need the key?" → "Account keys, count it"). Laptops
// have taken their keys from the account since 10-08; cloud computers were left asking for the person's own. Now the page
// does what a laptop's connector does (tools/code-keys-client.mjs): two key pairs — P-256, which the keys are SEALED to;
// Ed25519, which signs later calls — then POST /v1/spaces/code-keys with the account's sign-in. The answer is opened HERE,
// and the keys go where a pasted key went: the account's sealed cloud doc, handed only to the host's Credential Sentinel.
// The same caps ($50 TrustedRouter + $5 Tinfoil a month) and the same limit (3 computers per account). Removing the
// computer cancels them (drawer.js revokeCodeKeys). Cloud computers made before keep their pasted keys (owner's choice).
//
// `codeKey` = { keyId, tenantId, userId, kid, sealPriv, signPriv } (both private keys as JWK) rides the cloud entry, so a
// later open can call status (signed): that is what renews the Tinfoil key's cap each month, or mints one that failed.

export const CODE_KEYS_API = 'https://api.witbitz.chat/v1/spaces/code-keys'
const enc = new TextEncoder(), dec = new TextDecoder()
const b64u = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const ub64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0))
export const codeAad = (tenantId, userId, kid, provider) => `wbkey-v1|${tenantId}|${userId}|code:${kid}:${provider}` // = codeKeys.mjs codeAad
export const signedMessage = (op, keyId, ts) => `wbcode-v1|${op}|${keyId}|${ts}` // = codeKeys.mjs signedMessage

// What the person reads when the account will not give this computer keys — the server's codes, said as the laptop says them.
const REFUSALS = {
  not_invited: 'Coding on Witbitz is by invitation for now, and this account is not on the list.',
  code_keys_off: 'Coding on Witbitz is paused for now.',
  revoked: 'Billing for this account has been turned off.',
  signin_stale: 'Your sign-in on this device is about to end — open Settings, sign in again, then try once more.',
  not_signed_in: 'This device’s sign-in was not accepted — sign in again with your email, then try once more.',
  signin_invalid: 'This device’s sign-in was not accepted — sign in again, then try once more.',
}

/** The mkseal envelope (enclaveKeySeal.mjs) → the secret, or null (wrong key, tamper, wrong AAD). */
export async function openSealed(blob, sealPrivJwk, aad) {
  try {
    if (!blob || !blob.epk || !blob.iv || !blob.ct) return null
    const priv = await crypto.subtle.importKey('jwk', sealPrivJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
    const epkBytes = ub64u(blob.epk)
    const epk = await crypto.subtle.importKey('raw', epkBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256))
    const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new Uint8Array([...enc.encode('mkseal-v1'), ...epkBytes]) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64u(blob.iv), additionalData: enc.encode(aad) }, key, ub64u(blob.ct)))
  } catch { return null }
}

/** The computer's two key pairs, private halves as JWK (kept in the sealed cloud doc). */
export async function newIdentity() {
  const seal = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const sign = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const sp = await crypto.subtle.exportKey('jwk', seal.publicKey)
  return {
    sealPriv: await crypto.subtle.exportKey('jwk', seal.privateKey),
    signPriv: await crypto.subtle.exportKey('jwk', sign.privateKey),
    sealPub: { kty: 'EC', crv: 'P-256', x: sp.x, y: sp.y },
    signPub: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', sign.publicKey))),
  }
}

/** → { ok:true, tr, tinfoil, venice, codeKey } | { ok:false, reason } — the keys for computer `computerId`, from the account.
 *  `venice`: the zero-retention models' key (docs/code-venice-fallback.md) — '' when none came. */
export async function mintCloudKeys({ computerId, name, idToken, fetchImpl = fetch, api = CODE_KEYS_API } = {}) {
  if (!idToken) return { ok: false, reason: 'Sign in with your email in Spaces first — the computer’s keys come from your account.' }
  let id
  try { id = await newIdentity() } catch { return { ok: false, reason: 'This browser cannot make the computer’s keys (it lacks Ed25519) — update it, or use another device.' } }
  let r = null, j = null
  try {
    r = await fetchImpl(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken, computerId, name, sealPub: id.sealPub, signPub: id.signPub }) })
    j = await r.json().catch(() => null)
  } catch { return { ok: false, reason: 'Couldn’t reach Witbitz for the computer’s keys — check your connection and try again.' } }
  const err = (j && j.error) || {}, d = (j && j.data) || {}
  if (!r.ok || !d.sealed) {
    const code = String(err.code || '')
    return { ok: false, code, reason: (code === 'too_many_computers' && err.message ? err.message[0].toUpperCase() + err.message.slice(1) + '.' : '') || REFUSALS[code] || 'Witbitz did not give this computer its keys — try again in a minute.' }
  }
  j = d
  const tr = await openSealed(j.sealed.trustedrouter, id.sealPriv, codeAad(j.tenantId, j.userId, j.kid, 'trustedrouter'))
  if (!tr) return { ok: false, reason: 'The computer’s keys arrived but would not open — try again.' }
  const tinfoil = j.sealed.tinfoil ? (await openSealed(j.sealed.tinfoil, id.sealPriv, codeAad(j.tenantId, j.userId, j.kid, 'tinfoil'))) || '' : ''
  const venice = j.sealed.venice ? (await openSealed(j.sealed.venice, id.sealPriv, codeAad(j.tenantId, j.userId, j.kid, 'venice'))) || '' : ''
  const codeKey = takeCodeKey({ keyId: j.keyId, tenantId: j.tenantId, userId: j.userId, kid: j.kid, sealPriv: id.sealPriv, signPriv: id.signPriv })
  if (!codeKey) return { ok: false, reason: 'Witbitz answered with keys this page could not keep — try again.' }
  return { ok: true, tr, tinfoil, venice, codeKey }
}

/** At an opening: a SIGNED status — renews the Tinfoil cap at a month change, mints a Tinfoil key that failed at creation.
 *  And the Venice key, sent at every status (the server keeps resending it: a page before cloud computers took it threw it away).
 *  → { live, tinfoil?, venice? } (each only when one came back) | null (unknown: never blocks the opening). */
export async function cloudKeyStatus(codeKey, { fetchImpl = fetch, api = CODE_KEYS_API, nowS = () => Math.floor(Date.now() / 1000), timeoutMs = 5000 } = {}) {
  try {
    if (!codeKey || !codeKey.keyId || !codeKey.signPriv) return null
    const ts = nowS()
    const k = await crypto.subtle.importKey('jwk', codeKey.signPriv, { name: 'Ed25519' }, false, ['sign'])
    const sig = b64u(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, k, enc.encode(signedMessage('status', codeKey.keyId, ts)))))
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs)
    let j = null
    try { const r = await fetchImpl(api + '/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keyId: codeKey.keyId, ts, sig }), signal: ctrl.signal }); j = ((await r.json().catch(() => null)) || {}).data || null } finally { clearTimeout(t) }
    if (!j || typeof j.live !== 'boolean') return null
    const tinfoil = j.sealed && j.sealed.tinfoil ? await openSealed(j.sealed.tinfoil, codeKey.sealPriv, codeAad(codeKey.tenantId, codeKey.userId, codeKey.kid, 'tinfoil')) : null
    const venice = j.sealed && j.sealed.venice ? await openSealed(j.sealed.venice, codeKey.sealPriv, codeAad(codeKey.tenantId, codeKey.userId, codeKey.kid, 'venice')) : null
    return { live: j.live, ...(j.why ? { why: j.why } : {}), ...(tinfoil ? { tinfoil } : {}), ...(venice ? { venice } : {}) }
  } catch { return null }
}

const JWK_EC = (v) => v && typeof v === 'object' && v.kty === 'EC' && v.crv === 'P-256' && typeof v.d === 'string' && typeof v.x === 'string' && typeof v.y === 'string'
const JWK_ED = (v) => v && typeof v === 'object' && v.kty === 'OKP' && v.crv === 'Ed25519' && typeof v.d === 'string' && typeof v.x === 'string'
const ID = /^[A-Za-z0-9_-]{1,80}$/
/** codeComputers.js CLOUD_FIELDS validator: the shape above, or undefined (dropped). */
export function takeCodeKey(v) {
  if (!v || typeof v !== 'object') return undefined
  const keyId = String(v.keyId || ''), tenantId = String(v.tenantId || ''), userId = String(v.userId || ''), kid = String(v.kid || '')
  if (!/^[A-Za-z0-9_-]{1,80}\.[A-Za-z0-9_-]{1,80}$/.test(keyId) || !ID.test(tenantId) || !ID.test(userId) || !ID.test(kid) || !JWK_EC(v.sealPriv) || !JWK_ED(v.signPriv)) return undefined
  const ec = ({ kty, crv, x, y, d }) => ({ kty, crv, x, y, d }), ed = ({ kty, crv, x, d }) => ({ kty, crv, x, d })
  return { keyId, tenantId, userId, kid, sealPriv: ec(v.sealPriv), signPriv: ed(v.signPriv) }
}
