// safeMediaPins.js — WHICH tools-enclave builds may make a file safe (docs/safe-media.md § 4.3). A device draws a safe version
// only if its attestation names one of these images (PCR0) AND one of these safe-media tool blobs (register 20).
//
// EMPTY until the first tools-enclave release that carries safe_media: until then nothing verifies, and every photo or PDF
// in a Safe media room is the held card — never drawn on trust. A release adds its values here (infra/tools-enclave:
// make the image → PCR0; build-blobs.sh → registers.json safe_media.register), and keeps the old ones for as long as stored
// safe versions made by them should still be drawn (a statement is checked as of its own time, forever).
export const SAFE_MEDIA_PINS = Object.freeze({
  // tools enclave sm1 (2026-10-26, d7237d35) and rd1 (2026-11-07, 7fc8308c — read_doc; build enclave PASS, Rekor 3729370493):
  // each kernel built on the x86 build host, the safe_media blob by build-blobs.sh. sm1's copies stay drawable after rd1 serves.
  // rd2 (2026-11-13, 627fc06c — the base image with pass 9's E#3 supervisor; registers unchanged, safe_media still cafa891b).
  // ga1 (2026-11-17, 7e18e8e0f): the tools enclave on Graviton — the kernel built for arm64 (PCR0 d2ec214b), safe_media's canvas
  // arm64 (register 22a099e7). The x86 builds stay: their copies stay drawable.
  // trixie (2026-11-20, 2d93f0006): the tools enclave's base on Debian 13 — PCR0 fb52764f, safe_media's register unchanged
  pcr0: Object.freeze(['fb52764f784e50899285686bb3d9a4c90cf62681e6a61f8c81385843a85ed7add3b8e0782e6ce62b7de69b4a817ad7c2', 'd2ec214b4ef46d139e1c399629934579460284958e03a01abccde534a46c39b796a27e5725ae96c373c826f391f37e26', '761cd9c173630ebabc0ed1b311f7842f77aff950697d3e8c2d4b0a6d339fdae7cc2d9c1a9654c1cb7232a196d82212e7', '05dd1d2ef314348e32395a7d01fe72917e115c8e2cc7944e109a83dcfccbf6318baff9840d853080c5fc4abad2c6b326', 'f27fdc2247f0805df125e3fcdde0a9760434d4a02c6191a9b1b939e37036ce602d58f6d989617929dd101a5fabd98878']),
  register: Object.freeze(['22a099e721774a1ed89b6bf9f1980ffbbd62041179d002ea3f0a91e1a2737f4c1fb365aae52700b061b27b6dff354ad3', 'b34003b176af07e3021551d339285bc4f55bfc8aa631d00077496ded105edd582960552ec3ad4b3c9a636d38ee844950', 'cafa891b126afa78340d601d203252b67fc7bb756804feca7a882a59539c616950cebced5a326778828c2dee363c3f03']),
})
