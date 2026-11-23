// voiceAttest.js — THE PAGE CHECKS THE VOICE SERVICE ITSELF before it uses a press-to-talk or Play aloud key (docs/stt-cloud.md,
// 2026-10-17). op:'stt' / op:'tts' (agent/sttKey.mjs) mint the key only after the Lambda verified inference.tinfoil.sh's
// attestation, and the answer carries that evidence (`bundleGz`: the gzipped ATC bundle — AMD's SEV-SNP report, the
// Sigstore-signed release, the enclave's TLS certificate) and the certificate made from it (`cert`). The page used to take
// the Lambda's word. Now it verifies the evidence itself with Tinfoil's verifier (tinfoilVerifier.js, offline: AMD's root
// and Sigstore's trust root are compiled in; no network), against the HOST and REPO pinned here, and uses the key only when
// the evidence holds, is the certificate's own (same sha256) and names the certificate's TLS key. Fail closed: no
// microphone and no text to an endpoint the page could not check.
// Honest scope (docs/turn-certificates.md): a browser cannot pin its own websocket's TLS key, so the connection itself is
// ordinary TLS to that host; what this adds is that the PAGE, not only our server, saw the host prove its code.
export const VOICE_HOST = 'inference.tinfoil.sh'
export const VOICE_REPO = 'tinfoilsh/confidential-model-router'

const HEX64 = /^[0-9a-f]{64}$/
const refuse = (why) => Object.assign(new Error('the voice service did not prove what it runs (' + why + ') — not used'), { code: 'voice_unattested' })
let _verifier = null
const loadTinfoilVerifier = () => (_verifier = _verifier || import('./tinfoilVerifier.js').then((m) => m.Verifier).catch((e) => { _verifier = null; throw e }))
const _verified = new Map() // evidence sha256 → the TLS key it proved (this page's lifetime)

async function gunzipText (b64) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const out = new Response(new Response(bin).body.pipeThrough(new DecompressionStream('gzip')))
  return out.text()
}
async function sha256hex (text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Check a speech key's evidence. → the certificate, or throws { code: 'voice_unattested' }. */
export async function checkSpeechKey (k, { loadVerifier = loadTinfoilVerifier, cache = _verified } = {}) {
  const c = k && k.cert
  if (!c || typeof k.bundleGz !== 'string' || !k.bundleGz) throw refuse('no proof came with the key')
  if (c.host !== VOICE_HOST || c.repo !== VOICE_REPO) throw refuse('the certificate is for another service')
  const tls = String(c.tls || '').toLowerCase(), sum = String(c.bundle || '').toLowerCase()
  if (!HEX64.test(tls) || !HEX64.test(sum)) throw refuse('the certificate is incomplete')
  if (cache.get(sum) === tls) return c
  let bundle
  try {
    const text = await gunzipText(k.bundleGz)
    if (await sha256hex(text) !== sum) throw new Error('the evidence is not the certificate\'s')
    bundle = JSON.parse(text)
  } catch (e) { throw refuse(String((e && e.message) || 'unreadable evidence')) }
  if (!bundle || bundle.domain !== VOICE_HOST) throw refuse('the evidence is for another host')
  let r
  try { const V = await loadVerifier(); r = await new V({ configRepo: VOICE_REPO }).verifyBundle(bundle) } catch (e) { throw refuse('the evidence does not verify') }
  if (String((r && r.tlsPublicKeyFingerprint) || '').toLowerCase() !== tls) throw refuse('the evidence names another TLS key')
  cache.set(sum, tls)
  return c
}
