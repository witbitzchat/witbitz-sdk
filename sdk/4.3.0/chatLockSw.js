// chatLockSw.js — THE CHAT LOCK, WHAT THE SERVICE WORKER IS TOLD (docs/chat-lock-plan.md). A push for a locked Space shows only the
// generic line (sw-notif-core.js wbxChatLocked). The worker holds no account, so the page leaves it the locked Spaces' ids as SHA-256
// hashes under 'chatlocked:sw' (a name shared with the workers — idbSeal.js IDB_SHARED_NAMES), rewritten whenever the locks change.
export const CHAT_LOCKED_SW_KEY = 'chatlocked:sw'
export async function lockedRoomHash (room) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('chatlock|' + room)))
  return Array.from(d).map((b) => b.toString(16).padStart(2, '0')).join('')
}
/** Leave the worker the list for these rooms (a hidden room; an opened one too — its notices stay plain). */
export async function mirrorLockedRooms (rooms, idb) {
  const list = await Promise.all([...new Set(rooms)].map(lockedRoomHash))
  try { if (list.length) await idb.set(CHAT_LOCKED_SW_KEY, list.sort()); else await idb.del(CHAT_LOCKED_SW_KEY) } catch { /* the next change writes it */ }
}
