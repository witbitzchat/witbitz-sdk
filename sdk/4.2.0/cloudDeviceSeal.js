// cloudDeviceSeal.js — EVERY REQUEST TO THE CLOUD DEVICE, SEALED TO ITS ENCLAVE (docs/cloud-device-enclave-plan.md § 4). One writer
// for the regular app (spaceClient.cloudDevice) and the hosted app's vault (vault-loader.js cloudDevicePost):
//   1. op 'clouddevice' {t:'attest', nonce} → the device's attestation; held to CLOUD_DEVICE_PCR0 and role "clouddevice";
//   2. the request sealed to the attested share key (sealShare.js — the Sentinel's scheme), carrying the person's OWN sign-in
//      (the device acts for the account it names, never the Lambda's word) and a one-time answer key;
//   3. op 'clouddevice' {t:'sealed', sealed} → the answer, sealed under that key, opened here.
// The Space Lambda carries both and can read neither. No pins → REFUSED (sync sweep 11-22: it sent the plain request, a fallback for
// the EC2 prototype, retired 2026-11-17 — an empty pin list must never mean "in the clear").
import { verifyAttestation } from './nitroVerify.js'
import { sealTo } from './sealShare.js'
import { CLOUD_DEVICE_PCR0 } from './cloudDevicePins.js'
import { followedImages } from './followImage.js' // an image this build does not pin, accepted by its release log (docs/release-trust-design.md § 6)

const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)))
const unb64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0))
const refuse = (error, message, status = 502, detail = '') => ({ status, ok: false, error, message, ...(detail ? { detail: String(detail).slice(0, 200) } : {}) })

/** post(body) → { status, ...answer } (the Space API). cd = { t, … }. → the device's answer as a plain post would give it. */
export async function cloudDeviceCall (post, cd, idToken, { pins = CLOUD_DEVICE_PCR0, verify = verifyAttestation, now, follow = followedImages } = {}) {
  if (!pins || !pins.length) return refuse('no_pins', 'This app names no cloud device build, so nothing was sent to it.')
  const nonce = crypto.getRandomValues(new Uint8Array(32))
  const a = await post({ op: 'clouddevice', cd: { t: 'attest', nonce: b64(nonce) }, idToken })
  if (!a || a.status !== 200 || typeof a.doc !== 'string') return a && a.status && a.status !== 200 ? a : refuse((a && a.error) || 'attest_failed', 'The cloud device could not show what it runs.')
  let doc
  const check = (list) => verify(unb64(a.doc), { nonce, expectedPCRs: { 0: [...list] }, maxAgeMs: 5 * 60_000, ...(now ? { now } : {}) })
  try { doc = await check(pins) } catch (e) {
    // NOT THIS BUILD'S PIN: the newest cloud-device images whose release records verify here (followImage.js) — else refused, as before
    const more = follow ? (await follow('cloud-device')).filter((p) => !pins.includes(p)) : []
    try { if (!more.length) throw e; doc = await check([...pins, ...more]) } catch (e2) {
      return refuse('attestation', 'The cloud device is not running the published Witbitz image, so nothing was sent to it.', 502, (e2 && e2.message) || e2)
    }
  }
  let said = null; try { said = JSON.parse(new TextDecoder().decode(doc.userData || new Uint8Array(0))) } catch { said = null }
  if (!said || said.role !== 'clouddevice' || !doc.publicKey) return refuse('attestation', 'The attestation does not name a cloud device, so nothing was sent to it.', 502, 'role ' + (said && said.role))
  const key = await crypto.subtle.importKey('spki', doc.publicKey, { name: 'ECDH', namedCurve: 'P-384' }, false, [])
  const answerRaw = crypto.getRandomValues(new Uint8Array(32))
  const hint = a.hint && typeof a.hint === 'object' ? a.hint : null // the Lambda's word on the token's issuer (a hosted-app sign-in's own) — the enclave checks it
  const sealed = await sealTo(key, nonce, { ...cd, idToken, ...(hint ? { hint } : {}), answerKey: b64(answerRaw) })
  const r = await post({ op: 'clouddevice', cd: { t: 'sealed', sealed }, idToken })
  if (!r || r.status !== 200) return r
  if (!r.sealed || typeof r.sealed.iv !== 'string' || typeof r.sealed.ct !== 'string') return r.ok === false ? { status: 200, ok: false, error: r.error, message: r.message } : refuse('unsealed', 'The cloud device\'s answer was not sealed to this request.')
  let ans
  try {
    const k = await crypto.subtle.importKey('raw', answerRaw, 'AES-GCM', false, ['decrypt'])
    ans = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(r.sealed.iv) }, k, unb64(r.sealed.ct))))
  } catch { return refuse('unsealed', 'The cloud device\'s answer did not open.') }
  const { re: _re, ...rest } = ans || {}
  return { status: 200, ...rest }
}
