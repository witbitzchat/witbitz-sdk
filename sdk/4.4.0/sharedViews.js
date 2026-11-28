// sharedViews.js — a shared room's VIEWS (its itinerary and maps) as compact text for a private lane's assistant, one
// rendering for the Spaces app (mirrorLoop.js) and the SDK (witbitz-sdk.js Lane). The lane's assistant cannot read the
// shared room's widget docs — another room, another key — so the member's device, which holds both keys, writes this text
// into the lane's sealed `sharedviews` doc, and the lane's turn reads it (agent/asyncTurn.mjs). The SDK never wrote it
// (sync sweep, 2026-10-10): an SDK lane's assistant could not see the plan everyone else was looking at.
// Pure — no DOM, no network. spaces/test/sharedViews.test.mjs.

export const SHARED_VIEWS_DOC = 'sharedviews'
export const SHARED_VIEWS_MAX = 12000 // the state allows 32 KB; a long multi-week plan must arrive whole

/** `views` = [{ label, state }] (a widget's label and its doc's state) → the text, or '' when there is nothing to say. */
export function renderSharedViews(views, source = '') {
  const parts = []
  for (const v of Array.isArray(views) ? views : []) {
    const st = v && v.state
    if (!st || typeof st !== 'object') continue
    if (Array.isArray(st.days) && st.days.length) {
      parts.push('ITINERARY' + (st.title ? ' — ' + st.title : '') + '\n' + st.days.map((d) => `${(d && d.name) || 'Day'}: ${((d && d.items) || []).map((i) => `${i && i.when ? i.when + ' — ' : ''}${(i && i.text) || ''}`).filter(Boolean).join('; ')}`).join('\n'))
    } else if (Array.isArray(st.places) && st.places.length) {
      parts.push('MAP (' + String((v && v.label) || 'map').replace(/^\W+\s*/, '') + '): ' + st.places.map((pl) => `${(pl && pl.name) || 'place'}${pl && Number.isFinite(pl.rating) ? ` ★${pl.rating}` : ''}${pl && pl.chosen ? ' (shortlisted)' : ''}`).join(', '))
    }
  }
  const chars = Array.from(parts.join('\n\n').slice(0, SHARED_VIEWS_MAX))
  const size = text => new TextEncoder().encode(JSON.stringify({ source, text })).length
  const text = chars.join('')
  if (size(text) <= 32000) return text
  let low = 0, high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (size(chars.slice(0, mid).join('')) <= 32000) low = mid
    else high = mid - 1
  }
  return chars.slice(0, low).join('')
}

/** The views a room's log names: each widget's doc name and label, newest first, at most `max`. */
export function viewsNamedIn(entries, max = 12) {
  const out = [], seen = new Set()
  const list = Array.isArray(entries) ? entries : []
  for (let i = list.length - 1; i >= 0; i--) {
    const ws = list[i] && Array.isArray(list[i].widgets) ? list[i].widgets : []
    for (const w of ws) {
      if (!w || typeof w.name !== 'string' || !w.name || seen.has(w.name)) continue
      if (out.length >= max) {
        if (w.name !== 'itinerary' || !out.length) continue
        out.pop()
      }
      seen.add(w.name); out.push({ name: w.name, label: typeof w.title === 'string' && w.title ? w.title : w.name })
    }
  }
  return out
}
