// witz/public/shamir.js — Shamir's Secret Sharing over GF(256) (M3, docs/configurable-space-m3.md).
//
// The GENERAL shared-presence key model for a Space: split the room key `mk` into `n` shares so that ANY `k` of them
// reconstruct it and any `k-1` reveal NOTHING (information-theoretic). Generalizes the 2-of-2 XOR split (the k=n=2 case)
// to teams — "N members, any k present to open". Pure JS (no WebCrypto) → runs in the browser AND Node.
//
// Byte-wise: for each secret byte, a random degree-(k-1) polynomial with the byte as f(0); share j = f(j) at x=1..n;
// reconstruct via Lagrange interpolation at x=0. A share's wire form is base64url([x, ...yBytes]) — x is the 1-byte
// evaluation point, the rest are one y-byte per secret byte.

// base64url without Buffer (browser-safe; atob/btoa exist in Node 18+ too — same as e2ee.js).
const b64 = (bytes) => btoa(String.fromCharCode.apply(null, Array.from(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const ub64 = (s) => {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))
  const a = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
  return a
}

// ── GF(256) tables (AES field x^8+x^4+x^3+x+1 = 0x11b, generator 3) ──
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(function initField() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    let x2 = x << 1
    if (x2 & 0x100) x2 ^= 0x11b // x*2 in GF(256)
    x = (x2 ^ x) & 0xff // x = x*3 (the generator)
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] // doubled so mul/div need no modulo
})()
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])
const div = (a, b) => (a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]]) // b must be non-zero

// random bytes (WebCrypto's getRandomValues is a global in browser + Node — it's not part of subtle)
const rand = (n) => crypto.getRandomValues(new Uint8Array(n))

/** Split mk (base64url) into `n` shares (base64url strings); any `k` reconstruct it. Requires 2 ≤ k ≤ n ≤ 255. */
export function shamirSplit(mk, k, n) {
  const secret = ub64(mk)
  if (!secret.length) throw new Error('shamirSplit needs a key')
  if (!(k >= 2 && k <= n && n <= 255)) throw new Error('need 2 ≤ k ≤ n ≤ 255')
  const shares = []
  for (let j = 1; j <= n; j++) shares.push({ x: j, y: new Uint8Array(secret.length) })
  for (let bi = 0; bi < secret.length; bi++) {
    const coeffs = new Uint8Array(k)
    coeffs[0] = secret[bi] // f(0) = the secret byte
    const rc = rand(k - 1)
    for (let c = 1; c < k; c++) coeffs[c] = rc[c - 1] // random higher coefficients
    for (const s of shares) {
      let y = 0 // Horner: f(x) = ((c_{k-1}·x + c_{k-2})·x + …)·x + c_0
      for (let c = k - 1; c >= 0; c--) y = mul(y, s.x) ^ coeffs[c]
      s.y[bi] = y
    }
  }
  return shares.map((s) => b64(Uint8Array.of(s.x, ...s.y)))
}

/** Reconstruct mk (base64url) from ≥ k shares. Fewer than k → a WRONG value (verify with commit()). Order-independent;
 *  duplicate x's are rejected. */
export function shamirCombine(shareStrings) {
  const pts = (shareStrings || []).map((s) => { const a = ub64(s); return { x: a[0], y: a.slice(1) } }).filter((p) => p.x)
  if (pts.length < 2) return null
  const xs = pts.map((p) => p.x)
  if (new Set(xs).size !== xs.length) return null // duplicate share indices
  const len = pts[0].y.length
  const out = new Uint8Array(len)
  for (let bi = 0; bi < len; bi++) {
    let acc = 0
    for (let j = 0; j < pts.length; j++) {
      let num = 1
      let den = 1
      for (let m = 0; m < pts.length; m++) {
        if (m === j) continue
        num = mul(num, pts[m].x) // (0 - x_m) = x_m in GF(256)
        den = mul(den, pts[j].x ^ pts[m].x) // (x_j - x_m) = x_j XOR x_m
      }
      acc ^= mul(pts[j].y[bi], div(num, den)) // y_j · L_j(0)
    }
    out[bi] = acc
  }
  return b64(out)
}
