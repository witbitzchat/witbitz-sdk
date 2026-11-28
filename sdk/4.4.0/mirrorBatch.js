// Leave room for the encrypted payload's base64 envelope and request metadata.
const BATCH_BYTES = 3_900_000
const encoder = new TextEncoder()
export function* mirrorBatches(entries) {
  let batch = [], bytes = 2
  for (const entry of entries) {
    const size = encoder.encode(JSON.stringify(entry)).length + 1
    if (batch.length && bytes + size > BATCH_BYTES) {
      yield batch
      batch = []; bytes = 2
    }
    batch.push(entry); bytes += size
  }
  if (batch.length) yield batch
}

// Sealed requests also carry an encrypted outer envelope. Send binary parts separately before committing the message.
export async function stageMirrorAttachments(entries, send) {
  if (encoder.encode(JSON.stringify(entries)).length < 2_100_000) return { entries }
  const prepared = []
  for (const entry of entries) {
    const copy = { ...entry }
    for (const field of ['images', 'files']) {
      if (!Array.isArray(entry[field])) continue
      copy[field] = []
      for (const attachment of entry[field]) {
        if (!attachment?.b64) { copy[field].push(attachment); continue }
        const { b64, ref, parts: oldParts, ...metadata } = attachment
        const data = b64.replace(/^data:[^,]*;base64,/, '')
        const parts = []
        let size = 0
        for (let offset = 0; offset < data.length; offset += 1_200_000) {
          const r = await send([{ kind: 'mirror-part', id: entry.id, mime: metadata.mime, b64: data.slice(offset, offset + 1_200_000) }])
          // ★ A SERVER FROM BEFORE `mirror-part` (the Space Lambda until its next deploy; the enclave until its next repin) drops the
          //   piece and answers 200 with nothing added and no `ref`. Returned as an error, the lane's mirror stopped at this batch for
          //   good — every later message of the Space too (second review, 2026-11-27). Send the batch whole, as before staging existed.
          if (r?.status === 200 && typeof r.ref !== 'string') return { entries }
          if (r?.status !== 200 || !Number.isInteger(r.size)) return { error: r?.status && r.status !== 200 ? r : { status: 503, error: 'mirror_part_unconfirmed' } }
          parts.push(r.ref); size += r.size
        }
        copy[field].push({ ...metadata, size, ...(parts.length === 1 ? { ref: parts[0] } : { parts }) })
      }
    }
    prepared.push(copy)
  }
  return { entries: prepared }
}
