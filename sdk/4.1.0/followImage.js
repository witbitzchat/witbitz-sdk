// followImage.js — AN ENCLAVE IMAGE THE APP DOES NOT PIN, ACCEPTED BY ITS RELEASE LOG (docs/release-trust-design.md § 6; the owner,
// 2026-11-23: "Do the plan as you recommend"). Until now a new cloud-device image needed its PCR0 in cloudDevicePins.js and an
// Official release BEFORE the switch. Now the app also accepts the newest FOLLOW_WINDOW images of that subject whose release records
// verify HERE: made by a build enclave this app trusts (its anchors + the whole chain, sentinelRelease.js), for THIS record, signed by
// the key its attestation names, the image rebuilt from its source. The log comes from Witbitz's server (then this app's own site) —
// a carrier only: it can withhold a record, never invent one. The window is a policy: an old image is not brought back. A bad image
// is stopped by IMAGE_DENY (compiled in, held equal to agent/followImage.mjs by a test). The KMS key policy that releases an image's
// secrets stays an explicit list, moved by hand — following never hands a new image the data by itself.
import { BUILD_ENCLAVE_PCR0, trustedBuilders, chainFromSite, recordPcrBy } from './sentinelRelease.js'
import { verifyAttestation } from './nitroVerify.js'

export const FOLLOW_WINDOW = 2 // the newest two that verify: a rollover's new image and the one it replaces
export const FOLLOWED_SUBJECTS = Object.freeze(['cloud-device', 'tools-enclave'])
export const IMAGE_DENY = Object.freeze({ 'cloud-device': Object.freeze([]), 'tools-enclave': Object.freeze([]) })
export const TRUST_BASE = 'https://api.witbitz.chat/v1/trust/'

/** The passing records of `subject` in a log's text (jsonl), newest first. */
export function recordsOfLogText (text, subject) {
  const out = []
  for (const l of String(text || '').split('\n')) { try { const r = JSON.parse(l); if (r && typeof r === 'object' && r.subject === subject && r.verdict === 'pass') out.push(r) } catch { /* not a record */ } }
  return out.reverse()
}

const _logs = new Map()
/** One subject's passing records — the server first, this app's site second; once per page (nothing read: asked again next time). */
export function subjectLog (subject, { fetchFn = (typeof fetch === 'function' ? fetch : null) } = {}) {
  if (!fetchFn || !FOLLOWED_SUBJECTS.includes(subject)) return Promise.resolve([])
  if (typeof process !== 'undefined' && process.env && process.env.NODE_TEST_CONTEXT && fetchFn === globalThis.fetch) return Promise.resolve([]) // tests read no network
  if (!_logs.has(subject)) {
    _logs.set(subject, (async () => {
      for (const u of [TRUST_BASE + subject + '.jsonl', '/audit/releases/' + subject + '.jsonl']) {
        try {
          const res = await fetchFn(u, { cache: 'no-store' })
          if (!res || res.status !== 200 || /text\/html/.test((res.headers && res.headers.get && res.headers.get('content-type')) || '')) continue
          const l = recordsOfLogText(await res.text(), subject)
          if (l.length) return l
        } catch { /* the next */ }
      }
      return []
    })().then((l) => { if (!l.length) _logs.delete(subject); return l }))
  }
  return _logs.get(subject)
}

/** The newest `window` images of `subject` whose records verify here (never the denied): [{ pcr0, measurement }] — a tools-enclave
 *  image's measurement names the tool registers it was released with, so a PCR0 and a register are held to the SAME release. */
export async function followedImageRecords (subject, { window = FOLLOW_WINDOW, fetchFn, verify = verifyAttestation, builders = null, records = null } = {}) {
  try {
    const recs = records || await subjectLog(subject, fetchFn ? { fetchFn } : {})
    if (!recs.length) return []
    const trusted = builders || await trustedBuilders(await chainFromSite(fetchFn ? { fetchFn } : {}), { anchors: BUILD_ENCLAVE_PCR0, verify, max: Infinity })
    const deny = IMAGE_DENY[subject] || []
    const out = []
    for (const r of recs) {
      if (out.length >= window) break
      try { const { pcr0 } = await recordPcrBy(r, subject, trusted, verify); if (!deny.includes(pcr0) && !out.some((x) => x.pcr0 === pcr0)) out.push({ pcr0, measurement: r.measurement || {} }) } catch { /* not this one */ }
    }
    return out
  } catch { return [] }
}

/** The PCR0s of the newest `window` images of `subject` whose records verify here (never the denied). Never throws. */
export async function followedImages (subject, opts = {}) { return (await followedImageRecords(subject, opts)).map((x) => x.pcr0) }

/** An attestation check for a tools-enclave image + one tool register: the pins first; on "not this build", the followed images, each
 *  PCR0 paired with ITS register (never mixed). `check(pcr0List, registerList)` → the verified document (throws as verifyAttestation). */
export async function checkToolPaired (check, pins, register, { follow = followedImageRecords } = {}) {
  try { return await check(pins.pcr0, pins.register) } catch (e) {
    if (!follow || !/PCR\d+ mismatch/.test(String((e && e.message) || e))) throw e
    const pairs = (await follow('tools-enclave')).map((m) => ({ p0: m.pcr0, reg: String((m.measurement && m.measurement['pcr' + register]) || '').toLowerCase() })).filter((x) => /^[0-9a-f]{96}$/.test(x.reg))
    if (!pairs.length) throw e
    let doc
    try { doc = await check(pairs.map((x) => x.p0), pairs.map((x) => x.reg)) } catch { throw e } // neither: the pins' own reason
    const g0 = String(doc.pcrs[0] || '').toLowerCase(), gR = String(doc.pcrs[register] || '').toLowerCase()
    if (!pairs.some((x) => x.p0 === g0 && x.reg === gR)) throw new Error('attestation: the image and the tool register are from different releases')
    return doc
  }
}

/** The PCR0s an attestation of `subject` may name: this build's pins, then the followed images. */
export async function acceptedImages (subject, pins, opts = {}) {
  const deny = IMAGE_DENY[subject] || []
  const own = (pins || []).map((x) => String(x).toLowerCase()).filter((x) => !deny.includes(x))
  const more = (await followedImages(subject, opts)).filter((x) => !own.includes(x))
  return [...own, ...more]
}
