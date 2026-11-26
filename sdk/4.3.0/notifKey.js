// spaces/public/notifKey.js — Phase-4 NOTIFICATION-ONLY KEY (NK).  See docs/spaces-vault-architecture.md §07.
//
// NK = HKDF(mk, "notif"): a one-way, limited-authority key the Service Worker may hold so a background push can show a
// MINIMAL message preview WITHOUT the room master. HKDF is one-way, so a stolen NK never yields mk or anything else in
// the key hierarchy — only the ability to open notif envelopes. The preview is sealed as its OWN tiny envelope to the
// single recipient slot { notif: NK } (e2ee.seal), so NK opens the preview and NOTHING else: it cannot open the room
// LEDGER, which is sealed to { room: mk } under a different wrap key. Because NK is a deterministic function of mk, it
// forks automatically when mk forks on a membership-epoch change — a removed member's NK simply stops matching.
//
// This is the CRYPTO CORE (increment 1). Wiring it onto the live post → store → pollsealed → SW path, and then deleting
// the plaintext `space:mk:*` / idb `mk:*` mirrors, is the follow-on (server + SW) step.
import { seal, open } from './e2ee.js'

const enc = new TextEncoder()
const b64 = (u8) => { const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const ub64 = (str) => { let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - (s.length % 4)) % 4); const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o }

const PREVIEW_MAX = 140

/** NK = HKDF(mk, info="notif") → base64url 32-byte key. One-way (NK ↛ mk) and deterministic, so it forks with mk on a
 *  membership-epoch change. Throws on a missing/invalid mk (fail-closed — never seal to an empty key). */
export async function deriveNotifKey(mk) {
  if (!mk || typeof mk !== 'string') throw new Error('deriveNotifKey needs the room mk')
  const ikm = await crypto.subtle.importKey('raw', ub64(mk), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('notif') }, ikm, 256)
  return b64(new Uint8Array(bits))
}

/** Seal ONE entry's minimal preview under NK only. `mk` is used solely to DERIVE NK — it is not a recipient, so the
 *  envelope is bound to NK: NK opens it, mk-scoped keys do not, and NK cannot open anything else. The preview is capped
 *  and Markdown-stripped so the sealed field carries a one-line banner and nothing more. */
export async function sealNotif(mk, { who, preview, at } = {}) {
  const nk = await deriveNotifKey(mk)
  const body = JSON.stringify({
    who: String(who || '').slice(0, 80),
    preview: String(preview || '').replace(/[#*`>]/g, '').trim().slice(0, PREVIEW_MAX),
    at: Number(at) || 0,
  })
  return seal(body, { notif: nk })
}

/** Open a notif envelope with NK (the Service-Worker path — NO mk). Returns { who, preview, at } or null (fail-closed on
 *  wrong key / tamper / malformed). */
export async function openNotif(nk, env) {
  if (!nk || !env) return null
  const pt = await open(env, { mk: nk }) // open() tries the key against every slot; NK matches the single `notif` slot
  if (pt == null) return null
  try {
    const o = JSON.parse(pt)
    return { who: String(o.who || ''), preview: String(o.preview || ''), at: Number(o.at) || 0 }
  } catch { return null }
}

/** Transition helper: derive NK from mk and open. Used only where a caller still holds mk; the end-state SW holds NK
 *  directly and calls openNotif. */
export async function openNotifWithMk(mk, env) {
  try { return await openNotif(await deriveNotifKey(mk), env) } catch { return null }
}
