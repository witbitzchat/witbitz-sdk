// turnCerts.js — verify every reply's TURN CERTIFICATE in an enclave room, on this device (docs/turn-certificates.md).
//
// Each certified reply carries `cert` (signed inside the enclave) and, once per room per enclave boot, `certDoc` (the
// Nitro attestation whose public_key is the signing key). A reply is VERIFIED when all of these hold:
//   1. its certDoc is a genuine Nitro attestation (AWS root, COSE signature), checked as of its own timestamp;
//   2. that document's public_key hashes to the cert's kid, and its PCR0/16/17 equal the cert's;
//   3. the build has a PASS verdict in the published audit log (/audit/turn-enclave.jsonl — what pin D gates repins on);
//   4. the ECDSA signature verifies over the canonical body, the body names THIS room and this entry, and its `text`
//      is sha256 of the reply exactly as the ledger holds it.
// History older than the first certified reply is "before certificates" — never a failure. A reply AFTER a certified
// one with no certificate IS a failure: the enclave signs every reply, so a missing one means something else wrote it.
import { verifyAttestation, b64ToBytes, toHex } from './nitroVerify.js'

// Beside THIS module, on the Witbitz origin — also when the SDK imports it into a builder's page (served CORS-open).
const AUDIT_LOG = new URL('/audit/turn-enclave.jsonl', String(import.meta.url).startsWith('blob:') ? location.href : import.meta.url).href // a module run from a blob: (the vault's copy, plan step 8) resolves against the page // root-absolute: the log is live data at the site root, also for a versioned SDK copy under /sdk/<v>/
const enc = new TextEncoder()
const sha256Hex = async (s) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s)))

/** Byte-identical to agent/turnCert.mjs canonical(): object keys sorted at every depth. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  return JSON.stringify(v === undefined ? null : v)
}
// Repin 33/34 certificates recorded the receipt's model OBJECT as "[object Object]" (fixed in turnCert.mjs). The record
// is signed as it is, so it cannot be repaired — only read sensibly.
const modelName = (k) => (k && k.model && k.model !== '[object Object]' ? k.model : 'the model') + (k && k.provider ? ` on ${k.provider}` : '')
const certBody = (c) => { const { sig, ...rest } = c || {}; return rest }
// v2 (docs/rats-eat.md): the signature covers the JWT signing input, so the certificate IS a JWT EAT (RFC 9711).
const b64uText = (t) => { const u = new TextEncoder().encode(t); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
export const EAT_JWT_HEADER = b64uText(canonical({ alg: 'ES256', typ: 'JWT' }))
export const signingInput = (body) => EAT_JWT_HEADER + '.' + b64uText(canonical(body))
/** A v2 certificate as its standard JWT EAT — eat.js verifyEat(token, { key: <the certDoc's public_key> }). */
export const certToEat = (c) => (c && c.v === 2 && c.sig ? signingInput(certBody(c)) + '.' + c.sig : null)
const b64urlToBytes = (s) => b64ToBytes(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4))

// The audit log, cached per fetch function. A build missing from it re-reads it (at most once a minute): a repin's
// verdict is published with the release, and a page open across that release must not call the new build unaudited.
const _verdicts = new WeakMap() // fetchImpl → { at, list: Promise<verdict[]> }
const REREAD_MS = 60_000
function readLog(fetchImpl) {
  return (async () => {
    const r = await fetchImpl(AUDIT_LOG, { cache: 'no-store' })
    if (!r.ok) throw new Error('audit log http ' + r.status)
    return (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  })()
}
async function verdictFor(fetchImpl, pcrs) {
  let c = _verdicts.get(fetchImpl)
  if (!c) { c = { at: Date.now(), list: readLog(fetchImpl) }; _verdicts.set(fetchImpl, c) }
  let list
  try { list = await c.list } catch (e) { _verdicts.delete(fetchImpl); throw e }
  let hit = passFor(list, pcrs)
  if (!hit && Date.now() - c.at > REREAD_MS) {
    const fresh = { at: Date.now(), list: readLog(fetchImpl) }
    _verdicts.set(fetchImpl, fresh)
    try { hit = passFor(await fresh.list, pcrs) } catch { _verdicts.delete(fetchImpl) }
  }
  return hit
}
function passFor(verdicts, pcrs) {
  const p16 = String(pcrs && pcrs[16] || '').toLowerCase(), p17 = String(pcrs && pcrs[17] || '').toLowerCase()
  return verdicts.find((v) => v.verdict === 'pass' && v.measurement && String(v.measurement.pcr16).toLowerCase() === p16 && String(v.measurement.pcr17).toLowerCase() === p17) || null
}

const _docs = new Map() // kid → Promise<{ key, pcrs, at } | { error }>
// An ERROR is not kept (state machines pass 7, T#7): one bad copy of a key's attestation (a damaged or forged doc in the history,
// a verify at a bad moment) failed every later reply signed by that key for the page's life, even once the genuine doc arrived.
async function docFor(kid, certDocB64, opts) {
  if (!_docs.has(kid)) {
    const p = (async () => {
      try {
        const doc = await verifyAttestation(b64ToBytes(certDocB64), { atDocTime: true, ...(opts.root ? { root: opts.root } : {}) })
        if (!doc.publicKey) return { error: 'the attestation carries no signing key' }
        if ((await sha256Hex(doc.publicKey)).slice(0, 16) !== kid) return { error: 'the attestation is for a different key' }
        const key = await crypto.subtle.importKey('spki', doc.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
        return { key, pcrs: doc.pcrs, at: doc.timestamp }
      } catch (e) { return { error: 'the attestation does not verify: ' + String((e && e.message) || e).slice(0, 120) } }
    })()
    _docs.set(kid, p)
    p.then((d) => { if (d && d.error && _docs.get(kid) === p) _docs.delete(kid) })
  }
  return _docs.get(kid)
}

/** Verify one certified entry. → { ok: true, build } | { ok: false, reason } */
export async function verifyEntryCert(entry, { room, docs, fetchImpl = fetch, root } = {}) {
  const c = entry && entry.cert
  if (!c || (c.v !== 1 && c.v !== 2) || !c.kid || !c.sig) return { ok: false, reason: 'no certificate' }
  if (c.room !== room) return { ok: false, reason: 'the certificate is for another room' }
  if (c.id !== entry.id || c.ts !== entry.ts) return { ok: false, reason: 'the certificate is for another message' }
  const docB64 = docs.get(c.kid)
  // NOT a failure: the proof rides only the first reply after each enclave boot, and this device keeps the room's last 200
  // messages — it may simply not hold that reply. Soft (never cached), and the page reads the older history for it.
  if (!docB64) return { ok: false, reason: 'the attestation for this key is not on this device yet', soft: true, missingDoc: true }
  const d = await docFor(c.kid, docB64, { root })
  if (d.error) return { ok: false, reason: d.error }
  for (const i of [0, 16, 17]) if (String(d.pcrs[i] || '').toLowerCase() !== String((c.pcrs || {})[i] || '').toLowerCase()) return { ok: false, reason: `PCR${i} differs from the attested build` }
  let ok = false
  try { ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, d.key, b64urlToBytes(c.sig), enc.encode(c.v === 2 ? signingInput(certBody(c)) : canonical(certBody(c)))) } catch { ok = false }
  if (!ok) return { ok: false, reason: 'the signature does not verify' }
  if (c.text !== await sha256Hex(String(entry.text || ''))) return { ok: false, reason: 'the reply was changed after it was signed' }
  let verdict = null
  try { verdict = await verdictFor(fetchImpl, c.pcrs) } catch { return { ok: false, reason: 'the audit log could not be read', soft: true } }
  if (!verdict) return { ok: false, reason: 'this build has no passing audit verdict', soft: true } // soft: re-checked, never cached as final
  return { ok: true, build: { pcr16: c.pcrs[16], pcr17: c.pcrs[17], audit: String(verdict.source && verdict.source.commit || '').slice(0, 8) } }
}

/** A copy the SERVER vouches for (pass 9, X#2): a lane's `sh:` line, or one it stamped `carried`. Not every mirrored entry. */
const vouchedCopy = (e) => !!e && e.source === 'shared' && (String(e.id == null ? '' : e.id).startsWith('sh:') || !!(e.carried && typeof e.carried === 'object'))

/** Verify a room's whole history. → { verified, failed: [{ id, reason }], before, copies, builds, calls, tools } */
export async function verifyRoom(entries, { room, fetchImpl = fetch, root, cache = new Map(), docs: known } = {}) {
  const docs = new Map(known || []) // proofs found in older history this device read on purpose (setCertDocFetcher)
  for (const e of entries) if (e && e.certDoc && e.cert && e.cert.kid && !docs.has(e.cert.kid)) docs.set(e.cert.kid, e.certDoc)
  const out = { verified: 0, failed: [], unchecked: 0, missing: new Set(), before: 0, copies: 0, builds: new Map(), calls: new Map(), tools: new Map() }
  let started = false
  for (const e of entries) {
    if (!e || !e.self || e.sys) continue // the enclave certifies the ASSISTANT's replies
    // ⛔ A COPY FROM THE SPACE IS NOT A REPLY OF THIS ROOM (the owner, 2026-11-11: "⚠ 2 UNVERIFIED" on a confidential Space's
    //   private assistant). A lane's mirror copies the Space's messages in (agent/spaceService.mjs sets `source: 'shared'`, and keeps
    //   `self` on the Space's assistant's replies so they draw as Markdown). This room's enclave turn never signed them, so each
    //   one after the lane's first certified reply read "no certificate". Counted as copies, never as failures.
    // ⚑ WIDER THAN roomName.js isLaneCopy BY ONE CASE (sync sweep 2026-11-12, Unclear): a copy CARRIED into a lane that was moved
    //   (`carried`; isLaneCopy says no, for the render) is still not this room's reply — under the narrower rule a moved lane's
    //   carried copies, which sit after its carried certified replies, would read "no certificate" again.
    // ⛔ BUT NOT "EVERYTHING THAT CAME THROUGH op mirror" (state machines pass 9, X#2). `source: 'shared'` is stamped by the server
    //   on every mirrored text entry, with the sender's `self` kept — so any member of a confidential Space could put an
    //   "assistant" reply into the SHARED room through `mirror` and it was exempt here: drawn as the assistant's, never flagged.
    //   The certificate is the only thing that tells the enclave's reply from a key holder's text. A copy is what the SERVER
    //   vouches for: an `sh:` line of a lane (drawn as a copy), or one it stamped `carried` (never taken from a client —
    //   agent/spaceService.mjs carriedMarks). An imported chat's reply added after the room's first certified one is, truly,
    //   not certified.
    if (!e.cert && vouchedCopy(e)) { out.copies++; continue }
    if (!e.cert) { if (started) out.failed.push({ id: e.id, reason: 'no certificate' }); else out.before++; continue }
    started = true
    const key = e.id + '|' + e.cert.sig
    let v = cache.get(key)
    if (!v) { v = await verifyEntryCert(e, { room, docs, fetchImpl, root }); if (!v.soft) cache.set(key, v) }
    if (!v.ok && v.missingDoc) { out.unchecked++; out.missing.add(e.cert.kid); continue } // not on this device yet — not a failure
    if (!v.ok) { out.failed.push({ id: e.id, reason: v.reason }); continue }
    out.verified++
    const b = out.builds.get(v.build.pcr16) || { ...v.build, replies: 0 }
    b.replies++; out.builds.set(v.build.pcr16, b)
    for (const k of e.cert.calls || []) { const n = `${modelName(k)} · ${k.policy || k.tier || '?'}`; out.calls.set(n, (out.calls.get(n) || 0) + 1) }
    for (const t of e.cert.tools || []) {
      for (const r of t.ran || []) {
        const where = r.in === 'tinfoil' ? `Tinfoil ${r.repo ? r.repo.split('/').pop() : r.host}${r.release ? ' ' + r.release : ''}` : r.in === 'nitro-tools' ? 'Witbitz tools enclave' : 'this enclave'
        const n = `${t.name} → ${where}`; out.tools.set(n, (out.tools.get(n) || 0) + 1)
      }
    }
  }
  return out
}

// ── the page: entries noted as they render, the room re-verified (debounced), the badge + sheet fed from the result ──
const _rooms = new Map() // room → { entries: Map(id → entry), cache, result, timer }
let _onChange = () => {}
let _opts = {} // { root, fetchImpl } — tests only (a synthetic Nitro chain); the page uses AWS's root and fetch
export const configureCerts = (o = {}) => { _opts = { ...o } }
export const onCertChange = (fn) => { _onChange = typeof fn === 'function' ? fn : () => {} }
// The room's OLDER history, read once when a proof is not on this device (the owner, 2026-10-11: "26 unverified" in Help —
// the proofs were in replies past the 200 messages a device keeps). `fn(room)` → that room's entries. The page sets it.
let _fetchHistory = null
export const setCertDocFetcher = (fn) => { _fetchHistory = typeof fn === 'function' ? fn : null }
function verifySoon(room, r) {
  clearTimeout(r.timer)
  r.timer = setTimeout(async () => {
    const list = [...r.entries.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0))
    try { r.result = await verifyRoom(list, { room, cache: r.cache, docs: r.docs, ..._opts }) } catch { /* a verifier fault is not a verdict */ }
    try { _onChange(room) } catch { /* */ }
    if (r.result && r.result.missing.size && _fetchHistory && !r.fetched) { // look the missing proofs up, once per room per page
      r.fetched = true
      try {
        for (const e of (await _fetchHistory(room)) || []) if (e && e.certDoc && e.cert && e.cert.kid && !r.docs.has(e.cert.kid)) r.docs.set(e.cert.kid, e.certDoc)
      } catch { /* stays unchecked — still not a failure */ }
      verifySoon(room, r)
    }
  }, 300)
}
export function noteEntry(room, e) {
  if (!room || !e || e.id == null || !(e.cert || e.self)) return
  let r = _rooms.get(room)
  if (!r) { r = { entries: new Map(), cache: new Map(), docs: new Map(), fetched: false, result: null, timer: 0 }; _rooms.set(room, r) }
  r.entries.set(String(e.id), e)
  verifySoon(room, r)
}
export const roomCertResult = (room) => (_rooms.get(room) || {}).result || null

/** The badge's suffix: '' when every reply verified (the owner, 2026-10-14: "don't show the count next to the enclave" —
 *  the count is in the enclave sheet), or '⚠ N UNVERIFIED' with `warn` — a failure is a warning, and it stays. */
export function certBadge(room) {
  const r = roomCertResult(room)
  if (!r || !r.failed.length) return { text: '', warn: false }
  return { text: `⚠ ${r.failed.length} UNVERIFIED`, warn: true }
}

/** The Certificates section of the enclave sheet. */
export function renderCertSection(el, room) {
  if (!el) return
  const r = roomCertResult(room)
  el.textContent = ''
  const line = (t, cls) => { const d = document.createElement('div'); d.textContent = t; if (cls) d.className = cls; el.appendChild(d); return d }
  line('Turn certificates', 'tc-h')
  // a private lane's copies of the Space's replies: said, so nobody wonders why they carry no certificate here
  const copies = () => { if (r && r.copies) line(`${r.copies} ${r.copies === 1 ? 'reply' : 'replies'} copied from the Space ${r.copies === 1 ? 'is' : 'are'} not this room’s — no certificate here.`) }
  if (r && !r.verified && !r.failed.length && r.unchecked) { line(`${r.unchecked} ${r.unchecked === 1 ? 'reply' : 'replies'} not checked yet — their proof is in older messages; looking it up.`); copies(); return }
  if (!r || (!r.verified && !r.failed.length)) { line(r && r.before ? `No certified replies yet (${r.before} from before certificates).` : 'No certified replies yet.'); copies(); return }
  line(`${r.verified} ${r.verified === 1 ? 'reply' : 'replies'} verified on this device${r.failed.length ? `, ${r.failed.length} failed` : ''}${r.unchecked ? `, ${r.unchecked} not checked yet (their proof is in older messages)` : ''}${r.before ? ` · ${r.before} from before certificates` : ''}.`)
  for (const b of r.builds.values()) line(`Build ${String(b.pcr16).slice(0, 12)}… · audited PASS @ ${b.audit} · ${b.replies} ${b.replies === 1 ? 'reply' : 'replies'}`)
  for (const [n, c] of r.calls) line(`Model: ${n} ×${c}`)
  for (const [n, c] of r.tools) line(`Tool: ${n} ×${c}`)
  for (const f of r.failed.slice(0, 5)) line(`⚠ ${f.reason}`, 'tc-bad')
  copies()
}

/** The long-press sheet's lines for one reply: its own verdict, what produced it, what it called. */
export function describeEntryCert(room, e) {
  if (!e || !e.self) return []
  const c = e.cert
  if (!c && vouchedCopy(e)) return ['↗ A copy from the Space — not a reply of this room, so it carries no turn certificate here.']
  if (!c) {
    const r = roomCertResult(room)
    return r && r.failed.some((f) => f.id === e.id) ? ['⚠ No turn certificate — every reply after the first certified one should carry one.'] : []
  }
  const v = ((_rooms.get(room) || {}).cache || new Map()).get(e.id + '|' + c.sig)
  const lines = [!v ? '🔏 Turn certificate — checking…' : v.ok
    ? `🔏 Turn certificate verified on this device: enclave build ${String(c.pcrs && c.pcrs[16]).slice(0, 12)}…, audited PASS @ ${v.build.audit}.`
    : `⚠ Turn certificate NOT verified: ${v.reason}.`]
  return lines.concat(certCallLines(c))
}

/** What a certified reply called, GROUPED so it fits the long-press menu (2026-10-05, the owner: a turn with 5 model calls
 *  and 23 tool calls drew 29 lines and pushed Reply/Copy off the screen). One line per model+route with its call count
 *  (a single call keeps its receipt id), one line per place the tools ran with each tool's count in first-seen order,
 *  and a failed tool on a line of its own. The facts are the certificate's; only the layout changed. */
export function certCallLines(c) {
  const out = []
  const models = new Map() // label → { n, jti }
  for (const k of (c && c.calls) || []) {
    const label = `${modelName(k)} via ${k.policy || k.tier || 'an attested upstream'}`
    const m = models.get(label) || { n: 0, jti: k.jti }; m.n++; models.set(label, m)
  }
  for (const [label, m] of models) out.push(`Model: ${label}` + (m.n > 1 ? ` — ${m.n} calls` : ` (receipt ${String(m.jti || '').slice(0, 12)}…)`))
  const places = new Map() // where → Map(tool name → count)
  const failed = []
  for (const t of (c && c.tools) || []) {
    const where = (t.ran || []).map((r) => (r.in === 'tinfoil' ? `Tinfoil ${r.repo || r.host}${r.release ? ' ' + r.release : ''}` : r.in === 'nitro-tools' ? 'the Witbitz tools enclave' : 'this enclave')).join(', ') || 'this enclave'
    if (t.error) { failed.push(`Tool failed: ${t.name} → ${where}`); continue }
    const tools = places.get(where) || new Map(); tools.set(t.name, (tools.get(t.name) || 0) + 1); places.set(where, tools)
  }
  for (const [where, tools] of places) out.push(`Tools → ${where}: ` + [...tools].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(', '))
  return out.concat(failed)
}
