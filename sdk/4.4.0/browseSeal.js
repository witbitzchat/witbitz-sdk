// browseSeal.js — the envelope the agent's browser and the owner's phone share, and the only thing the relay ever
// carries (docs/cloud-computer.md § 12). ONE file, imported by both ends: the publisher inside the enclave
// (infra/cloud-computer/vm/browse-publisher.mjs, bundled) and the viewer page. A second implementation of a wire
// format is a second set of bugs, and this one has to agree byte for byte or nothing decodes.
//
// Why not e2ee.js's envelope: that one seals a STRING into a JSON object with a wrapped content key per recipient —
// right for a ledger entry, wrong for 249 binary frames a second, where base64 alone would add a third to the
// measured 267 KB/s. This is the same primitive (AES-256-GCM) with a fixed single recipient and no JSON at all:
//
//     [ 1 byte kind ][ 12 byte iv ][ ciphertext+tag ]
//
// The kind byte is INSIDE the ciphertext's associated data, so a frame cannot be replayed as a control message.
const enc = new TextEncoder()
const dec = new TextDecoder()

export const KIND_RFB = 1  // raw bytes of KasmVNC's own protocol, in either direction
export const KIND_CTL = 2  // JSON: the viewer taking the controls, and the publisher's answer
// The browser's SOUND, publisher → phone only: 20 ms of PCM, signed 16-bit little-endian, mono, 24 kHz (960 bytes).
// KasmVNC carries no audio (its server has no audio path; the Kasm desktops get theirs from a separate helper), so
// this is a second stream beside the screen. PCM rather than a codec on purpose for the first cut: nothing to decode
// on the phone but a ring buffer, and the publisher sends NOTHING while the browser is silent, so an idle screen
// costs no audio at all. ~384 kbit/s while sound plays; a codec (Opus) is the follow-up once that is measured.
export const KIND_AUDIO = 3
export const AUDIO_RATE = 24000
export const AUDIO_FRAME_MS = 20
// ONE FRAME of the screencast, publisher → viewer (docs/agent-browser-views.md, stage 1): a JPEG of the shown tab and a
// small JSON header saying what it is (its CSS size, its url). Packed as [2-byte header length][header][jpeg].
// A viewer from before stage 1 does not know this kind and ignores it (open() returns null) — which is what lets the
// publisher stream frames on a channel where an older viewer is still watching by KasmVNC.
export const KIND_FRAME = 4

export function packFrame (header, jpeg) {
  const h = enc.encode(JSON.stringify(header))
  if (h.length > 65535) throw new Error('frame header too large')
  const out = new Uint8Array(2 + h.length + jpeg.length)
  out[0] = h.length >> 8; out[1] = h.length & 255
  out.set(h, 2)
  out.set(jpeg, 2 + h.length)
  return out
}

/** → {header, jpeg} or null. */
export function unpackFrame (bytes) {
  if (!bytes || bytes.length < 2) return null
  const n = (bytes[0] << 8) | bytes[1]
  if (bytes.length < 2 + n) return null
  try { return { header: JSON.parse(dec.decode(bytes.subarray(2, 2 + n))), jpeg: bytes.subarray(2 + n) } } catch { return null }
}

/** The key as the bundle carries it (base64 of 32 bytes) → an AES-GCM key usable by both ends. */
export async function browseKey (b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  if (raw.length !== 32) throw new Error('browse key must be 32 bytes, got ' + raw.length)
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** The relay channel, derived from the key so the relay is told a hash and never the key. Same shape the browse
 *  room used in August (43 chars of base64url), because the relay's path regex already accepts exactly that. */
export async function channelFor (b64) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b64 + ':witbitz-browse-relay-v1')))
  let s = ''
  for (const b of h) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 43)
}

/** The relay channel of one FRAME STREAM — a mirror at one shape (docs/agent-browser-views.md, stage 2). Each stream
 *  has its own channel because the relay sends everything on a channel to everyone on it: a phone must not download
 *  the desktop stream to throw it away. Derived from the key like the main channel; the relay sees only a hash. */
export async function streamChannelFor (b64, stream) {
  if (!/^[a-z]{1,8}$/.test(stream)) throw new Error('bad stream name')
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b64 + ':witbitz-browse-stream-v1:' + stream)))
  let s = ''
  for (const b of h) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 43)
}

export async function seal (key, kind, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new Uint8Array([kind]) }, key, bytes))
  const out = new Uint8Array(1 + 12 + ct.length)
  out[0] = kind
  out.set(iv, 1)
  out.set(ct, 13)
  return out
}

/** → {kind, bytes} or null. Fail-closed and silent: anything that does not open under this key is not ours, which
 *  on a shared relay channel is an ordinary thing to receive, not an error to report. */
export async function open (key, buf) {
  try {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    if (b.length < 14) return null
    const kind = b[0]
    if (kind !== KIND_RFB && kind !== KIND_CTL && kind !== KIND_AUDIO && kind !== KIND_FRAME) return null
    const pt = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b.subarray(1, 13), additionalData: new Uint8Array([kind]) }, key, b.subarray(13)))
    return { kind, bytes: pt }
  } catch { return null }
}

export const sealCtl = async (key, obj) => seal(key, KIND_CTL, enc.encode(JSON.stringify(obj)))
export const readCtl = (bytes) => { try { return JSON.parse(dec.decode(bytes)) } catch { return null } }
