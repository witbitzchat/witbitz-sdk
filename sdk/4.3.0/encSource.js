// encSource.js — "REBUILT FROM SOURCE" in a confidential room's sheet (the Hacker News demo's verify step). The build this room's
// enclave attests (its PCR16, verified on this device) is looked up in the build enclave's published releases
// (/audit/releases/turn-enclave.jsonl, docs/build-enclave.md): a passing entry says the attested build enclave rebuilt that
// measurement from a named commit's source, and the entry is in Rekor, the public transparency log, at its logIndex. The row
// links that entry, so anyone can check it without trusting this page.
export const RELEASES_LOG = '/audit/releases/turn-enclave.jsonl'
export const rekorUrl = (logIndex) => `https://search.sigstore.dev/?logIndex=${encodeURIComponent(String(logIndex))}`

/** The newest PASSING release whose claim names `pcr16`, from the log's text → { commit, logIndex, at } | null. */
export function releaseFor (text, pcr16) {
  const want = String(pcr16 || '').toLowerCase()
  if (!/^[0-9a-f]{96}$/.test(want)) return null
  let hit = null
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    const c = e && e.claim, s = e && e.source, r = e && e.rekor
    if (!e || e.verdict !== 'pass' || !c || String(c.pcr16 || '').toLowerCase() !== want) continue
    if (!s || !/^[0-9a-f]{40}$/.test(String(s.commit || '')) || !r || !Number.isInteger(r.logIndex)) continue
    if (!hit || Number(e.at) >= hit.at) hit = { commit: s.commit, logIndex: r.logIndex, at: Number(e.at) || 0 }
  }
  return hit
}

let _log = null // the log's text for this page's life: it changes only with a release
/** Look `pcr16` up in the published log → the release, null (not in it), or undefined (the log could not be read). */
export async function loadReleaseFor (pcr16, fetchImpl = (u, o) => fetch(u, o)) {
  try {
    if (_log === null) { const r = await fetchImpl(RELEASES_LOG, { cache: 'no-cache' }); if (!r || !r.ok) return undefined; _log = await r.text() }
    return releaseFor(_log, pcr16)
  } catch { return undefined }
}
export const _resetLog = () => { _log = null } // tests

/** Fill the sheet's row (label + value span) for the attested build `att`. */
export async function renderEncSource (valueEl, att, deps = {}) {
  if (!valueEl) return
  const pcr16 = att && att.pcrs && att.pcrs[16]
  valueEl.textContent = 'Checking…'
  const rel = pcr16 ? await loadReleaseFor(pcr16, deps.fetch) : null
  if (rel === undefined) { valueEl.textContent = 'Couldn’t read the log'; return }
  if (!rel) { valueEl.textContent = 'Not in the published log'; valueEl.classList.add('enc-bad'); return }
  const a = document.createElement('a')
  a.href = rekorUrl(rel.logIndex); a.target = '_blank'; a.rel = 'noopener noreferrer'
  a.textContent = `Yes · commit ${rel.commit.slice(0, 8)} ↗`
  a.title = `The build enclave rebuilt this measurement from commit ${rel.commit}; Rekor entry ${rel.logIndex}`
  // OUR COPY OF THE RECORD beside the public log's (2026-11-04: search.sigstore.dev said "Load failed" while Rekor did not
  // answer): the signed entry is in the published release log too, so the proof never rests on one third-party page.
  const rec = document.createElement('a')
  rec.href = RELEASES_LOG; rec.target = '_blank'; rec.rel = 'noopener noreferrer'; rec.className = 'enc-rec'
  rec.textContent = 'record ↗'
  rec.title = 'The build enclave\'s signed release record (the same entry as in Rekor), published with this app'
  valueEl.replaceChildren(a, ' · ', rec); valueEl.classList.add('enc-ok')
  return rel
}
