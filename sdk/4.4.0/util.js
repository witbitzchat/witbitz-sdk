// util.js — pure, dep-free leaf helpers (Verified-Client Phase 1). The DOM lookup ($) and formatters,
// imported by space.js and (going forward) every extracted TCB module, so they need no rewiring.

import { env } from './env.js' // leaf: is this frame the vault's (saveTextFile)
import { attachSheetChrome, BACK_SVG, X_SVG } from './sheetChrome.js' // the one chrome every sheet gets: handle, ✕, pull-down, scrim tap, Escape

export const $ = (id) => document.getElementById(id)
// ★ WHERE A SHEET CAME FROM (the owner, 2026-10-10: "Pressing on x — make it return to the settings … This is true for all
//   x. It should return to the sheet it came from … So maybe the x should be changed to <"). A sheet opened while another
//   is open, or right after its opener closed one (Settings → Back up & recovery closes Settings, then opens), remembers
//   that sheet; its corner button is then ‹ and goes back. Scrim, pull-down and Escape still close outright.
let lastClosed = null, returning = false, dismissing = false // dismissing: the person closed it (✕, scrim, pull, Escape) — never a hand-off
const FROM_WINDOW_MS = 1500
export const closeSheet = (id) => { const n = $(id); const was = !n.classList.contains('hidden'); n.classList.add('hidden'); if (was) lastClosed = dismissing ? null : { id, at: Date.now() } } // only a sheet that was OPEN hands off
/** The sheet `id` was opened from — '' when none (opened from the chat, the menu, a link). */
export const sheetFrom = (id) => { try { return $(id).dataset.from || '' } catch { return '' } }
function noteFrom (root, id) {
  if (returning) { root.dataset.from = root.dataset.from || ''; return } // going BACK keeps the parent's own parent
  let from = ''
  try { const other = [...document.querySelectorAll('.sheet:not(.hidden)')].find((n) => n.id && n.id !== id); if (other) from = other.id } catch { /* */ }
  if (!from && lastClosed && lastClosed.id !== id && Date.now() - lastClosed.at < FROM_WINDOW_MS) {
    // ★ A CHILD HANDING BACK IS A RETURN, NOT A NEW STEP (the owner, 2026-10-20: Contact info → Edit → ✓ "comes back with <
    //   instead of x. I think I have it also somewhere else"): the sheet just closed was opened FROM this one, so this one
    //   keeps the parent it had — the card is where it was, not one step deeper into the one it opened.
    const child = $(lastClosed.id)
    if (child && child.dataset.opener === id) { root.dataset.from = root.dataset.from || ''; return }
    from = lastClosed.id
  }
  root.dataset.opener = from // where it was opened from, even on a card whose corner is always ✕ (the return check above reads it)
  root.dataset.from = root.dataset.noBack === '1' ? '' : from // a card whose corner is always ✕ (an edit card: ✕ = discard or exit, its own handler asks)
}
/** Dress the corner button for where this sheet stands: ‹ back to its parent, or ✕. Its click goes back when there is one. */
function dressBack (root, card, close) {
  const x = card && card.querySelector(':scope > .sc-head .sc-x, .sc-x')
  if (!x) return
  const back = !!root.dataset.from
  x.innerHTML = back ? BACK_SVG : X_SVG
  x.setAttribute('aria-label', back ? 'Back' : 'Close'); x.title = back ? 'Back' : 'Close'
  if (x.dataset.backWired) return
  x.dataset.backWired = '1'
  x.addEventListener('click', (e) => { // ahead of the chrome's own close (capture): back = close this one, reopen the parent
    const from = root.dataset.from
    if (!from || !document.getElementById(from)) return
    e.stopImmediatePropagation(); e.preventDefault()
    close()
    returning = true
    try { goBackTo(from) } finally { returning = false }
  }, true)
}
// A parent reopened the way its own opener would — through its row's click when it has one (it renders its contents), else
// the plain open.
const BACK_OPENERS = { settingsSheet: () => { const b = document.getElementById('dwSettings'); if (b) { b.click(); return true } return false } }
/** A sheet that renders its contents when opened registers how to reopen it, so ‹ back from a child redraws it. */
export const setBackOpener = (id, fn) => { BACK_OPENERS[id] = () => { fn(); return true } }
function goBackTo (id) { if (!(BACK_OPENERS[id] && BACK_OPENERS[id]())) openSheet(id) }
// A bottom sheet is a `.hidden`-toggled element. Its first open dresses it: the 26 sheets of space.html were built by
// many hands with a Cancel row here and a handle there — the chrome is attached at this one chokepoint, so they all
// pull down, close on a scrim tap and on Escape, and carry the same handle and ✕ (attach is idempotent).
export const openSheet = (id) => {
  const root = $(id), card = typeof root.querySelector === 'function' ? root.querySelector('.sheet-card, .csheet-card') : null // a stub DOM (node tests) gets no chrome
  // ✕, pull-down, scrim tap and Escape do exactly what the sheet's own Cancel/Close does — its handler may resolve a
  // promise (the confirm) or stop a camera (the scanner) — and only a sheet with no such button is simply hidden.
  // The sheet's own way out: its `.sheet-cancel` row, or any button that just says Cancel/Close (the views picker's
  // `#vsCancel` is a `.sheet-opt`). "Done" is left alone — on some sheets it finishes a flow rather than dismissing.
  const ownClose = () => card && ([...card.querySelectorAll('button')].find((b) => b.classList.contains('sheet-cancel') || b.classList.contains('csheet-cancel') || /^(cancel|close)$/i.test(b.textContent.trim())) || null)
  const close = () => { dismissing = true; try { const b = ownClose(); if (b) b.click(); else closeSheet(id) } finally { dismissing = false } }
  // The confirm is a centred QUESTION: it gets the ways out (pull, scrim, Escape = "no") but not a handle and ✕ over
  // its two answers.
  const chrome = card && attachSheetChrome(root, { card, close, isOpen: () => !root.classList.contains('hidden'), head: !card.classList.contains('csheet-card') })
  // The Cancel/Close row under a ✕ is the same button twice (the owner: "remove the cancel close"). It stays in the DOM
  // — the chrome's close() clicks it, so a sheet's own close handler still runs — but it is no longer shown. A handle
  // the sheet brought itself (the views picker's `.sheet-grip`) goes the same way: one handle, the chrome's ("sometimes
  // there are two handles" — the owner's screenshot).
  if (chrome && chrome.head) {
    for (const b of card.querySelectorAll('button')) if (b.classList.contains('sheet-cancel') || /^(cancel|close)$/i.test(b.textContent.trim())) b.classList.add('sc-gone')
    for (const g of card.querySelectorAll('.sheet-grip')) g.classList.add('sc-gone')
  }
  noteFrom(root, id)
  if (chrome && chrome.head) dressBack(root, card, close)
  root.classList.remove('hidden')
}
export const fmtAgo = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago' }
export const fmtDay = (t) => { try { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } catch { return '' } }
export const fmtByteCount = (n) => { n = Number(n) || 0; return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB' }
export const fmtBytes = (b64) => fmtByteCount(Math.round((b64.length * 3) / 4))
export const lsGet = (k) => { try { return localStorage.getItem(k) } catch { return null } }
// ★ DIAGNOSTICS ARE OFF UNTIL SOMEONE ASKS FOR THEM. "Offline readiness" and "Crash trail" are instruments, not
// features: every person who opens Settings reads them as things they are supposed to understand, and neither has an
// action attached for an ordinary user (the owner, 2026-09-25). They still RECORD always — only the rows are hidden.
// ⛑ A URL flag alone cannot be the way in. The installed app opens at its own start_url, and Safari's localStorage is
//    a different store from the installed app's — which is exactly why crashTrail's row exists inside the app at all.
//    So the unlock is also five taps on the build line in Settings (settingsSheet.js), which works with no keyboard,
//    no URL bar, and no second browser.
export const diagOn = () => {
  try {
    const u = new URLSearchParams(location.search).get('diag')
    if (u === '1') { localStorage.setItem('space:diag', '1'); return true }
    if (u === '0') { localStorage.removeItem('space:diag'); return false }
    return localStorage.getItem('space:diag') === '1'
  } catch { return false }
}
export const u8ToB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s) }
export const mkFp = (mk) => { const s = String(mk || ''); if (!s) return '—'; let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16).slice(0, 6) } // one-way fingerprint; two devices with the SAME room must share this or they can't read each other's state
export const b64ToU8 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u }
export const b64url = (u8) => u8ToB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// A first message that carries NO subject must not become the room's name. The heuristic titler fires on the first
// message and marks the room `titled`, which is sticky — so "Hi" became a Space's permanent name, replacing the
// agent's own name and blocking the LLM titler that would have described the conversation.
// Deliberately conservative: only obvious greetings/acknowledgements, or a message too short to carry a subject.
// Anything else still titles as before — a wrong-but-descriptive title is better than none, an empty pleasantry is not.
const TRIVIAL_TITLE = new Set([
  'hi', 'hii', 'hey', 'hello', 'yo', 'sup', 'hiya', 'howdy', 'good morning', 'good evening', 'good afternoon',
  'thanks', 'thank you', 'thx', 'ty', 'ok', 'okay', 'k', 'kk', 'yes', 'yep', 'yeah', 'no', 'nope', 'sure',
  'cool', 'nice', 'great', 'excellent', 'perfect', 'awesome', 'lol', 'test', 'testing', 'ping',
  'שלום', 'היי', 'הי', 'אהלן', 'תודה', 'תודה רבה', 'אוקיי', 'אוקי', 'בסדר', 'כן', 'לא', 'מעולה', 'מצוין', 'בדיקה',
])

/** Would `s` make a useless room title? (a greeting/acknowledgement, or too short to carry a subject) */
export function isTrivialTitle(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim().replace(/[?!.,;:…]+$/u, '').toLowerCase()
  if (!t) return true
  if (TRIVIAL_TITLE.has(t)) return true
  // No letters at all (emoji-only, punctuation, digits) says nothing about the subject either.
  if (!/\p{L}/u.test(t)) return true
  // One short word is a greeting in some language we haven't listed; two+ words are allowed to be terse.
  return t.split(' ').length === 1 && t.length <= 4
}

// ── small shared pieces the personal views (calendar / tasks / people) and their agent tools have in common ──
/** An empty-state block for a workspace view: big glyph, title, optional one-liner. */
export function wsEmpty(icon, title, text) {
  const box = document.createElement('div'); box.className = 'ws-empty'
  const k = document.createElement('div'); k.className = 'ws-empty-k'; k.textContent = icon; box.appendChild(k)
  const t = document.createElement('div'); t.className = 'ws-empty-t'; t.textContent = title; box.appendChild(t)
  if (text) { const p = document.createElement('div'); p.className = 'ws-empty-p'; p.textContent = text; box.appendChild(p) }
  return box
}
export const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many)
/** A fresh local uid for a calendar/task/contact item — random when the platform allows, time-derived otherwise. */
export const newUid = () => { try { return 'u-' + [...crypto.getRandomValues(new Uint8Array(10))].map((x) => x.toString(36)).join('').slice(0, 14) } catch { return 'u-' + Date.now().toString(36) } }
/** Hand the user a text file (an .ics / .vcf / .md export) through a transient object URL. */
// FRAMED? ASK THE VAULT TO SAVE. `<a download>` on a blob is INERT inside a cross-origin iframe on iOS — it throws
// nothing and does nothing, so an export "succeeds", says so, and no save sheet ever appears. The vault is the
// top-level document and can actually perform the save, so hand it the bytes. Content only; no key material.
// Unframed (the standalone app) is unchanged — the link path below still runs.
export function saveTextFile(name, text, mime) {
  const type = mime || 'text/plain;charset=utf-8'
  try {
    if (typeof window !== 'undefined' && window.top && window.top !== window) {
      // TARGET THE FRAMER EXPLICITLY. This payload is the user's DECRYPTED conversation, so '*' would be careless even
      // though the app's own CSP frame-ancestors admits only the vault. ancestorOrigins names the real top origin;
      // where the browser does not provide it, fall through to the link rather than broadcast.
      const top = (() => { try { return (location.ancestorOrigins && location.ancestorOrigins[location.ancestorOrigins.length - 1]) || '' } catch { return '' } })()
      // ONLY THE VAULT answers saveFile: in the regular app's assistant panel (same origin) or an embed (another host that is
      // not our vault) the bytes went to a page that ignores them, and nothing was saved (2026-10-17) — those take the link.
      if (top && top !== location.origin && env.crossOrigin) { window.top.postMessage({ ch: 'vcHandoff', t: 'saveFile', name, text, mime: type }, top); return }
    }
  } catch (e) { /* cross-origin probe threw → fall through to the link */ }
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000)
}

// HTML-escape third-party text before it is interpolated into markup (moved from space.js, verified-client split step 50).
export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])) }
// A ledger entry id, canonical across the mirror: an entry mirrored from a shared room carried a `sh:<room>:` prefix once;
// pins and captions key on the canonical form (moved from space.js, step 50).
import { canonId, entryKeyOf } from './ledgerView.js' // the one rule, shared with the SDK (docs/sdk-convergence.md 4d)
export { canonId }

// ★ THE MESSAGE KEY — and the SERVER computes the same string (agent/spaceService.mjs `entryKey`). Keep the two in
// step or a reaction lands on nothing: the server recomputes this from its own ledger and 404s a target it cannot
// find, so drift shows up as "the emoji does nothing" rather than as an error. A member's entry `id` is the MEMBER
// id — two of their messages differ only by `ts` — so neither half identifies a message alone; the pair does.
export const entryKey = entryKeyOf // ledgerView.js — the SDK keys reactions and replies the same way

// A FIELD IS FOCUSED BY ITSELF ONLY WHERE THERE IS A MOUSE (the owner, 2026-10-14: "When I press a contact in android it
// automatically opens the composer. On iPhone the composer stays closed. On iPhone it is better" → "Sweep for this auto
// focus"). iOS ignores a focus that runs outside the tap (a timer, after a load); Android raises the keyboard for it. A
// focus made INSIDE a tap (Reply, Rename, the search icon) is the person asking to type and stays as it is.
export const hasMouse = () => { try { return matchMedia('(hover:hover) and (pointer:fine)').matches } catch { return false } }
export function focusIfMouse(el) { if (el && hasMouse()) { try { el.focus() } catch { /* a nicety */ } } }
