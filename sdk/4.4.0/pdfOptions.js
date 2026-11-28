// pdfOptions.js — THE OPTIONS EVERY pdf.js getDocument() IN THE APP TAKES (2026-10-26; the owner: "isEvalSupported: false
// everywhere we call pdf.js, as defense in depth" + "Update the bundled pdf.js to the server's version").
//
// • isEvalSupported: false — pdf.js can compile a font's glyph programs into JavaScript (`new Function`); that path is what
//   CVE-2024-4367 used to run a crafted PDF's script in the page. Our CSP has no 'unsafe-eval', so it is blocked today; this
//   keeps it off if the CSP ever changes. pdf.js then interprets the glyphs instead — the same pictures, a little slower.
// • wasmUrl — pdf.js 5 fetches its JPEG 2000 / JBIG2 / colour-profile decoders from here (pdfjs-wasm/, vendored with it);
//   relative to the PAGE, so a build in its own folder (/b/<build>/) finds its own copy. No URL → those images do not draw.
export function pdfOpts () {
  const o = { isEvalSupported: false }
  try { o.wasmUrl = new URL('pdfjs-wasm/', document.baseURI).href } catch { /* no document (a test): pdf.js does without */ }
  return o
}
