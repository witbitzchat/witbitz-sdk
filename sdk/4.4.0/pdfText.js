// pdfText — a PDF's readable text, extracted IN THE BROWSER with our own vendored pdf.js.
//
// ★ Why this exists. MEASURED against TrustedRouter (2026-09-12): a PDF cannot traverse its chat-completions
//   surface. opencode sends the standard OpenAI file part — {type:'file',file:{filename,file_data}} — and TR answers
//   502 `provider error` for EVERY model, with and without cache_control, data: URL or bare base64. The identical PDF
//   read perfectly through TR's /v1/messages (Anthropic-native `document` block), so the gap is the TRANSPORT, not
//   the models. Extracting the text ourselves makes a PDF answerable on all 18 models instead of none, and it is the
//   same thing agent/fileText.mjs already does server-side.
//
// ★ The item-join is the whole trick, and it was learned the hard way (see fileText.mjs): pdf.js splits a line into
//   PER-WORD items. Concatenating them — which is what unpdf's merged extractText does — runs the words together,
//   and in Hebrew that produces one unreadable string. Joining with a space restores the word boundaries.
// ★ …but not with a BLANKET space (the owner's Witbitz_Overview_2.pdf, 2026-09-13: "AI a ge nts a r e on l y",
//   "T R U S T E D I N F R A S T R U C T U R E"). Dumped from this vendored pdf.js in Chromium: a word can arrive in
//   TOUCHING pieces ("a" ends at 90.9, "ge" starts at 90.4) with the real spaces as their own " " items, and a
//   letter-spaced heading arrives with pdf.js's spaces INSIDE the string ("T R U S T E D") and the word gap as a " " item
//   1.2× the font size wide. So the join reads the positions: a space where the PDF has one or the gap is a word's,
//   nothing between touching pieces, and a letter-spaced line is read as words. Items without positions (and items out
//   of reading order) keep the plain space join.
//
// Keyless and local: the bytes never leave the page except as the text the model is asked about.

import { pdfOpts } from './pdfOptions.js' // isEvalSupported: false + the decoders' folder
let _lib = null
/** The vendored pdf.js, loaded ONLY when a PDF is actually attached (it is large). Same module fileViewer.js uses. */
async function defaultLib() {
  if (_lib) return _lib
  const lib = await import('./pdfjs.mjs')
  // against THIS module (the SDK on a builder's page loads it from Witbitz's address — d3d0526fb), except where the module runs from
  // a blob: (the hosted app's code from the vault): nothing resolves against a blob:, so against the page, as sttCloud.js does
  const base = String(import.meta.url).startsWith('blob:') ? location.href : import.meta.url
  try { lib.GlobalWorkerOptions.workerSrc = new URL('./pdfjs.worker.mjs', base).href } catch { /* falls back to main-thread parsing */ }
  _lib = lib
  return lib
}

export const PDF_TEXT_MAX = 60_000 // matches agent/fileText.mjs — a big document is truncated, never the file

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{text: string, pages: number, truncated: boolean}>}
 */
export async function pdfToText(bytes, { maxChars = PDF_TEXT_MAX, getLib = defaultLib } = {}) {
  const lib = await getLib()
  const doc = await lib.getDocument({ data: bytes, ...pdfOpts() }).promise
  const out = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    const lines = [[]]
    for (const it of tc.items) { lines[lines.length - 1].push(it); if (it.hasEOL) lines.push([]) }
    const s = lines.map(joinLine).join('\n')
    out.push(s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim())
  }
  const text = out.filter(Boolean).join('\n\n')
  return { text: text.slice(0, maxChars), pages: doc.numPages, truncated: text.length > maxChars }
}

const hasGeo = (it) => Array.isArray(it.transform) && it.transform.length >= 6 && typeof it.width === 'number'
const sizeOf = (it) => (hasGeo(it) && Math.abs(it.transform[3])) || it.height || 0
const LETTER_RUN = /^\S( \S)+$/ // "T R U S T E D": pdf.js's own spaces between the letters of a tracked heading
/** The gap from one item to the next, in reading order (null when either has no position). */
function gapBetween(a, b) {
  if (!hasGeo(a) || !hasGeo(b)) return null
  return a.dir === 'rtl' || b.dir === 'rtl' ? a.transform[4] - (b.transform[4] + b.width) : b.transform[4] - (a.transform[4] + a.width)
}
/** One line's items → its text (see the header for what the positions are used for). */
function joinLine(items) {
  const words = items.filter((it) => (it.str || '').trim())
  if (!words.length) return ''
  const geo = words.every(hasGeo)
  // letter-spaced: every piece is one character or a run of spaced letters, and there are a few of them
  const letters = words.reduce((n, it) => n + it.str.trim().split(/\s+/).length, 0)
  const spaced = geo && (letters >= 3 || words.some((it) => LETTER_RUN.test(it.str.trim()))) && words.every((it) => [...it.str.trim()].length === 1 || LETTER_RUN.test(it.str.trim()))
  let s = '', prev = null, spaceItem = false
  for (const it of items) {
    const str = it.str || ''
    if (!str.trim()) { if (str) spaceItem = true; continue }
    if (prev) {
      const gap = gapBetween(prev, it), size = Math.max(sizeOf(prev), sizeOf(it)) || 1
      if (spaced) s += gap >= 0.6 * size ? ' ' : ''
      else if (gap == null || gap < -size) s += ' ' // no positions, or out of reading order: the plain join
      else s += spaceItem || gap > 0.15 * size ? ' ' : ''
    }
    s += spaced ? str.trim().replace(/ /g, '') : str
    prev = it; spaceItem = false
  }
  return s
}

/** The extracted text as the model should SEE it: named, page-counted, and honest about truncation. */
export function pdfTextBlock({ name = 'document.pdf', text = '', pages = 0, truncated = false }) {
  const head = `--- ${name} (PDF, ${pages} page${pages === 1 ? '' : 's'}, text extracted in the browser` +
    `${truncated ? `, TRUNCATED to the first ${PDF_TEXT_MAX} characters` : ''}) ---`
  return `${head}\n${text}\n--- end of ${name} ---`
}

/**
 * A message that carries extracted PDFs → what was typed, and the PDFs by name. The transcript shows the typed text and a
 * chip per PDF instead of the whole extracted text (the model still gets all of it). Anything else is left as it is.
 */
export function splitPdfBlocks(message) {
  const pdfs = []
  const text = String(message || '').replace(/(^|\n\n)--- (.+?) \(PDF, (\d+) pages?, text extracted in the browser(, TRUNCATED to the first \d+ characters)?\) ---\n[\s\S]*?\n--- end of \2 ---/g,
    (m, lead, name, pages, truncated) => { pdfs.push({ name, pages: Number(pages), truncated: !!truncated }); return '' })
  return { text: pdfs.length ? text.trim() : String(message || ''), pdfs }
}
