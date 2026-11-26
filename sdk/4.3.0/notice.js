// spaces/public/notice.js — how the app TELLS you something (spaces/test/notice.test.mjs). The owner, 2026-10-10: "There are
// many cases where warnings or errors are written to the card or room view which looks unprofessional." Four kinds, each
// with its own place:
//   - something that happened IN THE ROOM (a rename, a join): a line in the room — messageRender.addSys, unchanged;
//   - feedback on YOUR action ("Backed up 12 Spaces", "Couldn't save the contact"): toast() — a pill above the message box
//     that fades on its own;
//   - a problem you must ACT on ("This Space only admits listed accounts"): banner() — the same pill, with its button and a
//     ✕, until you answer it;
//   - technical detail (status codes, exception text): logDetail() — the console and the device's diagnostics list
//     (Settings → five taps on the build line), never the screen.
// Words: short, plain, no emoji, no internal terms (docs: the owner's "unprofessional").

const DETAIL_KEY = 'space:detail' // the last 50 technical details, for the diagnostics viewer — no message text, no keys
const TOAST_MS = 3500

let css = false
function ensureCss() {
  if (css || typeof document === 'undefined') return
  css = true
  const s = document.createElement('style'); s.id = 'noticeCss'
  s.textContent = `
#noticeStack { position:fixed; left:0; right:0; bottom:calc(92px + var(--sat-b, env(safe-area-inset-bottom))); z-index:9000; display:flex; flex-direction:column; align-items:center; gap:8px; pointer-events:none; padding:0 16px; }
.notice { pointer-events:auto; max-width:min(480px, 100%); display:flex; align-items:center; gap:10px; background:var(--grp-pill, var(--bg, #fff)); color:var(--fg, #111); border-radius:18px; padding:11px 14px; box-shadow:0 6px 24px rgba(0,0,0,.16); font-size:14.5px; line-height:1.35; opacity:0; transform:translateY(8px); transition:opacity .2s ease, transform .2s ease; }
.notice.in { opacity:1; transform:none; }
.notice.error { color:var(--danger, #9c3b33); }
.notice-text { flex:1 1 auto; min-width:0; }
.notice-act { flex:0 0 auto; border:0; background:var(--btn, #111); color:var(--btn-fg, #fff); border-radius:999px; padding:7px 13px; font:inherit; font-weight:600; font-size:13.5px; cursor:pointer; }
.notice-x { flex:0 0 auto; border:0; background:transparent; color:var(--muted, #888); width:28px; height:28px; border-radius:50%; font-size:16px; line-height:1; cursor:pointer; }
@media (prefers-reduced-motion: reduce) { .notice { transition:none; } }
`
  document.head.append(s)
}
function stack() {
  ensureCss()
  let s = document.getElementById('noticeStack')
  if (!s) { s = document.createElement('div'); s.id = 'noticeStack'; s.setAttribute('role', 'status'); s.setAttribute('aria-live', 'polite'); document.body.append(s) }
  return s
}
const show = (n) => { requestAnimationFrame(() => n.classList.add('in')) }
function hide(n) { if (!n || !n.isConnected) return; n.classList.remove('in'); setTimeout(() => n.remove(), 220) }

/** Feedback on the person's own action: a pill that fades. The same words twice in a row are one pill, its timer renewed. */
export function toast(text, { kind = 'info', ms = TOAST_MS } = {}) {
  if (typeof document === 'undefined' || !text) return null
  const s = stack()
  const same = [...s.children].find((n) => n.dataset.text === String(text) && !n.dataset.banner)
  if (same) { clearTimeout(same._t); same._t = setTimeout(() => hide(same), ms); return same }
  const n = document.createElement('div'); n.className = 'notice' + (kind === 'error' ? ' error' : ''); n.dataset.text = String(text)
  const t = document.createElement('span'); t.className = 'notice-text'; t.dir = 'auto'; t.textContent = String(text)
  n.append(t); s.append(n); show(n)
  n._t = setTimeout(() => hide(n), ms)
  n.addEventListener('click', () => hide(n))
  while (s.children.length > 3) s.firstElementChild.remove() // never a pile
  return n
}

/** A problem to act on: stays until its button or ✕. One per `id` — a second call replaces the first. */
export function banner(text, { id = '', action = null, kind = 'info' } = {}) {
  if (typeof document === 'undefined' || !text) return null
  const s = stack()
  if (id) { const old = [...s.children].find((n) => n.dataset.banner === id); if (old) old.remove() }
  const n = document.createElement('div'); n.className = 'notice' + (kind === 'error' ? ' error' : ''); n.dataset.banner = id || '1'
  const t = document.createElement('span'); t.className = 'notice-text'; t.dir = 'auto'; t.textContent = String(text)
  n.append(t)
  if (action && action.label) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'notice-act'; b.textContent = action.label
    b.onclick = () => { hide(n); try { action.onClick && action.onClick() } catch (e) { logDetail('banner action', e) } }
    n.append(b)
  }
  const x = document.createElement('button'); x.type = 'button'; x.className = 'notice-x'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '✕'
  x.onclick = () => hide(n)
  n.append(x); s.append(n); show(n)
  return n
}
export function clearBanner(id) { try { const n = [...document.getElementById('noticeStack').children].find((x) => x.dataset.banner === id); hide(n) } catch { /* none */ } }

/** Technical detail: the console and the diagnostics list — never the screen. */
export function logDetail(where, err) {
  const msg = String((err && (err.message || err.error)) || err || '').slice(0, 300)
  try { console.warn('[' + where + ']', err) } catch { /* */ }
  try {
    const a = JSON.parse(localStorage.getItem(DETAIL_KEY) || '[]')
    a.push({ t: Date.now(), where: String(where).slice(0, 60), msg })
    localStorage.setItem(DETAIL_KEY, JSON.stringify(a.slice(-50)))
  } catch { /* private mode */ }
}
export const readDetails = () => { try { const a = JSON.parse(localStorage.getItem(DETAIL_KEY) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }

/** A provider's error the person can ACT on, said plainly — else ''. The raw text still goes to logDetail; this keeps the reason
 *  ("out of credits") that a generic "couldn't finish" would hide. */
export function plainReason(raw) {
  const t = String(raw || '').toLowerCase()
  if (/insufficient|credit|balance|billing|payment required|quota|budget|spend limit|\b402\b/.test(t)) return 'The model’s account is out of credits.'
  if (/rate.?limit|too many requests|\b429\b|overloaded/.test(t)) return 'The model is busy right now. Try again in a minute.'
  if (/context (length|window)|too many tokens|maximum context|prompt is too long|too long for/.test(t)) return 'The conversation is too long for this model. Compact it or start a new session.'
  if (/invalid api key|unauthori[sz]ed|\b401\b|api key/.test(t)) return 'The model’s key wasn’t accepted.'
  return ''
}

// A toast for the NEXT page: an action that ends in a navigation (recreate opens the new Space) would show its toast for
// an instant on the page it leaves (sync sweep, 2026-10-10). Kept in sessionStorage — this tab only — and shown once.
const NEXT_KEY = 'space:toastNext'
export function toastNext(text, opts = {}) {
  try {
    let list = []; try { list = JSON.parse(sessionStorage.getItem(NEXT_KEY) || '[]') } catch { /* */ } if (!Array.isArray(list)) list = []
    sessionStorage.setItem(NEXT_KEY, JSON.stringify([...list, { text: String(text), kind: opts.kind || 'info', ...(Number.isFinite(opts.ms) ? { ms: opts.ms } : {}) }].slice(-3)))
  } catch { toast(text, opts) }
}
if (typeof document !== 'undefined') {
  setTimeout(() => {
    try {
      const raw = sessionStorage.getItem(NEXT_KEY); if (!raw) return; sessionStorage.removeItem(NEXT_KEY)
      const v = JSON.parse(raw); for (const n of (Array.isArray(v) ? v : [v])) toast(n.text, { kind: n.kind, ms: Number.isFinite(n.ms) ? n.ms : 10000 })
    } catch { /* */ }
  }, 800)
}
