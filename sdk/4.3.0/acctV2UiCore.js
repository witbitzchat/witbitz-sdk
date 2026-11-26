// acctV2UiCore.js — the account recovery v2 screens and cards (askCode with "Continue with Google", showCode, the devices
// section, Advanced Backup, start / restore / add a device / delete), for BOTH apps: the regular app's page (acctV2Ui.js
// wires it to acctV2Wiring.js) and the hosted app's VAULT (acctV2VaultWiring.js — docs/hosted-account-v2-plan.md: the
// client runs where the master is). It imports no page state: the wiring that loads it hands over the account client, the
// account's address and the confirm card (setAcctV2UiDeps) — so the vault never loads the regular page's modules.
import { BASE_KEY, newAccountService, baseOf } from './acctV2Switch.js'
import { GOOGLE_CLIENT_ID } from './config.js' // the same address as every other importer
import { onKeyPrompt } from './acctV2WebAuthn.js'

// THE WIRING (set once by the page that loads this): { acctV2() → the client (acctV2App.makeAcctV2), accountAddress() → the
// account's email or null, confirm({ message, confirmLabel, cancelLabel, destructive }) → Promise<boolean>, offerFresh(),
// onStagingApp(), onProdPreview(), sectionTitle?, and for Release 3's move (§ 12.2) moveService() → the service this account
// would move to ('' = none here), oldAccountHere() → this device holds an account still on the OLD service, switchOn(svc) → undo,
// afterMove() → sign out the account's other devices (gracefully: devices.js MOVED_MARK) → their ids, or null when unknown }
let _deps = null
export function setAcctV2UiDeps(d) { _deps = d || null }
const dep = () => { if (!_deps) throw Object.assign(new Error('acct_v2_unwired'), { code: 'acct_v2_unwired' }); return _deps }
export const acctV2 = () => dep().acctV2()
export const accountAddress = () => dep().accountAddress()
const offerFresh = () => { try { return !!(dep().offerFresh && dep().offerFresh()) } catch { return false } }
const onStagingApp = () => { try { return !!(dep().onStagingApp && dep().onStagingApp()) } catch { return false } }
const onProdPreview = () => { try { return !!(dep().onProdPreview && dep().onProdPreview()) } catch { return false } }
const confirmSheet = (o) => dep().confirm(o)
/** The page's confirm card (acctV2ResetCore.js asks through it too). */
export const confirmCard = (o) => confirmSheet(o)

const MESSAGES = {
  key_registered: 'This browser was used for another account on the new service. Reload the page and try again — if it happens again, clear this site’s data (or use a new browser profile).',
  email_code_wrong: 'That code didn’t match. Nothing changed — try again.',
  need_code: 'This device doesn’t have a copy of your recovery code. Enter it to continue.',
  no_backup: 'This device has no backup to move yet.',
  no_account_key: 'This device doesn’t hold your account key. Move the account from another of your devices.',
  already_migrated: 'This account has already been moved.',
  v2_off: 'The new account service isn’t switched on for this device.',
  not_migrated: 'Move this account to the new account service first.',
  no_legacy_gate: 'The new service can’t find this account’s backup to move. Use “Start on the new service” instead.',
  no_account: 'No account on the new service has that recovery code. Check it and try again.',
  bad_code: 'That doesn’t look like a recovery code. Check it and try again.',
  wrapper_unopened: 'That recovery code doesn’t open this account’s backup. Nothing changed.',
  backup_unopened: 'The backup couldn’t be opened. Nothing changed — try again in a moment.',
  backup_unconfigured: 'That account has no recovery code yet, so it can’t be restored.',
  already_migrated: 'This device already has an account on the new service.',
  need_security_key: 'This needs one of your security keys, and this device can’t ask for one.',
  key_cancelled: 'The security key didn’t answer — the prompt was closed, timed out, or a key that isn’t on this account was touched. Nothing changed.',
  key_wrong_site: 'Security keys can’t be used in this app yet.', // accounts are per app (sync sweep 11-16 #17): never sent to another app's address
  webauthn_unavailable: 'This browser can’t use security keys.',
  key_already_registered: 'That key is already on this account. Use a different key.',
  attestation_refused: 'That key can’t be used for Advanced Backup. It must be a YubiKey with a PIN (or fingerprint) set up.',
  advanced_not_enabled: 'Advanced Backup isn’t available yet.',
  possession_pending: 'Set up your recovery code first.',
  email_only: 'This account was moved with your email only, so Advanced Backup isn’t available for it.',
  too_many_keys: 'This account already has the most security keys it can hold (5).',
  no_other_key: 'Removing a key needs another of your keys to confirm it.',
  keys_mismatch: 'The service answered with keys this device didn’t register. Nothing was changed.',
  session_ended: 'That took too long or something changed meanwhile. Nothing changed — start again.',
  pending_not_kept: 'This device couldn’t save the new recovery code, so it wasn’t activated. Your current code still works — free some space or try again.',
  address_taken: 'That email address already has an account on the new service. Restore it on this device instead (“Restore my account from the new service”).',
  bad_address: 'That doesn’t look like an email address.',
  state_changed: 'Something changed on your account meanwhile. Nothing changed — start again.',
  bad_new_device: 'That device’s code isn’t valid. Show a new code on it and scan again.',
  enrol_key_registered: 'That device was used for another account, or was signed out of this one. On it, use Settings → Reset this device, then show a new code.',
  device_proof: 'This device is no longer one of your account’s devices, so it can’t add another. Nothing was sent.',
  google_not_authoritative: 'Google can’t confirm this address (only a Gmail or Google Workspace address). Use the emailed code instead.',
  google_refused: 'That Google sign-in didn’t check out. Try again, or use the emailed code.',
  google_stale: 'That Google sign-in was too old. Try again, or use the emailed code.',
  not_this_account: 'That Google account isn’t this account’s email. Sign in with the right Google account, or use the emailed code.',
  google_other_address: 'That Google account is a different address from the one you typed. Sign in with that address’s Google account, or use the emailed code.',
  google_used: 'That Google sign-in was already used. Try again.',
  reset_open: 'A move of this email is already under way. It has to finish or be cancelled first.',
  reset_ended: 'That move has ended (it was cancelled, or too much time passed). Start again if you still need it.',
  not_yet: 'The week isn’t over yet — finish the move on the date shown. (A device of the old account may have asked for more time: the move then waits 30 days from its start.)',
  already_objected: 'More time was already asked for on this move — it can be asked for only once. The date shown is when it moves.',
  no_reset: 'There’s no move of this email under way on this device.',
  reset_conflict: 'Something changed on that account meanwhile. Try finishing again.',
  feature_unavailable: 'This isn’t available yet.',
  not_ours: 'That device is no longer one of your account’s devices. Nothing changed.',
  not_this_device: 'That is the device you’re using. Nothing changed.',
  google_unavailable: 'Google sign-in isn’t available for this yet. Use the emailed code.',
}
// An unexpected failure names its reason (the service's code, or the browser's error), so a report can say what happened.
export const messageFor = (e) => {
  if (MESSAGES[e && e.code]) return MESSAGES[e.code]
  try { console.error('account v2:', e) } catch { /* */ }
  const why = e ? [e.code, e.name, e.message].filter(Boolean).join(': ') : 'unknown'
  return `Something went wrong (${why.slice(0, 160)}). Nothing changed — try again in a moment.`
}

/** A small card asking for the 6-digit code (or, with `field: 'recovery'`, the recovery code). → the text, or null. */
export const RESTORE_INSTEAD = Symbol('restore instead')
export const MOVE_EMAIL = Symbol('move the email to a new account') // § 11.5, acctV2Reset.js
/** The email a Google ID token names (its payload's `email`), or null — the address of a restore that went through Google. */
const googleEmailOf = (idToken) => { try { const b = String(idToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); const j = JSON.parse(atob(b + '='.repeat((4 - b.length % 4) % 4))); return typeof j.email === 'string' ? j.email : null } catch { return null } }

/** The nonce a Google sign-in for `action` carries — the service checks the same (acct/googleProof.mjs googleNonce). */
export async function googleNonce(action) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('witbitz-acct-google|' + String(action))))
  return btoa(String.fromCharCode(...h)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
/** `alt` = { label, id }: a second way out — resolves RESTORE_INSTEAD. `google` = { action, address }: "Continue with
 *  Google" — a Google sign-in for THAT action (its nonce) in place of the code — resolves { google: idToken }. */
export function askCode({ title, message, field = 'email', alt = null, alts = null, google = null }) {
  const ways = alts || (alt ? [alt] : []) // each { id, label, value? } — resolves its value (RESTORE_INSTEAD by default)
  return new Promise((resolve) => {
    const shade = document.createElement('div')
    shade.id = 'acctV2CodeCard'
    shade.style.cssText = 'position:fixed; inset:0; z-index:2147483000; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:16px'
    shade.className = 'kbfit' // with the keys up it fits the visible area (space.html), its field above them
    const card = document.createElement('div')
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true')
    card.style.cssText = 'background:var(--bg, #fff); color:var(--fg, #111); border-radius:14px; padding:18px; width:100%; max-width:360px; box-shadow:0 10px 40px rgba(0,0,0,.3)'
    const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-weight:600; font-size:17px; margin-bottom:6px'
    const p = document.createElement('div'); p.textContent = message; p.style.cssText = 'font-size:14px; opacity:.8; margin-bottom:12px; line-height:1.4; white-space:pre-line'
    const input = document.createElement('input')
    input.id = 'acctV2CodeInput'
    input.autocomplete = field === 'email' ? 'one-time-code' : field === 'address' ? 'email' : 'off'
    input.inputMode = field === 'email' ? 'numeric' : field === 'address' ? 'email' : 'text'
    input.placeholder = field === 'email' ? '6-digit code' : field === 'address' ? 'you@example.com' : 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX'
    input.style.cssText = 'width:100%; box-sizing:border-box; font-size:18px; padding:10px; border-radius:10px; border:1px solid rgba(127,127,127,.4); background:transparent; color:inherit; letter-spacing:.08em'
    const row = document.createElement('div'); row.style.cssText = 'display:flex; gap:8px; margin-top:14px'
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'
    const ok = document.createElement('button'); ok.type = 'button'; ok.id = 'acctV2CodeOk'; ok.textContent = 'Continue'
    for (const b of [cancel, ok]) b.style.cssText = 'flex:1; padding:11px; border-radius:10px; border:0; font-size:15px; cursor:pointer'
    ok.style.background = 'var(--accent, #1f5fd6)'; ok.style.color = '#fff'
    if (google && field === 'address') ok.textContent = 'Email me a code'
    const done = (v) => { shade.remove(); resolve(v) }
    cancel.onclick = () => done(null)
    ok.onclick = () => { const v = input.value.trim(); if (v) done(field === 'email' ? v.replace(/\D/g, '') : v) }
    input.onkeydown = (e) => { if (e.key === 'Enter') ok.onclick(); if (e.key === 'Escape') done(null) }
    row.append(cancel, ok)
    card.append(h, p)
    // GOOGLE IN PLACE OF THE CODE (owner, 2026-11-15: "Everywhere there is code should also have Gmail also"): the service
    // accepts it only for a Gmail or Google Workspace address, freshly, for this very request (acct/googleProof.mjs)
    if (google && google.action && (field === 'email' || field === 'address')) {
      const g = document.createElement('button'); g.type = 'button'; g.id = 'acctV2Google'; g.textContent = 'Continue with Google'
      g.style.cssText = 'display:block; width:100%; margin:0 0 12px; padding:11px; border-radius:10px; border:1px solid rgba(127,127,127,.4); background:transparent; color:inherit; font-size:15px; cursor:pointer'
      const gmsg = document.createElement('div'); gmsg.style.cssText = 'font-size:13px; color:#c0392b; margin:-6px 0 10px; display:none'
      // READY BEFORE THE TAP: the nonce and the sign-in module are made now, so the tap reaches googleIdToken with nothing awaited.
      // In the hosted app's vault that opens Google's page with window.open, and a browser lets a page open a window only from the
      // tap itself — two awaits first (a digest, an import) could cost Safari's permission, and a blocked window read as "didn't
      // work here" (the owner's iPhone, 2026-11-16, Add a device's approval).
      let pre = null
      const ready = Promise.all([googleNonce(google.action), import('./spaceEmailGate.js')]) // a DYNAMIC import carries its own stamp
      ready.then((v) => { pre = v }, () => {})
      g.onclick = async () => {
        gmsg.style.display = 'none'
        shade.style.display = 'none' // the Google card sits lower on the screen's stack: this card steps aside, and back on a cancel
        try {
          const [nonce, { googleIdToken }] = pre || await ready
          const r = await googleIdToken({ clientId: GOOGLE_CLIENT_ID, nonce, fresh: true, googleOwn: true, copy: { title: 'Confirm with Google', sub: field === 'address' ? 'Sign in with the Google account of your Spaces account.' : 'Instead of the emailed code: sign in with the Google account of ' + (google.address || 'this email') + '.' } })
          if (r && r.idToken) done({ google: r.idToken })
        } catch (e) { if (!(e && /cancel/.test(String(e.message)))) { gmsg.textContent = field === 'address' ? 'Google sign-in didn’t work here — enter your email for a code.' : 'Google sign-in didn’t work here — use the emailed code.'; gmsg.style.display = 'block' } }
        if (shade.isConnected) shade.style.display = 'flex'
      }
      card.append(g, gmsg)
    }
    // the second way out ABOVE the buttons: under them the keyboard hid it (owner's iPhone, 2026-11-15)
    for (const w of ways) {
      const a = document.createElement('button'); a.type = 'button'; a.id = w.id || 'acctV2CodeAlt'; a.textContent = w.label
      a.style.cssText = 'display:block; width:100%; margin:0 0 8px; padding:6px; border:0; background:none; color:var(--accent, #1f5fd6); font-size:14px; cursor:pointer; text-decoration:underline'
      a.onclick = () => done(w.value || RESTORE_INSTEAD)
      card.append(a)
    }
    card.append(input, row)
    shade.append(card)
    document.body.append(shade)
    setTimeout(() => input.focus(), 0)
  })
}

/** Show a new recovery code until the person says it is saved. The code is NOT active yet — the activation follows. */
export function showCode(code) {
  return new Promise((resolve) => {
    const shade = document.createElement('div')
    shade.id = 'acctV2ShowCode'
    shade.style.cssText = 'position:fixed; inset:0; z-index:2147483000; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:16px'
    shade.className = 'kbfit' // with the keys up it fits the visible area (space.html), its field above them
    const card = document.createElement('div')
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true')
    card.style.cssText = 'background:var(--bg, #fff); color:var(--fg, #111); border-radius:14px; padding:18px; width:100%; max-width:380px; box-shadow:0 10px 40px rgba(0,0,0,.3)'
    const h = document.createElement('div'); h.textContent = 'Your new recovery code'; h.style.cssText = 'font-weight:600; font-size:17px; margin-bottom:6px'
    const p = document.createElement('div'); p.textContent = 'Write it down or save it somewhere safe. It replaces your old code once you continue — not before.'; p.style.cssText = 'font-size:14px; opacity:.8; margin-bottom:12px; line-height:1.4'
    const c = document.createElement('div'); c.id = 'acctV2NewCode'; c.textContent = code
    c.style.cssText = 'font-family:ui-monospace, Menlo, monospace; font-size:17px; letter-spacing:.05em; padding:12px; border-radius:10px; background:rgba(127,127,127,.12); text-align:center; user-select:all; word-break:break-all'
    const ok = document.createElement('button'); ok.type = 'button'; ok.id = 'acctV2CodeSaved'; ok.textContent = 'I’ve saved it — continue'
    ok.style.cssText = 'width:100%; margin-top:14px; padding:11px; border-radius:10px; border:0; font-size:15px; cursor:pointer; background:var(--accent, #1f5fd6); color:#fff'
    ok.onclick = () => { shade.remove(); resolve() }
    // A COPY BUTTON (the owner, 2026-11-21: "why dont we have a copy glyph?"), as the old service's sheet has (recCopy): the code goes
    // to the clipboard; where the clipboard is refused, the code is selected for a manual copy.
    const cp = document.createElement('button'); cp.type = 'button'; cp.id = 'acctV2CopyCode'; cp.textContent = 'Copy code'
    cp.style.cssText = 'width:100%; margin-top:10px; padding:10px; border-radius:10px; border:1px solid rgba(127,127,127,.4); background:transparent; color:inherit; font-size:15px; cursor:pointer'
    cp.onclick = async () => {
      try { await navigator.clipboard.writeText(code); cp.textContent = 'Copied ✓'; setTimeout(() => { cp.textContent = 'Copy code' }, 1500) }
      catch { try { const r = document.createRange(); r.selectNodeContents(c); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r) } catch { /* the code is on screen */ } cp.textContent = 'Selected — copy it' }
    }
    card.append(h, p, c, cp, ok)
    shade.append(card)
    document.body.append(shade)
  })
}

export const notice = (message) => confirmSheet({ message, confirmLabel: 'OK', cancelLabel: '', destructive: false })

/** The email code, asked after the service has sent it (the flows call this once the request is on its way). */
// The service answers alike whether or not it mailed (§ 9.3), so the card names every reason a code may not come:
// `kind` 'new' = starting an account (no code to an address that already has one), else an action on an account (no code
// to any address but the account's own). Both: over the per-address limit nothing comes.
export const noCodeHelp = (kind) => 'Nothing after a minute or two? Check spam. '
  + (kind === 'new'
    ? 'If this email already has an account, nothing is sent: use Restore with your recovery code instead. '
    : kind === 'claim' ? '' // moving the email (§ 11.5): a code is mailed to the address whatever account it has
    : 'A code only goes to the email this account was made with — make sure it’s that one. ')
  + 'If you’ve asked for several codes in the last hour, a new one may only come once the hour is up.'
// STARTING an account, the card also offers Restore (owner's iPhone, 2026-11-15: "Start a new account" with an email that
// already had an account on the new service waited for a code that never comes — one account per email there)
// GOOGLE OR THE EMAILED CODE, ASKED FIRST (the owner, 2026-11-16: "It should first ask for a choice between sending the code and
// Google login. Currently it automatically sends the code"): acctV2Client asks `choose` before anything is mailed. → { google }
// (Google's own token for this action — the code is never sent), { email: true } (send the code), or a `cancelled` error.
// A Google sign-in that fails leaves the card up with a line saying so: the email is still there to choose.
export function chooseProof({ address, action }) {
  return new Promise((resolve, reject) => {
    const shade = document.createElement('div'); shade.id = 'acctV2Choose'
    shade.style.cssText = 'position:fixed; inset:0; z-index:2147483000; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:16px'
    const card = document.createElement('div'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true')
    card.style.cssText = 'background:var(--bg, #fff); color:var(--fg, #111); border-radius:14px; padding:18px; width:100%; max-width:360px; box-shadow:0 10px 40px rgba(0,0,0,.3)'
    const h = document.createElement('div'); h.textContent = 'Confirm it’s you'; h.style.cssText = 'font-weight:600; font-size:17px; margin-bottom:6px'
    const p = document.createElement('div'); p.textContent = `Sign in with the Google account of ${address || 'your email'}, or get a 6-digit code by email.`; p.style.cssText = 'font-size:14px; opacity:.8; margin-bottom:14px; line-height:1.4'
    const btn = (id, label, primary) => { const b = document.createElement('button'); b.type = 'button'; b.id = id; b.textContent = label; b.style.cssText = 'display:block; width:100%; margin:0 0 10px; padding:11px; border-radius:10px; font-size:15px; cursor:pointer; ' + (primary ? 'border:0; background:var(--accent, #1f5fd6); color:#fff' : 'border:1px solid rgba(127,127,127,.4); background:transparent; color:inherit'); return b }
    const g = btn('acctV2ChooseGoogle', 'Continue with Google', true), m = btn('acctV2ChooseEmail', 'Email me a code', false), c = btn('acctV2ChooseCancel', 'Cancel', false)
    c.style.border = '0'
    const gmsg = document.createElement('div'); gmsg.style.cssText = 'font-size:13px; color:#c0392b; margin:-4px 0 10px; display:none'
    const done = (fn) => { shade.remove(); fn() }
    // READY BEFORE THE TAP (as askCode): Safari lets a page open the broker's window only from the tap itself
    let pre = null
    const ready = Promise.all([googleNonce(action), import('./spaceEmailGate.js')])
    ready.then((v) => { pre = v }, () => {})
    g.onclick = async () => {
      gmsg.style.display = 'none'; shade.style.display = 'none'
      try {
        const [nonce, { googleIdToken }] = pre || await ready
        const r = await googleIdToken({ clientId: GOOGLE_CLIENT_ID, nonce, fresh: true, googleOwn: true, copy: { title: 'Confirm with Google', sub: 'Sign in with the Google account of ' + (address || 'this email') + '.' } })
        if (r && r.idToken) return done(() => resolve({ google: r.idToken }))
      } catch (e) { if (!(e && /cancel/.test(String(e.message)))) { gmsg.textContent = 'Google sign-in didn’t work here — get the code by email instead.'; gmsg.style.display = 'block' } }
      if (shade.isConnected) shade.style.display = 'flex'
    }
    m.onclick = () => done(() => resolve({ email: true }))
    c.onclick = () => done(() => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })))
    card.append(h, p, g, gmsg, m, c); shade.append(card); document.body.append(shade)
  })
}
/** A getCode that asks Google-or-email FIRST (acctV2Client chooseFirst), then the code when the email was chosen. */
const withChoice = (address, fn) => Object.assign(fn, { choose: ({ action }) => chooseProof({ address, action }) })
export const emailCode = (address, kind = 'account') => withChoice(address, async (ctx = {}) => {
  const c = await askCode({ title: 'Check your email', message: `We sent a 6-digit code to ${address}. Enter it to continue.\n\n${noCodeHelp(kind)}`, ...(ctx.action && !ctx.chose ? { google: { action: ctx.action, address } } : {}), ...(kind === 'new' ? { alts: [{ id: 'acctV2RestoreInstead', label: 'No code? This email already has an account — restore it' }, { id: 'acctV2MoveEmail', label: 'Lost that account’s recovery code and devices? Move this email to a new account', value: MOVE_EMAIL }] } : {}) })
  if (c === RESTORE_INSTEAD) throw Object.assign(new Error('restore_instead'), { code: 'restore_instead' })
  if (c === MOVE_EMAIL) throw Object.assign(new Error('move_email'), { code: 'move_email' })
  if (c && typeof c === 'object' && c.google) return c // a Google sign-in in place of the code (acctV2Client emailProof)
  if (!c) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
  return c
})

/** Append the section to the devices box; `rerender` redraws the panel after a change. */
export function renderAcctV2Section(box, rerender) {
  const a = acctV2()
  if (!a.enabled()) { renderMoveOnly(box, rerender); return } // an account on the OLD service: only the move, where it is open
  const s = a.state()
  const sec = document.createElement('div')
  sec.id = 'acctV2Section'
  sec.style.cssText = 'margin-top:14px; padding-top:10px; border-top:1px solid rgba(127,127,127,.25)'
  const t = document.createElement('div'); t.className = 'sheet-s'; t.style.cssText = 'padding:4px; font-weight:600'; t.textContent = dep().sectionTitle || 'New account service (preview)'
  const d = document.createElement('div'); d.className = 'sheet-s'; d.style.cssText = 'padding:4px 4px 8px; opacity:.75'
  const b = document.createElement('button'); b.className = 'dev-out'; b.type = 'button'; b.style.cssText = 'width:100%; padding:10px'
  const address = accountAddress()
  if (!s) {
    d.textContent = MOVE_TEXT
    b.id = 'acctV2Move'; b.textContent = 'Move to the new account service'
    b.onclick = () => moveAccount(rerender)
  } else {
    d.textContent = s.trust === 'email_only' ? 'This account uses the new account service (moved with your email only).' : 'This account uses the new account service.'
    b.id = 'acctV2SignOutAll'; b.textContent = 'Sign out all other devices now'
    b.onclick = async () => {
      if (!(await confirmSheet({ message: `Sign out every other device now?\n\nFrom this moment they can’t use your account, your backup or your recovery. A device that connects again removes this account from itself. One that never reconnects — lost or stolen — keeps the Spaces already on it: sign-out can’t reach those. We’ll send a code to ${address}.`, confirmLabel: 'Sign out' }))) return
      try {
        await withSteps(() => a.signOutOthers({ address, getCode: emailCode(address) }))
        await notice('Done. Every other device is signed out of your account and backup.')
      } catch (e) { if (!(e && e.code === 'cancelled')) await notice(messageFor(e)) }
      rerender()
    }
    const nc = document.createElement('button'); nc.className = 'dev-out'; nc.type = 'button'; nc.style.cssText = 'width:100%; padding:10px; margin-top:6px'
    nc.id = 'acctV2NewCodeBtn'; nc.textContent = 'New recovery code'
    nc.onclick = async () => {
      if (!(await confirmSheet({ message: `Make a new recovery code?\n\nYour old code stops working, and every other device is signed out of your account and backup — you will need to reconnect them. One that never reconnects keeps the Spaces already on it. Anything on them that hasn’t been backed up may be lost. We’ll send a code to ${address}.`, confirmLabel: 'Make a new code' }))) return
      try {
        await withSteps(() => a.newRecoveryCode({ address, getCode: emailCode(address), showCode }))
        await notice('Done. Your new recovery code is active, and every other device is signed out.')
      } catch (e) { if (!(e && e.code === 'cancelled')) await notice(messageFor(e)) }
      rerender()
    }
    if (s.setup === 'pending') { // the account exists; its first recovery code did not finish
      d.textContent = 'Your account on the new service is made, but it has no recovery code yet.'
      b.id = 'acctV2FinishSetup'; b.textContent = 'Finish: make my recovery code'
      b.onclick = () => startFresh(a, address, rerender)
      sec.append(t, d, b); box.append(sec); return
    }
    sec.append(t, d, serviceDevicesBlock(a, address, rerender), b, nc)
    const mw = moveWarningBlock(rerender) // § 11.5, 3a: a move of this account's address under way — above everything else
    if (mw) sec.prepend(mw)
    box.append(sec)
    renderAdvanced(sec, a, address, rerender)
    return
  }
  if (onStagingApp()) d.textContent = 'Staging: start an account on the new service from this device (there’s no old backup service here to move from).'
  // the move is offered for an account on the old service, where the service accepts moves (Release 3; moveShown)
  else if (moveShown(rerender)) sec.append(t, d, b)
  else { d.textContent = onProdPreview() ? 'Preview: start an account on the new service from this device, or restore one.' : 'Start an account on the new service from this device, or restore one.'; sec.append(t, d) }
  if (onStagingApp()) sec.append(t, d)
  const rs = document.createElement('button'); rs.className = 'dev-out'; rs.type = 'button'; rs.id = 'acctV2Restore'; rs.textContent = 'Restore my account from the new service'
  rs.style.cssText = 'width:100%; padding:10px; margin-top:6px'
  rs.onclick = () => restoreHere(a, address, rerender)
  sec.append(rs)
  if (offerFresh()) {
    const f = document.createElement('button'); f.className = 'dev-out'; f.type = 'button'; f.id = 'acctV2Fresh'; f.textContent = 'Start on the new service'
    f.style.cssText = 'width:100%; padding:10px; margin-top:6px'
    f.onclick = () => startFresh(a, address, rerender)
    sec.append(f)
  }
  box.append(sec)
}

// ── THE ACCOUNT'S OTHER DEVICES, AS THE SERVICE KNOWS THEM (the owner, 2026-11-17: "Why don't I see the code wsl device here?")
//    The list above the section is the devices' OWN entries in the account's synced list — a computer paired for Code writes
//    none, so it never showed. These rows are the service's devices that the page did not already draw (dep().drawnSpks(): the
//    regular app's own list; the vault's sheet draws none, so it shows them all), each with its own Sign out: that device
//    only, proved as signing out all of them (an email code). Drawn into a slot once the answer comes; nothing on a failure.
const DEVICES_FRESH_MS = 30_000
let _devCache = null // { at, list } — Your devices redraws several times as it opens; one question serves them
export function forgetServiceDevices() { _devCache = null }
export const CLOUD_DEVICE_LABEL = 'Cloud device' // the label it is registered under (cloudDeviceSheet.js enrolDevice)
/** The page drew the cloud device's own row: the service's row for it goes (whichever was drawn first). */
export function cloudDeviceRowShown (row) { try { row.dataset.cloudDeviceRow = '1'; for (const r of document.querySelectorAll('[data-cloud-device-service]')) r.remove() } catch { /* */ } }
/** SIGN OUT AT THE SERVICE TOO (the owner, 2026-11-18: "Yes, revoke at the service", sync sweep unclear): the regular app's synced
 *  list stamped only the account's index, so a signed-out device kept its account-service sign-in until it next checked in. For an
 *  account on the new service, a row that knows the device's key revokes it there as well (the email code, as the service row asks).
 *  → true revoked · false not on the service / no key · throws a cancel or the service's refusal. */
export async function revokeAtService(spk) {
  const a = acctV2(); if (!spk || !(a.enabled() && a.state())) return false
  const address = accountAddress()
  await withSteps(() => a.signOutDevice({ spk, address, getCode: emailCode(address) }))
  forgetServiceDevices()
  return true
}
const drawnSpks = () => { try { return new Set((dep().drawnSpks && dep().drawnSpks()) || []) } catch { return new Set() } }
const dayOf = (sec) => { try { return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) } catch { return '' } }
export function serviceDevicesBlock(a, address, rerender, { now = Date.now } = {}) {
  const slot = document.createElement('div'); slot.id = 'acctV2Devices'
  const draw = (list) => {
    const drawn = drawnSpks()
    // THE CLOUD DEVICE ONCE (sync sweep 11-18 unclear): its own row ("Cloud device · always on", with its Spaces and a Sign out that
    // forgets the account on it) is drawn by the page when the device serves this account — then the service's row for it goes
    const cloudRowShown = () => { try { return !!document.querySelector('[data-cloud-device-row]') } catch { return false } }
    const rows = (list || []).filter((x) => x && typeof x.spk === 'string' && !drawn.has(x.spk) && !(x.me && drawn.size) && !(x.label === CLOUD_DEVICE_LABEL && cloudRowShown()))
    if (!rows.length) { slot.replaceChildren(); return }
    const h = document.createElement('div'); h.className = 'sheet-s'; h.style.cssText = 'padding:4px 4px 2px; opacity:.75'
    h.textContent = drawn.size ? 'Also signed in to your account' : 'Devices signed in to your account'
    const group = document.createElement('div'); group.className = 'dev-list' // one group of rows (vault-loader.html styles it as a card)
    const out = [h, group]
    for (const x of rows) {
      const row = document.createElement('div'); row.className = 'dev-row'; row.dataset.spk = x.spk; if (x.label === CLOUD_DEVICE_LABEL) row.dataset.cloudDeviceService = '1'
      const meta = document.createElement('div'); meta.className = 'dev-meta'
      const name = document.createElement('div'); name.className = 'dev-name'; name.dir = 'auto'; name.textContent = (x.label || 'Device') + (x.me ? ' · this device' : '')
      const sub = document.createElement('div'); sub.className = 'dev-sub'
      sub.textContent = [x.at ? 'added ' + dayOf(x.at) : '', x.state === 'provisional' ? 'not confirmed yet' : ''].filter(Boolean).join(' · ')
      meta.append(name, sub); row.append(meta)
      if (x.me) { const tg = document.createElement('span'); tg.className = 'dev-this'; tg.textContent = 'You'; row.append(tg) }
      else {
        const b = document.createElement('button'); b.className = 'dev-out'; b.type = 'button'; b.textContent = 'Sign out'
        b.onclick = async () => {
          const what = x.label ? `“${x.label}”` : 'this device'
          if (!(await confirmSheet({ message: `Sign out ${what}?\n\nIt can’t use your account, your backup or your recovery any more, and removes your account from itself the next time it checks in. Your other devices stay signed in. We’ll send a code to ${address}.`, confirmLabel: 'Sign out', destructive: true }))) return
          b.disabled = true
          try {
            await withSteps(() => a.signOutDevice({ spk: x.spk, address, getCode: emailCode(address) }))
            forgetServiceDevices()
            await notice(`Done. ${x.label ? '“' + x.label + '”' : 'That device'} is signed out of your account.`)
          } catch (e) { b.disabled = false; if (!(e && e.code === 'cancelled')) await notice(messageFor(e)) }
          rerender()
        }
        row.append(b)
      }
      group.append(row)
    }
    slot.replaceChildren(...out)
  }
  if (_devCache && now() - _devCache.at < DEVICES_FRESH_MS) draw(_devCache.list)
  else {
    Promise.resolve().then(() => a.devices()).then((list) => {
      if (!Array.isArray(list)) return
      _devCache = { at: now(), list }
      draw(list)
    }).catch(() => { /* offline or refused: the section stays as it was — nothing flashed */ })
  }
  return slot
}

// ── § 11.5, 3a: SOMEONE IS MOVING THIS ACCOUNT'S EMAIL ADDRESS (docs/account-recovery-email-move-warning.md; owner, 2026-11-16:
//    "Warning the old account's devices about an email move.") The status check tells an active device; these say it, and
//    offer what the reviewed rule allows: cancel with a code to the address (the mailbox decides), or — once — ask for more
//    time (the move then waits 30 days from its start; a device never cancels it).
const moveDay = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
/** The move under way, if the last status answer named one (acctV2App.knownMove). */
export const knownEmailMove = () => { try { const a = acctV2(); return a.enabled() && a.state() && a.knownMove ? a.knownMove() : null } catch { return null } }
/** The warning's one line (the banner, the card, the account section). */
export function moveWarningText(m = knownEmailMove(), address = accountAddress()) {
  if (!m) return ''
  return `Someone is moving your email address${address ? ' ' + address : ''} to a new account. It moves on ${moveDay(m.ready_at)}. If this wasn’t you, act now.`
}
/** The warning, step by step: cancel with a code to the address; if that inbox can't be read, ask for more time (once).
 *  → 'cancelled' | 'objected' | null (nothing done) */
export async function reviewEmailMove(rerender = () => {}) {
  const a = acctV2(), m = knownEmailMove(), address = accountAddress()
  if (!m) return null
  let done = null
  try {
    if (!(await confirmSheet({ message: `${moveWarningText(m, address)}

Someone who can read ${address || 'your email'} asked to move it to a NEW, empty account. Your account, its Spaces and its devices are not affected — but after the move, this address no longer signs in to it.${m.objected ? `

More time was already asked for: it waits until ${moveDay(m.ready_at)}.` : ''}`, confirmLabel: 'This wasn’t me', cancelLabel: 'Not now', destructive: true }))) return null
    const canRead = await confirmSheet({ message: `Cancel the move with a code we send to ${address || 'your email'}.

Only someone who can read that inbox can cancel it — not a device. If someone else got into it, change its password with your email provider first.`, confirmLabel: 'Send me a code', cancelLabel: m.objected ? 'Not now' : 'I can’t read that inbox', destructive: false })
    if (canRead) {
      if (!address) { await notice('This device doesn’t know your account’s email address.'); return null }
      await a.cancelMove({ address, getCode: emailCode(address, 'claim') })
      await notice('Cancelled. Your email address stays with your account.')
      done = 'cancelled'
    } else if (!m.objected) {
      if (!(await confirmSheet({ message: `Ask for more time?

The move will wait until ${moveDay(m.ready_at - 7 * 86400 + 30 * 86400)} instead, so you can get your inbox back from your email provider — then cancel the move here. More time can be asked for once; it can’t stop the move.`, confirmLabel: 'Ask for more time', cancelLabel: 'Not now', destructive: false }))) return null
      const r = await a.objectMove()
      await notice(`Done. The move now waits until ${moveDay(r.ready_at)}. Get your inbox back from your email provider, then cancel the move here.`)
      done = 'objected'
    }
  } catch (e) { if (!(e && e.code === 'cancelled')) await notice(messageFor(e)) }
  rerender()
  return done
}
/** The warning block at the top of the account section, or null. */
function moveWarningBlock(rerender) {
  const m = knownEmailMove()
  if (!m) return null
  const box = document.createElement('div')
  box.id = 'acctV2MoveWarning'
  box.style.cssText = 'margin:0 0 10px; padding:12px; border-radius:12px; background:rgba(220,38,38,.10); border:1px solid rgba(220,38,38,.35)'
  const t = document.createElement('div'); t.className = 'sheet-s'; t.style.cssText = 'font-weight:600; padding:0 0 6px'; t.textContent = 'Someone is moving your email address'
  const d = document.createElement('div'); d.className = 'sheet-s'; d.style.cssText = 'line-height:1.4'; d.textContent = moveWarningText(m)
  const b = document.createElement('button'); b.className = 'dev-out'; b.type = 'button'; b.id = 'acctV2MoveReview'; b.textContent = 'Review the move'; b.style.cssText = 'width:100%; padding:10px; margin-top:8px'
  b.onclick = () => reviewEmailMove(rerender)
  box.append(t, d, b)
  return box
}

// ── RELEASE 3: MOVE AN ACCOUNT FROM THE OLD SERVICE (protocol § 12.2; owner, 2026-11-15: "Let's just add a button in settings
//    that lets you migrate if you are on the old backup") — the REVIEWED transition, from this device, only when the person taps
//    it: the recovery code (gid: L1), an emailed code to the address the old backup was set up with (L2: email only — the
//    service has no Google path for this ticket), the account key's signature where the old backup has one (L3), and this
//    device's new keys (L4). An old backup without an account key moves as `email_only` (lower trust, stated). Then — never
//    before — the account's OTHER devices are signed out, gracefully (owner: "The migration also logs out all other clients
//    (gracefully)"): each wipes itself at its next sync and its first screen says the account moved (devices.js MOVED_MARK).
const MOVE_TEXT = 'This account still uses the old backup service. Move it to the new account service: your devices are then checked by the service, and signing out a device takes effect at once. Your Spaces and your recovery code stay the same.'
const MOVE_MESSAGES = {
  already_migrated: 'This account was already moved to the new account service, from another of your devices. To use this device with it: Settings → Reset this device, then restore your Spaces with your recovery code — or add this device from one that moved (Add a device).',
  no_legacy_gate: 'The new service can’t find this account’s backup on the old service. If you typed your recovery code, check it. Nothing changed.',
  nothing_to_migrate: 'This account’s backup on the old service was deleted, so there’s nothing to move. Nothing changed.',
  feature_unavailable: 'Moving accounts to the new service isn’t open yet. Nothing changed.',
  attempt_ended: 'That took too long, or another move of this account is under way. Nothing changed — try again in a few minutes.',
  no_backup: 'This device has no backup to move. Turn on backup first.',
}
const _moveProbe = new Map(), _moveKnown = new Map() // service → its answer (asked once per page; a failed ask is asked again)
/** Does `svc` accept moves now? An UNSIGNED intent: `501 feature_unavailable` while the service's switch (ACCT_FEATURES
 *  `migration`) is off; on, its signature check refuses it (401) before anything is read or written. */
export function moveOpen(svc, fetchImpl = (...x) => fetch(...x)) {
  if (!svc) return Promise.resolve(false)
  if (_moveKnown.has(svc)) return Promise.resolve(_moveKnown.get(svc))
  if (!_moveProbe.has(svc)) {
    _moveProbe.set(svc, (async () => {
      try {
        const r = await fetchImpl(String(svc).replace(/\/+$/, '') + '/v2/account/legacy/intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        const on = r.status !== 501 && r.status !== 404 && r.status < 500
        _moveKnown.set(svc, on)
        return on
      } catch { return false } finally { _moveProbe.delete(svc) }
    })())
  }
  return _moveProbe.get(svc)
}
const moveSvc = () => { try { return (dep().moveService && dep().moveService()) || '' } catch { return '' } }
const oldAccountHere = () => { try { return dep().oldAccountHere ? !!dep().oldAccountHere() : true } catch { return false } }
/** Offer the move here? An account on the old service, and its service open to moves — not yet known: ask, then redraw. */
function moveShown(rerender) {
  if (!oldAccountHere()) return false
  const svc = moveSvc()
  if (!svc) return false
  if (_moveKnown.has(svc)) return _moveKnown.get(svc) === true
  moveOpen(svc).then((on) => { if (on) rerender() }).catch(() => {})
  return false
}
/** The section of a device whose account is still on the OLD service (the new service's client is off here): the move only. */
function renderMoveOnly(box, rerender) {
  if (!moveShown(rerender)) return
  const sec = document.createElement('div')
  sec.id = 'acctV2Section'
  sec.style.cssText = 'margin-top:14px; padding-top:10px; border-top:1px solid rgba(127,127,127,.25)'
  const t = document.createElement('div'); t.className = 'sheet-s'; t.style.cssText = 'padding:4px; font-weight:600'; t.textContent = 'New account service'
  const d = document.createElement('div'); d.className = 'sheet-s'; d.style.cssText = 'padding:4px 4px 8px; opacity:.75'; d.textContent = MOVE_TEXT
  const b = document.createElement('button'); b.className = 'dev-out'; b.type = 'button'; b.style.cssText = 'width:100%; padding:10px'
  b.id = 'acctV2Move'; b.textContent = 'Move to the new account service'
  b.onclick = () => moveAccount(rerender)
  sec.append(t, d, b)
  box.append(sec)
}
/** THE MOVE, OFFERED WHEN THE APP OPENS (the owner, 2026-11-18: "Yes" — for the old accounts the silent move cannot take: their old
 *  backup has no account key, so the reviewed email path is the only safe one). acctSilentMove.js calls it once the silent move
 *  stopped with `email_needed`; "Not now" (or any cancel) waits a week, as the silent stop does. → whether the account moved. */
export async function offerAutoMove(rerender = () => {}) {
  if (!oldAccountHere()) return false
  return moveAccount(rerender, { auto: true })
}
const AUTO_MOVE_TEXT = (address) => `Your account needs a one-time move to Witbitz’s new account service.\n\nWe’ll send a code to ${address} — type it in the next step. Your Spaces and your recovery code stay as they are.\n\nWhen the move is done, your OTHER devices are signed out: each clears itself the next time it’s online and says why. To use one again, restore your Spaces on it with your recovery code, or add it from this device (Add a device).\n\nYou can also do it later: Settings → Back up & recovery.`
/** The move itself. The device is switched onto the service for it, and back if the account did not move. → whether it moved. */
async function moveAccount(rerender, { auto = false } = {}) {
  const address = accountAddress()
  if (!address) { if (!auto) await notice('Sign in with your email on this device first.'); return false }
  if (!(await confirmSheet(auto ? { message: AUTO_MOVE_TEXT(address), confirmLabel: 'Move now', cancelLabel: 'Not now', destructive: false } : { message: `Move this account to the new account service?\n\nWe’ll send a code to ${address}. Your Spaces and your recovery code stay as they are.\n\nWhen the move is done, your OTHER devices are signed out: each clears itself the next time it’s online and says why. To use one again, restore your Spaces on it with your recovery code, or add it from this device (Add a device).`, confirmLabel: 'Move', destructive: false }))) return false
  let a = acctV2(), undo = () => {}
  if (!a.enabled()) {
    const svc = moveSvc()
    if (!svc || !dep().switchOn) { await notice(MESSAGES.v2_off); return false }
    undo = dep().switchOn(svc) || (() => {})
    a = acctV2()
    if (!a.enabled()) { undo(); await notice(MESSAGES.v2_off); return false }
  }
  let typedCode = null, r = null
  while (!r) {
    try {
      r = await a.migrate({ address, getCode: emailCode(address), typedCode })
    } catch (e0) {
      let e = e0
      if (e && e.code === 'need_code' && !typedCode) { // this device keeps no copy of the code: the person types it
        typedCode = await askCode({ title: 'Your recovery code', message: MESSAGES.need_code, field: 'recovery' })
        if (typedCode) continue
        e = { code: 'cancelled' }
      }
      if (!a.state()) undo() // not moved: this device is left as it was (the old service, its backup, its devices)
      if (!(e && e.code === 'cancelled')) await notice(MOVE_MESSAGES[e && e.code] || messageFor(e))
      rerender()
      return false
    }
  }
  // MOVED. Only now are the other devices signed out (a move that failed signed out nobody).
  let others = null
  try { others = dep().afterMove ? await dep().afterMove({ trust: r.legacy_trust }) : null } catch { others = null }
  const emailOnly = r.legacy_trust === 'email_only'
  await notice('Done. This account now uses the new account service, with the same recovery code.'
    + (emailOnly ? '\n\nIt was moved with your email only (its old backup had no account key), so it stays in a lower-trust state: Advanced Backup isn’t available for it, and the original backup is kept as it was for a year.' : '')
    + (Array.isArray(others) && !others.length ? '' : '\n\nYour other devices are being signed out: each clears itself the next time it’s online and says why. To use one again, restore your Spaces on it with your recovery code, or add it from this device (Add a device).'))
  rerender()
  return true
}

/** THE NORMAL "Turn on backup" for a NEW account on the new service (recoverySheet.js turnOnBackup, when the release switch
 *  or the owner-only preview says so — acctV2Switch.newAccountService): the address this device signed in with, an email
 *  code, then the first recovery code (shown until saved). → { ok } | { ok: false, reason } */
export async function startNewAccountOnV2(address0) {
  const a = acctV2()
  let address = address0
  if (!address) {
    address = await askCode({ title: 'Your email', message: 'Your account is tied to this email address. We’ll send it a code.', field: 'address' })
    if (!address) return { ok: false, reason: 'cancelled' }
  }
  try {
    await withSteps(() => a.startFresh({ address, getCode: emailCode(address, 'new'), showCode }))
    return { ok: true }
  } catch (e) {
    if (e && e.code === 'cancelled') return { ok: false, reason: 'cancelled' }
    if (e && e.code === 'restore_instead') return { ok: false, reason: 'restore_instead' } // recoverySheet opens Restore
    if (e && e.code === 'move_email') return { ok: false, reason: 'move_email' } // recoverySheet starts the move (acctV2Reset.js)
    return { ok: false, reason: messageFor(e) }
  }
}

/** § 8.6 Add a device, on the APPROVING device (deviceLinkSheet.js giveTo): the service registers the new device's key —
 *  this device + an email code, or + a touch of a security key on an Advanced account. → { ok: true, acct, base, address }
 *  | { ok: false, reason } (reason '' = cancelled). Nothing of the account's goes to the new device unless this is ok. */
export async function approveNewDevice({ newSpk, label }) {
  const a = acctV2()
  const address = accountAddress()
  try {
    const r = await withSteps(() => a.enrolDevice({ newSpk, label, address, getCode: emailCode(address) }), 'Touch one of your security keys to add the device, then enter its PIN when asked.')
    return { ok: true, ...r }
  } catch (e) {
    if (e && e.code === 'cancelled') return { ok: false, reason: '' }
    if (e && e.code === 'key_registered') return { ok: false, reason: MESSAGES.enrol_key_registered }
    return { ok: false, reason: messageFor(e) }
  }
}

/** § 8.6 on the NEW device: the approving device registered it and sent { acct, base, address } with the account's keys.
 *  This device is switched on for that service (only the service this app may use — acctV2Switch.baseOf) and reads the
 *  backup through it with its own key. → { ok: true, rooms } | { ok: false, reason }; nothing kept on failure. */
export async function adoptLinkedV2({ v2, master, code }) {
  const base = baseOf(v2 && v2.base, location.hostname)
  if (!base || !v2.acct) return { ok: false, reason: 'This device can’t use the new account service. Use Restore your Spaces with your recovery code instead.' }
  let prev = null
  try { prev = localStorage.getItem(BASE_KEY) } catch { /* */ }
  try { localStorage.setItem(BASE_KEY, base) } catch { return { ok: false, reason: MESSAGES.v2_off } }
  try {
    const r = await acctV2().adoptLinked({ acct: v2.acct, address: v2.address || '', master, code })
    return { ok: true, rooms: r.rooms }
  } catch (e) {
    try { if (prev == null) localStorage.removeItem(BASE_KEY); else localStorage.setItem(BASE_KEY, prev) } catch { /* */ }
    return { ok: false, reason: messageFor(e) }
  }
}

/** Release checklist 1.11 — the "Delete my account" step for an account on the new service (accountEraseUi.js deleteBackup):
 *  an email code, then the service signs out every device, frees the address and deletes the backup. → { ok, reason? } —
 *  the shape of the old service's backup step, so the erase goes on only when this worked. */
export async function eraseV2Account() {
  const a = acctV2()
  let address = accountAddress()
  if (!address) {
    address = await askCode({ title: 'Your email', message: 'The email address of this account. We’ll send it a code to confirm the deletion.', field: 'address' })
    if (!address) return { ok: false, reason: 'cancelled' }
  }
  try {
    await withSteps(() => a.eraseAccount({ address, getCode: emailCode(address) }))
    return { ok: true }
  } catch (e) {
    if (e && e.code === 'cancelled') return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: messageFor(e) }
  }
}

/** SHOW THE RECOVERY CODE ON AN ACCOUNT ON THE NEW SERVICE (the owner, 2026-11-22: it showed with no check): the email check —
 *  Google or the emailed code — when no passkey on this device answered. → true when proved; false on a cancel or a failure. */
export async function proveEmailToShowCode() {
  const a = acctV2()
  const address = accountAddress()
  if (!a.enabled() || !a.state() || !address) return false
  try { await withSteps(() => a.proveEmail({ address, getCode: emailCode(address) })); return true }
  catch (e) { if (!(e && e.code === 'cancelled')) await notice(messageFor(e)); return false }
}

/** Bring an account on the new service to this device: its email, its recovery code, an email code, and a key if Advanced. */
async function restoreHere(a, address0, rerender) {
  let address = address0
  if (!address) {
    address = await askCode({ title: 'Your email', message: 'The email address of the account you’re restoring. Next, you confirm it’s you with Google or a code by email.', field: 'address' })
    if (!address) return
  }
  const code = await askCode({ title: 'Your recovery code', message: `The recovery code of the account for ${address}.`, field: 'recovery' })
  if (!code) return
  try {
    const r = await withSteps(() => a.restoreHere({ address, getCode: emailCode(address), typedCode: code }))
    await notice(`Done. Your account is on this device${r.rooms ? ` (${r.rooms} Space${r.rooms === 1 ? '' : 's'})` : ''}.`)
    // finish like every other restore (recoverySheet.js finishRestore, which listens): the account's index and the private
    // lanes registry are read before the list is drawn — without it each private lane showed as a Space of its own (the
    // owner's iPhone, 2026-11-15). An event, not an import: this card also runs where the recovery sheet does not.
    dispatchEvent(new CustomEvent('acctv2:restored', { detail: { rooms: r.rooms || 0 } }))
  } catch (e) { if (!(e && e.code === 'cancelled')) await notice(messageFor(e)) }
  rerender()
}

/** Start an account on the new service from this device: confirm the address, get the first recovery code. */
async function startFresh(a, address0, rerender) {
  let address = address0
  if (!address) {
    address = await askCode({ title: 'Your email', message: 'Your account on the new service is tied to this email address. We’ll send it a code.', field: 'address' })
    if (!address) return
  }
  if (!(await confirmSheet({ message: `Start an account on the new service from this device?\n\nWe’ll send a code to ${address}, then show you a new recovery code to save. This device’s current backup and recovery code are replaced by the new ones.`, confirmLabel: 'Start', destructive: false }))) return
  try {
    await a.startFresh({ address, getCode: emailCode(address, 'new'), showCode })
    await notice('Done. This device has an account on the new account service, with your new recovery code.')
  } catch (e) {
    if (e && e.code === 'restore_instead') return restoreHere(a, address, rerender) // the email already has an account: restore it
    if (!(e && e.code === 'cancelled')) await notice(messageFor(e))
  }
  rerender()
}

// ── Advanced Backup (docs/account-recovery-design.md § 6; protocol § 10): security keys ──

/** Known key models by their model id (AAGUID); every accepted key is a YubiKey (the service pins Yubico's certificates). */
const MODELS = { 'f4ce5fc057d346f5a736efb7d5bc63b5': 'YubiKey 5 series with NFC' }
const modelOf = (aaguid) => MODELS[String(aaguid || '').replace(/-/g, '')] || 'YubiKey'

/** The card before each security-key prompt: what to touch, and a button whose tap opens the browser's prompt (Safari opens
 *  one only in answer to a tap). Hidden until a prompt is due. */
function stepCard() {
  const shade = document.createElement('div')
  shade.id = 'acctV2KeyStep'
  shade.style.cssText = 'position:fixed; inset:0; z-index:2147482000; background:rgba(0,0,0,.45); display:none; align-items:center; justify-content:center; padding:16px'
  shade.className = 'kbfit' // with the keys up it fits the visible area (space.html), its field above them
  const card = document.createElement('div')
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true')
  card.style.cssText = 'background:var(--bg, #fff); color:var(--fg, #111); border-radius:14px; padding:18px; max-width:360px; width:100%; box-shadow:0 10px 40px rgba(0,0,0,.3)'
  const h = document.createElement('div'); h.textContent = 'Security key'; h.style.cssText = 'font-weight:600; font-size:17px; margin-bottom:6px'
  const p = document.createElement('div'); p.id = 'acctV2KeyStepText'; p.style.cssText = 'font-size:14px; opacity:.85; line-height:1.4'
  const row = document.createElement('div'); row.style.cssText = 'display:flex; gap:8px; margin-top:14px'
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'
  const go = document.createElement('button'); go.type = 'button'; go.id = 'acctV2KeyGo'; go.textContent = 'Use security key'
  for (const b of [cancel, go]) b.style.cssText = 'flex:1; padding:11px; border-radius:10px; border:0; font-size:15px; cursor:pointer'
  go.style.background = 'var(--accent, #1f5fd6)'; go.style.color = '#fff'
  row.append(cancel, go); card.append(h, p, row); shade.append(card); document.body.append(shade)
  return {
    /** Show `text`; on the tap, run `call()` inside it and settle with its result. */
    ask: (text, call) => new Promise((resolve, reject) => {
      p.textContent = text
      shade.style.display = 'flex'
      go.onclick = () => { shade.style.display = 'none'; let pr; try { pr = call() } catch (e) { reject(e); return } Promise.resolve(pr).then(resolve, reject) }
      cancel.onclick = () => { shade.style.display = 'none'; reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })) }
    }),
    close: () => shade.remove(),
  }
}
const STEP_TEXT = ({ step, index, of }) => step === 'register'
  ? (of > 1 ? `Security key ${index + 1} of ${of}: insert or tap it, then enter its PIN when asked.` : 'Insert or tap your new security key, then enter its PIN when asked.')
  : step === 'confirm'
    ? (of > 1 ? `Now confirm security key ${index + 1} of ${of}: touch it once more.` : 'Now confirm the new key: touch it once more.')
    : 'Last step: touch one of your existing security keys.'

/** Run a flow with the key card: before each prompt it says which key to touch (the flow's latest step, else `fallback`). */
export async function withSteps(run, fallback = 'Insert or tap one of your security keys, then enter its PIN when asked.') {
  const card = stepCard()
  let text = null
  onKeyPrompt((kind, call) => card.ask(text || fallback, call))
  try { return await run((s) => { text = STEP_TEXT(s) }) } finally { onKeyPrompt(null); card.close() }
}

export function renderAdvanced(sec, a, address, rerender, { confirm = confirmSheet, notify = notice, getCode = emailCode(address) } = {}) {
  const box = document.createElement('div')
  box.id = 'acctV2Advanced'
  box.style.cssText = 'margin-top:12px'
  const t = document.createElement('div'); t.className = 'sheet-s'; t.style.cssText = 'padding:4px; font-weight:600'; t.textContent = 'Advanced Backup'
  const d = document.createElement('div'); d.className = 'sheet-s'; d.style.cssText = 'padding:4px 4px 8px; opacity:.75'; d.textContent = 'Checking…'
  box.append(t, d)
  sec.append(box)
  const btn = (id, text) => { const x = document.createElement('button'); x.className = 'dev-out'; x.type = 'button'; x.id = id; x.textContent = text; x.style.cssText = 'width:100%; padding:10px; margin-top:6px'; box.append(x); return x }
  const run = async (fn, done) => {
    try { await fn(); await notify(done) } catch (e) { if (!(e && e.code === 'cancelled')) await notify(messageFor(e)) }
    rerender()
  }
  a.security().then((st) => {
    if (st.mode !== 'advanced') {
      if (!st.advanced_available) { d.textContent = 'Not available for this account yet.'; return }
      d.textContent = 'Restoring your backup also needs one of your security keys (YubiKeys). Someone with your recovery code and your email still can’t restore it without a key.'
      btn('acctV2AdvOn', 'Turn on Advanced Backup').onclick = async () => {
        if (!(await confirm({ message: `Turn on Advanced Backup?\n\nYou’ll register your security keys now — have them ready, with their PINs. Either key works alone.\n\nIf you lose every key AND every device, nobody can restore your backup — not even Spaces support.\n\nWe’ll send a code to ${address}.`, confirmLabel: 'Continue', destructive: false }))) return
        run(() => withSteps((onStep) => a.turnOnAdvanced({ address, getCode, onStep })), 'Advanced Backup is on. Restoring now needs one of your security keys.')
      }
      return
    }
    d.textContent = st.keys.length === 1 ? 'On, with 1 security key.' : `On, with ${st.keys.length} security keys. Any one of them works.`
    for (const k of st.keys) {
      const row = document.createElement('div')
      row.className = 'acctV2Key'
      row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 4px'
      const name = document.createElement('div'); name.style.cssText = 'flex:1; font-size:14px'
      const when = k.activated_at ? new Date(k.activated_at * 1000).toLocaleDateString() : ''
      name.textContent = modelOf(k.aaguid) + (when ? ' · added ' + when : '')
      row.append(name)
      if (st.keys.length > 1) {
        const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'dev-out acctV2KeyRemove'; rm.textContent = 'Remove'; rm.style.cssText = 'padding:6px 10px'
        rm.onclick = async () => {
          if (!(await confirm({ message: `Remove this security key?\n\nYou’ll confirm with one of your OTHER keys. We’ll send a code to ${address}.`, confirmLabel: 'Remove' }))) return
          run(() => withSteps(() => a.removeKey({ address, getCode, credId: k.credId }), 'When asked, touch one of your OTHER security keys — not the one you’re removing.'), 'The key is removed.')
        }
        row.append(rm)
      }
      box.append(row)
    }
    btn('acctV2AddKey', 'Add a security key').onclick = async () => {
      if (!(await confirm({ message: `Add a security key?\n\nHave the new key AND one of your current keys ready. We’ll send a code to ${address}.`, confirmLabel: 'Continue', destructive: false }))) return
      run(() => withSteps((onStep) => a.addKey({ address, getCode, onStep })), 'The new key is added.')
    }
    btn('acctV2AdvOff', 'Turn off Advanced Backup').onclick = async () => {
      if (!(await confirm({ message: `Turn off Advanced Backup?\n\nRestoring will need only your recovery code and your email again, and your security keys are removed. We’ll send a code to ${address} and ask for one of your keys.`, confirmLabel: 'Turn off' }))) return
      run(() => withSteps(() => a.turnOffAdvanced({ address, getCode })), 'Advanced Backup is off.')
    }
  }).catch((e) => { d.textContent = 'Couldn’t check right now.'; void e })
}

/** The app's first-run "Restore my Spaces" with a recovery code (recoverySheet.js doRestore), where the new service is on:
 *  try it first. → null = not here (switched off, already an account, or the service does not know this code — today's
 *  restore goes on), { done, rooms, address } = restored, { message } = stop and show it. */
export async function restoreFromCode(code, { service = null, signIn = null } = {}) {
  let a = acctV2()
  if (a.enabled() && a.state()) return null // this device already has an account on the new service
  // A DEVICE NOT YET ON THE NEW SERVICE (a new phone, a fresh browser): once new accounts start there (the release switch,
  // acctV2Switch.newAccountService — the same rule, so every account it makes can be restored), the normal Restore asks it
  // too, switching this device on for the try and back if the code is not an account there. Without this, an account made
  // there could not be restored anywhere but a device already switched on (found 2026-11-15, before the switch).
  let undo = null
  if (!a.enabled()) {
    let prev = null
    try { prev = localStorage.getItem(BASE_KEY) } catch { /* */ }
    const svc = service || newAccountService({ host: location.hostname, stored: prev })
    if (!svc) return null
    try { localStorage.setItem(BASE_KEY, svc) } catch { return null }
    undo = () => { try { if (prev == null) localStorage.removeItem(BASE_KEY); else localStorage.setItem(BASE_KEY, prev) } catch { /* */ } }
    a = acctV2()
    if (!a.enabled()) { undo(); return null }
  }
  // the email is asked only once the service has shown the code IS an account there (acctV2Client.restore): an old
  // account's restore falls through below without an email prompt or a code sent
  let address = accountAddress(), found = false, picked = null, signedIn = null
  // ONE CARD, GOOGLE OR THE EMAIL (the owner, 2026-11-22: "We should see the Google login and email code in the same page. No
  // previous page that you enter the email"): with no address known, the card offers Continue with Google (the address is then
  // the Google account's) beside the email field (a code is mailed to it); the choice is kept and `choose` answers it.
  const askAddress = async ({ action } = {}) => {
    found = true // the service knows this code
    // ONE SIGN-IN (the owner, 2026-11-23: "we do the login twice"): where the app hands its own sign-in (`signIn`), the proof IS the
    // app's sign-in card — Google or the app's emailed code — bound to this challenge; the device stays signed in after the restore
    if (signIn && action) {
      signedIn = await signIn({ challenge: action })
      if (!signedIn) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
      picked = { signIn: { idToken: signedIn.idToken, spk: signedIn.spk, sig: signedIn.sig } }; address = signedIn.email
      return address
    }
    if (!address) {
      const got = await askCode({ title: 'Confirm it’s you', message: 'Continue with the Google account of your Spaces account, or enter its email address for a 6-digit code.', field: 'address', google: action ? { action } : null })
      if (got && typeof got === 'object' && got.google) { picked = { google: got.google }; address = googleEmailOf(got.google) }
      else if (got) { picked = action ? { email: true } : null; address = got }
    }
    if (!address) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
    return address
  }
  try {
    // GOOGLE OR THE CODE, ASKED FIRST HERE TOO (the owner, 2026-11-21, the iPhone app's restore: "it sends the code automatically
    // and only then I get the Google sign option"): this wrapper (the address is known only once the service knows the code) had no
    // `choose`, so acctV2Client mailed the code at once. The address is set by askAddress before the client asks the choice.
    const getCode = Object.assign((ctx) => emailCode(address)(ctx), { choose: (o) => (picked ? Promise.resolve(picked) : chooseProof({ address, ...o })) })
    const r = await withSteps(() => a.restoreHere({ address: askAddress, getCode, typedCode: code }))
    return { done: true, rooms: r.rooms, address, ...(signedIn ? { signedIn: true } : {}) }
  } catch (e) {
    if (undo) undo()
    if (signedIn && signedIn.undo) { try { signedIn.undo() } catch { /* */ } } // the restore did not happen: neither does its sign-in
    if (e && e.code === 'no_account') return null
    if (e && e.code === 'cancelled') return { message: '' }
    // the service could not be reached (or failed) before it said whether the code is an account there: today's restore
    // goes on — an old account is never stopped by the new service being down
    if (!found && !(e && e.status && e.status < 500)) return null
    return { message: messageFor(e) }
  }
}
