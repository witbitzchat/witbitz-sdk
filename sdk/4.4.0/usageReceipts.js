// usageReceipts.js — the DEVICE half of usage receipts (docs/usage-receipts.md). The account's USAGE KEY (a P-256 box pair
// + a secret) rides the account like the invite key; a turn this device sends carries `receipt: { drop, pub }`, where the
// drop is HMAC(secret, room) — a different opaque id in every room, so the server cannot link this account's rooms. The
// collector reads each room's receipts, opens them, and folds them into the SIDECAR: one doc per month in the account's
// index room, `usage-YYYY-MM`, holding every receipt by id (so two devices folding the same receipt count it once).
// Settings → Usage reads only the sidecar.
import { genRecipientKey, openBox } from './e2ee.js'

export const USAGE_KEY = 'space:usagekey'
export const PAYERS = ['you', 'admin', 'app', 'witbitz']
const enc = new TextEncoder()
const b64u = (u8) => { let x = ''; for (const b of u8) x += String.fromCharCode(b); return btoa(x).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const ub64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const B43 = /^[A-Za-z0-9_-]{43}$/

/** A well-formed usage key, or null. { id, pub:{x,y}, priv:jwk, secret } — `id` picks one key when two devices made one. */
export function normUsageKey (k) {
  if (!k || typeof k !== 'object' || typeof k.id !== 'string' || !k.id || !k.pub || !B43.test(String(k.pub.x)) || !B43.test(String(k.pub.y)) || !k.priv || typeof k.priv.d !== 'string' || !B43.test(String(k.secret || ''))) return null
  return { id: k.id.slice(0, 32), pub: { x: k.pub.x, y: k.pub.y }, priv: { kty: 'EC', crv: 'P-256', x: k.priv.x, y: k.priv.y, d: k.priv.d, ext: true }, secret: k.secret }
}
export const loadUsageKey = (ls = globalThis.localStorage) => { try { return normUsageKey(JSON.parse(ls.getItem(USAGE_KEY) || 'null')) } catch { return null } }
export const saveUsageKey = (k, ls = globalThis.localStorage) => { const n = normUsageKey(k); if (n) { try { ls.setItem(USAGE_KEY, JSON.stringify(n)) } catch { /* private mode */ } } return n }
/** Two devices that each made a key converge on one: the smaller id wins, the same choice on both sides. */
export const pickUsageKey = (a, b) => { const x = normUsageKey(a), y = normUsageKey(b); return !x ? y : !y ? x : (x.id <= y.id ? x : y) }

export const USAGE_KEYS_OLD = 'space:usagekey:old'
export const loadOldUsageKeys = (ls = globalThis.localStorage) => { try { const a = JSON.parse(ls.getItem(USAGE_KEYS_OLD) || '[]'); return Array.isArray(a) ? a.map(normUsageKey).filter(Boolean) : [] } catch { return [] } }
/**
 * Converge this device's usage key with the one the account's index carries. The smaller id wins on every device; the
 * LOSER is kept as a retired key (receipts already sealed to it, at drops derived from it, are still collected — a key
 * that lost a race must not lose its receipts). → { key, old } after saving both.
 */
export function mergeUsageKeys (remote, { ls = globalThis.localStorage } = {}) {
  const local = loadUsageKey(ls), rk = normUsageKey(remote && remote.usageKey)
  const key = pickUsageKey(local, rk)
  const all = [...loadOldUsageKeys(ls), ...((remote && Array.isArray(remote.usageKeysOld)) ? remote.usageKeysOld.map(normUsageKey).filter(Boolean) : []), local, rk].filter(Boolean)
  const seen = new Set(key ? [key.id] : []), old = []
  for (const k of all) if (!seen.has(k.id)) { seen.add(k.id); old.push(k) }
  const keep = old.slice(-4)
  if (key) saveUsageKey(key, ls)
  try { ls.setItem(USAGE_KEYS_OLD, JSON.stringify(keep)) } catch { /* private mode */ }
  return { key, old: keep }
}

export async function newUsageKey () {
  const kp = await genRecipientKey()
  return normUsageKey({ id: b64u(crypto.getRandomValues(new Uint8Array(12))), pub: { x: kp.publicJwk.x, y: kp.publicJwk.y }, priv: kp.privateJwk, secret: b64u(crypto.getRandomValues(new Uint8Array(32))) })
}

/** This account's drop in `room`: HMAC-SHA256(secret, room). */
export async function dropFor (key, room) {
  const k = await crypto.subtle.importKey('raw', ub64u(key.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('witbitz-usage-drop:' + room))))
}
/** The receipt address a turn in `room` carries. */
export async function receiptFor (key, room) { return key ? { drop: await dropFor(key, room), pub: { ...key.pub } } : null }

// ── the sidecar: `usage-YYYY-MM` = { v:1, r: { <receipt id>: [day, payer, costMicros, in, out] } } ──
export const monthOf = (ts) => { const d = new Date(ts); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') }
export const docNameFor = (month) => 'usage-' + month
const row = (b) => [new Date(b.ts).getUTCDate(), Math.max(0, PAYERS.indexOf(b.payer)), Math.max(0, Math.round(Number(b.costMicros) || 0)), Math.max(0, Math.round(Number(b.in) || 0)), Math.max(0, Math.round(Number(b.out) || 0))]

/** Merge receipts into a month doc (idempotent by receipt id). */
export function foldInto (doc, bodies) {
  const r = { ...((doc && doc.r) || {}) }
  for (const b of bodies) if (b && typeof b.id === 'string' && Number.isFinite(b.ts)) r[b.id] = row(b)
  return { v: 1, r }
}
/** A month doc → totals: costMicros overall and by payer, replies, tokens, and per day. */
export function usageTotals (doc) {
  const t = { costMicros: 0, replies: 0, in: 0, out: 0, byPayer: Object.fromEntries(PAYERS.map((p) => [p, 0])), byDay: {} }
  for (const v of Object.values((doc && doc.r) || {})) {
    if (!Array.isArray(v)) continue
    const [day, pi, cost, i, o] = v
    const payer = PAYERS[pi] || 'witbitz'
    t.costMicros += cost; t.replies++; t.in += i; t.out += o; t.byPayer[payer] += cost
    t.byDay[day] = (t.byDay[day] || 0) + cost
  }
  return t
}

export const HOLD_MS = 30 * 86400000 // receipts stay in their room this long after folding — the sidecar can be rebuilt from them
/** This device's read positions (device-local, safe to lose: re-reading is idempotent). `${keyId}|${room}` →
 *  { pos: next absolute position to read, pend: [[pos, ts], …] folded but not yet cleared }. */
export function cursorStore (ls = globalThis.localStorage, KEY = 'space:usagecur') {
  const all = () => { try { return JSON.parse(ls.getItem(KEY) || '{}') || {} } catch { return {} } }
  return {
    get: (k) => { const c = all()[k]; return c && Number.isInteger(c.pos) ? { pos: c.pos, pend: Array.isArray(c.pend) ? c.pend : [] } : null },
    set: (k, v) => { try { const a = all(); a[k] = v; ls.setItem(KEY, JSON.stringify(a)) } catch { /* private mode: we re-read next time */ } },
  }
}

/**
 * Collect: for each room, read this account's receipts from where this device stopped, open them, fold them into the
 * month docs, write, READ BACK, and move on only once the read-back shows every receipt. Receipts are CLEARED from the
 * room only HOLD_MS after they were sent, so the sidecar can be rebuilt from them for a month.
 * deps: { key, rooms, read(room, drop, since), ack(room, drop, upTo), readDoc(name) → doc | null when absent, THROWS when
 * unknown; writeDoc(name, doc), cursor (cursorStore()), now } → { folded, rooms, cleared }
 */
const READS_AT_ONCE = 8
// `pace` (optional, MUTABLE — read before every read): { atOnce, gapMs }. A run in the background reads a few at a time with a gap
// (e2e 2026-11-24: a fresh restore's first run read 400 Spaces × 5 usage keys, 8 at a time, and with the rest of the restore met the
// API route's shared limit — 429s, and a Space's first read held back); Your usage's open raises it to READS_AT_ONCE, no gap, even
// for a run already going.
export const PACE_FAST = Object.freeze({ atOnce: READS_AT_ONCE, gapMs: 0 })

export async function collectUsage ({ key, rooms, read, ack, readDoc, writeDoc, cursor = cursorStore(), now = Date.now(), holdMs = HOLD_MS, pace = PACE_FAST }) {
  if (!key || !Array.isArray(rooms)) return { folded: 0, rooms: 0, cleared: 0 }
  const perRoom = [] // { room, drop, ck, c, end, items:[{id,pos,ts}] }
  const byMonth = new Map()
  // The reads go out CONCURRENTLY (READS_AT_ONCE at a time): one at a time, ~200 Spaces kept "Your usage" on "Updating…"
  // for tens of seconds (the owner, 2026-10-09: "Your usage take too long. Why?"). They are then handled in the rooms'
  // order, exactly as before.
  const fetched = new Array(rooms.length)
  let next = 0
  const nap = (ms) => new Promise((res) => setTimeout(res, ms))
  const worker = async (w) => {
    while (next < rooms.length) {
      if (w >= Math.max(1, Number(pace.atOnce) || 1)) { await nap(200); continue } // a worker the pace does not use waits for it to rise
      const i = next++, room = rooms[i]
      const drop = await dropFor(key, room), ck = key.id + '|' + room
      const c = cursor.get(ck) || { pos: 0, pend: [] }
      let r = null
      try { r = await read(room, drop, c.pos) } catch { r = null }
      fetched[i] = { room, drop, ck, c, r }
      if (pace.gapMs > 0 && next < rooms.length) await nap(pace.gapMs)
    }
  }
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, rooms.length) }, (_, w) => worker(w)))
  for (const f of fetched) {
    if (!f) continue
    const { room, drop, ck, c, r } = f
    if (!r || r.status !== 200 || !Array.isArray(r.boxes)) continue
    const items = []
    for (let i = 0; i < r.boxes.length; i++) {
      let b = null
      try { b = JSON.parse(await openBox(JSON.parse(r.boxes[i]), key.priv)) } catch { b = null }
      if (!b || typeof b.id !== 'string' || !Number.isFinite(b.ts)) continue // not ours (or garbage): cleared with its neighbours, never counted
      items.push({ id: b.id, pos: (r.base || 0) + i, ts: b.ts })
      const m = monthOf(b.ts)
      if (!byMonth.has(m)) byMonth.set(m, [])
      byMonth.get(m).push(b)
    }
    perRoom.push({ room, drop, ck, c, end: r.end, items })
  }
  const confirmed = new Set()
  for (const [m, bodies] of byMonth) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let cur
      try { cur = await readDoc(docNameFor(m)) } catch { break } // UNKNOWN, not empty: a write REPLACES the doc, so writing now could erase the month — skip it; nothing moves on
      await writeDoc(docNameFor(m), foldInto(cur, bodies)).catch(() => null)
      const back = await readDoc(docNameFor(m)).catch(() => null)
      for (const b of bodies) if (back && back.r && back.r[b.id]) confirmed.add(b.id)
      if (bodies.every((b) => confirmed.has(b.id))) break
    }
  }
  let folded = 0, cleared = 0
  for (const p of perRoom) {
    if (!p.items.every((it) => confirmed.has(it.id))) continue // the next run reads them again from the same place
    folded += p.items.length
    const pend = [...p.c.pend, ...p.items.map((it) => [it.pos, it.ts])].sort((a, b) => a[0] - b[0]).slice(-1000)
    // Clear the OLD prefix only: everything up to the last receipt sent before the hold, with nothing newer before it.
    let upTo = 0, keep = pend
    for (let i = 0; i < pend.length && pend[i][1] <= now - holdMs; i++) { upTo = pend[i][0] + 1; keep = pend.slice(i + 1) }
    if (upTo) {
      try {
        const r = await ack(p.room, p.drop, upTo)
        if (r && r.status === 200) cleared += pend.length - keep.length
        else keep = pend // an HTTP refusal resolves normally; keep it pending just like a transport failure
      } catch { keep = pend }
    }
    const pos = Number.isInteger(p.end) ? p.end : p.c.pos
    if (pos !== p.c.pos || keep.length !== p.c.pend.length) cursor.set(p.ck, { pos, pend: keep }) // a quiet room costs no write
  }
  return { folded, rooms: perRoom.filter((p) => p.items.length).length, cleared }
}
