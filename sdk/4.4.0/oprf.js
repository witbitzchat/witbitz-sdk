// Verifiable OPRF over P-256 (2HashDH) — the WIRE-COMPATIBLE browser port of agent/oprf.mjs (docs/spaces-email-invite.md).
// Same curve, same DSTs, same encodings, so a `handle` blinded and finalized here in the browser equals the one the
// server derives with handleFor() (agent/oprf.test.mjs + oprfParity.test.mjs lock it). This is the client half: it turns
// an email into a directory handle WITHOUT the email leaving the device (the server evaluates a blinded point), and it
// VERIFIES the server's DLEQ proof so a malicious build/server can't substitute a per-user key to deanonymise lookups.
//
// The only dependency is the vendored, self-contained P-256 bundle (WebCrypto can't do scalar-mult / hash-to-curve).
// It's local JS — nothing leaves the origin, so the egress-lock CSP is untouched.
import { p256, hashToCurve, sha256 } from './noble-p256.js'

const P = p256.Point, Fn = P.Fn
const DST_H2C = 'WB-OPRF-v1-P256-SHA256'
const L_DLEQ = 'wb-oprf-dleq-v1'
const L_HANDLE = 'wb-oprf-handle-v1'
const enc = new TextEncoder()
const randBytes = () => (p256.utils.randomSecretKey || p256.utils.randomPrivateKey)()

function b64u(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function ub64u(str) { str = String(str).replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(str); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out }
function cat(arrs) { let n = 0; for (const a of arrs) n += a.length; const out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length } return out }
function u32(x) { return new Uint8Array([(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]) }

const toNum = (b) => { let x = 0n; for (const y of b) x = (x << 8n) | BigInt(y); return x }
const scalar = (bytes) => Fn.create(toNum(bytes))
const pt = (p) => p.toBytes(true)
const unpt = (b) => P.fromBytes(b)
const norm = (email) => String(email).trim().toLowerCase()
const h2c = (emailNorm) => hashToCurve(enc.encode(emailNorm), { DST: DST_H2C })
function randScalar() { let s; do { s = scalar(randBytes()) } while (Fn.is0(s)); return s }

function dleqChallenge(G, kpub, B, Z, A1, A2) {
  return scalar(sha256(cat([enc.encode(L_DLEQ), pt(G), pt(kpub), pt(B), pt(Z), pt(A1), pt(A2)])))
}
function finalizeHandle(emailNorm, N) {
  const e = enc.encode(emailNorm)
  return b64u(sha256(cat([enc.encode(L_HANDLE), u32(e.length), e, pt(N)])))
}

// ── server-shaped helpers (present for tests/parity; the browser normally calls only blind/finalize) ──────────────
export function generateKey() { return b64u(randBytes()) }
export function publicKey(kB64) { return b64u(pt(P.BASE.multiply(scalar(ub64u(kB64))))) }
export function evaluate(bB64, kB64) {
  const k = scalar(ub64u(kB64))
  const B = unpt(ub64u(bB64))
  const Z = B.multiply(k)
  const G = P.BASE, kpub = G.multiply(k)
  const t = randScalar()
  const A1 = G.multiply(t), A2 = B.multiply(t)
  const c = dleqChallenge(G, kpub, B, Z, A1, A2)
  const s = Fn.add(t, Fn.mul(c, k))
  return { z: b64u(pt(Z)), proof: { c: b64u(Fn.toBytes(c)), s: b64u(Fn.toBytes(s)) } }
}
export function handleFor(email, kB64) { return finalizeHandle(norm(email), h2c(norm(email)).multiply(scalar(ub64u(kB64)))) }

// ── CLIENT (what the PWA actually uses) ──────────────────────────────────────────────────────────────────────────
export function blind(email) {
  const r = randScalar()
  return { b: b64u(pt(h2c(norm(email)).multiply(r))), r: b64u(Fn.toBytes(r)) }
}
export function finalize(email, zB64, rB64, proof, kpubB64) {
  const G = P.BASE, kpub = unpt(ub64u(kpubB64))
  const r = scalar(ub64u(rB64))
  const B = h2c(norm(email)).multiply(r)
  const Z = unpt(ub64u(zB64))
  const c = scalar(ub64u(proof.c)), s = scalar(ub64u(proof.s))
  const A1 = G.multiply(s).subtract(kpub.multiply(c))
  const A2 = B.multiply(s).subtract(Z.multiply(c))
  if (!Fn.eql(c, dleqChallenge(G, kpub, B, Z, A1, A2))) throw new Error('oprf: DLEQ verification failed')
  return finalizeHandle(norm(email), Z.multiply(Fn.inv(r)))
}
