// acctV2Keys.js — the CLIENT's keys for account recovery v2 (docs/account-recovery-protocol.md § 3):
// the possession key from the recovery code, the backup write key from the master (P-256 from a 48-byte seed, § 3.1 —
// WebCrypto cannot import a bare private scalar, so the vendored noble P-256 computes the point and signs), and a signer
// over THIS device's existing non-extractable WebCrypto key (devices.js) — whose raw r‖s signatures become DER here.
import { p256, sha256 as nobleSha256 } from './noble-p256.js'
import { rawToDer, b64u, unb64u } from './acctV2Wire.js'

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const enc = new TextEncoder()
const SALT = enc.encode('witbitz-spaces-backup-v1')

export async function hkdf(ikm, info, n) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) }, k, n * 8))
}

/** § 3.1 — a P-256 key from a 48-byte seed: { d (bigint), pub (65 bytes), sign(bytes) → DER } */
export function p256FromSeed(seed) {
  if (!seed || seed.length !== 48) throw new Error('p256FromSeed: the seed must be 48 bytes')
  let x = 0n
  for (const b of seed) x = (x << 8n) | BigInt(b)
  const d = (x % (N - 1n)) + 1n
  const dBytes = new Uint8Array(32)
  for (let i = 31, t = d; i >= 0; i--, t >>= 8n) dBytes[i] = Number(t & 0xffn)
  const pub = p256.getPublicKey(dBytes, false)
  // no private scalar on the returned object: a key that is logged or serialised must not carry it
  return { pub, spk: b64u(pub), sign: (bytes) => p256.sign(nobleSha256(bytes), dBytes).toDERRawBytes() }
}

export const possessionKey = async (codeBytes) => p256FromSeed(await hkdf(codeBytes, 'possession-key-v1', 48))
export const backupWriteKey = async (master) => p256FromSeed(await hkdf(master, 'backup-write-key-v1', 48))
export const gateValues = async (codeBytes) => ({ gid: Array.from(await hkdf(codeBytes, 'gate-id', 16), (b) => b.toString(16).padStart(2, '0')).join(''), gk: await hkdf(codeBytes, 'gate-commit', 32) })

/** A signer over a WebCrypto ECDSA P-256 key pair (the device key: devices.js keeps it non-extractable in IndexedDB). */
/** The device key as the app stores it (devices.js: a non-extractable private key + `spk`, the public point in base64url):
 *  older records carry no usable public CryptoKey, so the signer is built from the stored bytes. */
export function webCryptoSignerFromSpk(privateKey, spk) {
  return { pub: unb64u(spk), spk, sign: async (bytes) => rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes))) }
}
export async function webCryptoSigner(privateKey, publicKey) {
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
  return { pub, spk: b64u(pub), sign: async (bytes) => rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes))) }
}
