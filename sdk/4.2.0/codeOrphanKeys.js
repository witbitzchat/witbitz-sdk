// codeOrphanKeys.js — COMPUTERS THAT HOLD CODING KEYS BUT ARE ON NO LIST (the owner, 2026-10-29: "Why does my laptop appear twice?"
// — a new laptop was refused "this account already codes on 3 computers (Laptop, Laptop (WSL), Laptop)", and only one
// "Laptop" was a computer the account still knew). The coding keys live per pairing at the control plane
// (control-plane/src/lib/codeKeys.mjs); a computer set up again without unpairing first is a NEW pairing, and the old one's
// keys stay live under the same name, counted against the account's computers (one free, three when invited). The Computers list is the account's registry, so
// its Remove could never reach them. The control plane has listed every computer with live keys all along
// (POST /v1/spaces/code-keys/list); this reads it and offers Remove for the ones the registry does not name.
export const CODE_KEYS_LIST = 'https://api.witbitz.chat/v1/spaces/code-keys/list'
export const CODE_KEYS_REVOKE = 'https://api.witbitz.chat/v1/spaces/code-keys/revoke'

/** The key rows whose computer is on none of `computers` (the registry's entries, by id). */
export function orphanKeyRows (rows, computers) {
  const known = new Set((computers || []).map((c) => c && c.id).filter(Boolean))
  return (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.computerId === 'string' && !known.has(r.computerId))
}

const post = async (fetchImpl, url, body) => {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => null)
  if (!r.ok) throw new Error((j && j.error && (j.error.message || j.error.code)) || 'HTTP ' + r.status)
  return (j && j.data) || {}
}

/** Every computer of the account with live coding keys: [{ keyId, computerId, name, createdAt }]. */
export async function listKeyComputers (token, fetchImpl = (...a) => fetch(...a)) {
  const d = await post(fetchImpl, CODE_KEYS_LIST, { idToken: token })
  return Array.isArray(d.computers) ? d.computers : []
}

/** Cancel one computer's coding keys (as removing a listed computer does, drawer.js revokeCodeKeys). → true when revoked. */
export async function revokeKeyComputer (token, computerId, fetchImpl = (...a) => fetch(...a)) {
  const d = await post(fetchImpl, CODE_KEYS_REVOKE, { idToken: token, computerId })
  return !!d.revoked
}

/** "added 12 Oct" — which of two same-named computers is the old one. */
export function addedOn (ms, now = Date.now()) {
  const t = Number(ms); if (!(t > 0)) return ''
  const d = new Date(t)
  const o = { day: 'numeric', month: 'short', ...(new Date(now).getFullYear() !== d.getFullYear() ? { year: 'numeric' } : {}) }
  try { return 'added ' + d.toLocaleDateString(undefined, o) } catch { return 'added ' + d.toISOString().slice(0, 10) }
}
