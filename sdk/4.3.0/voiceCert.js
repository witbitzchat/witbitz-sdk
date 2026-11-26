// voiceCert.js — the press-to-talk certificate on a dictated message (docs/turn-certificates.md § Press-to-talk).
//
// op:'stt' answers with { cert, bundleGz }: Witbitz verified inference.tinfoil.sh's attestation (AMD root, the
// Sigstore-signed release, the TLS key) before it issued the key. A message the member dictated carries `voice` with
// that certificate. The raw ATC evidence (`bundleGz`, ~21 KB) rides only the FIRST dictated message per room per bundle,
// so the room keeps it once per Tinfoil release rather than once per message; this device remembers which it sent.

const SENT_KEY = 'wbVoiceBundles'
const MAX_ROOMS = 200

function sentMap() {
  try { const m = JSON.parse(localStorage.getItem(SENT_KEY) || '{}'); return m && typeof m === 'object' ? m : {} } catch { return {} }
}

/** The `voice` field for a message about to be sent. `stt` = the op:'stt' answer the dictation used. */
export function voicePayload(room, stt) {
  if (!stt || !stt.cert || !stt.cert.bundle) return null
  const m = sentMap()
  const had = Array.isArray(m[room]) && m[room].includes(stt.cert.bundle)
  if (!had) {
    m[room] = [...(Array.isArray(m[room]) ? m[room] : []), stt.cert.bundle].slice(-8)
    const rooms = Object.keys(m)
    for (const r of rooms.slice(0, Math.max(0, rooms.length - MAX_ROOMS))) delete m[r]
    try { localStorage.setItem(SENT_KEY, JSON.stringify(m)) } catch { /* the bundle simply rides again next time */ }
  }
  return { model: stt.model || undefined, cert: stt.cert, ...(!had && stt.bundleGz ? { bundleGz: stt.bundleGz } : {}) }
}

const short = (h) => String(h || '').slice(0, 12)
const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) } catch { return String(iso || '') } }

// What served the endpoint, and what Certificate Transparency says could have (agent/sttAudit.mjs).
function auditLine(a) {
  if (!a || !a.live) return []
  const live = `${a.live.addresses === 1 ? 'Its one live address serves' : `All ${a.live.addresses} live addresses serve`} the attested key`
  const ct = !a.ct || a.ct.error ? 'Certificate Transparency could not be read' : `${a.ct.valid} valid certificates for the host: ${a.ct.recentVerified} of ${a.ct.recent} issued in the last day verified, ${a.ct.older} older not verifiable`
  return [`${live}. ${ct} (checked ${when(a.checkedAt)}).`]
}

/** Readable lines for the long-press sheet. */
export function describeVoice(entry) {
  const v = entry && entry.voice
  if (!v || !v.cert) return []
  const c = v.cert
  return [
    '🎙 Dictated. Speech-to-text ran in Tinfoil’s confidential enclave' + (v.model ? ` (${v.model})` : '') + '.',
    `Verified by Witbitz before the key was issued, ${when(c.verifiedAt)}: ${c.host} runs ${c.repo}${c.release ? ' ' + c.release : ''} on AMD SEV-SNP.`,
    `Measurement ${short(c.measurement)}… · TLS key ${short(c.tls)}… · evidence ${short(c.bundle)}…`,
    ...auditLine(c.audit),
  ]
}
