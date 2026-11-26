// acctV2Check.js — WHEN a device asks the account service for its status (acctV2Wiring.js startAcctV2StatusChecks).
// Every status call is signed by the device key, so each one tells the service "this device is in use now". It was every
// launch and every return to the foreground; now at most once a day (owner, 2026-11-15), remembered across launches.
// Nothing protected depends on it: the service refuses a signed-out device on every operation itself — the check only lets
// a signed-out device notice sooner and remove the account. So it still runs at once when it matters:
//  - an unfinished new recovery code (vault().pending): the F-01 reconcile must run at the next launch;
//  - the service refused this device as signed out on another call (403 `revoked`): remove the account now;
//  - the person opened Settings → Your devices (owner, 2026-11-15: a signed-out device showed nothing for a day) — they
//    asked, so the check is theirs, not a per-launch record; at most once per OPEN_FLOOR however often the panel opens;
//  - a move of this account's email address is under way (`moving` — the last answer said so: protocol § 11.5, 3a): every
//    launch and foreground until it ends, so the warning is current and goes away when the move is cancelled or over.
export const CHECK_EVERY = 24 * 3600 * 1000
export const CHECKED_KEY = 'space:acctv2:checked' // when this device last had an answer — a time, kept on this device only

/** Is a status check due? `last` = the stored time of the last answer (ms), anything else = never. */
export function statusDue({ now, last, pending = false, force = false, moving = false }) {
  if (force || pending || moving) return true
  const t = Number(last)
  if (!Number.isFinite(t) || !t || t > now) return true // never checked, garbage, or a clock moved back: check
  return now - t >= CHECK_EVERY
}

export const OPEN_FLOOR = 10 * 1000

/** Opening Your devices: check now, unless the panel was opened (and checked) less than OPEN_FLOOR ago. */
export const openCheckDue = ({ now, lastOpen }) => !(Number(lastOpen) > 0 && now - Number(lastOpen) < OPEN_FLOOR && now >= Number(lastOpen))

/** A v2 answer that says this device is signed out (any route but the status check, which answers 200 { state }). */
export const refusedAsRevoked = (status, body) => status === 403 && !!body && body.reason === 'revoked'
