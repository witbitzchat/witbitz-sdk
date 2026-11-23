// sheetChrome.js — ONE chrome for every sheet-shaped card in the app: a grab handle, a round ✕, and one set of ways
// out (pull the card down, tap the scrim, press Escape). Nine mechanisms and ~55 instances had grown here with
// different chrome — a Cancel row on one, a handle on another, an ✕ on a third; scrim tap on 11 of 26, Escape on
// none of them, a pull gesture on five, written three ways (the owner, 2026-09-26: "some cards have cancel instead
// of a handle — let's make the UI as universal as possible"). This is dep-free DOM: a sheet keeps its own open/close
// (a `.hidden` class, a `hidden` attribute, whatever it has) and tells this module how to close and whether it is open.
//
//   attachSheetChrome(root, { card, close, isOpen, scrim?, grab?, x?, body?, mouseFrom?, pull?, head?, onEscape? })
//     root   the fixed full-screen layer (often it IS the backdrop)         card  the panel inside it
//     close  closes the sheet (the sheet's own way)                          isOpen  () => boolean
//     scrim  a separate backdrop element when the root is not the backdrop
//     grab/x existing handle / close button to adopt instead of inserting ours (the Code steps sheet has both);
//            `x:false` = no ✕ at all (the artifact card and the file viewer — the owner: "the card doesn't need an x.
//            It is better with a handle")
//     body   the scrolling region: a pull from it counts only while it is scrolled to the top
//     mouseFrom  more elements a MOUSE may drag the card by (the artifact card's title bar)
//     pull   () => boolean — whether the pull applies right now (the assistant panel is a rail on a wide screen)
//   Idempotent per root. Returns { head, grab, x }. A card whose CSS moves it by `--wdy` (the artifact card, the file
//   viewer: their wide-screen centring is a transform of their own) is pulled through that variable, not an inline transform.
//   Phase 2 (2026-09-26): the five bespoke gestures — widgetRegistry's attachSheetDrag (artifact card, file viewer, views
//   picker), assistPanel's handle drag, messageActions' who-sheet, the vault's account sheet — are on this module.
//
// ★ THE GESTURE, and what it learned on the Code steps sheet (codeSteps.js, 2026-09-25): the pull must listen on a
// REGION, not a glyph — a 40×5 px pill and a title's text line left most of the card's top dead to a thumb ("dragging
// it down is sometimes unresponsive"). Here the whole card pulls, minus what scrolls (a scroller not at its top) and
// what types (a field), and a drag of more than DRAG_PX swallows the click it would otherwise land on a button. A touch
// the browser takes over (`touchcancel`) resets the card; a short pull springs back; the close threshold is 90 px or a
// flick. Touch events, not pointer: a pointer drag on a scroller needs `touch-action:none`, which kills the scroll.

const CLOSE_PX = 90, FLICK = 0.6 /* px per ms */
// A DRAG is DRAG_PX of travel, not 8. The 8 px line swallowed TAPS on iOS: WebKit delivers every touchmove, a thumb
// wobbles 9–15 px in an ordinary tap, and iOS still synthesises the click for that (it is inside its own slop) — so
// the click landed on the ✕ and was thrown away as "a drag that ended on a button". Chromium never showed it: it hands
// the page NO touchmove inside its slop (measured 2026-09-27: 14 px of wobble, 0 moves seen, click delivered). The
// steps sheet's ✕ "does not work" (the owner) while the pull-down does — a deliberate pull is far past any wobble.
const DRAG_PX = 24
const attached = new WeakMap() // root → chrome
const chromeFit = new WeakMap() // root → re-read the card's colour + padding (on each open: a sheet restyled while closed)
const roots = new Set()
// When each sheet last OPENED (a counter, not a clock): Escape closes the newest. Attach order lost to the menu's pages
// (pageHandles.js attaches New Space last, so Escape closed it under the people picker), and DOM order loses to a
// confirm raised over a sheet that sits after it in the page.
const openedAt = new WeakMap()
let openSeq = 0
let css = false

function ensureCss() {
  if (css || typeof document === 'undefined' || typeof document.createElement !== 'function' || !document.head) return // a test's stub document (no head): nothing to dress
  css = true
  const s = document.createElement('style'); s.id = 'sheetChromeCss'
  s.textContent = `
.sc-head { position:sticky; top:calc(-1 * var(--sc-pt, 0px)); margin-top:calc(-1 * var(--sc-pt, 0px)); padding-top:var(--sc-pt, 0px); z-index:3; background:inherit; border-radius:inherit; border-bottom-left-radius:0; border-bottom-right-radius:0; flex:0 0 auto; min-height:calc(38px + var(--sc-pt, 0px)); touch-action:none; cursor:grab; user-select:none; -webkit-user-select:none; } /* sticky: a card that scrolls keeps its handle and ✕ in reach */
.sc-grab { position:absolute; left:50%; top:calc(8px + var(--sc-pt, 0px)); width:38px; height:5px; margin-left:-19px; border-radius:3px; background:var(--line, #c8c8cc); opacity:.9; }
.sc-x { position:absolute; left:0; top:calc(4px + var(--sc-pt, 0px)); width:36px; height:36px; padding:0; border:0; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; background:var(--field, rgba(0,0,0,.06)); color:var(--fg, #111); font:inherit; font-size:18px; line-height:1; cursor:pointer; }
.sc-x svg { width:22px; height:22px; display:block; } .sc-head:has(+ .sc-title) .sc-x svg { width:24px; height:24px; } /* the owner, 2026-10-14: "The x and < should be larger to match Claude code" (were 18px) */
@media (hover:hover) { .sc-x:hover { filter:brightness(.95); } }
.sc-pulling { transition:none !important; }
.sc-head + .sc-title { position:sticky; top:calc(var(--sc-g, 16px) - 14px - var(--sc-pt, 0px)); z-index:2; pointer-events:none; margin:calc(var(--sc-g, 16px) - 52px - var(--sc-pt, 0px)) calc(-1 * var(--sc-px, 16px)) 0; padding:14px 64px 22px; min-height:44px; line-height:44px; box-sizing:content-box; text-align:center; font-size:17px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; background:linear-gradient(var(--sc-bg, #fff) calc(100% - 14px), transparent); box-shadow:0 min(0px, calc(14px - var(--sc-g, 16px))) 0 0 var(--sc-bg, #fff); border-top-left-radius:inherit; border-top-right-radius:inherit; }
.sc-title button, .sc-title a, .sc-title input { pointer-events:auto; }
.sc-title > .sheet-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } /* a title row with tools (the Code section): its text cut the same way */
.sc-scrolled > .sc-head + .sc-title { background:linear-gradient(var(--sc-bg, #fff) 22px, color-mix(in srgb, var(--sc-bg, #fff) 88%, transparent) 40%, color-mix(in srgb, var(--sc-bg, #fff) 62%, transparent) 62%, color-mix(in srgb, var(--sc-bg, #fff) 28%, transparent) 84%, transparent); }
.sc-head:has(+ .sc-title) { background:transparent; }
.sc-head:has(+ .sc-title) .sc-grab { top:8px; } /* the handle close to the card's edge, above the ✕ and title row (the owner, 2026-10-12: "a little more up") */
.sc-head:has(+ .sc-title) .sc-x { width:44px; height:44px; top:var(--sc-g, 16px); left:calc(var(--sc-g, 16px) - var(--sc-px, 16px)); } /* CONCENTRIC with the card's corner (the owner, 2026-10-12: "The x circle should exactly fit the corner curve"): its centre on the corner curve's centre — an even gap all round (--sc-g = radius − 22, read from the card at attach), the title centred on the same line */
.sc-head:has(+ .sc-title :is(button, a):not(.sc-gone)) { pointer-events:none; } .sc-head:has(+ .sc-title :is(button, a)) .sc-x { pointer-events:auto; }
.sc-gone { display:none !important; } /* a sheet's own Cancel/Close row once the chrome provides the ✕ — kept in the DOM for its handler */
/* GLASS (the owner, 2026-10-14, after iOS 26's Liquid Glass ✕ / ⓘ — "the outline … glows at the bottom and top while on
   the sides it is more black"). MEASURED on Claude's ✕ (light, 3× screenshot), and built to it: (1) a HAIRLINE outline, one
   device pixel, ~30% black on the sides fading to ~10% at the top and bottom; (2) the glint is INSIDE the edge — a white
   band under the top and over the bottom, fading into the button; (3) the fill is nearly the card's own colour (translucent
   white over a blur), and the shadow is a breath (~1% at its darkest) — a solid white disc with a 10% shadow read as a
   glowing halo. The outline is a ring masked from a top-to-bottom gradient, so a circle and the wide input pill both work. */
/* ON A TOUCH SCREEN ONLY (the owner, 2026-10-21: "On desktop don't do the fake glow effect of iOS"): the glass is iOS 26's
   look, and with a mouse it reads as a fake glow — a computer keeps each button's own flat style. */
@media (hover: none) and (pointer: coarse) {
:where(.set-back, .cp-x, .conn-filter, .conn-count, #composer .pill, .dw-gear, .gear, .computer-pick, #toApp, #searchBtn, .dw-round) { position:relative; } /* + the ☰ drawer's Settings pill (app .dw-gear, Code .gear) and Code's computer pick */
.conn-filter, .conn-count { border-color:transparent; } /* the Connections search filter and the connected pill: the outline replaces their grey border */
:is(.sc-x, .set-back, .cp-x, #lockBack, #scrollBtn, #kbMenuBtn, .conn-filter, .conn-count, #composer .pill, .dw-gear, .gear, .computer-pick, #toApp, #searchBtn, .dw-round)::before { content:''; position:absolute; inset:0; border-radius:inherit; padding:var(--rim-w); pointer-events:none;
  background:linear-gradient(180deg, var(--rim-hi) 0%, var(--rim-lo) 35%, var(--rim-lo) 65%, var(--rim-hi) 100%);
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude; }
:is(.conn-filter, .conn-count)::before { inset:-1px; }
:root { --rim-w:1px; --rim-hi:rgba(0,0,0,.12); --rim-lo:rgba(0,0,0,.42); }
@media (min-resolution:2dppx), (-webkit-min-device-pixel-ratio:2) { :root { --rim-w:.5px; } }
@media (min-resolution:3dppx), (-webkit-min-device-pixel-ratio:3) { :root { --rim-w:.5px; } }
@media (prefers-color-scheme: light) {
  #scrollBtn { border-color:transparent; } /* glass carries its own rim */
  :is(.sc-x, .set-back, .cp-x, #scrollBtn, #kbMenuBtn, .conn-filter, .conn-count, #composer .pill, .dw-gear, .gear, .computer-pick, #toApp, #searchBtn, .dw-round):not(.conn-filter-on) {
    background:rgba(255,255,255,.28); -webkit-backdrop-filter:blur(12px) saturate(1.6); backdrop-filter:blur(12px) saturate(1.6);
    box-shadow:inset 0 5px 6px -4px #fff, inset 0 -5px 6px -4px #fff, inset 0 0 0 1.5px rgba(255,255,255,.7), 0 3px 14px rgba(0,0,0,.05); }
}
@media (prefers-color-scheme: dark) { :root { --rim-hi:rgba(255,255,255,.34); --rim-lo:rgba(0,0,0,.55); } }
/* PRESSED GLASS — buttons only, never the input box (#composer .pill: the owner, 2026-10-15: a tap to write "also makes the glow animation. This is not needed at all") (the owner, 2026-10-14: "The feedback when pressing a glowing button should be more noticeable" → iOS 26's own:
   it swells and lights from inside the moment the finger lands, and springs back). \`scale\`, not \`transform\`, so a button
   that positions itself with a transform (the scroll-down arrow) keeps it. Reduced motion: the light only. */
:is(.sc-x, .set-back, .cp-x, #scrollBtn, #kbMenuBtn, .conn-filter, .conn-count, .dw-gear, .gear, .computer-pick, #toApp, #searchBtn, .dw-round) { transition:scale .22s cubic-bezier(.34,1.56,.64,1), filter .18s ease, box-shadow .18s ease; }
:is(.sc-x, .set-back, .cp-x, #scrollBtn, #kbMenuBtn, .conn-filter, .conn-count, .dw-gear, .gear, .computer-pick, #toApp, #searchBtn, .dw-round):active { scale:1.14; filter:brightness(1.12) saturate(1.1); transition-duration:.08s; box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.9), 0 0 0 5px rgba(255,255,255,.28), 0 6px 22px rgba(0,0,0,.14); }
/* ↓ grows by its own .pressed (the pages, with its centring translate) — here only the light (the owner, 2026-10-15: "make the down arrow glow too") */
#scrollBtn:active { scale:none; } #scrollBtn.pressed { filter:brightness(1.12) saturate(1.1); box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.9), 0 0 0 5px rgba(255,255,255,.28), 0 6px 22px rgba(0,0,0,.14); }
@media (prefers-reduced-motion: reduce) { :is(.sc-x, .set-back, .cp-x, #scrollBtn, #kbMenuBtn, .conn-filter, .conn-count, .dw-gear, .gear, .computer-pick, #toApp, #searchBtn, .dw-round):active { scale:none; } }
}
/* NO HANDLE MARK (the owner, 2026-10-14: "let's remove the handle mark itself from every card"): the strip stays — the whole
   card still pulls down to close — only the bar is not drawn. */
.sc-grab { background:transparent !important; }
/* A SWITCH ROW DOES NOT FLASH (the owner, 2026-10-16: "When you press the line of a switch just don't do anything. Currently it
   blinks"): no tap highlight on the row; only its switch flips it (guardSwitchTaps below) */
:is([role="switch"], label:has(> input.set-sw)) { -webkit-tap-highlight-color:transparent; }
/* NO BLUE ON ANDROID (the owner, 2026-10-27: "when I long press the x … I get a blue background under the x like it is being
   copied" → "I want it to have the glowing effect like in iPhone"): Chrome on Android paints its tap highlight over a pressed
   button and holds it through a long press, on top of the glass. No highlight, no long-press menu or selection on the glass
   buttons: the press is the PRESSED GLASS above — it swells and glows, as on the iPhone. */
:is(.sc-x, .set-back, .cp-x, #lockBack, #scrollBtn, #kbMenuBtn, .conn-filter, .conn-count, .dw-gear, .gear, .computer-pick, #toApp, #searchBtn, .dw-round) { -webkit-tap-highlight-color:transparent; -webkit-touch-callout:none; -webkit-user-select:none; user-select:none; }
/* GREY, NOT BLUE — EVERYWHERE (the owner, 2026-10-27: "Suppress the blue copy on them too" — "The pen, the three lines, the
   three dots etc" — "when I press an item on the drawer it should be grayed not blue (Same as iPhone)" — "This goes to every
   menu pick" — "Also in the input line"). Android's tap highlight is BLUE and is held through a long press; the iPhone's is a
   soft grey. So the app's highlight is that grey (it is inherited: every menu pick, row and link gets it), and what already has
   its own press look takes none, so nothing is shaded twice: the glass (it glows, above), the top bar's icons (.tb-ic: their
   circle), the drawer (its rows grey themselves, .dw-item:active / .dw-new:active) and the input line (the box and its buttons).
   A long press selects no button's label and opens no menu on it. */
html { -webkit-tap-highlight-color:color-mix(in srgb, var(--fg, #111) 13%, transparent); }
:is(.tb-ic, #drawer, #composer, input, textarea, [contenteditable="true"]) { -webkit-tap-highlight-color:transparent; }
:is(button, [role="button"], summary, #drawer a) { -webkit-touch-callout:none; -webkit-user-select:none; user-select:none; }
`
  document.head.append(s)
}
ensureCss() // at load: the rim also dresses buttons no sheet attaches (the scroll-down arrow, the settings pages' ‹)

// The way BACK (the owner, 2026-10-10: "It should return to the sheet it came from … maybe the x should be changed to <"):
// a sheet opened from another sheet wears ‹ in the ✕'s place, and the button returns there (util.js openSheet).
export const BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>'
// ONLY THE SWITCH FLIPS A SWITCH (the owner, 2026-10-16: "When you toggle you actually need to press the toggle button. Do it
// everywhere that has a switch"). A switch row is either the switch itself (role="switch", its knob a .set-sw inside) or a label
// around an <input class="set-sw">; a tap anywhere on the row used to flip it. Now a tap that is not on the knob does nothing.
// A keyboard's Enter/Space (a click with detail 0), code's .click(), and a field inside the row (Siri's name editor) are untouched.
let switchGuard = false
export function guardSwitchTaps (doc = document) {
  if (switchGuard) return; switchGuard = true
  doc.addEventListener('click', (e) => {
    if (!e.detail) return // the keyboard or code
    const t = e.target; if (!t || !t.closest) return
    if (t.closest('.set-sw')) return // the knob: as always
    const row = t.closest('[role="switch"]'), lab = !row && t.closest('label')
    const host = row && row.querySelector('.set-sw') ? row : (lab && lab.querySelector('input.set-sw') ? lab : null)
    if (!host) return
    const act = t.closest('input,textarea,select,[contenteditable="true"],button,a')
    if (act && act !== host && host.contains(act) && !act.classList.contains('dw-link')) return // a control of its own inside the row
    e.preventDefault(); e.stopPropagation()
  }, true)
}
try { guardSwitchTaps() } catch { /* no document (a worker / node) */ }

export const X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'

const isTyping = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
/** The nearest scrolled ancestor inside the card: a pull that starts on one is a scroll, not a dismiss. */
function scrolledAncestor(t, card) {
  for (let n = t; n && n !== card; n = n.parentElement) {
    if (n.scrollTop > 0) return n
    const o = getComputedStyle(n).overflowY
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight && n.scrollTop > 0) return n
  }
  return null
}

/** Can something from `t` up to the card scroll the way the finger is going? A sideways move asks only whether a row
 *  there scrolls sideways at all (RTL makes scrollLeft's sign the direction's business, not ours). */
function scrollsThatWay(t, card, dx, dy, axis = null) {
  const sideways = axis ? axis === 'x' : Math.abs(dx) > Math.abs(dy)
  for (let n = t; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n)
    if (sideways) { if (/auto|scroll/.test(cs.overflowX) && n.scrollWidth > n.clientWidth) return true }
    else if (/auto|scroll/.test(cs.overflowY) && n.scrollHeight > n.clientHeight && (dy < 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0)) return true
    if (n === card) break
  }
  return false
}

// ★ A SEARCH HOLDS THE CARD'S HEIGHT (the owner, 2026-10-14: "When you search pin down the search box position and what is
// above it. Else it can be covered by the composer"). A card is anchored at the bottom, so a list that filters down made it
// SHORTER and the search box dropped down behind the keyboard and the composer. Once a search field in a card has the focus,
// the card keeps the height it had (min-height) — the field and everything above it stay put — until the field is left empty.
if (typeof document !== 'undefined') {
  const cardOf = (t) => (t && t.matches && t.matches('input[type="search"]') && t.closest) ? t.closest('.sheet-card') : null
  // ⛔ …NEVER TALLER THAN THE AREA ABOVE THE KEYS (the owner, 2026-11-16, Settings → Connections → Search services on the iPhone: the
  //   field 146 pt above the screen, `vv h544`). The height is measured as the field takes the focus — before the keys are up — and a
  //   min-height beats the card's keyboard cap (space.html … .sheet-card max-height): the whole card stayed, its top off the screen.
  //   The pin is also kept as --sc-pin, and with the keys up space.html caps it: min(--sc-pin, the visible area).
  document.addEventListener('focusin', (e) => { const c = cardOf(e.target); if (c && !c.style.minHeight) { const h = c.getBoundingClientRect().height + 'px'; c.style.minHeight = h; c.style.setProperty('--sc-pin', h) } }, true)
  document.addEventListener('focusout', (e) => { const c = cardOf(e.target); if (c && !String(e.target.value || '').trim()) { c.style.minHeight = ''; c.style.removeProperty('--sc-pin') } }, true)
  // a card opened again starts at its own height (its sheet's class goes back to hidden on close)
  if (typeof MutationObserver === 'function') new MutationObserver((ms) => { for (const m of ms) { const el = m.target; if (el.classList && el.classList.contains('sheet') && el.classList.contains('hidden')) for (const c of el.querySelectorAll('.sheet-card')) { if (c.style.minHeight) c.style.minHeight = ''; c.style.removeProperty('--sc-pin') } } })
    .observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] })
}

// ★ A FIELD IN A CARD IS SHOWN ABOVE THE KEYS (the owner, 2026-11-09, Outside agents' name field under the composer; 2026-11-15, the
//   email-code card — a box built in JS, class `kbfit`): with the keys up
//   the card is capped to the visible area (space.html, body.kb-open … .sheet-card), so a field low in a long card must be scrolled
//   into the card's view once the keys are up — iOS does not pan a fixed sheet for it.
if (typeof document !== 'undefined') {
  const fieldIn = (t) => !!(t && t.matches && t.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea') && t.closest && t.closest('.sheet-card, .kbfit > *'))
  const reveal = (t) => { try { if (document.activeElement === t) t.scrollIntoView({ block: 'nearest' }) } catch { /* */ } }
  // DIAGNOSTICS (the owner, 2026-11-16: "It did not work" — the Connections search on the iPhone, after f991ea03c): what the fit
  // actually saw, in the boot log (Settings → five taps on the build line). The flags, the sizes the rules use, what the iPhone
  // reports, and where the sheet, the card and the field are. Read-only.
  const fitLog = (t, when) => {
    try {
      const b = document.body, cs = getComputedStyle(document.documentElement), vv = window.visualViewport
      const card = t.closest('.sheet-card, .kbfit > *'), sheet = card && card.parentElement
      const r = (el) => { if (!el) return '-'; const x = el.getBoundingClientRect(); return Math.round(x.top) + '+' + Math.round(x.height) }
      const fl = ['inscroll', 'kb-open', 'inscroll-kb', 'embedded', 'in-chat'].filter((c) => b.classList.contains(c)).join(',')
      const line = `sheetfit ${when} #${(sheet && sheet.id) || '?'} flags=${fl || 'none'} html=${['inscroll', 'kb-open'].filter((c) => document.documentElement.classList.contains(c)).join(',') || 'none'}` +
        ` vvh=${cs.getPropertyValue('--vvh').trim() || '-'} vvtop=${cs.getPropertyValue('--vvtop').trim() || '-'} vv=${vv ? Math.round(vv.height) + '@' + Math.round(vv.offsetTop) : '-'} ih=${innerHeight} sy=${Math.round(scrollY)}` +
        ` sheet=${r(sheet)} card=${r(card)} cardMax=${card ? getComputedStyle(card).maxHeight : '-'} cardScroll=${card ? Math.round(card.scrollTop) : '-'} field=${r(t)}`
      const k = 'space:bootlog', a = JSON.parse(localStorage.getItem(k) || '[]'); a.push(new Date().toISOString().slice(11, 23) + ' ' + line); while (a.length > 1000) a.shift(); localStorage.setItem(k, JSON.stringify(a))
    } catch { /* diagnostics only */ }
  }
  document.addEventListener('focusin', (e) => { const t = e.target; if (!fieldIn(t)) return; fitLog(t, 'focus'); setTimeout(() => fitLog(t, '+350'), 340); setTimeout(() => fitLog(t, '+1200'), 1200); setTimeout(() => reveal(t), 350); try { addEventListener('wb-keys-up', () => reveal(t), { once: true }) } catch { /* */ } }, true)
}

// ★ ONE STYLE READ FOR EVERY CARD AT START (the launch profile, 2026-10-26: the real app's start-up in Chromium with the CPU 4×
//   slow spent 95 ms of its ~170 ms of JavaScript in fitCard/fitHead — each attach changed the page, then read its card's
//   computed style, so every sheet the app attaches as it starts forced its own style recalculation of the whole page). The
//   first fit is queued: before the next frame, every queued card is read, then every one written — one recalculation. A
//   sheet is fitted again as it opens (chromeFit, below) and on resize, as before; only the first measurement waits a frame.
const fitQueue = []
let fitArmed = false
function queueFit (read) {
  fitQueue.push(read)
  if (fitArmed) return
  fitArmed = true
  const run = () => {
    fitArmed = false
    const writes = fitQueue.splice(0).map((r) => { try { return r() } catch { return null } }) // every read first…
    for (const w of writes) { try { if (w) w() } catch { /* */ } } // …then every write
  }
  try { requestAnimationFrame(run) } catch { setTimeout(run, 0) }
}
export function attachSheetChrome(root, { card, close, isOpen, scrim = null, grab = null, x = null, body = null, onEscape = null, head: wantHead = true, mouseFrom = [], pull = null, pullFrom = null } = {}) {
  if (!root || !card) return null
  if (attached.has(root)) return attached.get(root)
  ensureCss()
  const noX = x === false; if (noX) x = null
  // The head: adopt the sheet's own handle / ✕ when it has them (the steps sheet), else insert ours as the card's first
  // row. `head:false` = the ways out without the furniture — a centred QUESTION (the confirm) has its answer buttons
  // for chrome; it still pulls, still closes on the scrim and on Escape, all as "no".
  let head = null
  if (!grab && wantHead) {
    head = document.createElement('div'); head.className = 'sc-head'
    grab = document.createElement('div'); grab.className = 'sc-grab'; grab.setAttribute('aria-hidden', 'true')
    head.append(grab)
    card.prepend(head)
    // ★ THE HEAD COVERS THE CARD'S TOP PADDING (the owner, 2026-10-05: "a piece of strip above the handle and x where the
    //   text reveals. Again."). Sticky top:0 is the top of the card's CONTENT box, so a scrolled card showed its rows
    //   through the padding above the head. --sc-pt pulls the head up over that padding (negative top + margin, the same
    //   padding inside it) and moves the handle and ✕ down by it: they sit exactly where they did; only the strip is gone.
    const readHead = () => { const pt = (parseFloat(getComputedStyle(card).paddingTop) || 0) + 'px'; return () => head.style.setProperty('--sc-pt', pt) }
    const fitHead = () => { try { readHead()() } catch { /* */ } }
    queueFit(readHead); try { window.addEventListener('resize', fitHead) } catch { /* */ }
  }
  // ★ THE TITLE, SHARED (the owner, 2026-10-12: the Code section's card "moves the title with the scroll … don't we use a
  //   general card layout for this?" → "Let's try to share the title"). The row right after the head — `.sheet-title`
  //   (the room sheets, the vault's account sheet) or `.sheet-head` (the Code section: the title and its tools) — is THE
  //   title: `.sc-title` sticks it where it rests, beside the ‹/✕, and the rows scroll and fade under it (the CSS above).
  //   Each page used to style its own, and the Code page's scrolled away. The band is painted in the card's own colour,
  //   read here (--sc-bg), and spans its padding (--sc-px), so one rule fits every card.
  if (head) {
    const t = head.nextElementSibling
    if (t && t.matches('.sheet-title, .sheet-head')) t.classList.add('sc-title')
    const readCard = () => {
      const cs = getComputedStyle(card), bg = cs.backgroundColor, px = (parseFloat(cs.paddingLeft) || 0) + 'px', pt = (parseFloat(cs.paddingTop) || 0) + 'px', g = Math.max((parseFloat(cs.borderTopLeftRadius) || 0) - 22, 12) + 'px'
      return () => { card.style.setProperty('--sc-bg', bg); card.style.setProperty('--sc-px', px); card.style.setProperty('--sc-pt', pt); card.style.setProperty('--sc-g', g) }
    }
    const fitCard = () => { try { readCard()() } catch { /* */ } }
    queueFit(readCard); chromeFit.set(root, fitCard)
    try { window.addEventListener('resize', fitCard); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fitCard) } catch { /* */ }
  }
  if (!x && wantHead && !noX) { // an adopted ✕ keeps its owner's handler (the steps sheet's turns into a back arrow); ours closes
    x = document.createElement('button'); x.type = 'button'; x.className = 'sc-x'; x.setAttribute('aria-label', 'Close'); x.title = 'Close'; x.innerHTML = X_SVG
    ;(head || grab.parentElement || card).append(x)
    x.addEventListener('click', (e) => { e.stopPropagation(); close() })
  }
  // Scrim: the root itself when it is the backdrop (a tap beside the card lands on it), else the element given. A card
  // that IS its own root (the artifact card, the file viewer) has no backdrop of its own here — its scrim is `scrim`.
  if (root !== card) root.addEventListener('click', (e) => { if (e.target === root) close() })
  if (scrim) scrim.addEventListener('click', () => close())
  // A WHEEL over the backdrop is a reach for the page beneath — it closes the sheet like a tap there (the owner, 2026-10-10,
  // desktop Settings: "when touching the underneath scroll it should hide the settings (like any other tap)"). Inside the card
  // the wheel scrolls the card; the target test keeps it apart.
  if (root !== card) root.addEventListener('wheel', (e) => { if (e.target === root) close() }, { passive: true })
  if (scrim) scrim.addEventListener('wheel', () => close(), { passive: true })
  // The pull. A card whose stylesheet already moves it by `--wdy` keeps its own transform (the wide-screen centring is
  // `translateX(-50%) translateY(var(--wdy))` — an inline transform would drop the centring mid-pull); anything else
  // is moved by an inline transform.
  const byVar = () => getComputedStyle(card).getPropertyValue('--wdy').trim() !== ''
  const place = (dy) => { if (byVar()) { card.style.setProperty('--wdy', dy + 'px'); card.style.transform = '' } else card.style.transform = dy ? `translateY(${dy}px)` : '' }
  let y0 = null, t0 = 0, dy = 0, dragged = false, scroller = null
  const reset = () => { y0 = null; card.classList.remove('sc-pulling'); card.style.transform = ''; card.style.removeProperty('--wdy') }
  const mayPull = () => isOpen() && (!pull || pull())
  // The open animation must not fight the finger, and it must NOT RESTART when the finger lifts. `.sc-pulling` used to
  // carry `animation:none !important` for that — but a CSS animation whose property goes none → <name> starts over, so
  // EVERY touch on the card (a tap on a row: touchstart, touchend) replayed the slide-in the moment the class came off.
  // Measured on the Code steps sheet (2026-09-27): a bare touchstart+touchend on a row, and the card is at translateY
  // +213 px and sliding for 260 ms; the click iOS fires after the touchend lands where the finger was — above the card,
  // on the backdrop — and the backdrop CLOSES the sheet ("pressing the nested cards doesn't work", the owner). Finishing
  // the running animations instead jumps them to their end state and leaves the property alone: nothing to restart.
  const settleAnimations = () => { try { for (const a of card.getAnimations()) a.finish() } catch { /* an engine without the Web Animations API keeps its animation */ } }
  const start = (e) => {
    if (!mayPull() || e.touches.length !== 1 || isTyping(e.target)) return
    // A ZOOMABLE card pulls only from its top (the owner, 2026-10-16: "Because it is zoomable it is better to disable the drag
    // … Enable it only at the top"): `pullFrom` lists where a pull may start (the handle strip, the title bar).
    if (Array.isArray(pullFrom) && !pullFrom.some((el) => el && el.contains(e.target))) return
    scroller = scrolledAncestor(e.target, card); if (scroller) return
    // THE CARD ITSELF may be the scroller (a grouped menu, Settings): scrolled down, a drag in it is a scroll — except on
    // the pinned head, which is exactly where a pull to close belongs.
    if (card.scrollTop > 0 && !(head && head.contains(e.target)) && e.target !== grab) return
    y0 = e.touches[0].clientY; t0 = performance.now(); dy = 0; dragged = false
    settleAnimations(); card.classList.add('sc-pulling'); place(0)
  }
  const move = (e) => {
    if (y0 == null) return
    if (axis === 'x') { reset(); return } // a sideways gesture never pulls the card
    // The body began scrolling after all (it was at the top, the finger went up then down): hand the gesture back.
    if (((body && body.scrollTop > 0) || card.scrollTop > 0) && e.target !== grab && !(head && head.contains(e.target))) { reset(); return }
    dy = Math.max(0, e.touches[0].clientY - y0); if (dy > DRAG_PX) dragged = true
    place(dy)
  }
  const end = () => {
    if (y0 == null) return
    const flick = dy / Math.max(1, performance.now() - t0)
    const out = dy > CLOSE_PX || (dy > 30 && flick > FLICK)
    reset()
    if (out) { dragged = false; close() } // close() may click the sheet's own Cancel — that click must not be swallowed below
  }
  // ⛔ A DRAG ON A SHEET NEVER SCROLLS WHAT IS UNDER IT (the owner, 2026-10-06, an iPhone: "When a card is dragged the sheet
  // under it scrolls … It is inconsistent"). iOS hands a touchmove nothing in the card can use to the page beneath — the
  // chat scrolled under the Connections sheet (its content fits: no scroller) while a long sheet, scrolling itself, did
  // not. This listener was passive, so it moved the card but could never stop that. Now a move is refused unless
  // something inside the card scrolls that way, or the finger is in a field; the scrim beside the card refuses them all.
  // ★ ONE AXIS PER GESTURE (the owner, 2026-10-14, the room map's sideways row: "It jitters"). The direction was decided
  // again on every move, so a sideways swipe that drifted a pixel down read as vertical for that move and was refused —
  // the native scroll stuttered — and the pull-down followed the drift, so the card wobbled. Now the first ~8 px decide
  // it, and it holds until the finger lifts: sideways scrolls sideways only, and never pulls the card.
  let gx = 0, gy = 0, sx = 0, sy = 0, axis = null
  const AXIS_PX = 8
  const track = (e) => { const p = e.touches[0]; if (p) { gx = sx = p.clientX; gy = sy = p.clientY; axis = null } }
  const guard = (e) => {
    const p = e.touches[0]; if (!p || e.touches.length !== 1) return // a pinch is the browser's
    const dx = p.clientX - gx, dy = p.clientY - gy; gx = p.clientX; gy = p.clientY
    if (!axis) { const tx = p.clientX - sx, ty = p.clientY - sy; if (Math.abs(tx) + Math.abs(ty) >= AXIS_PX) axis = Math.abs(tx) > Math.abs(ty) ? 'x' : 'y' }
    if (!e.cancelable || !isOpen() || (!dx && !dy) || isTyping(e.target)) return
    if (!scrollsThatWay(e.target, card, dx, dy, axis)) e.preventDefault()
  }
  card.addEventListener('touchstart', track, { passive: true })
  card.addEventListener('touchstart', start, { passive: true })
  card.addEventListener('touchmove', (e) => { guard(e); move(e) }, { passive: false })
  // ★ GROWTH GLIDES (the owner, 2026-10-06: a card "does a little vertical expansion right after. A jump." → "Maybe we can
  // just do a progressive animation"). A sheet whose content arrives after it opened (Settings → Siri waits on the
  // Sentinel) grew in one frame, and anchored at the bottom its top jumped. Now when an open card GROWS, its top glides
  // from where it was to where it is: FLIP on transform, started before the frame paints (a ResizeObserver runs after
  // layout). Only growth — a shrinking card would lift off its bottom edge — and never mid-pull, never during its own open
  // animation, never on a card moved by --wdy, never under reduced motion, never when the window itself changed size —
  // and never for what the user just did: a tap or a key in the card that opens a field shows it at once, under the
  // finger (the Code picker's "New folder"); only content that ARRIVES on its own (the network's answer) glides in.
  if (typeof ResizeObserver === 'function') {
    let last = null, actedAt = -1e9
    const acted = () => { actedAt = performance.now() }
    for (const ev of ['pointerdown', 'keydown', 'input']) card.addEventListener(ev, acted, { capture: true, passive: true })
    new ResizeObserver(() => {
      const r = card.getBoundingClientRect(), prev = last
      last = { top: r.top, h: r.height, vh: window.innerHeight }
      if (!prev || !isOpen() || y0 != null || r.height <= prev.h || prev.vh !== window.innerHeight || byVar()) return
      if (performance.now() - actedAt < 700) return
      const d = prev.top - r.top; if (d < 4) return
      try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return } catch { /* */ }
      try {
        if (card.getAnimations().some((a) => a.id !== 'sc-grow' && a.playState === 'running')) return // its own open slide is moving it
        card.animate([{ transform: `translateY(${d}px)` }, { transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.32,.72,.24,1)', id: 'sc-grow' })
      } catch { /* no Web Animations: it takes its new size at once, as before */ }
    }).observe(card)
  }
  const still = (e) => { if (e.cancelable && isOpen() && !card.contains(e.target)) e.preventDefault() }
  if (root !== card) root.addEventListener('touchmove', still, { passive: false })
  if (scrim) scrim.addEventListener('touchmove', still, { passive: false })
  card.addEventListener('touchend', end)
  card.addEventListener('touchcancel', reset)
  // A MOUSE can drag the head too (a desktop courtesy, and what the views-picker test does). Mouse only — a finger is
  // handled above, and a pointer drag on the scrolling body would need touch-action:none, which kills the scroll.
  // ⛑ The surface is OUR head, or an adopted handle's own row when it has one — never the card. The steps sheet's grab
  // is a direct child of its card, and `grab.parentElement` made the whole card the surface; with pointer CAPTURE on
  // it, the browser retargeted every mouseup — and so every click — onto the card, and a step row could not be
  // opened (two opencodeSection tests). So: no capture; the move/up ride the document only while a drag is on.
  const dragSurface = head || (grab && grab.parentElement !== card ? grab.parentElement : grab) || null
  const surfaces = [dragSurface, ...mouseFrom].filter(Boolean)
  if (surfaces.length) {
    let pid = null
    const pmove = (e) => { if (pid == null || e.pointerId !== pid) return; dy = Math.max(0, e.clientY - y0); if (dy > DRAG_PX) dragged = true; place(dy) }
    const off = () => { pid = null; document.removeEventListener('pointermove', pmove); document.removeEventListener('pointerup', pend); document.removeEventListener('pointercancel', pcancel) }
    const pend = (e) => { if (pid == null || e.pointerId !== pid) return; off(); end() }
    const pcancel = (e) => { if (pid == null || e.pointerId !== pid) return; off(); reset() }
    for (const s of surfaces) s.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || pid != null || !mayPull() || e.target === x || (x && x.contains(e.target)) || (e.target.closest && e.target.closest('button, a, input, select, textarea') && e.target !== s)) return
      pid = e.pointerId; y0 = e.clientY; t0 = performance.now(); dy = 0; dragged = false; settleAnimations(); card.classList.add('sc-pulling'); place(0)
      document.addEventListener('pointermove', pmove); document.addEventListener('pointerup', pend); document.addEventListener('pointercancel', pcancel)
    })
  }
  // SCROLLED: a card whose rows have scrolled up under its title says so (`sc-scrolled`), so the title's fade can grow only
  // then — a long fade at rest would fade the first row (the owner, 2026-10-11: "Is there a fade out? I can hardly see").
  const markScrolled = () => card.classList.toggle('sc-scrolled', card.scrollTop > 2)
  card.addEventListener('scroll', markScrolled, { passive: true })
  // A drag that ended on a button must not press it: the browser's own click after a touch (trusted) is swallowed once.
  card.addEventListener('click', (e) => { if (dragged && e.isTrusted) { dragged = false; e.stopPropagation(); e.preventDefault() } }, true)
  const chrome = { root, card, head, grab, x, close, isOpen, scrim, onEscape: onEscape || close } // a two-view sheet goes BACK on Escape first
  attached.set(root, chrome); roots.add(root)
  let wasOpen = false
  const stamp = () => { const now = !!isOpen(); if (now && !wasOpen) { openedAt.set(root, ++openSeq); const f = chromeFit.get(root); if (f) f() } wasOpen = now }
  stamp()
  try { new MutationObserver(stamp).observe(root, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] }) } catch { /* no observer: attach order decides, as before */ }
  return chrome
}

/** The TOPMOST open sheet — the one opened last among those open, the order they stack in. */
function topSheet() {
  let top = null
  for (const r of roots) { // an artifact card that left the DOM (a re-render) is forgotten here rather than kept for ever
    if (!r.isConnected) { roots.delete(r); continue }
    const c = attached.get(r); if (!c || !c.isOpen()) continue
    if (!top || (openedAt.get(r) || 0) >= (openedAt.get(top.root) || 0)) top = c
  }
  return top
}
/** Escape closes the topmost open sheet. */
function onKey(e) {
  if (e.key !== 'Escape') return
  if (e.target && e.target.closest && e.target.closest('[data-keeps-escape]')) return // a field that undoes its own edit on Escape (siriSheet's alias)
  const top = topSheet()
  if (top) { e.stopImmediatePropagation(); top.onEscape() }
}
if (typeof document !== 'undefined') document.addEventListener('keydown', onKey, true)
// A press on the PAGE'S OWN SCROLLBAR closes the topmost sheet, like a tap beside it. The scrollbar is outside the page, so
// the backdrop never sees it; the browser reports it as a press on the root element itself, which nothing else produces.
if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => {
  if (e.target !== document.documentElement) return
  const top = topSheet(); if (top) top.close()
}, true)

/** For tests: which attached sheets are open right now. */
export const openSheets = () => [...roots].filter((r) => r.isConnected && attached.get(r).isOpen())
/** Is `t` inside an open sheet — its layer, or the separate scrim of a card that is its own root? A gesture of the page
 *  beneath (the drawer's edge drag) must not start there: the owner, 2026-10-06, dragged a sheet's upper-left corner and
 *  the drawer opened under it. */
export const inOpenSheet = (t) => !!t && openSheets().some((r) => { const c = attached.get(r); return r.contains(t) || !!(c.scrim && c.scrim.contains(t)) })
