// speechOut.js — text read aloud (the Spaces app's "Play aloud" on a bubble, and the SDK's wb.speak()): the bubble's text read by Tinfoil's attested speech model, billed to the account's
// OWN capped key, exactly like press-to-talk the other way round (agent/sttKey.mjs § SPEECH OUTPUT; docs/stt-cloud.md §
// Speech output). The page POSTs the text STRAIGHT to the attested host and plays what comes back; our servers see
// neither the text nor the audio.
//
// Measured 2026-10-03: voxtral-tts bills $0.002 PER REQUEST whatever the length; a sentence answers in ~1.8 s, 1,500
// characters in ONE request take 15 s and arrive all at once. So a long message is cut into chunks at sentence ends — a
// SHORT first chunk for a quick first sound, larger ones after — and each chunk is fetched one ahead while the previous
// plays. A paragraph-long bubble is 2–4 requests, under a cent.
//
// ⚑ Neither speech model has Hebrew (their own transcriber hears a stuck syllable / mangled words back). Hebrew-dominant
//    text is REFUSED with `no_hebrew` before any spend, so the person gets a sentence instead of gibberish and a charge.
//
// One module for both: the app's ttsPlay.js adds its surface stamp, the SDK's sdkSpeech.js its own key (sdk-assistant.md#speak).

// THE ENDPOINT IS PINNED HERE, as press-to-talk's (sttCloud.js STT_URL): the key comes from op:'tts', where the TEXT goes does
// not — the answer's `url` is ignored. And the page checks the key's evidence itself before any text goes (voiceAttest.js).
import { checkSpeechKey } from './voiceAttest.js'
export const TTS_URL = 'https://inference.tinfoil.sh/v1/audio/speech'

export const FIRST_CHUNK = 240 // characters: a quick first sound (~2 s)
export const CHUNK = 900 // characters: the later chunks (~8 s of generation each, fetched while the previous plays)
const KEY_SLACK_MS = 10 * 60_000 // ask for a new key this long before the old one expires (as sttCloud does)

// Split at sentence ends (., !, ?, Hebrew/Arabic full stops, newlines), the first piece short, the rest up to CHUNK; a
// sentence longer than a chunk is split at a space. Markdown is read as text: code fences and headings lose their marks.
export function chunkText (text, { first = FIRST_CHUNK, max = CHUNK } = {}) {
  const t = String(text || '').replace(/```[\s\S]*?```/g, ' code block ').replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim()
  if (!t) return []
  const sentences = t.match(/[^.!?؟。\n]+[.!?؟。]*\s*/g) || [t]
  const out = []; let cur = ''
  const limit = () => (out.length === 0 ? first : max)
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = '' }
  for (let s of sentences) {
    while (s.length > limit()) { // a run-on sentence: cut at the last space before the limit
      const room = limit() - cur.length
      if (room < 40) { push(); continue }
      const cut = s.lastIndexOf(' ', room); const at = cut > 20 ? cut : room
      cur += s.slice(0, at); push(); s = s.slice(at).trimStart()
    }
    if (cur && cur.length + s.length > limit()) push()
    cur += s
  }
  push()
  return out
}

// Hebrew-dominant? (letters only: a Hebrew message with Latin product names is still Hebrew; an English message quoting a
// Hebrew word is still English.)
export function isHebrew (text) {
  const he = (String(text || '').match(/[֐-׿]/g) || []).length
  const latin = (String(text || '').match(/[A-Za-z]/g) || []).length
  return he > 0 && he >= latin
}

/** createTtsPlayer({ getKey, fetchImpl, AudioImpl, now, URLImpl }) → { play(text), stop(), playing }.
 *  getKey() → { key, model, voice, expiresAt, cert, bundleGz } from op:'tts' (its `url` is not used: TTS_URL). play() resolves when the whole text has played (or
 *  rejects: `no_hebrew`, `empty`, a fetch/HTTP failure); stop() ends playback and aborts fetches in flight. */
export function createTtsPlayer ({ getKey, checkKey = checkSpeechKey, fetchImpl = (...a) => globalThis.fetch(...a), AudioImpl = globalThis.Audio, now = () => Date.now(), URLImpl = globalThis.URL } = {}) {
  let keyEpoch = 0, key = null, session = 0, audio = null, ctrl = null
  const self = { playing: false }
  const freshKey = async () => { if (!key || Date.parse(key.expiresAt) - now() < KEY_SLACK_MS) { const epoch = keyEpoch; const k = await getKey(); await checkKey(k); if (epoch !== keyEpoch) throw new Error('speech payer changed'); key = k } return key } // checkKey throws voice_unattested: no text is sent
  const fetchChunk = async (text, k, signal) => {
    const r = await fetchImpl(TTS_URL, { method: 'POST', headers: { authorization: 'Bearer ' + k.key, 'content-type': 'application/json' }, body: JSON.stringify({ model: k.model, input: text, ...(k.voice ? { voice: k.voice } : {}), response_format: 'mp3' }), signal })
    if (!r.ok) { if (r.status === 401 || r.status === 402 || r.status === 403) key = null; throw Object.assign(new Error('speech ' + r.status), { code: 'http_' + r.status }) }
    return r.blob()
  }
  const playBlob = (blob, signal) => new Promise((resolve, reject) => {
    const url = URLImpl.createObjectURL(blob)
    const a = new AudioImpl(url); audio = a
    const done = (err) => { try { URLImpl.revokeObjectURL(url) } catch { /* */ } if (audio === a) audio = null; err ? reject(err) : resolve() }
    a.onended = () => done(); a.onerror = () => done(Object.assign(new Error('audio failed'), { code: 'audio' }))
    if (signal) signal.addEventListener('abort', () => { try { a.pause() } catch { /* */ } done(Object.assign(new Error('stopped'), { code: 'stopped' })) }, { once: true })
    Promise.resolve(a.play()).catch((e) => done(Object.assign(e || new Error('play refused'), { code: 'play' })))
  })
  self.stop = () => { session++; self.playing = false; try { ctrl && ctrl.abort() } catch { /* */ } ctrl = null; try { audio && audio.pause() } catch { /* */ } audio = null }
  self.resetKey = () => { keyEpoch++; key = null; self.stop() }
  self.play = async (text) => {
    self.stop()
    if (isHebrew(text)) throw Object.assign(new Error('Hebrew is not supported by the speech model'), { code: 'no_hebrew' })
    const chunks = chunkText(text)
    if (!chunks.length) throw Object.assign(new Error('nothing to read'), { code: 'empty' })
    const mine = ++session; ctrl = new AbortController(); const signal = ctrl.signal
    self.playing = true
    try {
      const k = await freshKey()
      if (session !== mine) return
      let next = fetchChunk(chunks[0], k, signal)
      for (let i = 0; i < chunks.length; i++) {
        const blob = await next
        if (session !== mine) return
        next = i + 1 < chunks.length ? fetchChunk(chunks[i + 1], k, signal) : null // one ahead, while this one plays
        if (next) next.catch(() => {}) // judged when awaited; never an unhandled rejection
        await playBlob(blob, signal)
        if (session !== mine) return
      }
    } catch (e) {
      if (session === mine && e && e.code !== 'stopped') throw e
    } finally { if (session === mine) { self.playing = false; ctrl = null } }
  }
  return self
}
