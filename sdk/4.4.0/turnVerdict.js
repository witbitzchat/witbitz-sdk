// turnVerdict.js — what a turn's answer MEANS, one reading for the Spaces app's send and the SDK's (docs/sdk-convergence.md,
// phase 4c). Each side still decides what to SHOW.
//   ok · silent (posted; the assistant stays quiet) · busy (a reply is running: HOLD the message and resend — the server
//   stores nothing new meanwhile, docs/spaces-turn-queue.md) · warming (the enclave is starting) · stale_key (the enclave
//   cannot open the key we sealed to it) · not_admitted (401/403: the gate) · refused (another 4xx) · pending (a 5xx with
//   none of our codes: the API front door cut the request at ~30 s while the server finishes — the reply still comes;
//   never resend) · failed (a 5xx we raised) · no_answer
export const CLOCK_REASON = 'This device’s clock is more than a minute off, so the confidential Space refused the request — set the clock to the right time (automatic), then try again.'
export const CONTINUATION_WINDOW_MS = 10 * 60 * 1000
export const QUEUE_RETRY_MS = 1500
export const QUEUE_MAX_TRIES = 640 // ~16 min of holding: longer than the longest turn (13 min since 2026-11-18; was 120 ≈ 180 s)

export function turnVerdict (r) {
  if (!r) return { kind: 'no_answer' }
  // status 0 = the request got NO answer (OHTTP returns one rather than throwing; the SDK's transport failure): it may have
  // been posted, so it is never a refusal to resend (sync sweep, 2026-10-10)
  if (!r.status) return { kind: 'no_answer', ...(r.error ? { code: String(r.error) } : {}) }
  const v = (kind) => ({ kind, ...(r.error ? { code: String(r.error) } : {}), ...(r.reason ? { reason: String(r.reason) } : {}) })
  if (r.status === 200 && r.ok === false && r.error) return v('refused') // a refusal that came back as a 200 is not a send (sweep 11-06 #1)
  if (r.status === 200) return { kind: r.busy ? 'busy' : r.silent ? 'silent' : 'ok' }
  if (r.error === 'enclave_warming' || r.warming) return v('warming')
  if (r.error === 'enclave_policy_unknown') return v('warming') // nothing was sent: the enclave could not be checked yet — wait and send again, as for a warming one (sweep 11-06 #8)
  if (r.status === 401 && r.error === 'bad_mkseal') return v('stale_key')
  // a request ENVELOPE sealed to an enclave since replaced (pollVerdict.js, 2026-11-09): nothing ran, so re-attest and send again
  if (r.status === 400 && r.error === 'bad_envelope') return v('stale_key')
  // ⛔ A DEVICE CLOCK OFF BY MORE THAN A MINUTE (state machines pass 7, T#2): the enclave refuses an envelope outside its window
  //   (agent/mkUnseal.mjs DEFAULT_SKEW_MS) and every send said only "Couldn't send that. Try again." — say what to fix.
  if (r.error === 'envelope_stale') return { kind: 'refused', code: 'envelope_stale', reason: CLOCK_REASON }
  if (r.status === 401 || r.status === 403) return v('not_admitted')
  if (r.status >= 400 && r.status < 500) return v('refused')
  // 'refused' with no sentence on a 5xx is reqEnvelope.openAnswer's own default for a BARE reply (no server sets it): an older opener
  // — the hosted app's vault worker follows Official — still tags a gateway cut-off (30 s, a long confidential turn) that way.
  // The Lambda runs on and stores the reply: pending (the owner, 2026-11-11: "Not sent" on a turn that was answering it)
  if (r.status >= 500 && r.error === 'refused' && !r.reason) return v('pending')
  if (r.status >= 500) return v(r.error ? 'failed' : 'pending')
  return v('refused')
}
