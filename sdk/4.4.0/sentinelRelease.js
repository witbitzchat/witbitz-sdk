// sentinelRelease.js — A STANDING SENTINEL BUILD THE APP DOES NOT PIN, CHECKED BY ITS RELEASE RECORD, IN THE BROWSER (docs/standing-sentinel.md
// § Following verified releases; the owner, 2026-11-17: "Make it cheaper"). The Sentinel's front hands, with each attestation, the
// build enclave's signed verdict for the running build. Here it must hold: made by a build-enclave image pinned below (its AWS
// Nitro attestation, verified against the pinned AWS root), for THIS verdict (user_data = sha256 of the verdict without its proofs),
// signed by the key that attestation names (ECDSA P-256), subject standing-sentinel, verdict pass, the image rebuilt from its source.
// Rekor is checked by the Space Lambda and the turn enclave (agent/sentinelFollow.mjs), not here. A build that passes is then
// followed exactly as a published one is: at once with "Accept new Witbitz builds automatically", else the person is asked.
import { verifyAttestation } from './nitroVerify.js'
import { derSigToRaw } from './x509.js'

/** The build-enclave images whose verdicts count — infra/build-enclave/pins.json `buildEnclave` (held equal by a test). */
export const BUILD_ENCLAVE_PCR0 = Object.freeze([
  "c6a8cbd0c05d8e003e75b266f1dde2a6426b7cd61f845e4b128e59063e40968b44f30d934bbe1925582fe33bbdd0b1d7",
  "f490096d57e4287146e8b8d7bf4c75f423984ca52199efab0ee8684fbee6cfe6ab82c72d54f05a38f24a0d4ad6e2f557",
  "41ec7e0e54beac5759fba7efa06c48081dbd96c7299c29c92a9c619036ce057cec357ad4ad71a165d7f881df120b043b",
  "9f0801335a952bdbac70b6793150738d7ce30bc3a0d520fec6f573de22a822aa5ef762f78648bc8608ca0b2eeccda556",
  "a145e8524bbe8764d4db6b81b4e18d72eae42e8b9e1c834e62e22aba18cce318f9eaa84942671c688c3eeb89ec30b0e8",
  "5d29c3691cd38f6c6ce0da2b2f9d1da82712d9da12a89c99d38a03cae6369ebe6ba7a1ab1060cfa9daf6a19228c7a2dc",
  "6c962286faed81c395bcf3d319011f91893cfec723c2dc7069ad8805980d77e99f75c94671881cc793794521fe5d2ff0",
  "578945d0342d346d72e50b36ffe74a3631e53e111bc010394108457e362d10830ebadcc7ec5ffa4445d5b10b9c522d28",
  "7e9f760db923c6f31fd18db06f6b60a53902beb6b0d80b91b5355d33c461e43bcddc31c08e2380ff9dc75c10909e6acb",
  "5b6bffe6953eef271a69e453072b6e202ae024cd3983fff3a637b7421a60ad92ab3fd19f8ae809e19182a3feebbe94c2",
  "551006e397efd43a619b370ef336a6a594d8a8338cd49860e54845330354c73afd3ba673360d50f78e5f1d702e19946b",
  "eecf817c561e633b30632ca434a28ad56ed46395d765172fedcc0742d8d5c9982845d6ce32b6451b943f4b6f0a55ea36",
  "3df18dce5385b467208bfa325d2f812bd622ef6def87ef97e63116310a896427db9f2c69d7c2631bccc9c65549b3d512",
  "a51fcaeafa6d188b46d11710442f981169304aa4feecc4b40263943966c3dd8ff9b986d30989b4152fa1540c85a76b5e",
  "f977e0490f5abfc77c311b426399bddd6909848bb8175db4142885c839e9cc23c3ca0047317b039883dce4b1a2efe096",
  "d5f13dff5647f5f4ee351dd9e1ba9348ecd39da88acd6ffd9c324897b0ca7563da974b08c2e84504a76dc98b48700b74",
  "2babe4262b2a00949eeef5b04a81327eb606dc347caaf507527d04f8847730a31dd26d6d7be3e0a672c537b51c914133",
  "25a0967ec1366bc0ec43e45e2f89c435adb1a3e54d8702d89599acb442337afcb36f8f64d51a6608cefb3bb1e4f6b8ed",
  "8665867cbb86ea3178f4179cf040fdec9e6df22bdd4f1e3d8df6b2d9096db5aecd8420b42203969bbe9446b585c78870",
  "ef738ca713ddc39dc29505d857c2aac22a0598a714163ae01e2879085e1c262cc5bde3c239b7ce76385d10c5910ed487",
  "41de07c0c12f388f9dc7d87cfa835edce2c58be42f6893f227002329d263285bf78bb209cd69c384dd7566097f2a3d47",
  "a77141c4ac00099cbdd9053e0190b70234aa2eccdb22cb358e9b8b0fef5bef6b7ad6d9b5eb73137244a3790f98869505",
  "70dde35fed128d1cb007f8c6edfa3de70e991955e1748aa500ad4685d1c752b1775565fb9a6d11c483969d5596e3b159",
  "f0ea83ee58b3a4a9ebe7c8c74f102eba17118711573b6ce773b6f31ed223564cbf215992b5a7a30462b70281ae624453",
  "f7adfbec8cf3a014f9585c7decc21bb03a50484339811ea3b44947d23fc16aff8eedb56346915b816e83fc5faad55e7a",
  "917f7d95eabd64eabd1145cc0898c08ff414037775fd416162002c4783b4f95dcb550c3c5493baadaf41eaceb0e7da0d",
  "74b1cbd4398f319a636de05d36eaa40953df4dc0bb86769f7ac4e0fe2c576f55b3c4a15a5583048ded80b0b4d303f55e",
  "420088665bd62edcba51dfbcc55cbc85611529985fde54b655a3476198a8f9421e02d1898db28180b153550ceeb66798",
])

const enc = new TextEncoder()
const unb64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0))
const hex = (u8) => [...new Uint8Array(u8)].map((b) => b.toString(16).padStart(2, '0')).join('')
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const PROOFS = ['attestation', 'signature', 'rekor']

/** A release record → the standing Sentinel PCR0 it vouches for, or throws with why. `links`: the build-enclave links its front handed
 *  beside it (docs/trust-root.md) — the record's builder may be one they make trusted from the anchors. */
export async function sentinelPcrOfRelease (r, { builders = BUILD_ENCLAVE_PCR0, links = null, verify = verifyAttestation, site = chainFromSite } = {}) {
  const trusted = Array.isArray(links) && links.length ? await trustedBuilders(links, { anchors: builders, verify }) : builders
  try { return await recordPcr(r, 'standing-sentinel', trusted, verify) } catch (e) {
    // NO LIMIT ON THE CHAIN (the owner, 2026-11-23): the record's builder is newer than this app's anchors and the links handed beside
    // it did not reach it — read the WHOLE log from this app's own site and walk it (each link verified here; the site can withhold
    // one, never invent one). Once per page; a site without the log changes nothing.
    if (!site || !/not made by a build enclave this app trusts/.test(String((e && e.message) || e))) throw e
    const all = [...(Array.isArray(links) ? links : []), ...await site()]
    if (!all.length) throw e
    return recordPcr(r, 'standing-sentinel', await trustedBuilders(all, { anchors: builders, verify, max: Infinity }), verify)
  }
}

/** Every passing build-enclave link Witbitz publishes (CHAIN_URLS), newest first — read once per page. */
let _siteChain = null
// Witbitz's server first (always the current log: published with each build enclave), then this app's own site (the log as of its deploy).
export const CHAIN_URLS = Object.freeze(['https://api.witbitz.chat/v1/trust/build-enclave.jsonl', '/audit/releases/build-enclave.jsonl'])
export function chainFromSite ({ fetchFn = (typeof fetch === 'function' ? fetch : null), urls = CHAIN_URLS } = {}) {
  if (!fetchFn) return Promise.resolve([])
  const own = fetchFn === globalThis.fetch && urls === CHAIN_URLS // only the page's own read is remembered (a caller's fetch is read each time)
  if (own && typeof process !== 'undefined' && process.env && process.env.NODE_TEST_CONTEXT) return Promise.resolve([]) // tests read no network
  if (!own) return readChain(fetchFn, urls)
  return _siteChain || (_siteChain = readChain(fetchFn, urls).then((l) => { if (!l.length) _siteChain = null; return l })) // nothing read: ask again next time
}
function readChain (fetchFn, urls) {
  return (async () => {
    for (const u of urls) {
      try {
        const res = await fetchFn(u, { cache: 'no-store' })
        if (!res || res.status !== 200 || /text\/html/.test((res.headers && res.headers.get && res.headers.get('content-type')) || '')) continue
        const l = linksOfLogText(await res.text())
        if (l.length) return l
      } catch { /* the next */ }
    }
    return []
  })()
}

/** The passing `build-enclave` records in a release log's text (jsonl), newest first — tools/build-enclave/trustedNow.mjs linksOfLog. */
export function linksOfLogText (text) {
  const out = []
  for (const l of String(text || '').split('\n')) { try { const r = JSON.parse(l); if (r && r.subject === 'build-enclave' && r.verdict === 'pass') out.push(r) } catch { /* not a record */ } }
  return out.reverse()
}

// THE CHAIN OF BUILD ENCLAVES, the browser's twin of agent/buildEnclaveChain.mjs (held equal by spaces/test/buildEnclaveChainTwin.test.mjs):
// the anchors + every build enclave a trusted one rebuilt (a `build-enclave` record, checked here as every record is), minus the deny list.
export const BUILD_ENCLAVE_DENY = Object.freeze([])
export const LINKS_MAX = 4 // links one ANSWER may carry (agent/buildEnclaveChain.mjs) — the log read here (chainFromSite) is not capped
// VERIFIED ONCE (as the server's chain): a link that verified is remembered by its signature for this page's life, reused only while
// the builder that signed it is trusted in this walk — never a wider trust, only the same checks not repeated.
const verified = new Map()
export async function trustedBuilders (links = [], { anchors = BUILD_ENCLAVE_PCR0, deny = BUILD_ENCLAVE_DENY, verify = verifyAttestation, max = LINKS_MAX } = {}) {
  const denied = new Set((deny || []).map((x) => String(x).toLowerCase()))
  const trusted = new Set((anchors || []).map((x) => String(x).toLowerCase()).filter((x) => !denied.has(x)))
  const cache = verify === verifyAttestation
  let pending = Array.isArray(links) ? links.slice(0, max) : []
  for (let grew = true; grew && pending.length;) {
    grew = false
    const left = []
    for (const l of pending) {
      try {
        const sig = l && l.signature && typeof l.signature.sig === 'string' ? l.signature.sig : ''
        const known = sig && cache ? verified.get(sig) : null
        let p
        if (known && trusted.has(known.builder) && String((l.measurement && l.measurement.pcr0) || '').toLowerCase() === known.pcr0) p = known.pcr0
        else {
          const got = await recordPcrBy(l, 'build-enclave', [...trusted], verify)
          p = got.pcr0
          if (sig && cache) { if (verified.size >= 4096) verified.delete(verified.keys().next().value); verified.set(sig, got) }
        }
        if (!denied.has(p) && !trusted.has(p)) { trusted.add(p); grew = true }
      } catch (e) { if (/not made by a build enclave this app trusts/.test(String((e && e.message) || e))) left.push(l) }
    }
    pending = left
  }
  return [...trusted]
}

/** A release record of `subject` → the PCR0 it vouches for, made by one of `builders`; or throws with why. */
async function recordPcr (r, subject, builders, verify) { return (await recordPcrBy(r, subject, builders, verify)).pcr0 }

/** The same, with the builder that made it: { pcr0, builder } — any subject (followImage.js uses it for the images the apps follow). */
export async function recordPcrBy (r, subject, builders, verify = verifyAttestation) {
  if (!r || typeof r !== 'object') throw new Error('no release record came with the attestation')
  if (r.subject !== subject || r.verdict !== 'pass') throw new Error(`the record is not a passing ${subject} release`)
  const repro = Array.isArray(r.checks) && r.checks.find((c) => c && c.name === 'reproducible-build')
  if (!repro || repro.ok !== true) throw new Error('the record does not say the image was rebuilt from its source')
  const pcr0 = String((r.measurement && r.measurement.pcr0) || '').toLowerCase()
  if (!/^[0-9a-f]{96}$/.test(pcr0) || (r.claim && String(r.claim.pcr0 || '').toLowerCase() !== pcr0)) throw new Error('the record names no single PCR0')
  if (!r.attestation || !r.attestation.doc || !r.signature || !r.signature.key || !r.signature.sig) throw new Error('the record carries no proof')
  const rest = {}; for (const [k, v] of Object.entries(r)) if (!PROOFS.includes(k)) rest[k] = v
  const art = enc.encode(JSON.stringify(rest))
  const doc = await verify(unb64(r.attestation.doc), { atDocTime: true })
  const builder = String((doc.pcrs && doc.pcrs[0]) || '').toLowerCase()
  if (!builders.includes(builder)) throw new Error('the record was not made by a build enclave this app trusts')
  const want = enc.encode(JSON.stringify({ role: 'build-enclave', verdict: hex(await crypto.subtle.digest('SHA-256', art)) }))
  if (!doc.userData || !same(new Uint8Array(doc.userData), want)) throw new Error('the build enclave\'s attestation is not for this record')
  const spki = unb64(r.signature.key)
  if (!doc.publicKey || !same(new Uint8Array(doc.publicKey), spki)) throw new Error('the record is not signed by the key the build enclave attested')
  const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derSigToRaw(unb64(r.signature.sig), 32), art)
  if (!ok) throw new Error('the record\'s signature does not verify')
  return { pcr0, builder }
}
