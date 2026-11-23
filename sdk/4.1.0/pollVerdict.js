// pollVerdict.js — what a poll answer MEANS, decided one way for the Spaces app and the SDK (docs/sdk-convergence.md,
// phase 4a). Each used to classify refusals itself, and they drifted: the SDK read a refusal inside a 200 (a host front
// that flattened every status) as a refusal, the app as an empty room. Each side still decides what to SHOW for a verdict.
//   ok · cannot_open (422 — this key opens nothing; code 'no_key' when nothing here holds a key) · no_key (401, the
//   worker's own refusal of a keyless read) · stale_key (the enclave cannot open the key or the envelope we sealed to it) ·
//   verified_client · gated (an email gate) · warming (the enclave is starting) · unavailable (not judged just now: retry) ·
//   not_found · refused (anything else) ·
//   no_answer
export function pollVerdict (r) {
  if (!r) return { kind: 'no_answer', code: 'no_answer' }
  if (r.status === 200 && !r.error) return { kind: 'ok' }
  const code = r.error ? String(r.error) : r.status === 422 ? 'undecodable' : 'http_' + r.status
  const v = (kind) => ({ kind, code, ...(r.reason ? { reason: r.reason } : {}) })
  if (r.status === 422) return v('cannot_open')
  if (r.error === 'no_key') return v('no_key')
  // bad_envelope: the request ENVELOPE (reqEnvelope) was sealed to an enclave since replaced — the same stale key, one layer out
  // (2026-11-09: after a turn cutover the app read 400 bad_envelope once a second and never re-attested until relaunched).
  if (r.error === 'bad_mkseal' || r.error === 'bad_envelope') return v('stale_key')
  if (r.error === 'envelope_stale') return { kind: 'refused', code: 'envelope_stale', reason: 'This device’s clock is more than a minute off, so the confidential Space refused the request — set the clock to the right time (automatic), then try again.' } // the device's clock (pass 7, T#2; the same words as turnVerdict CLOCK_REASON)
  if (r.error === 'no_verified_client') return v('verified_client')
  // ★ ONLY THE EMAIL GATE'S REFUSAL IS "gated" (sync sweep, 2026-10-10). Every 403 used to read as gated, and the app then
  //   marked the room verified FOR GOOD — but a read is also refused 403 for an enclave build the room has not accepted
  //   (enclave_not_accepted) or an owner policy that does not verify (policy_invalid): an open room then asked for a
  //   sign-in for ever. The gate answers not_authorized (no or wrong sign-in, revoked) or gate_unreadable.
  if (r.status === 403 && (r.error === 'not_authorized' || r.error === 'gate_unreadable')) return v('gated')
  if (r.error === 'enclave_warming' || r.warming) return v('warming')
  // NOT JUDGED (sync sweep 11-11): the sign-in's verifier, the room's tier or its store could not be checked just now — a retryable 503,
  // never a refusal (no banner, no slowed poll): ask again
  if (r.status === 503 && (r.error === 'verifier_unavailable' || r.error === 'tier_unknown' || r.error === 'store_unavailable')) return v('unavailable')
  if (r.error === 'deleting') return v('unavailable') // its creator's delete is finishing (agent/roomDeleting.mjs): the next read hears 410, or the room again
  if (r.status === 404 && r.error === 'not_found') return v('not_found')
  return v('refused')
}
