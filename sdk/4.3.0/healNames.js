// spaces/public/healNames.js — a Space listed as "Space" gets its own name back (spaces/test/healNames.test.mjs).
// The owner, 2026-10-10: "In my account I now have many space rooms" → one of them (sp-2t5k…, Arizona with Liat, 4
// messages from 1 August) is a real conversation whose ROOM still holds its name ("Interesting Places In Arizona", its
// title doc) while the account's list row says "Space". Rows reach a list without a name when another device pushes
// them in (the account-switch merge, 755a57ee) or adopts them from an index entry that carried none (roomSync: no title
// → 'Space'); nothing ever asked the room again, because a room's name is read only when it is OPENED (readSealedTitle).
//
// This asks each such room once per session, in the background (two at a time), the same way the open room is asked:
// its newest title entry, else its title doc. The name lands in the list (and, through the list, on every device);
// a name set by hand stays marked as one. Nothing is deleted, and a row someone renamed is never touched.

let _h = {
  rows: () => [],                  // → this device's list (recents): [{ room, title, renamed }]
  read: async () => null,          // (room) → { entries, doc } — the room's log and its `title` state doc (either may be null)
  apply: () => {},                 // (room, title, manual) → write it to the list
  latestTitle: () => null,         // roomName.latestTitle
  titleFromDoc: () => null,        // roomName.titleFromDoc
}
export const setHealNamesHooks = (h) => { _h = { ..._h, ...h } }

const asked = new Set() // once per session per room
export const isUnnamed = (r) => !!r && !!r.room && !r.renamed && !String(r.room).startsWith('tmp-') && (!r.title || r.title === 'Space' || r.title === r.room)

/** → how many rows got their name back. */
export async function healNames(hooks = _h, visited = asked) {
  const todo = (hooks.rows() || []).filter((r) => isUnnamed(r) && !visited.has(r.room))
  let healed = 0, i = 0
  const worker = async () => {
    while (i < todo.length) {
      const r = todo[i++]
      visited.add(r.room)
      let v = null
      try { v = await hooks.read(r.room) } catch { v = null }
      if (!v) continue
      const t = hooks.latestTitle(v.entries || [])
      const d = !t && v.doc ? hooks.titleFromDoc(v.doc) : null
      const name = (t && t.title) || (d && d.title)
      if (!name || name === 'Space') continue
      try { if (hooks.apply(r.room, name, !!((t && t.manual) || (d && d.manual))) !== false) healed++ } catch { /* the row keeps its name */ }
    }
  }
  await Promise.all([worker(), worker()])
  return healed
}
export const _resetHealNames = () => asked.clear() // tests
