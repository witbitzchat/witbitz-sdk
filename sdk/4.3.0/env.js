// env.js — facts about WHERE this page is running, shared by every module of the split (space.js and the modules cut
// out of it). LEAF: no imports. Platform (isIOS / installedPWA), the framing vault's origin (VAULT_ORIGIN), and the one
// mutable boot flag, `env.crossOrigin` (was space.js's `let CROSS_ORIGIN`): set once during boot when a SEPARATE L1
// vault framed us, read everywhere room-switching or push registration must go THROUGH the vault. An object rather
// than an exported `let` because ES-module bindings are read-only from the importer's side.
export const env = { crossOrigin: false } // CROSS_ORIGIN axis (renamed from IN_VAULT, Phase 0): framed by a SEPARATE L1 vault (vcp handshake) → room-switching goes THROUGH the vault (awaitVaultKey per room), never a #mk= reload
// The origin of the vault that framed us (it delivers the key over vcHandoff). Exact via ancestorOrigins; referrer's
// origin is the portable fallback. NOT framed / same-origin (Stage 0 + the extension vault) → location.origin, so the
// handshake stays byte-identical there. Stage 1 (cross-origin vault): this is the vault's separate origin. STAGE 2
// hardening = compare against a PINNED allowlist here instead of trusting the actual framer (the app only ever RECEIVES
// the key, never emits it, so a wrong framer can at worst deliver a key that fails to decrypt).
export const VAULT_ORIGIN = (() => { try { if (window.top === window) return location.origin; const ao = location.ancestorOrigins; if (ao && ao.length && ao[ao.length - 1]) return ao[ao.length - 1]; if (window.parent === window.top && document.referrer) return new URL(document.referrer).origin } catch { /* */ } try { return location.origin } catch { return '' } })() // (no location in Node: the SDK and its test harness import this through util.js) — the TOP frame = the vault; a nested panel/widget resolves IT, not the app it sits inside
// On iOS, `standalone` is true only for the installed home-screen app; elsewhere the display-mode query covers it.
// The TENANT app's frame cannot see it: navigator.standalone is undefined in a cross-origin iframe and display-mode is
// unreliable there, so the vault — the top-level installed app — passes ?standalone=1 (installedChrome.js already trusts it).
// Without this the installed tenant app offered "Install" and said "install the app first" (the regular↔tenant sweep, 2026-10-12).
// THE NATIVE APP (android/attested-client, a WebView shell) is installed too, though its page reports no display-mode: it puts its
// hardware-key bridge on the page (`WitbitzAttest`, deviceAttest.js) — the test browserGate.js uses. Without it the shell met the
// in-app-browser warning and the install prompts (first run on a phone, 2026-11-07).
/** WHICH native app this page runs in: its bridge's platform, else the app's user-agent token (a frame the bridge does not reach) —
 *  'ios' | 'android' | 'macos' | 'windows' | 'linux' | '' (a browser). The Mac app answers 'macos' by its bridge, 'mac' by its token. */
export const nativePlatform = () => {
  try {
    const b = globalThis.WitbitzAttest
    if (b && typeof b.sign === 'function') { const p = typeof b.platform === 'function' ? String(b.platform()) : 'android'; return p === 'mac' ? 'macos' : p }
    const m = /\bWitbitzApp\/([a-z]+)/.exec(navigator.userAgent || '')
    return m ? (m[1] === 'mac' ? 'macos' : m[1]) : ''
  } catch { return '' }
}
const APP_NAMES = { ios: 'the iPhone app', android: 'the Android app', macos: 'the Mac app', windows: 'the Windows app', linux: 'the Linux app' }
/** "the iPhone app" … — the words for the app this is ('the app' for one this page does not know). */
/** A native app that CARRIES ITS OWN CODE (Android, Windows, the Mac / Linux desktop app, and the iPhone app since its bundled build:
 *  a new version is a new app). An iPhone app from before that loads the LIVE hosted app and must take new builds like a browser does.
 *  2026-11-21: checkVersion returned at once for every nativeApp(), so an iPhone app never left the build it first ran
 *  (the simulator still ran 7d98b999 four Official releases later). */
export const nativeBundled = () => nativeApp() && (nativePlatform() !== 'ios' || /\bWitbitzBundled\//.test((globalThis.navigator && navigator.userAgent) || ''))
// ↑ the iPhone app CARRIES its code since docs/ios-bundled-plan.md (2026-11-21) and says so (WitbitzBundled/1); an older iPhone app
//   that loads the live site does not, and keeps updating like a browser
export const nativeAppNamed = () => APP_NAMES[nativePlatform()] || 'the app'
export const nativeApp = () => { try { const b = globalThis.WitbitzAttest; return !!(b && typeof b.sign === 'function') || /\bWitbitzApp\//.test(navigator.userAgent || '') } catch { return false } } // + the app's user-agent token: a frame the bridge does not reach
export const installedPWA = () => window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || framedStandalone() || nativeApp()
const framedStandalone = () => { try { const q = new URLSearchParams(location.search); return q.get('fullapp') === '1' && q.get('standalone') === '1' } catch { return false } }
// iOS reports as iPhone/iPad — or, on iPadOS, as "MacIntel" with a touchscreen. We need this because a `_blank`
// window.open from a STANDALONE PWA on iOS opens the in-app browser (the "Search or enter website name" chrome) and
// leaves a blank tab in front of the app when maps redirects out. Instead we hand off with the Apple Maps URL scheme,
// which the OS routes straight to the Maps app — the PWA itself never navigates, so nothing blanks out.
export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
// iPhone LOCKDOWN MODE (the owner, 2026-10-12): it switches off WebAssembly, IndexedDB and — for web apps — notifications,
// with no exemption for an installed app. On iOS only Lockdown takes WebAssembly away, so its absence is the signal.
export const iosLockdownLikely = () => { try { return isIOS() && typeof WebAssembly === 'undefined' } catch { return false } }
// The install LANDING page — per-browser steps that walk a new person through installing the PWA. When we're framed by an
// L1 vault (a vaulted/tenant deployment), the ENTRY POINT people should install is the VAULT origin (it signs you in and
// frames the app, confining keys); sharing this inner app origin would bypass the vault and land on the naked app. The
// vault serves its own install landing at '/'. Standalone → the app IS the entry point, so its own /install page.
/** Open the install page. In the tenant app the FRAME must not navigate to the vault (it refuses to be framed — a blank
 *  screen): the vault page itself goes there. */
export function openInstallPage() {
  // A GUEST'S ROOM (the HN demo — its key only in this page): the install page opens in a NEW tab, from this tap, so the room
  // stays open (the owner, 2026-11-04: Install did not lead to spaces.witbitz.chat/install, and replaced the room)
  try { if (document.body.classList.contains('guest-room')) { const w = window.open(installLink(), '_blank'); if (w) { try { w.opener = null } catch { /* */ } return } } } catch { /* fall through */ } // not 'noopener': with it open() answers null even when it opened, and this tab left too
  if (env.crossOrigin && VAULT_ORIGIN && VAULT_ORIGIN !== location.origin) { try { window.top.postMessage({ ch: 'vcHandoff', t: 'openInstall' }, VAULT_ORIGIN); return } catch { /* fall through */ } }
  location.href = installLink()
}
export const installLink = () => (env.crossOrigin && VAULT_ORIGIN && VAULT_ORIGIN !== location.origin) ? VAULT_ORIGIN + '/install' : location.origin + '/install' // the hosted app's /install too (the owner, 2026-10-20: "like the regular app"; the vault serves the same Install page there)
export const isLanePanel = (() => { try { return new URLSearchParams(location.search).get('panel') === '1' } catch { return false } })() // this app instance IS a docked private-lane panel (an iframe of the parent shared-room app)
export const ATLAS = (() => { try { return new URLSearchParams(location.search).get('atlas') === '1' } catch { return false } })() // opt-in: render the drawer from the Atlas keyless projection instead of reading recents directly. Default OFF → byte-identical.
// The loader passes ?fullapp=1 when it frames the WHOLE app (not one room) — the app-site pane and the installed-app chrome
// read it (moved from space.js, verified-client split step 50).
export const FULLAPP = (() => { try { return new URLSearchParams(location.search).get('fullapp') === '1' } catch { return false } })()
// External APP handoff (whatsapp:// / mailto:) — a cross-origin iframe can't navigate to a custom scheme (iOS blocks it
// silently: the invite buttons looked dead), so when framed, hand the URL to the VAULT (top-level) to perform. The vault
// whitelists the schemes it will follow. Standalone: plain location.href, exactly as before.
export const extNav = (url) => { if (env.crossOrigin) { try { window.top.postMessage({ ch: 'vcHandoff', t: 'extnav', url }, VAULT_ORIGIN); return } catch { /* fall through */ } } location.href = url }
