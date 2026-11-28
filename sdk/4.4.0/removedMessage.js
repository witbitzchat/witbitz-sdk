export const REMOVED_TEXT = 'Removed by Witbitz for breaking the Terms'
export const SHARED_REMOVED_TEXT = 'Removed in the shared Space'
/** Replacement, never a merge: no body, media, tool output or attachment references survive. */
export function removedCopy(e) {
  const { id, ts, name, from, self, verified, user, spk, vspk, sid } = e || {}
  return { id, ts, name, from, self, verified, user, spk, vspk, sid, ...(e?.keyOnly ? { keyOnly: true } : {}), kind: 'text', text: REMOVED_TEXT, removedByWitbitz: true }
}
export function sharedRemovedCopy(e) {
  const { id, ts, name, from, self } = e || {}
  return { id, ts, name, from, self, kind: 'text', source: 'shared', text: SHARED_REMOVED_TEXT, sourceRemoved: true }
}
