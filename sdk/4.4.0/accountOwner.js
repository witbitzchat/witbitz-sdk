// WHOSE Spaces this device holds — so a second person signing in on it does not get the first one's rooms.
//
// Nothing used to tell accounts apart on one device: a sign-in only replaced the identity, the rooms and keys the device
// already held stayed, and the next sync PUSHED every one of them into the list (and the backup) of the account now
// signed in (the owner, 2026-10-09: Liat signed in on a computer that had been used with another account, and her list
// filled with rows called "Space" that are not hers). The device now remembers the email whose Spaces it holds — set by
// the first sync that runs signed in — and a different email gets NO push: the merge cannot happen, and the page offers
// "Switch account" (devices.js wipeDevice: this device's Spaces are cleared, the new person signs in on a clean device).
// Signed out (no email), nothing is decided. Log out / Switch account clears the record with everything else (space:*).
const KEY = 'space:acct-owner'
const norm = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '')

/** The signed-in email, read as spaceEmailGate.js reads its anchor (space:esession, unexpired) — no import of the sign-in
 *  module, so the sync code stays loadable on its own. */
export function signedInEmail() {
  try { const a = JSON.parse(localStorage.getItem('space:esession') || 'null'); return a && (!a.exp || a.exp > Date.now()) ? norm(a.email) : '' } catch { return '' }
}

export function deviceOwner() {
  try { return norm(localStorage.getItem(KEY)) } catch { return '' }
}

/** May this device's Spaces be pushed into the account of `email`? The first signed-in sync claims the device for it. */
export function ownerAllows(email) {
  const e = norm(email)
  if (!e) return { ok: true }
  const o = deviceOwner()
  if (!o) {
    try { localStorage.setItem(KEY, e) } catch { /* no storage: nothing to protect either */ }
    return { ok: true }
  }
  return o === e ? { ok: true } : { ok: false, owner: o, email: e }
}

let told = false
/** Say it once per page: the page shows the switch (accountMismatch listener in space.js). */
export function noteMismatch(check) {
  if (told || !check || check.ok) return
  told = true
  try { if (typeof dispatchEvent === 'function' && typeof CustomEvent === 'function') dispatchEvent(new CustomEvent('space:account-mismatch', { detail: { owner: check.owner, email: check.email } })) } catch { /* */ }
}

// ★ NOT A SILENT STOP (2026-11-07, the implicit-state-machine review): a refused push returned before the backup's error mark,
//   so Back up & recovery kept saying all was well while nothing was saved, and the person was told once per page (a notice
//   they could dismiss). The refusal is now kept (space:recovery:owner-mismatch) and shown as the backup's health until a push
//   is allowed again (the right email signed in, or Switch account — which clears space:* with everything else).
const MISMATCH_KEY = 'space:recovery:owner-mismatch'
/** The refusal in force, if any: { owner, email, at } — for backupHealth. */
export function ownerMismatch() {
  try { const m = JSON.parse(localStorage.getItem(MISMATCH_KEY) || 'null'); return m && m.owner && m.email ? m : null } catch { return null }
}

/** The guard both pushes call: false = do not push (and the page has been told). */
export function mayPushFor(email = signedInEmail()) {
  const c = ownerAllows(email)
  if (!c.ok) { noteMismatch(c); try { localStorage.setItem(MISMATCH_KEY, JSON.stringify({ owner: c.owner, email: c.email, at: Date.now() })) } catch { /* */ } }
  else if (norm(email)) { try { localStorage.removeItem(MISMATCH_KEY) } catch { /* */ } } // a push for the owner again: the warning goes
  return c.ok
}
