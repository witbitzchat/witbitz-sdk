// spaces/public/backupVault.js
//
// Clean account-backup model:
//   1. A random 32-byte master secret identifies and encrypts the backup.
//   2. Each recovery method stores one wrapper: the master secret encrypted to that method's secret.
//   3. Restoring with any enrolled method opens its wrapper, gets the same master secret, then opens the one backup.
//
// The server remains content-blind. It stores opaque blobs by derived ids and never receives a recovery code, passkey
// secret, backup key, or plaintext.
import { deriveKeysFromSecret, seal, unseal } from './recovery.js'

const enc = new TextEncoder()
const WRAP_LABEL = enc.encode('witbitz:backup-wrapper:v2')

const b64 = (u8) => {
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}
const ub64 = (s) => {
  const b = atob(s)
  const u = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i)
  return u
}

export function newMasterSecret() {
  return crypto.getRandomValues(new Uint8Array(32))
}

async function wrapperSecret(credentialSecret) {
  if (!credentialSecret || credentialSecret.length < 16) throw new Error('bad_secret')
  const buf = new Uint8Array(credentialSecret.length + WRAP_LABEL.length)
  buf.set(credentialSecret)
  buf.set(WRAP_LABEL, credentialSecret.length)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
}

export async function wrapperLocation(credentialSecret) {
  return deriveKeysFromSecret(await wrapperSecret(credentialSecret))
}

export async function backupLocation(masterSecret) {
  if (!masterSecret || masterSecret.length !== 32) throw new Error('bad_master_secret')
  return deriveKeysFromSecret(masterSecret)
}

export async function sealWrapper(credentialSecret, masterSecret) {
  const { key } = await wrapperLocation(credentialSecret)
  return seal(key, { v: 2, master: b64(masterSecret) })
}

export async function openWrapper(credentialSecret, blob) {
  if (!blob) return null
  try {
    const { key } = await wrapperLocation(credentialSecret)
    const data = await unseal(key, blob)
    const master = data && typeof data.master === 'string' ? ub64(data.master) : null
    return master && master.length === 32 ? master : null
  } catch { return null }
}

export async function enrollCredential(transport, credentialSecret, masterSecret) {
  const { id, wt } = await wrapperLocation(credentialSecret)
  return !!(await transport.put(id, await sealWrapper(credentialSecret, masterSecret), wt)) // wt binds the write to the credential secret (see backup.js write-auth)
}

export async function unlockMaster(transport, credentialSecret) {
  let loc
  try { loc = await wrapperLocation(credentialSecret) } catch { return null }
  const blob = await transport.get(loc.id)
  return openWrapper(credentialSecret, blob)
}

export async function createVault(transport, credentialSecrets) {
  const secrets = (credentialSecrets || []).filter((s) => s && s.length >= 16)
  if (!secrets.length) throw new Error('no_credentials')
  const masterSecret = newMasterSecret()
  const enrolled = []
  for (const secret of secrets) {
    if (await enrollCredential(transport, secret, masterSecret)) enrolled.push(secret)
  }
  if (!enrolled.length) throw new Error('enroll_failed')
  return { masterSecret, enrolled, location: await backupLocation(masterSecret) }
}

export async function replaceCredential(transport, { masterSecret, oldWrapperId, newSecret }) {
  if (!(await enrollCredential(transport, newSecret, masterSecret))) return false
  if (oldWrapperId) {
    try { await transport.put(oldWrapperId, null) } catch { /* stale old wrapper is acceptable */ }
  }
  return true
}

// (Retired 2026-09-03: the v3 "operator-resistant code wrapper" — code AND S=HMAC(GATE_ROOT_KEY,email) folded in — was
// the aTLS-P2 enclave-gated recovery. SUPERSEDED by passkey-PRF as the operator-resistant tier, docs/recovery-operator-
// resistance.md. It was additive + never wired into the live restore flow, so this removal is behaviour-neutral.)
