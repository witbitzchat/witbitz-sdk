// codeBrowse.js — what the Code section says about the agent's browser, and the link that opens it
// (docs/cloud-computer.md § 12). Pure: it takes the enclave's own `browse` report — which rides the assign result
// and the hello beside `egress` and `agent` — plus the computer's cloud entry, and returns a row or nothing.
//
// ★ THE ROW IS THE ONLY PLACE THE OWNER LEARNS THE AGENT HAS A BROWSER, so it must not overstate. A computer made
// before this shipped has no browse key and offers nothing; a browser the agent has never opened is not a browser
// "waiting to connect"; and the sentence about take-over says what take-over actually buys.
import { RELAY_URL } from './codeRelay.js'

// The viewer's own origin — a DEDICATED Pages project, deliberately not the app's (spaces/browse-connector/_headers
// explains why: this is the one page allowed to reach the relay, and the app's signed egress-lock cert stays clean).
export const BROWSE_ORIGIN = 'https://browse.witbitz.chat'

/**
 * The link the owner opens to watch. The key rides the FRAGMENT, never the query: a fragment is not sent to the
 * server and is not what proxies and access logs keep.
 * @returns {string|null} null when this computer has no browse key at all.
 */
export function watchUrl (cloud, { take = false, origin = BROWSE_ORIGIN, session = '' } = {}) {
  const key = cloud && cloud.browse
  if (!key) return null
  const relay = (cloud && cloud.relay) || RELAY_URL
  const hash = new URLSearchParams({ key })
  if (take) hash.set('take', '1')
  // THE CODE SESSION it shows: each session has its own tab on the computer (vm/sessiontabs.go; the owner, 2026-11-24)
  if (/^[A-Za-z0-9_-]{1,128}$/.test(String(session || ''))) hash.set('session', session)
  return `${origin}/watch?${new URLSearchParams({ relay })}#${hash}`
}

/**
 * @param {{offered?:boolean, running?:boolean, takeover?:boolean, viewport?:string, error?:string}} report
 *   the enclave's own `browse` report, as it arrives in the hello.
 * @param {{freeBrowsing?:{on?:boolean}}} [egress] the enclave's egress report, for whether the web is open now
 * @returns {{kind:string, title:string, detail:string, actions:{label:string,url?:string,act?:string}[]}|null}
 */
export function browseRow (report, cloud, egress, { session = '' } = {}) {
  if (!report || !report.offered) return null
  const watch = watchUrl(cloud, { session })
  if (!watch) return null // no key on this computer: there is nothing to open, so there is nothing to say

  if (report.error && !report.running) {
    return { kind: 'error', title: 'The browser could not start', detail: String(report.error).slice(0, 200), actions: [] }
  }
  // Not started is not a state worth a row. The agent opens the browser when it needs one; an empty "not browsing"
  // row every session teaches the owner to ignore the exact place the real thing will appear.
  if (!report.running) return null

  if (report.takeover) {
    // ★ FREE BROWSING IS OFFERED HERE AND NOWHERE ELSE — only while the controls are actually held. It is what
    //   take-over buys, not a setting, and a page that offered it beside "Watch" would be offering the `full` the
    //   owner struck with an extra tap. The enclave refuses it without take-over anyway; this is the same rule said
    //   where a person can see it. docs/cloud-computer-free-browsing.md § 5.
    // ⛑ `act` rather than `url`: this one is a CALL, authenticated by the device half, not a link anyone could share.
    // ★ ONE KIND. There used to be a second — "taken, with the whole web open" — with "Open the web" / "Close the
    //   web" actions behind it. The owner asked for that to go (2026-09-21): the browser reaches everything by
    //   construction now, so there is nothing to open and nothing to close. `egress` is still accepted so callers
    //   need not change; it decides nothing here.
    return {
      kind: 'taken',
      title: 'You have the controls',
      detail: 'The agent cannot see this browser while you hold it. The whole web is reachable — and the agent can use whatever you log into afterwards, so don\'t type a password you use anywhere else.',
      actions: [{ label: 'Open', url: watch }],
    }
  }
  return {
    kind: 'watching',
    title: 'Browsing' + (report.viewport ? ' · ' + report.viewport : ''),
    detail: 'The agent is using a browser on this computer. You can watch it, or take the controls.',
    actions: [
      { label: 'Watch', url: watch },
      { label: 'Take over', url: watchUrl(cloud, { take: true, session }) },
    ],
  }
}

// ★ ON A COMPUTER THE VIEWER OPENS INSIDE THE APP (the owner, 2026-10-17: "in desktop PWA when I open the cloud computer
//   browser it open a new tab in the browser" → "it is in chrome but not in the PWA"). The viewer lives on its own origin
//   (spaces/browse-connector/_headers), and an installed app sends ANY page outside its own site — a link or a popup —
//   to the browser. So on a computer it is shown in a panel over the Code section; its frame-ancestors names our app's
//   pages only. Opening it again shows the same panel.
// ★ AND ON A PHONE TOO (the owner, 2026-10-18: "Why can't I get help from the app?" → "Yes"): a phone's link opened a
//   Safari sheet over the installed app; iPhone pauses the app under it, so nothing in the viewer — its ? included — could
//   reach the app. In the panel the viewer is a frame of this page and ? opens Help at once.
// A COMPUTER = any mouse or touchpad, and a window wider than a phone. Not "the PRIMARY pointer is fine": Chrome on a
// Windows laptop with a touchscreen can report its primary pointer as coarse, and the panel then never opened there
// (the owner's ASUS, 2026-10-17 — still sent to Chrome on the panel build).
export const isComputer = () => matchMedia('(any-pointer: fine)').matches && innerWidth >= 700
/** The person switched Code sessions while the panel is open: the viewer shows that session's tab (watch.js listens). */
export function setBrowsePanelSession (session) {
  const f = document.getElementById('browsePanelFrame')
  if (!f || !/^[A-Za-z0-9_-]{1,128}$/.test(String(session || ''))) return
  try { f.contentWindow.postMessage({ ch: 'wb-browse-panel', session }, new URL(f.getAttribute('src')).origin) } catch { /* the panel is closing */ }
}

export function openBrowsePanel (url) {
  if (!url) return false
  let panel = document.getElementById('browsePanel')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'browsePanel'
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#0f1418;display:flex;flex-direction:column'
    // iOS 27 FROSTS the top of an installed web app: a light haze the app hides by keeping that strip in its own background
    // colour. Painted dark here it showed as a grey fade (the owner, iPhone, 2026-10-18: "a kind of fade in the top of the
    // screen", then "Still there is the frost"). So the strip under the status bar (--sat-t, the iOS 27 extra included —
    // codeView.js forwards it into this frame) is the app's background, as everywhere else, and the dark viewer starts below.
    // ⚑ THE × IS IN THE VIEWER'S OWN ROW now (the owner: "the x above the top raw … should move into the top bar"), so there is
    // no bar here — the strip alone keeps the frost off the dark controls: --sat-t, plus 22 px while there is a status bar at
    // all (the frost reached ~95 pt on the owner's iPhone where --sat-t is 74); a phone held sideways has none, so no strip.
    const strip = document.createElement('div')
    strip.style.cssText = 'flex:0 0 auto;height:calc((var(--sat-t, env(safe-area-inset-top)) + min(var(--sat-t, env(safe-area-inset-top)), 22px)) * var(--sat-on, 1));background:var(--bg, #fff)'
    strip.id = 'browsePanelStrip'
    const frame = document.createElement('iframe')
    frame.id = 'browsePanelFrame'; frame.title = "The agent's browser"
    frame.allow = 'fullscreen; clipboard-write; autoplay'
    frame.referrerPolicy = 'no-referrer'
    frame.style.cssText = 'flex:1;width:100%;border:0;background:#000'
    // the viewer shows its own × only when asked (watch.js): this panel hears "leave"; an older one would not
    frame.addEventListener('load', () => { try { frame.contentWindow.postMessage({ ch: 'wb-browse-panel', leave: true }, new URL(frame.getAttribute('src')).origin) } catch { /* */ } })
    panel.append(strip, frame)
    document.body.append(panel)
    playbackSession(true)
    setBrowsing(true)
    addEventListener('resize', onPanelTurn)
    try { if (screen.orientation) screen.orientation.addEventListener('change', onPanelTurn) } catch { /* */ }
    fitStrip()
    noteTurn('open')
    document.addEventListener('keydown', onPanelKey, true)
  }
  const frame = document.getElementById('browsePanelFrame')
  if (frame.getAttribute('src') !== url) frame.src = url
  panel.hidden = false
  try { frame.focus() } catch { /* */ }
  return true
}
function onPanelKey (e) { const p = document.getElementById('browsePanel'); if (e.key === 'Escape' && p && !p.hidden) { e.preventDefault(); e.stopPropagation(); closeBrowsePanel() } }
// ★ THE VIEWER'S ? OPENS HELP (the owner, 2026-10-18: "the help (?) in the browser should open the Help assistance"): the
//   viewer, a frame of the panel, says so to this page, which closes the panel and opens the app's Help assistant.
let browseHelp = () => {}
export const setBrowseHelp = (fn) => { browseHelp = typeof fn === 'function' ? fn : () => {} }
if (typeof addEventListener === 'function') addEventListener('message', (e) => {
  const f = document.getElementById('browsePanelFrame')
  let from = BROWSE_ORIGIN; try { from = new URL(f.getAttribute('src')).origin } catch { /* */ } // the site this panel itself loaded
  if (!f || e.origin !== from || e.source !== f.contentWindow || !e.data) return
  if (e.data.ch === 'wb-browse-leave') { closeBrowsePanel(); return } // the viewer's ×, first in its own row (watch.html #leave)
  if (e.data.ch !== 'wb-browse-help') return
  closeBrowsePanel(); try { browseHelp() } catch { /* */ }
})
/** Closing REMOVES it: the viewer's socket goes with it, so a browser nobody watches costs the screen nothing. */
export function closeBrowsePanel () {
  const p = document.getElementById('browsePanel'); if (!p) return
  document.removeEventListener('keydown', onPanelKey, true)
  p.remove()
  playbackSession(false)
  setBrowsing(false)
  removeEventListener('resize', onPanelTurn)
  try { if (screen.orientation) screen.orientation.removeEventListener('change', onPanelTurn) } catch { /* */ }
  noteTurn('close')
}
// SOUND UNDER THE SILENT SWITCH (the owner, iPhone, 2026-10-18: "There is no sound", the ringer off). The viewer's sound is
// Web Audio, which iOS mutes on silent unless the page is a PLAYER (navigator.audioSession 'playback'). The viewer says so
// itself, but in the panel it is a frame of another site, and the audio session is the page's — so the app says it while
// the panel is open, and goes back to the default when it closes. Unproven on a device yet; Safari 17+, elsewhere a no-op.
// A PHONE MAY TURN SIDEWAYS ONLY WHILE THIS IS OPEN (the owner, 2026-10-18). "Turn your phone back" (space.html #portraitOnly)
// covers every screen of a phone held sideways — and the panel opens inside the Code FRAME, under the app page's cover
// (the owner: "it was locked … by the css"). So html.browsing goes on this page AND every same-origin page above it.
// THE BOOT LOG SAYS WHAT A TURN DID (Settings → Crash trail → Boot log; the owner, 2026-10-18: landscape showed "Turn your
// phone back" over the browser on Beta, while the same page held sideways in WebKit here lifts it). One line on open, close
// and every size change while open: the size, whether the app page carries html.browsing, and whether its cover shows.
let turnT = 0
// SIDEWAYS THERE IS NO STATUS BAR, so no strip (the owner, landscape full screen: "it is not really full" — a white band
// the height of the portrait status bar stayed on top: the app's --sat-t keeps its upright value). Wider than tall = none.
// ⚑ SIDEWAYS BY THE PHONE, NOT BY THIS FRAME (the owner: portrait → landscape → portrait came back "too high without the
//   frost guard"): this page is the Code FRAME, whose size the app re-sets after a turn — read too early it was still wide,
//   so the strip stayed off upright. The phone's own orientation decides, read again as the turn settles.
const sideways = () => {
  try { const t = screen.orientation && screen.orientation.type; if (t) return t.startsWith('landscape') } catch { /* */ }
  try { return matchMedia('(orientation: landscape)').matches && (window.top.innerWidth > window.top.innerHeight) } catch { return innerWidth > innerHeight }
}
// ⚑ AND ITS HEIGHT IS THE LARGEST UPRIGHT STATUS BAR SEEN (the owner's boot log, 2026-10-18: \`browse open … strip 93\`, then
//   \`browse turn 430x932 … strip 24 · portrait-primary\` — after a turn, and after the keyboard opened with no turn at all,
//   the app hands this frame a --sat-t of ~12 px, and the strip sized from it put the controls under the frost again).
//   Upright, the status bar does not shrink: keep the largest --sat-t read upright and size the strip from it in px.
let satMax = 0
const satNow = () => { try { const pr = document.createElement('div'); pr.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;height:var(--sat-t, env(safe-area-inset-top))'; document.body.appendChild(pr); const h = pr.getBoundingClientRect().height; pr.remove(); return h } catch { return 0 } }
const fitStrip = () => {
  try {
    const st = document.getElementById('browsePanelStrip'); if (!st) return
    if (sideways()) { st.style.display = 'none'; return }
    satMax = Math.max(satMax, satNow())
    st.style.display = ''; st.style.height = Math.round(satMax + Math.min(satMax, 22)) + 'px'
  } catch { /* */ }
}
const onPanelTurn = () => {
  fitStrip(); clearTimeout(turnT)
  for (const ms of [250, 700, 1500]) setTimeout(fitStrip, ms) // a turn lands in steps on iOS (the crash trail caught 430x104 mid-turn)
  turnT = setTimeout(() => { fitStrip(); noteTurn('turn') }, 1600)
}
function noteTurn (what) {
  try {
    let w = window, app = null
    for (let i = 0; i < 4 && w; i++) { try { if (w.document.getElementById('portraitOnly')) { app = w; break } } catch { break } if (w === w.parent) break; w = w.parent }
    const top = app || window
    const cover = app ? app.getComputedStyle(app.document.getElementById('portraitOnly')).display : 'no app page'
    const st = document.getElementById('browsePanelStrip'), fe = window.frameElement, fr = fe && fe.getBoundingClientRect(), vv = top.visualViewport
    const where = ` · frame ${innerWidth}x${innerHeight}` + (fr ? ` at top ${Math.round(fr.top)} h ${Math.round(fr.height)}` : '') + (vv ? ` · vv off ${Math.round(vv.offsetTop)} h ${Math.round(vv.height)}` : '') + ` · scrollY ${Math.round(top.scrollY)} · strip ${st ? (st.style.display === 'none' ? 'off' : Math.round(st.getBoundingClientRect().height)) : '-'} · ${(screen.orientation && screen.orientation.type) || '?'}`
    const line = `browse ${what} ${top.innerWidth}x${top.innerHeight} · browsing=${top.document.documentElement.classList.contains('browsing') ? 1 : 0} · cover ${cover}` + where
    const k = 'space:bootlog', a = JSON.parse(localStorage.getItem(k) || '[]'); a.push(new Date().toISOString().slice(11, 23) + ' ' + line); while (a.length > 1000) a.shift(); localStorage.setItem(k, JSON.stringify(a))
  } catch { /* a diagnostic never costs the panel */ }
}
function setBrowsing (on) {
  // THE iPHONE APP turns sideways only while this is on (ios/attested-client OrientationBridge.swift; the owner, 2026-11-23): it
  // refuses landscape everywhere else, so the cover below never shows there. Nothing elsewhere has the bridge.
  // …and so does the ANDROID app (android/attested-client OrientationBridge.kt), whose bridge answers at once instead of a promise
  try { if (window.WitbitzOrientation) { const r = window.WitbitzOrientation.landscape(!!on); if (r && typeof r.catch === 'function') r.catch(() => {}) } } catch { /* */ }
  let w = window
  for (let i = 0; i < 4 && w; i++) {
    try { w.document.documentElement.classList.toggle('browsing', on) } catch { break } // a cross-origin parent (the vault) has no cover
    if (w === w.parent) break
    w = w.parent
  }
}
function playbackSession (on) {
  try { if (navigator.audioSession) navigator.audioSession.type = on ? 'playback' : 'auto' } catch { /* */ }
}
