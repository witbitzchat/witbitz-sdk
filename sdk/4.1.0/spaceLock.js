// spaceLock.js — SHARED tier-2 biometric lock (Face ID / Touch ID). Used by BOTH the tenant vault (vault-loader.js,
// covering the app IFRAME) and the regular single-origin app (space.js, covering its OWN DOM). Extracted so the two
// don't drift (convergence: one core, the surface difference parameterised — cf. sw-notif-core.js).
//
// ★ TIER 2 = the OS biometric prompt gates the PIXELS: an opaque overlay covers the app until a user-verified WebAuthn
// assertion passes. It does NOT encrypt keys by itself — a storage extraction bypasses it. TIER 3 is the `protect` option
// below (docs/device-storage-protection.md): "Also protect this device's storage" enrolls a PRF/largeBlob passkey
// (spacePasskey.js) and hands the derived device secret to the shell at enroll / unlock / lock, which seals the key store.
//
// The DIFFERENCES between the two surfaces are the only config:
//   storeKey  localStorage key for the {on,auto,credId} config ('vault:lock' vs 'space:lock')
//   ids       DOM id map (the regular app overrides `err` — space.html already owns a #lockErr for an unrelated msg)
//   cover     { onEngage, onRelease } — the vault hides/shows the app iframe; the regular app is a no-op (the overlay,
//             at max z-index, covers its own DOM)
//   onState   called after any config change (vault → postMessage the app its Settings row state; app → refresh the row)

const B64 = (u8) => { let t = ''; for (let i = 0; i < u8.length; i++) t += String.fromCharCode(u8[i]); return btoa(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const U8 = (b) => { const t = atob(String(b).replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u }

// What this device calls its passkey check — the lock screen said "Face ID or Touch ID" on a Windows computer too.
export function unlockWithName (nav = globalThis.navigator) {
  const ua = String((nav && nav.userAgent) || ''), plat = String((nav && nav.userAgentData && nav.userAgentData.platform) || '')
  if (/Windows/i.test(plat) || /Windows/i.test(ua)) return 'Windows Hello'
  if (/iPhone|iPad|Mac/i.test(ua) || /macOS|iOS/i.test(plat)) return 'Face ID or Touch ID'
  return 'your fingerprint or screen lock'
}
// The lock card's own words for it (sync sweep 10-24 #27: "Face ID lock", "Waiting for Face ID…" on a Windows computer):
// `check` is what asks, `title` the switch, `require` the line under the card's title. A Mac without touch has Touch ID.
export function lockNames (nav = globalThis.navigator) {
  const n = unlockWithName(nav), ua = String((nav && nav.userAgent) || '')
  if (n === 'Windows Hello') return { check: 'Windows Hello', title: 'Windows Hello lock', require: 'Windows Hello' }
  if (n === 'Face ID or Touch ID' && /Macintosh/i.test(ua) && !(Number(nav && nav.maxTouchPoints) > 1)) return { check: 'Touch ID', title: 'Touch ID lock', require: 'Touch ID' }
  if (n === 'Face ID or Touch ID') return { check: 'Face ID', title: 'Face ID lock', require: 'Face ID / Touch ID' }
  return { check: 'your screen lock', title: 'Screen lock', require: 'your fingerprint or screen lock' }
}
// What a failed check says — this device's own name for it, never "Face ID" on a computer (sync sweep 10-20 #9).
// the browser's own reason in brackets (the owner's iPhone app, 2026-11-22: "Why I get didn't complete yet?" — it said nothing more)
const whyOf = (e) => { const n = (e && e.name) || '', m = String((e && e.message) || '').slice(0, 90); return n || m ? ` (${[n, m].filter(Boolean).join(': ')})` : '' }
const didntComplete = (e) => `${unlockWithName().replace(/^your /, 'The ')} didn’t complete — try again.${whyOf(e)}`
// A second request while the system's prompt is still up is refused as already pending — not a failed check.
export const isPendingRefusal = (e) => !!e && (e.name === 'InvalidStateError' || /already pending|pending request|in progress/i.test(String(e.message || '')))

const DEFAULT_IDS = { screen: 'lockscreen', set: 'lockset', unlockBtn: 'unlockBtn', err: 'lockErr', on: 'lockOn', off: 'lockOff', msg: 'lockMsg', auto: 'lockAuto', close: 'lockClose', protect: 'lockProtect', protectMsg: 'lockProtectMsg', previews: 'lockPreviews', toggle: 'lockToggle', toggleLbl: 'lockToggleLbl', desc: 'lockDesc', reset: 'lockReset' }

// `appName` (default 'Spaces'): the name the sheet and the lock's own passkey say — a builder's vault (vaultCoreLock.js) passes its brand.
// `owner` (the desktop app, Linux and the Mac — desktop/ownerCheck.mjs; the owner, 2026-11-22): { check(reason) → Promise<{ ok }>, names }
//   — the OPERATING SYSTEM confirms the person (the Mac's Touch ID or password, Linux's polkit dialog) in place of a passkey, which
//   Electron cannot show there. No credential is made; the config's credId is the marker OWNER_ID. Tier 3 (`protect`) is not offered
//   with it: the desktop app's storage is sealed by the OS key store already.
export const OWNER_ID = 'desktop-owner'
export function makeLock({ storeKey, ids = {}, cover = {}, onState, protect = null, appName = 'Spaces', owner = null } = {}) {
  const id = { ...DEFAULT_IDS, ...ids }
  const O = owner && typeof owner.check === 'function' ? owner : null
  const names = () => (O && O.names && O.names.check ? O.names : lockNames())
  const checkName = () => (O && O.names && O.names.check ? O.names.check : unlockWithName())
  const ownerConfirms = async () => { const r = await O.check('unlock ' + appName); if (r && r.ok) return true; if (r && !r.cancelled && r.error) throw Object.assign(new Error(r.error), { name: 'OwnerCheck' }); return false }
  // §PROTECT hooks (all optional; absent ⇒ tier 2 exactly as before): enroll(label) → { credId, secret }; unlock(credId) →
  // { secret } (a user-verified assertion, so it also serves as the tier-2 gate); onProtect(secret) seals the device's
  // stores; onUnlock(secret) opens them; onLock() drops them from memory; onUnprotect(secret) writes them back in the clear.
  const P = protect && typeof protect === 'object' ? protect : null
  const protectOn = () => { const c = cfg(); return !!(P && c.protect && c.protect.on && c.protect.credId) }
  // §PREVIEWS (opt-in under protection): leave only the push-preview keys in the clear, so a tickle shows the sender + first
  // line while the device is locked; the room keys, the identity and the cached messages stay sealed. onPreviews(on) applies it.
  const previewsOn = () => { const c = cfg(); return !!(c.protect && c.protect.on && c.protect.previews) }
  const el = (k) => { try { return document.getElementById(id[k]) } catch (e) { return null } }
  const onEngage = cover.onEngage || (() => {})   // vault: hide the app iframe · regular: no-op (overlay covers)
  const onRelease = cover.onRelease || (() => {})
  const notify = typeof onState === 'function' ? onState : (() => {})

  function cfg() { try { const c = JSON.parse(localStorage.getItem(storeKey) || 'null'); return (c && typeof c === 'object') ? c : { on: false, auto: 5 } } catch (e) { return { on: false, auto: 5 } } }
  function save(c) { try { localStorage.setItem(storeKey, JSON.stringify(c)) } catch (e) {} notify(cfg()) }

  async function enroll() { // a dedicated PLATFORM credential for the lock (wraps nothing in tier 2)
    if (O) return (await ownerConfirms()) ? OWNER_ID : null // the desktop app: the system confirms; nothing to make
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: appName }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: appName + ' lock', displayName: appName + ' lock' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000 } })
    return (cred && cred.rawId) ? B64(new Uint8Array(cred.rawId)) : null
  }
  async function assert() { // ANY user-verified assertion unlocks — pinned to the enrolled credential when we have one
    if (O) return ownerConfirms()
    const c = cfg()
    const pk = { challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: 'required', timeout: 60000 }
    if (c.credId) pk.allowCredentials = [{ type: 'public-key', id: U8(c.credId) }]
    const a = await navigator.credentials.get({ publicKey: pk })
    return !!a
  }
  // THE OWNER, PROVEN, WITH A PASSKEY THAT EXISTS (2026-10-16; the owner: "It did not read my face … it doesn't find a
  // passkey"). The lock keeps its credId when it goes off, and the credential can be gone from the device since (deleted,
  // replaced). Asking only for it then fails for ever: the switch never goes off and a launch never unlocks. When the
  // remembered one does not answer, a NEW platform passkey with userVerification 'required' is the same Face ID / passcode
  // proof — make it, keep it. ⇒ the credId that verified, or null.
  async function verifyOwner() {
    if (O) return (await ownerConfirms()) ? OWNER_ID : null // the system's own check, every time — never a passkey
    const c = cfg()
    if (c.credId) { try { if (await assert()) return c.credId } catch (e) { if (isPendingRefusal(e)) throw e /* the first prompt is still up — never a new passkey for it */ } } // else gone, or cancelled: a new passkey asks again
    const id = await enroll()
    if (id) save({ ...cfg(), credId: id })
    return id
  }

  let _locked = false, _hiddenAt = 0, _visWired = false
  // §HAND-OFF: the standalone app LOADS A NEW PAGE whenever it opens a room (location.href) — and "lock when the app opens"
  // used to fire on every one of those (the owner's phone, 2026-10-06: a Face ID for each room). An unlocked page stamps
  // the moment it leaves (pagehide); a page that loads within HANDOFF_MS of that stamp is the same session continuing, not a
  // launch. Tier 3 also needs the KEY to cross: P.handoff() asks the service worker for it (space.js); no key → the prompt.
  const HANDOFF_MS = 20000
  const leftKey = storeKey + ':left'
  const stampLeft = () => { try { if (cfg().on && !_locked) sessionStorage.setItem(leftKey, String(Date.now())) } catch (e) {} }
  const takeLeft = () => { try { const v = +sessionStorage.getItem(leftKey) || 0; sessionStorage.removeItem(leftKey); return v } catch (e) { return 0 } }
  // WHY rides along (2026-10-21, the owner's vault: "app frame hidden (Face ID lock)" while turning the lock OFF, and the app
  // stayed hidden): the cover says which path engaged it, and a lock that is off never engages.
  function engage(why = '') {
    if (_locked) return
    if (!cfg().on) return
    _locked = true
    if (protectOn() && P.onLock) { try { Promise.resolve(P.onLock()).catch(() => {}) } catch (e) {} } // §PROTECT: nothing usable stays in memory while locked
    try {
      const scr = el('screen'); if (!scr) { _locked = false; return }
      const btn = el('unlockBtn'); if (btn) btn.onclick = tryUnlock
      const em = el('err'); if (em) em.textContent = ''
      const how = scr.querySelector && scr.querySelector('p'); if (how) how.textContent = `Unlock with ${checkName()} to continue.`
      onEngage(why); holdScroll(true); scr.style.display = 'flex'
    } catch (e) { _locked = false }
  }
  // NO SCROLLBAR UNDER THE LOCK (the owner, 2026-10-21, desktop: "when I unlock it wiggles left and right before settling").
  // While the card is up the room is laid out beneath it; for a frame the page was taller than the window, a classic
  // scrollbar appeared, the window's width dropped by its ~24 px and the centred card jumped 12 px left and back (measured
  // frame by frame in the recording). The page's own overflow is held hidden for exactly as long as the card is shown.
  let _ovf = null
  const holdScroll = (on) => { try { const h = document.documentElement; if (on) { if (_ovf === null) { _ovf = h.style.overflow || ''; h.style.overflow = 'hidden' } } else if (_ovf !== null) { h.style.overflow = _ovf; _ovf = null } } catch (e) {} }
  function release() { _locked = false; try { const scr = el('screen'); if (scr) scr.style.display = 'none'; holdScroll(false); onRelease() } catch (e) {} }
  async function tryUnlock() {
    const em = el('err'), btn = el('unlockBtn')
    // ★ FEEDBACK AT ONCE (the owner, 2026-10-19: "when i press unlock there is no feedback that it was being pressed"): the
    //   system's passkey prompt can take a moment to come up — the button says so, and a second press does nothing meanwhile
    if (btn && btn.disabled) return
    const label = btn ? btn.textContent : ''
    if (btn) { btn.disabled = true; btn.setAttribute?.('aria-busy', 'true'); if (btn.style) btn.style.opacity = '0.6'; btn.textContent = 'Unlocking…' }
    try { return await unlockOnce(em) } finally {
      if (btn) { btn.disabled = false; btn.removeAttribute?.('aria-busy'); if (btn.style) btn.style.opacity = ''; btn.textContent = label }
    }
  }
  async function unlockOnce(em) {
    try {
      if (em) em.textContent = ''
      if (protectOn()) { // §PROTECT: the passkey assertion IS the gate, and its secret reopens the sealed stores
        const r = await P.unlock(cfg().protect.credId)
        if (!r || !r.secret) { if (em) em.textContent = 'Not verified — try again.'; offerStartOver(); return }
        if (P.onUnlock) await P.onUnlock(r.secret, { previews: previewsOn() })
        // a switch-on that was cut short: finish it now, with the same key — but a failure there (a full disk) must not keep the
        // person behind the lock the passkey just opened (A#14): `pending` stays, the next unlock tries again
        try { await finishPending(r.secret) } catch (e) { try { console.warn('lock: finishing protection failed — tried again at the next unlock', e && e.message) } catch (_) {} }
        release(); return
      }
      const ok = await verifyOwner(); if (ok) release(); else if (em) em.textContent = 'Not verified — try again.'
    }
    catch (e) {
      if (isPendingRefusal(e)) return // the prompt from the first press is still up: nothing failed, nothing to start over
      if (em) em.textContent = `${checkName().replace(/^your /, 'The ')} didn’t complete — press Unlock to try again.${whyOf(e)}`; offerStartOver()
    }
  }
  // A PROTECTED device whose passkey is gone (replaced on the authenticator, deleted, another computer) can never open its
  // sealed stores again. After a failed unlock, offer to start this browser over — the Spaces themselves live in the
  // account (the backup, the other devices); only this browser's sealed copy goes. The shell supplies P.startOver.
  function offerStartOver() {
    try {
      if (!protectOn() || !P || typeof P.startOver !== 'function') return
      const b = el('reset'); if (!b) return
      b.style.display = ''
      b.onclick = () => { try { P.startOver() } catch (e) { /* */ } }
    } catch (e) { /* */ }
  }
  function wireVisibility() {
    if (_visWired) return; _visWired = true
    try { addEventListener('pagehide', stampLeft) } catch (e) {}
    document.addEventListener('visibilitychange', () => {
      try {
        const c = cfg(); if (!c.on) return
        if (document.hidden) { _hiddenAt = Date.now(); return }
        const away = _hiddenAt ? Date.now() - _hiddenAt : 0
        _hiddenAt = 0 // ONE absence, judged once — a stale stamp must not lock a later return (a Face ID prompt, 2026-10-21)
        if (_locked) return
        const auto = +c.auto || 0
        if (auto > 0 && away > auto * 60000) engage('away ' + Math.round(away / 60000) + ' min')
      } catch (e) {}
    })
  }
  function onLaunch() {
    try {
      if (!cfg().on) return
      const left = takeLeft(), gap = Date.now() - left
      if (!(left && gap >= 0 && gap < HANDOFF_MS)) { engage('launch'); return } // a launch (or a long gap): the lock, as before
      if (!protectOn()) return // tier 2: the same session, continuing — stay unlocked
      Promise.resolve().then(() => (P && P.handoff ? P.handoff() : false)).then((ok) => { if (!ok) engage('handoff: no key') }, () => engage('handoff failed')) // tier 3: the key must have crossed too
    } catch (e) {}
  }

  async function showSheet() { // enable/disable ceremony — needs REAL top-level user activation (WebAuthn)
    const scr = el('set'); if (!scr) return
    const onB = el('on'), offB = el('off'), msg = el('msg'), sel = el('auto')
    const c = cfg()
    if (msg) msg.textContent = ''
    if (sel) sel.value = String(+c.auto || 0)
    const nm = names() // this device's own words (Windows Hello, Touch ID…, the desktop app's system check), never "Face ID" on a computer
    const lbl = el('toggleLbl'), desc = el('desc')
    if (lbl) lbl.textContent = nm.title
    if (desc) desc.textContent = `Require ${nm.require} to open ${appName} on this device.`
    if (onB) onB.textContent = `Turn on ${nm.title}`
    if (offB) offB.textContent = `Turn off (${nm.check.replace(/^your /, '')})`
    if (onB) onB.style.display = c.on ? 'none' : ''
    if (offB) offB.style.display = c.on ? '' : 'none'
    const pBox = el('protect'), pMsg = el('protectMsg')
    // §PROTECT FOLLOWS THE LOCK (the owner, 2026-10-16: "always off and grayed out without the lock on. With the lock on it
    // is turned on and off only after checking the passkey"). Off + greyed out while the lock is off; while it is on, each
    // change is one passkey ceremony — on: a protection passkey, its secret seals the stores; off: that passkey's secret
    // writes them back — and the lock stays on. A failed or cancelled ceremony puts the switch back.
    const showProtect = () => {
      if (!pBox) return
      const cur = cfg()
      if (O && !protectOn()) { pBox.disabled = true; pBox.checked = false; if (pMsg) pMsg.textContent = 'This computer’s storage is already encrypted by its own key store.'; return }
      pBox.disabled = !P || !cur.on; pBox.checked = protectOn()
      if (pMsg) pMsg.textContent = !P ? 'Storage protection needs a browser with passkeys (Chrome, Edge, Safari).' : !cur.on ? `Turn on ${nm.title} first.` : (protectOn() ? 'On — your keys and messages on this device are encrypted until you unlock.' : '')
    }
    showProtect()
    if (pBox) pBox.onchange = async () => {
      const want = !!pBox.checked, cur = cfg()
      if (!P || !cur.on || want === protectOn()) { showProtect(); return }
      pBox.disabled = true; if (pMsg) pMsg.textContent = `Waiting for ${nm.check}…`
      try {
        if (want) {
          const r = await P.enroll(appName + ' device protection')
          if (!r || !r.credId || !r.secret) { showProtect(); if (pMsg) pMsg.textContent = 'This passkey can’t protect storage on this device.'; return }
          const previews = !!(P.previewsPref ? P.previewsPref() : (vBox && vBox.checked))
          // WRITE-AHEAD (2026-11-08, docs/state-machines.md I4): the config says "protected, not finished" BEFORE anything is sealed
          await switchOnProtection(r.secret, { credId: r.credId, mode: r.mode || 'prf', previews }) // the same passkey gates the lock from now on
        } else {
          const r = await P.unlock(cur.protect.credId)
          if (!r || !r.secret) { showProtect(); if (pMsg) pMsg.textContent = 'Not verified — protection stays on.'; return }
          if (P.onUnprotect) await P.onUnprotect(r.secret)
          const next = { ...cfg() }; delete next.protect; save(next) // the lock stays on, gated by the same passkey
        }
        showProtect()
      } catch (e) { showProtect(); if (pMsg) pMsg.textContent = didntComplete(e) }
    }
    const vBox = el('previews')
    if (vBox) { // §PREVIEWS: a sub-option of protection — while the lock is OFF it rides into the switch-on; while protection is ON it applies at once
      vBox.checked = !!(c.protect && c.protect.previews)
      vBox.disabled = !P || !protectOn()
      vBox.onchange = async () => {
        const cur = cfg(); if (!protectOn()) return // not on yet: the choice rides the switch-on
        vBox.disabled = true
        try { if (P.onPreviews) await P.onPreviews(vBox.checked); save({ ...cur, protect: { ...cur.protect, previews: vBox.checked } }) } catch (e) { vBox.checked = !vBox.checked }
        vBox.disabled = false
      }
    }
    onEngage(); scr.style.display = 'flex'
    if (onB) onB.onclick = async () => {
      onB.disabled = true; if (msg) msg.textContent = `Waiting for ${nm.check}…`
      try {
        // §PREVIEWS: the shell's "Show message preview" setting decides (beside Notifications, notifPreview.js); the sheet's
        // own box only on a shell that still has one.
        const protectCfg = null // storage protection is its own switch once the lock is on (§PROTECT FOLLOWS THE LOCK)
        const credId = await verifyOwner() // ALWAYS a Face ID — a remembered passkey may be gone (verifyOwner)
        if (!credId) { if (msg) msg.textContent = `Couldn’t set up ${nm.check} on this device.`; onB.disabled = false; return }
        save({ on: true, auto: +(sel && sel.value) || 0, credId, ...(protectCfg ? { protect: protectCfg } : {}) })
        if (msg) msg.textContent = protectCfg ? 'On ✓ — your keys and messages on this device are now encrypted until you unlock.' : `On ✓ — ${appName} will ask for ${nm.check} when it opens.`
        showProtect()
        onB.style.display = 'none'; onB.disabled = false; if (offB) offB.style.display = ''
      } catch (e) { if (msg) msg.textContent = O ? `${nm.check.replace(/^your /, 'The ')} didn’t complete — try again.${whyOf(e)}` : didntComplete(e); onB.disabled = false }
    }
    if (offB) offB.onclick = async () => {
      offB.disabled = true; if (msg) msg.textContent = `Confirm with ${nm.check} to turn off…`
      try {
        const cur0 = cfg()
        if (protectOn()) { // §PROTECT: the passkey's secret writes the stores back in the clear before the lock goes
          const r = await P.unlock(cur0.protect.credId)
          if (!r || !r.secret) { if (msg) msg.textContent = 'Not verified.'; offB.disabled = false; return }
          if (P.onUnprotect) await P.onUnprotect(r.secret)
        } else {
          const ok = await verifyOwner()
          if (!ok) { if (msg) msg.textContent = 'Not verified.'; offB.disabled = false; return }
        }
        const cur = cfg(); save({ on: false, auto: cur.auto, credId: cur.credId })
        if (_locked) release() // a cover that engaged meanwhile goes with the lock — never a lock screen for a lock that is off // keep the credential — re-enabling skips enrollment; protection is forgotten (re-enable re-enrolls)
        showProtect()
        if (vBox) { vBox.checked = false; vBox.disabled = true }
        if (msg) msg.textContent = `Off. ${appName} opens without a lock.`
        offB.style.display = 'none'; offB.disabled = false; if (onB) onB.style.display = ''
      } catch (e) { if (msg) msg.textContent = didntComplete(e); offB.disabled = false }
    }
    if (sel) sel.onchange = () => { const cur = cfg(); if (cur.on) save({ ...cur, auto: +sel.value || 0 }) }
    // THE SWITCH (a shell that has #lockToggle; 2026-10-10): one switch in place of the Turn on / Turn off buttons — it runs
    // the same ceremony as they do (Face ID, the protection passkey) and shows the lock's REAL state after, so a cancelled
    // Face ID leaves it where it was. The buttons stay as the ceremony's handles; a shell without the switch keeps them.
    const sw = el('toggle')
    if (sw) {
      const show = () => sw.setAttribute('aria-checked', String(!!cfg().on))
      if (onB) onB.style.display = 'none'
      if (offB) offB.style.display = 'none'
      show()
      sw.onclick = async () => {
        sw.disabled = true
        try { await (cfg().on ? (offB && offB.onclick && offB.onclick()) : (onB && onB.onclick && onB.onclick())) } finally {
          if (onB) onB.style.display = 'none'
          if (offB) offB.style.display = 'none'
          show(); sw.disabled = false
        }
      }
    }
    const cl = el('close'); if (cl) cl.onclick = () => { scr.style.display = 'none'; onRelease() }
  }

  /** §PREVIEWS changed OUTSIDE the sheet ("Show message preview", beside Notifications): under protection, apply it now —
   *  the push-preview keys go clear (on) or sealed (off) — and remember it. Nothing to do without protection. */
  async function applyPreviews (on) {
    if (!protectOn() || !P || !P.onPreviews) return false
    await P.onPreviews(!!on)
    const cur = cfg(); save({ ...cur, protect: { ...cur.protect, previews: !!on } })
    return true
  }
  // DESKTOP PROTECTION (secureComputer.js, docs/desktop-protection.md): the switch-on below without the sheet — setup made the
  // passkey already, so this seals the stores with its key and turns the lock on, the same credential gating both.
  async function enableProtection({ credId, mode = 'prf', raw, previews = false }) {
    if (!P || !P.onProtect) throw new Error('protection_unavailable')
    if (!credId || !raw) throw new Error('no_key')
    const cur = cfg()
    // sealed under ANOTHER passkey already (another tab secured this computer — pass 9, V#1): a switch-on with this one would
    // remove what that one sealed. Only the passkey the configuration names may finish (its own pending switch-on).
    if (cur.protect && cur.protect.on && cur.protect.credId && cur.protect.credId !== credId) throw new Error('already_protected')
    save({ ...cur, on: true, auto: Number.isFinite(+cur.auto) && +cur.auto > 0 ? +cur.auto : 5 })
    await switchOnProtection(raw, { credId, mode, previews })
    return true
  }
  // ⛔ PROTECTION IS SWITCHED ON WRITE-AHEAD (2026-11-08, docs/state-machines.md I4 / A#1): the stores were sealed FIRST and the
  //   config said so only after — a page killed (iOS), a tab closed or a throw (quota) in between left a disk sealed under a
  //   key the config did not name: the next launch read it as unprotected, the device looked signed out, and switching
  //   protection on again deleted the sealed entries for good. Now the config names the key and `pending` first; the seal
  //   follows; `pending` goes when it is done. A launch that finds `pending` unlocks with that passkey and finishes the switch-on
  //   (unlockOnce) — the same secret, so whatever was sealed opens and the rest is sealed.
  async function switchOnProtection (secret, { credId, mode, previews }) {
    save({ ...cfg(), credId, protect: { on: true, credId, mode, at: Date.now(), previews, pending: true } })
    if (P.onProtect) await P.onProtect(secret, { previews })
    const c = cfg(); const { pending: _p, ...done } = c.protect || {}
    save({ ...c, protect: done })
  }
  async function finishPending (secret) {
    const c = cfg()
    if (!(c.protect && c.protect.pending) || !P.onProtect) return
    await P.onProtect(secret, { previews: !!c.protect.previews, resume: true }) // resume: what is sealed already is this key's, not an earlier setup's leftover
    const n = cfg(); const { pending: _p, ...done } = n.protect || {}
    save({ ...n, protect: done })
  }
  return { enableProtection, cfg, save, enroll, assert, engage, release, tryUnlock, wireVisibility, onLaunch, showSheet, isLocked: () => _locked, protectOn, previewsOn, applyPreviews }
}
