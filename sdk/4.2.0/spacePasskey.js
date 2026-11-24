// spaces/public/spacePasskey.js — a PHRASELESS recovery secret from a passkey, so you can restore your Spaces with a
// fingerprint/PIN instead of a typed code. Two mechanisms, tried in order:
//   • PRF  (WebAuthn `prf`)      — the authenticator DERIVES a stable secret from the credential (best: re-derives on any
//                                  synced device). Works on iOS/Android, Safari on recent macOS, some desktop setups.
//   • largeBlob (`largeBlob`)    — the authenticator STORES a random secret we write into the credential. Covers many
//                                  desktop passkeys that support log-in but not PRF (common on Windows Hello, Chrome/Mac).
// Either way the 32-byte secret feeds recovery.js deriveKeysFromSecret → the exact same content-blind backup. We never
// verify the assertion server-side; the passkey is a LOCAL secret oracle bound to user verification. Zero deps.

const SALT = new TextEncoder().encode('witbitz-spaces-backup-prf-v1') // fixed → same credential + salt ⇒ same PRF secret
const rpId = () => location.hostname
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n))
// What an authenticator said about the two ways it can hold a key — for the diagnostics list, never the secret itself.
const extSummary = (ext) => { try { const p = ext && ext.prf, l = ext && ext.largeBlob; return `prf:${p ? (p.results && p.results.first ? 'result' : (p.enabled === true ? 'enabled' : p.enabled === false ? 'disabled' : 'silent')) : 'absent'} largeBlob:${l ? (l.blob ? 'blob' : l.written === true ? 'written' : l.supported === true ? 'supported' : l.supported === false ? 'unsupported' : 'silent') : 'absent'}` } catch { return '?' } }
const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s) }
const fromB64 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }
// A STABLE per-device user.id so re-enrolling doesn't spawn a NEW passkey every time — the authenticator/manager treats
// the same (rpId, user.id) as one account and updates it in place, instead of piling up duplicates (as happened before).
// ⚑ ONE HANDLE PER PURPOSE (2026-10-06): "updates it in place" is also how a SECOND purpose's enrollment replaced the
// first — device protection enrolled under the recovery passkey's handle and the authenticator overwrote it. `key` names
// the purpose's own handle (sdkProtect.js uses 'space:pkuser:protect'); the default is the recovery handle, as before.
function stableUserId(key = 'space:pkuser') {
  try { const s = localStorage.getItem(key); if (s) return fromB64(s); const u = rnd(16); localStorage.setItem(key, b64(u)); return u } catch { return rnd(16) }
}

// ⛔ THE REPAIR MUST NOT BREAK THE DEVICE (2026-10-17). A device that turned storage protection on before 755e9c48 enrolled
// its PROTECTION passkey under the recovery handle (that is how its recovery passkey was replaced). Adding a backup
// passkey there now would replace the protection passkey in turn — and the device could no longer open its own sealed
// storage. Recognised by: protection on (either lock's config) while this device never made a protection handle.
// Turning protection off and on again re-enrols it under its own handle; then a backup passkey is safe to add.
export const SHARED_HANDLE_TEXT = 'This device’s storage protection uses the same passkey slot as a backup passkey, so adding one here would replace it. Turn “Also protect this device’s storage” off and on again (Face ID lock), then add the passkey.'
export function protectionSharesRecoveryHandle () {
  try {
    if (localStorage.getItem('space:pkuser:protect')) return false
    return ['space:lock', 'vault:lock'].some((k) => { const c = JSON.parse(localStorage.getItem(k) || 'null'); return !!(c && c.protect && c.protect.on) })
  } catch { return false }
}

/** This device as a person would recognise it ("Chrome on Windows") — the same words as Your devices (devices.js). */
export function passkeyDevice() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /(Mac OS X|Macintosh)/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'a device'
  const br = /Edg\//.test(ua) ? 'Edge' : /(OPR\/|Opera)/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser'
  return br + ' on ' + os
}
/** The name a passkey carries in the keychain (the owner, 2026-10-11: "many passkeys for the same origin. Can I distinguish
 *  between them? For what device? What purpose?") — purpose · device · date, e.g. "Spaces backup · Chrome on Windows · 11 Oct 2026". */
export function describePasskey(purpose, at = Date.now()) {
  let day = ''; try { day = new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) } catch { /* */ }
  return [purpose, passkeyDevice(), day].filter(Boolean).join(' · ')
}

/** A backup passkey's name says WHOSE it is (the owner, 2026-10-12: two accounts' passkeys were both "Spaces backup · iPhone
 *  · date", and nothing told them apart in Passwords). The app is the website it is filed under. */
export const passkeyPurpose = (email) => (email && /@/.test(String(email)) ? String(email).trim().toLowerCase() + ' · ' : '') + 'Spaces backup'

/** Is the platform capable of a passkey at all? (Coarse — real PRF/largeBlob support is only known once we try to enroll.) */
export function passkeyPossible() {
  return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create && location.protocol === 'https:')
}

// Read the secret from an assertion, requesting BOTH mechanisms — PRF (derive) and largeBlob (stored) — and returning
// whichever the credential answers with. `credId` scopes to a known credential; null → discoverable (a new device picks a
// synced passkey). Throws 'cancelled' on dismiss, 'no_secret' if neither mechanism produced one.
async function readSecret(credId, rpIdOverride, hints) {
  let a
  try {
    a = await navigator.credentials.get({ publicKey: {
      challenge: rnd(32),
      rpId: rpIdOverride || rpId(),
      allowCredentials: credId ? [{ type: 'public-key', id: credId }] : [],
      userVerification: 'required',
      ...(hints ? { hints } : {}), // the same phone again, for a passkey just saved there
      // evalByCredential too, for the credential we name (the owner's 1Password through Windows, 2026-10-11: create said
      // prf:enabled, the read returned no prf at all with `eval` alone). The spec allows both; for a named credential it
      // takes evalByCredential, which some platform paths map where they ignore `eval`.
      extensions: { prf: { eval: { first: SALT }, ...(credId ? { evalByCredential: { [b64url(credId)]: { first: SALT } } } : {}) }, largeBlob: { read: true } },
    } })
  } catch (e) { const err = new Error(e && e.name === 'NotAllowedError' ? 'cancelled' : 'get_failed'); err.detail = (e && (e.name + ': ' + e.message)) || ''; throw err }
  const r = a.getClientExtensionResults() || {}
  const credOut = b64(new Uint8Array(a.rawId))
  // A credential can answer with BOTH a PRF secret and a largeBlob secret, and the backup may have been made with either
  // (e.g. a device without PRF used largeBlob, another device sees PRF). Return ALL of them so restore can try each.
  const secrets = []
  if (r.prf && r.prf.results && r.prf.results.first) secrets.push({ secret: new Uint8Array(r.prf.results.first), mode: 'prf' })
  if (r.largeBlob && r.largeBlob.blob) secrets.push({ secret: new Uint8Array(r.largeBlob.blob), mode: 'largeblob' })
  if (!secrets.length) { const err = new Error('no_secret'); err.detail = 'get ' + extSummary(r); throw err }
  return { credId: credOut, secret: secrets[0].secret, mode: secrets[0].mode, secrets }
}

// Store `secret` into a credential's largeBlob (a follow-up get with `write`). Returns true iff written.
const sameBytes = (a, b) => { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0 }
async function writeLargeBlob(credId, secret, rpIdOverride) {
  try {
    const a = await navigator.credentials.get({ publicKey: {
      challenge: rnd(32),
      rpId: rpIdOverride || rpId(),
      allowCredentials: [{ type: 'public-key', id: credId }],
      userVerification: 'required',
      extensions: { largeBlob: { write: secret } },
    } })
    const r = a.getClientExtensionResults() || {}
    return !!(r.largeBlob && r.largeBlob.written)
  } catch { return false }
}

/** Enroll a new discoverable passkey and obtain its secret — PRF if available, else largeBlob. Returns
 *  { credId (b64), secret (Uint8Array), mode }. Throws 'prf_unsupported' if the passkey can hold NEITHER a PRF nor a
 *  largeBlob key (→ fall back to a typed code), 'cancelled' on dismiss. */
export async function enrollPasskey(label, rpIdOverride, { rpName = 'Witbitz Spaces', userName = 'Spaces backup', userKey, onSecondStep, hints } = {}) { // rpIdOverride: enrol under the app's registrable domain so a subdomain vault's passkey is usable by the app; the names + userKey: an SDK app's own, or a second purpose's own handle
  if (!userKey && protectionSharesRecoveryHandle()) { const err = new Error('protect_shared_handle'); err.detail = SHARED_HANDLE_TEXT; throw err } // ⛔ above
  let cred
  try {
    cred = await navigator.credentials.create({ publicKey: {
      rp: { id: rpIdOverride || rpId(), name: rpName },
      user: { id: stableUserId(userKey), name: userName, displayName: label || userName }, // stable id → one passkey per purpose, not many
      challenge: rnd(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      extensions: { prf: { eval: { first: SALT } }, largeBlob: { support: 'preferred' } },
      ...(hints ? { hints } : {}), // ['hybrid'] = save it on a phone: the browser shows a code the phone scans (WebAuthn L3 hints)
    } })
  } catch (e) { const err = new Error(e && e.name === 'NotAllowedError' ? 'cancelled' : 'create_failed'); err.detail = (e && (e.name + ': ' + e.message)) || ''; throw err }
  const ext = cred.getClientExtensionResults() || {}
  const credId = new Uint8Array(cred.rawId)

  // ⛔ A SECRET FROM create() IS NOT TRUSTED UNTIL AN ASSERTION GIVES IT BACK (the owner's Windows Hello in Edge, 2026-10-12:
  // create() returned a PRF value, every later get() — eval, evalByCredential, both — returned NONE; the computer was sealed
  // under a secret no unlock could ever produce). The secret that counts is the one an UNLOCK will see, so it is read from
  // an assertion — and when create() also answered, the two must match. One extra prompt, at setup only.
  const createdPrf = (ext.prf && ext.prf.results && ext.prf.results.first) ? new Uint8Array(ext.prf.results.first) : null
  // ASK THE CREDENTIAL, don't trust create()'s silence. The PRF value only ever arrives on an ASSERTION for many
  // authenticators (iOS), and the spec does not require a provider to echo extension results from create() at all —
  // plenty simply don't. Gating this follow-up get() on `ext.prf` therefore misclassified perfectly capable
  // credentials as "can't hold a key": a Bitwarden-stored passkey on iOS enrolled fine at one point and failed later
  // with prf_unsupported, purely because create() said nothing about prf. The assertion is the authoritative test,
  // so always run it before giving up. Cost is one extra prompt, and ONLY on the path that would otherwise fail.
  try { if (onSecondStep) onSecondStep() } catch { /* the note is a courtesy */ } // say why a second prompt is coming (the owner, 2026-10-11)
  const trail = ['create ' + extSummary(ext)] // what each step answered — rides the failure to the diagnostics list
  try {
    const s = await readSecret(credId, rpIdOverride, hints)
    const prf = s && (s.secrets || []).find((x) => x.mode === 'prf' && x.secret && x.secret.length >= 16)
    if (prf && (!createdPrf || sameBytes(createdPrf, prf.secret))) return { credId: s.credId, secret: prf.secret, mode: 'prf', secrets: [prf] }
    trail.push(prf ? 'get prf: differs from create' : ('get ' + (createdPrf ? 'prf: none (create gave one)' : 'prf: none')))
  } catch (e) { trail.push((e && e.detail) || ('get ' + ((e && e.message) || 'failed'))) } // fall through to largeBlob
  // FALLBACK: largeBlob — STORE a random secret in the credential (for passkeys that log in but can't do PRF). Same
  // reasoning: attempt the write unless create() explicitly said largeBlob is unsupported.
  if (!ext.largeBlob || ext.largeBlob.supported !== false) {
    const secret = rnd(32)
    if (await writeLargeBlob(credId, secret, rpIdOverride)) {
      // …and READ IT BACK, as an unlock will: a "written" the next read cannot see is the same trap as a create-only PRF
      try { const s = await readSecret(credId, rpIdOverride, hints); const lb = s && (s.secrets || []).find((x) => x.mode === 'largeblob'); if (lb && sameBytes(lb.secret, secret)) return { credId: b64(credId), secret, mode: 'largeblob' }; trail.push('largeBlob: written, not read back') } catch (e) { trail.push('largeBlob read-back: ' + ((e && e.detail) || (e && e.message) || 'failed')) }
    } else trail.push('largeBlob write: refused')
  }
  // Nothing will ever use this passkey — ask the provider to drop it, so it does not sit in the user's list (and in every
  // later passkey prompt) doing nothing. Best-effort: the Signal API is newer than WebAuthn, and providers may ignore it.
  try { if (window.PublicKeyCredential && PublicKeyCredential.signalUnknownCredential) await PublicKeyCredential.signalUnknownCredential({ rpId: rpIdOverride || rpId(), credentialId: b64url(credId) }) } catch { /* */ }
  { const err = new Error('prf_unsupported'); err.detail = trail.join(' · ') + ' · ' + ((typeof navigator !== 'undefined' && navigator.userAgent) || '').slice(0, 120); throw err } // neither PRF nor largeBlob → this passkey can't hold a backup key
}

/** What to tell a person whose new passkey could not hold a key (prf_unsupported). Windows Hello is the common case on a
 *  desktop (the owner, 2026-10-11): it signs in, but gives the app no key — a phone's passkey (over the Windows prompt's
 *  phone option) does. */
export function noKeyPasskeyText() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  // Measured on the owner's Windows 11 (2026-10-11): a passkey SAVED TO THIS WINDOWS DEVICE holds the key; 1Password reached through the
  // Windows box said prf:enabled and then answered nothing. So name the manager as the cause and the device as the cure.
  if (/Windows/.test(ua)) return 'That passkey couldn’t hold the key your backup needs, so it wasn’t added — some passkey managers reached through the Windows box (1Password, for one) can’t. Your recovery code still works. Save it to this Windows device instead: in the Windows box choose this device, or turn on Windows Settings → Accounts → Passkeys → Advanced options → “Save passkeys to this Windows device”. Or use your phone.'
  return 'That passkey couldn’t hold a key. Try saving it to a different provider (iCloud Keychain is reliable on iOS) — your backup is unaffected.'
}
export const PASSKEY_SECOND_STEP = 'One more step: confirm the passkey you just made so it can hold your key.'

/** Read the secret from an existing/synced passkey (a follow-up unlock, or a new device's restore) — PRF or largeBlob.
 *  Returns { credId, secret, mode }; throws 'prf_no_result' if the passkey yielded no secret, 'cancelled' on dismiss. */
export async function unlockPasskey(credIdB64, rpIdOverride) { // rpIdOverride: assert under the app's registrable domain (a subdomain vault uses the parent rpId)
  try { return await readSecret(credIdB64 ? fromB64(credIdB64) : null, rpIdOverride) }
  catch (e) { const err = new Error(e && e.message === 'no_secret' ? 'prf_no_result' : (e && e.message) || 'get_failed'); if (e && e.detail) err.detail = e.detail; throw err }
}
