// The whole-account offline backup format (witbitz-spaces-<date>.json). Kept in its own module rather than inline in
// space.html so the OPACITY of the file is testable — spaces/test/offlineBundle.test.mjs asserts a built bundle
// carries no title, room id or message count.
//
// v1 wrote { room, title, count } in the CLEAR beside each sealed ledger. The file was handed to iCloud/Drive on the
// promise that it was unreadable ciphertext, and it was — except it announced every Space's name, id and size to
// anyone who opened it in a text editor. v2 seals that metadata under the SAME room key as the ledger it describes,
// using the ordinary e2ee envelope, so the offline decryptor (which already ports open()) recovers the real names
// the moment you load your keys file, and shows "Conversation N" until you do.
//
// Still visible by construction: HOW MANY conversations the bundle holds, and when it was exported. Hiding the count
// would mean padding the array with decoys — more cost than it buys for a personal backup, and the decoys would have
// to be indistinguishable to be worth anything.
import { seal, open } from './e2ee.js'

export const BUNDLE_KIND = 'witbitz-spaces-backup'
export const BUNDLE_VERSION = 2

// Seal one Space's descriptive metadata to its own room key. Same envelope as everything else in the product, so no
// new crypto reaches the decryptor.
export async function sealSpaceMeta(mk, meta) {
  if (!mk) throw new Error('sealSpaceMeta needs the room key')
  const m = meta || {}
  return seal(JSON.stringify({ title: m.title || '', room: m.room || '', count: m.count || 0 }), { room: mk })
}

// Recover metadata sealed by sealSpaceMeta. Fails CLOSED — a wrong key, a missing key or a tampered envelope all
// yield null rather than anything partial, so a caller can trial every key it holds and take the first hit.
export async function readSpaceMeta(env, mk) {
  if (!env || !mk) return null
  let txt = null
  try { txt = await open(env, { mk }) } catch { return null }
  if (txt == null) return null
  try {
    const m = JSON.parse(txt)
    return m && typeof m === 'object' ? m : null
  } catch { return null }
}

// The keys side of the backup, built once and used twice: downloaded as witbitz-keys-<date>.txt, and copied to the
// clipboard so it can be pasted straight into a password manager. The download alone meant fishing a .txt out of
// iOS Files and hoping Select All caught every line — the step people actually got wrong.
//
// The decryptor does not parse this; it regex-scans any pasted text for 40–64 char base64url runs. So the only hard
// requirement is that each key survives verbatim, which keeps the format free to stay human-readable.
export const KEYS_HEADER = 'Witbitz room keys — KEEP THIS SEPARATE from the sealed files.'

export function keysFileText(items) {
  const rows = (items || []).map((s) => `${s.title}\t${s.room}\t${s.key}`)
  return KEYS_HEADER + '\n\n' + (rows.length ? rows.join('\n') + '\n' : '')
}

// Assemble the file. Only `meta` and `ledger` survive per entry — anything else a caller passes is dropped rather
// than trusted, so a future field cannot leak into the bundle by accident.
export function makeBundle(spaces, exportedAt) {
  return {
    v: BUNDLE_VERSION,
    kind: BUNDLE_KIND,
    exportedAt: exportedAt || new Date().toISOString(),
    spaces: (spaces || []).map((s) => ({ meta: s.meta, ledger: s.ledger })),
  }
}
