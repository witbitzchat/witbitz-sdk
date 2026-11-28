// vaultSealedStore.js — the BUILDERS' vault (vault-core.js) keeps its other secrets sealed on disk too, as our hosted vault does
// (protectedLocal.js, sealed by default since 2026-11-16). The owner, 2026-11-24: "Yes" to "bring the builders' vault to our rule".
//
// vaultAtRest.js seals the room list's keys and the backup state. The rest of `wbvault:*` was written clear: the sign-in session,
// the invite box's PRIVATE key, the Siri key, outside agents' tokens, the connections' call keys (and those still being granted),
// and the merged view that carries them across devices. A copy of this origin's localStorage alone handed them over.
//
// `sealedStorage(raw, names)` is a Storage with the same three calls the vault uses (getItem / setItem / removeItem). For a name
// in `names`, once `open(key)` ran: what is read comes from memory (opened at start), what is written is kept in memory at once and
// sealed to disk in the order written (`flushed()` resolves once it is there). Every other name passes through untouched.
//   · Read-through, never destructive: a clear value an older vault wrote is read as it is and written back sealed; an entry no key
//     here opens reads as absent and is KEPT on disk — moved aside to `<name>:unopened` before anything is written over it.
//   · No key (no IndexedDB this launch): everything passes through as before — a secret is never lost for want of a seal. The
//     vault refuses to start keyless over sealed data (vaultAtRest.holdsSealed, given these names).
//   · Another tab's write: `refresh(name)` re-reads that name from disk (the vault's `storage` listener calls it first).
// Under the same key as the room list (deviceWrapKey: non-extractable, in this origin's IndexedDB) — so, like it, a copy of the whole
// browser profile still opens it; the person's passkey lock (vaultCoreLock.js) is the answer to that.
import { seal, open as openSealed, isSealed } from './deviceSeal.js'

const parse = (s) => { try { return JSON.parse(s) } catch { return undefined } }

export function sealedStorage (raw, names) {
  const sealedNames = new Set(names)
  const mem = new Map() // name → the clear string, as setItem got it
  const unopened = new Set() // names whose disk value no key here opens (kept as it is)
  let key = null
  let chain = Promise.resolve()
  const onDisk = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p }
  const ours = (n) => key && sealedNames.has(String(n))

  async function load (n) {
    let v = null; try { v = raw.getItem(n) } catch { v = null }
    mem.delete(n); unopened.delete(n)
    if (v == null) return false
    const blob = parse(v)
    if (!isSealed(blob)) { mem.set(n, v); return true } // an older vault's clear value: read as it is (open() writes it back sealed)
    try { const s = await openSealed(key, blob); if (typeof s === 'string') mem.set(n, s); else unopened.add(n) } catch { unopened.add(n) }
    return false
  }
  function putSealed (n, s) {
    return onDisk(async () => {
      if (unopened.has(n)) { // another key's entry is never written over and lost
        try { const was = raw.getItem(n); if (was != null) raw.setItem(n + ':unopened', was) } catch { /* */ }
        unopened.delete(n)
      }
      if (s == null) { try { raw.removeItem(n) } catch { /* */ } return }
      const blob = await seal(key, s)
      if (mem.get(n) !== s) return // written again meanwhile: the later write is queued behind this one
      try { raw.setItem(n, JSON.stringify(blob)) } catch { /* a full or blocked store: memory holds it this session */ }
    })
  }

  return {
    /** Start sealing under `k` (null: pass everything through, as before). Opens every sealed name; seals the clear ones. */
    async open (k) {
      key = k || null
      if (!key) return
      for (const n of sealedNames) if (await load(n)) putSealed(n, mem.get(n))
      await chain
    },
    getItem (n) { if (!ours(n)) return raw.getItem(n); return mem.has(n) ? mem.get(n) : null },
    setItem (n, v) { if (!ours(n)) return raw.setItem(n, v); const s = String(v); mem.set(n, s); putSealed(n, s) },
    removeItem (n) { if (!ours(n)) return raw.removeItem(n); mem.delete(n); putSealed(n, null) },
    /** Another tab wrote `n`: read it again from disk (after this tab's own writes). */
    refresh (n) { return ours(n) ? onDisk(() => load(n)) : Promise.resolve() },
    /** Resolves once every write made so far is on disk. */
    flushed: () => chain,
    async durableItem (n) {
      await chain
      const value = raw.getItem(n), blob = parse(value)
      return ours(n) && isSealed(blob) ? openSealed(key, blob) : value
    },
    /** Whether any of `names` holds a sealed value on disk (a keyless start must not run over it). */
    holdsSealed: () => [...sealedNames].some((n) => { try { return isSealed(parse(raw.getItem(n))) } catch { return false } }),
    get raw () { return raw },
  }
}
