// deviceKeyCore.js — THIS BROWSER'S DEVICE KEY, wherever it is kept: the regular app's page (devices.js, its idb) and the hosted
// app's VAULT (vault-loader.js, the vault origin's own store — docs/hosted-account-v2-plan.md: the new account service's client
// runs there, so its device key is the vault's). One P-256 signing key whose private half can never be exported; stored as a
// CryptoKey under `devkey:v1` (never sealed: sealing a non-extractable key protects nothing — idbSeal IDB_SHARED_NAMES).
// `store` = { get(key), set(key, value) } over raw IndexedDB values.
export const DEVKEY_IDB = 'devkey:v1'
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A NEW key, kept → { priv, pub, spk, at } */
export async function newKeyRecord(store) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) // false ⇒ the PRIVATE half can never be exported
  const rec = { priv: kp.privateKey, pub: kp.publicKey, spk: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), at: Date.now() }
  await store.set(DEVKEY_IDB, rec) // CryptoKey is structured-cloneable → the non-extractable key persists as a key, never as bytes
  return rec
}

/** The kept key, or a new one when there is none — or when what is kept is no key (sealed as JSON by an older protected-storage
 *  build → `{}`). → { priv, pub, spk, at } */
export async function ensureKeyRecord(store) {
  const rec = await store.get(DEVKEY_IDB)
  if (rec && rec.spk && (typeof CryptoKey === 'undefined' || rec.priv instanceof CryptoKey)) return rec
  return newKeyRecord(store)
}
