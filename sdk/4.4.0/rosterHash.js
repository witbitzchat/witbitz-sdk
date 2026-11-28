// Client twin of agent/rosterHash.mjs — a room-bound salted hash of a roster identity (an email), ported from
// kibitz/src/core/rosterHash.ts. Used at CREATE time to hash the email allow-list before it's sealed into the config,
// so co-members can't read each other's addresses; the server-side gate hashes the verified email the same way and
// checks membership. Output MUST be byte-identical to the server twin (same NFKC→trim→lowercase, SHA-256, base64url).
const enc = new TextEncoder()
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const norm = (s) => String(s == null ? '' : s).normalize('NFKC').trim().toLowerCase()

/** base64url(SHA-256(`norm(identity)|roomSalt`)); roomSalt (the room id) appended raw — matches kibitz + the server. */
export async function memberHash(identity, roomSalt) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${norm(identity)}|${roomSalt}`))
  return b64url(digest)
}
