// sealedReceipt.js — the TRUST RECEIPT a member computes from the ciphertext the server stores: its size, its SHA-256 and
// who it is sealed to (sync sweep, 2026-10-10). An open room's receipt comes from the keyless `sealed` read, which the
// server computes; a VERIFIED room refuses that read to non-members on purpose, so a member reads the same stored bytes
// through the authenticated pollsealed path and computes the receipt here. The SDK's sealedProof() uses it (the app's
// Trust sheet that also did was removed on 2026-10-10).
/** `sealed` = what pollsealed / exportSealed returns as `sealed` (a string, or the v3 `{ v, boxes }` wrapper). */
export async function receiptOf(sealed) {
  if (sealed == null) return null
  const raw = typeof sealed === 'string' ? sealed : JSON.stringify(sealed)
  let env = null; try { env = typeof sealed === 'string' ? JSON.parse(sealed) : sealed } catch { /* opaque */ }
  // v3 (what production writes): `boxes` are per-entry envelopes stored as JSON STRINGS (agent/spaceLedgerV3.mjs).
  const box0 = env && Array.isArray(env.boxes) && env.boxes.length ? (typeof env.boxes[0] === 'string' ? (() => { try { return JSON.parse(env.boxes[0]) } catch { return null } })() : env.boxes[0]) : null
  const rec = env && env.recipients ? env.recipients : (box0 && box0.recipients) || null
  const bytes = new TextEncoder().encode(raw)
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { bytes: bytes.length, sha256, recipients: rec && typeof rec === 'object' ? Object.keys(rec) : [], alg: env && env.v ? `AES-256-GCM · multi-recipient envelope v${env.v}` : 'opaque', sealed: raw }
}
