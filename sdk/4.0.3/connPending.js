// connPending.js — A CALL KEY WHOSE GRANT ANSWER WAS LOST (state machines pass 9, N#7), the rule both keepers use: the regular app's
// page (connections.js postWithPendingKey, connectionsSheet.js) and, in the hosted app, the VAULT, which mints and keeps the key
// itself (vaultConnKeys.js mint). A leaf: no DOM, no storage.

export const PENDING_MS = 86_400_000 // a day: older, the grant is taken as never filed

/** The pending keys the account's list now shows (and this keeper holds no key for) → adopt; older than a day → dropped. Pure. */
export function adoptPendingKeys (pending, listedIds, haveKeys, now = Date.now()) {
  const listed = new Set(listedIds || []), adopt = [], left = {}
  for (const [id, rec] of Object.entries(pending || {})) {
    if (!rec || typeof rec.callKey !== 'string' || !(now - (Number(rec.at) || 0) < PENDING_MS)) continue
    if (listed.has(id)) { if (!(haveKeys && haveKeys[id])) { const { at: _a, ...k } = rec; adopt.push([id, k]) } continue }
    left[id] = rec
  }
  return { adopt, pending: left }
}
