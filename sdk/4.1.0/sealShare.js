// sealShare.js — seal a bundle to an enclave's attested ECDH P-384 share key: the scheme the Sentinel's crypto.go
// `openShare` and the cloud computer's vm/crypto.go undo. One ephemeral P-384 key, ECDH → HKDF-SHA-256 (salt = the
// attest nonce, info "witbitz-cc share v1") → AES-GCM-256 with the nonce as AAD. Shared by codeCloud.js (a cloud
// computer's grant) and connections.js (a standing connection), so the wire has exactly one page-side writer.
const enc = new TextEncoder()
const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)))

/** @returns {{ epk: string, iv: string, ct: string, nonce: string }} — all standard base64 */
export async function sealTo(enclaveKey, nonce, bundle) {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveBits'])
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: enclaveKey }, eph.privateKey, 384)
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: nonce, info: enc.encode('witbitz-cc share v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: nonce }, key, enc.encode(JSON.stringify(bundle))))
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))
  return { epk: b64(epk), iv: b64(iv), ct: b64(ct), nonce: b64(nonce) }
}
