// sdkReport.js — `space.report(message, { reason, note, context })`: REPORT from a builder's page (App Store rule 1.2;
// docs/report-and-block.md §3; sync sweep 2026-11-13 "not in the SDK, not decided"). The same report the Spaces app files
// (reportActions.js, whose body is built from the drawn rows — this one from the SDK's messages): what the member chose to show
// Witbitz — the message, and only if asked the 5 before it — sent in the clear to the front (op `report`, agent/reportOp.mjs),
// which stores it and mails the reports address. Signed in (who reported), and a MEMBER: a token only the room's current key gets
// (op membertoken) is fetched first, as the app does.

/** The reasons the server takes (agent/reportOp.mjs REASONS — sdkAppParityMore.test holds them equal). */
export const REPORT_REASONS = Object.freeze(['harassment', 'threats', 'sexual', 'hate', 'spam', 'other'])
const CONTEXT = 5
const fail = (code, message) => Object.assign(new Error('witbitz: ' + message), { code })
const isPerson = (m) => m && typeof m === 'object' && !m.sys && m.kind !== 'data' && m.kind !== 'fork' && m.kind !== 'title'

/** One message as the report names it: what it said, and who the room says wrote it (`who`: the Block identity — the verified
 *  email / @username and the key that signed it; none for the assistant or an outside agent's relayed line). */
export function reportEntry (m, who, { proof = false } = {}) {
  const files = [...(Array.isArray(m.images) ? m.images : []), ...(Array.isArray(m.files) ? m.files : [])].map((a) => String((a && a.name) || '')).filter(Boolean).slice(0, 10)
  return {
    name: String(m.from || m.name || '').slice(0, 80), text: String(m.text || '').slice(0, 8000), ...(files.length ? { files } : {}), agent: m.self === true,
    ...(who && who.email ? { email: who.email } : {}), ...(who && who.user ? { user: who.user, verified: true } : {}), ...(who && who.sid ? { kid: who.sid } : {}),
    ...(m.ts != null ? { ts: m.ts } : {}), ...(m.id != null ? { id: String(m.id) } : {}),
    // FRANKING (docs/report-and-block.md §2; sync sweep 11-16 #5): the reported message's sealed record and the RAW text it was made
    // over — with them Witbitz can prove the report and act on it, as from the app (reportActions.js). The context carries none.
    ...(proof && typeof m.fr === 'string' ? { fr: m.fr, raw: String(m.text || '') } : {}),
    ...(proof && (m.source === 'shared' || (m.carried && typeof m.carried === 'object')) ? { copied: true } : {}), // #10: a copy from another Space
  }
}

/** The report's body → { room, reason, note, entry, context, confidential? }; throws invalid_argument. */
/** A mirrored copy in a lane → { room, id, fr } of the Space's original; anything else → null (reportActions.js laneOriginal's rule). */
export function laneOriginal (m) {
  if (!m || typeof m.fr !== 'string' || typeof m.frRoom !== 'string' || !m.frRoom) return null
  const id = String(m.id == null ? '' : m.id)
  return id.startsWith('sh:') && id.length > 3 ? { room: m.frRoom, id: id.slice(3), fr: m.fr } : null
}

export function reportBody (space, message, { reason, note = '', context = false } = {}) {
  if (!message || typeof message !== 'object' || message.id == null) throw fail('invalid_argument', 'report(message, { reason }) takes a Message (from "message" or space.messages)')
  if (!REPORT_REASONS.includes(reason)) throw fail('invalid_argument', 'reason is one of ' + REPORT_REASONS.join(', '))
  const who = (m) => (m.self === true ? null : space.blockIdentity(m))
  const before = []
  if (context === true) {
    const list = space.messages || [], at = list.findIndex((m) => m && m.id === message.id)
    for (let i = (at < 0 ? list.length : at) - 1; i >= 0 && before.length < CONTEXT; i--) if (isPerson(list[i])) before.unshift(reportEntry(list[i], who(list[i])))
  }
  return { room: space.room, reason, note: String(note || '').slice(0, 500), entry: reportEntry(message, who(message), { proof: true }), context: before, ...(space._isEnclave() ? { confidential: true } : {}) }
}

/** The whole report: sign-in, member token, the report → { ok: true, id } | { ok: false, error, detail? } (refusals are answers). */
export async function fileReport (space, message, opts = {}) {
  // A LANE COPY of its Space's message (the app's reportActions.js laneOriginal; sync sweep 11-19 P1): the record is the Space's, so
  // the report names the Space and the original's id, and the member token is the Space's — not the lane's
  const orig = laneOriginal(message)
  if (orig && space && space._sharedSpace && space._sharedSpace.room === orig.room) { const { source: _s, carried: _c, frRoom: _r, ...m } = message; return fileReport(space._sharedSpace, { ...m, id: orig.id, fr: orig.fr }, opts) } // the original, not a copy (no `copied`)
  const c = space._client
  if (c && c.vault) throw fail('vault_unsupported', 'a report from a vault is not available yet — the vault holds the sign-in and the room key')
  const body = reportBody(space, message, opts)
  const wb = space._wb
  if (!wb || typeof wb._auth !== 'function') throw fail('sign_in_required', 'sign in first — a report names who sent it')
  const { idToken } = wb._auth('a report belongs')
  if (!c || typeof c.memberToken !== 'function' || typeof c.report !== 'function') throw fail('unavailable', 'this Space cannot file a report here')
  const mt = await Promise.resolve().then(() => c.memberToken(space.room, space._mk)).catch(() => null)
  if (!mt || mt.status !== 200 || !mt.token) return { ok: false, error: 'not_member', detail: 'only a member of this Space can report from it — or email reports@witbitz.chat' }
  let r
  try { r = await c.report(idToken, body, mt.token) } catch (e) { return { ok: false, error: String((e && e.code) || 'unavailable'), detail: 'the report was not sent — try again, or email reports@witbitz.chat' } }
  if (r && r.ok === true) return { ok: true, id: String(r.id || ''), proven: r.proven === true } // proven: Witbitz's record matched (#5)
  return { ok: false, error: String((r && r.error) || 'failed'), ...(r && r.reason ? { detail: String(r.reason) } : {}) }
}
