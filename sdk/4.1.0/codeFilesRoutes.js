// codeFilesRoutes.js — the Files sheet's two routes and their limits, shared by the page (codeFiles.js) and the connector
// (tools/code-files.mjs), as codeOutputs.js shares OUTPUT_ROUTE. Both routes are the CONNECTOR's own: answered on the computer,
// never forwarded to OpenCode, so neither is on the relay's allowlist (codeRelay.js).
export const FILES_DOWNLOAD_ROUTE = '/witbitz/download' // GET ?session=&path=  → { name, kind, mime, size, mtime, b64 }
export const FILES_UPLOAD_ROUTE = '/witbitz/upload'     // POST ?session=  body { dir, name, b64, replace? } → { ok, name, path, size }
// One file's bytes, base64, in one relay message: the relay reassembles at most 32 MiB (codeRelay.js MAX_TOTAL), and base64
// is 4/3 of the bytes — so 20 MB, the same as a reply's file preview (tools/code-attachments.mjs MAX_SERVE_BYTES).
export const MAX_FILE_TRANSFER = 20 * 1024 * 1024

/** "report.pdf" taken → "report (2).pdf", then (3)… — Keep both, never overwriting. `taken(name)` says whether a name is used. */
export function keepBothName(name, taken) {
  const s = String(name || '')
  const dot = s.lastIndexOf('.')
  const base = dot > 0 ? s.slice(0, dot) : s, ext = dot > 0 ? s.slice(dot) : ''
  for (let n = 2; n < 1000; n++) { const c = `${base} (${n})${ext}`; if (!taken(c)) return c }
  return `${base} (${Date.now()})${ext}`
}
