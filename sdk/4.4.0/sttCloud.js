// sttCloud.js — press-to-talk's CLOUD engine: the microphone streams to Tinfoil's confidential realtime enclave
// (Voxtral Mini 4B Realtime, Mistral) over a websocket, STRAIGHT from the page — our servers never see the audio.
//
// Measured 2026-10-03 (docs/stt-cloud.md): first words ~1.5–3 s into speech, the final text 0.44 s after release, English
// WER 4.5% on FLEURS (Whisper turbo 3.9%), $0.002 per CONNECTION whatever is said on it — so ONE connection is kept open
// across presses (commit on release) and closed after a quiet spell. ⚑ No Hebrew: the model's 13 languages do not
// include it (Hebrew speech comes back in Latin letters), by the owner's choice "leave Hebrew as today".
//
// The key: getKey() → { key, url, expiresAt } from op:'stt' (agent/sttKey.mjs) — short-lived, capped, minted for the
// signed-in account. A browser cannot set headers on a websocket, so the key rides as the `openai-insecure-api-key.`
// subprotocol, which Tinfoil's router accepts and does NOT echo back (measured: it negotiates plain "realtime").

// beside THIS module, whichever page (the room, Code's frame) imported it — addModule() resolves against the document otherwise
// THE ENDPOINT IS PINNED HERE, in the signed page — not taken from the server's answer. The key comes from op:'stt'; where the
// microphone goes does not: a compromised server could otherwise point the page at any host its CSP allows (our own relay
// included). Changing the endpoint is a page release, which the audit reproduces and the certificate signs.
export const STT_URL = 'wss://inference.tinfoil.sh/v1/realtime?model=voxtral-mini-4b-realtime&intent=transcription'
// …and before the microphone goes there, the page checks the key's evidence ITSELF (voiceAttest.js) — not only our server.
import { checkSpeechKey } from './voiceAttest.js'
// a module run from the vault's copy (a blob: URL; docs/hosted-app-plan.md step 8) has no address to resolve beside — the page's
const MODULE_BASE = String(import.meta.url).startsWith('blob:') ? location.href : import.meta.url
const WORKLET_URL = new URL('./sttWorklet.js', MODULE_BASE).href
const b64 = (ab) => { const u = new Uint8Array(ab); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s) }

/** One engine per app window (voiceInput.js keeps it on the shared engine, like the on-device one). */
export function createCloudStt ({ getKey, checkKey = checkSpeechKey, WebSocketImpl = globalThis.WebSocket, now = () => Date.now(), idleMs = 15 * 60_000, commitTimeoutMs = 10_000, connectTimeoutMs = 10_000 }) {
  let key = null, ws = null, connecting = null, idleTimer = 0
  let cur = null // the press in progress: { onPartial, text, cancelled, finish }
  let committing = null // the press whose release is waiting for its final text
  const queue = [] // frames captured while the connection was still opening — so the first words are not lost

  async function freshKey () {
    if (!key || Date.parse(key.expiresAt) - now() < 10 * 60_000) {
      const k = await getKey()
      if (!k || !k.key) throw new Error('no voice key')
      await checkKey(k) // throws voice_unattested: no socket is opened
      key = k
    }
    return key
  }
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)) }
  function scheduleIdle () { clearTimeout(idleTimer); idleTimer = setTimeout(() => close(), idleMs) }
  function close () {
    clearTimeout(idleTimer)
    const sock = ws; ws = null
    if (sock) { sock.onclose = null; sock.onmessage = null; try { sock.close() } catch { /* */ } }
    cur = null; committing = null; queue.length = 0
  }

  function connect () {
    if (ws && ws.readyState === 1) return Promise.resolve()
    if (connecting) return connecting
    connecting = (async () => {
      const k = await freshKey()
      const sock = new WebSocketImpl(STT_URL, ['realtime', 'openai-insecure-api-key.' + k.key])
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => { reject(new Error('the voice service did not answer')); try { sock.close() } catch { /* */ } }, connectTimeoutMs)
        sock.onopen = () => { clearTimeout(t); resolve() }
        sock.onerror = () => { clearTimeout(t); reject(new Error('could not reach the voice service')) }
        sock.onclose = (e) => { clearTimeout(t); reject(new Error('the voice service closed the connection (' + e.code + ')')) }
      })
      ws = sock
      ws.onmessage = (m) => { if (ws === sock) onEvent(m) } // a retired socket's late events reach no press
      ws.onclose = () => {
        if (ws !== sock) return
        ws = null
        if (cur && cur.finish) cur.finish(cur.text) // keep what streamed; the next press reconnects
        else if (cur && !cur.cancelled && cur.onError) cur.onError(new Error('speech connection closed during recording'))
      }
      ws.onerror = () => {}
      send({ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 16000 } } } } })
      while (queue.length) send({ type: 'input_audio_buffer.append', audio: queue.shift() })
    })()
    connecting.finally(() => { connecting = null }).catch(() => {})
    return connecting
  }

  // ★ A PRESS'S TEXT COMES ONLY FROM ITS OWN AUDIO (pass 5, V#12): the service's events carry no press id, so after a ✕ mid-press
  // or a release whose final text timed out, words still on their way from THAT audio landed in the next press on the same
  // connection. Such a connection is RETIRED — closed, its events ignored — and the next press opens a fresh one (one more
  // $0.002 connection, only in those two cases). A release still waiting when a new press begins keeps what had streamed.
  function retire () {
    const s = ws; ws = null
    if (s) { s.onmessage = null; s.onclose = null; try { s.close() } catch { /* */ } }
    const c = committing; committing = null
    if (c && c.finish) c.finish(c.text)
  }

  function onEvent (m) {
    let e; try { e = JSON.parse(m.data) } catch { return }
    if (!cur || cur.cancelled) return
    if (/transcription\.delta$/.test(e.type) && typeof e.delta === 'string') { cur.text += e.delta; cur.onPartial(cur.text) }
    else if (/transcription\.completed$/.test(e.type)) { if (cur.finish) cur.finish(typeof e.transcript === 'string' && e.transcript ? e.transcript : cur.text) }
    else if (e.type === 'error' && cur.finish && /commit_empty/.test(JSON.stringify(e))) cur.finish('') // released before any audio arrived
  }

  return {
    /** A press: start a turn (connection opens if needed — frames are queued meanwhile). */
    begin ({ onPartial, onError }) {
      clearTimeout(idleTimer)
      if (committing) retire() // the last release's final text is still on its way: it must not become this press's
      queue.length = 0
      cur = { onPartial: onPartial || (() => {}), onError, text: '', cancelled: false, finish: null }
      return connect()
    },
    /** One 100 ms PCM16 frame (ArrayBuffer) from the worklet. */
    append (pcm) {
      if (!cur || cur.cancelled) return
      const a = b64(pcm)
      if (ws && ws.readyState === 1) send({ type: 'input_audio_buffer.append', audio: a }); else if (queue.length < 600) queue.push(a) // ≤ 60 s queued
    },
    /** Release: commit and wait for the final text (or keep the streamed partial on timeout/close). → text */
    async commit () {
      if (!cur) return ''
      const c = cur
      committing = c
      const done = new Promise((resolve) => {
        const t = setTimeout(() => { c.finish = null; if (committing === c) retire(); resolve(c.text) }, commitTimeoutMs) // its final text may still come: not into the next press
        c.finish = (text) => { clearTimeout(t); c.finish = null; resolve(text) }
      })
      try { await connect() } catch { /* the queued audio is lost with the connection; what streamed is kept */ }
      if (ws && ws.readyState === 1) send({ type: 'input_audio_buffer.commit' }); else if (c.finish) c.finish(c.text)
      const text = await done
      if (committing === c) committing = null
      if (cur === c) cur = null
      scheduleIdle()
      return text
    },
    /** Cancel the press: drop its audio on the server too, keep the connection for the next one. */
    cancel () {
      const live = !!cur
      if (cur) cur.cancelled = true
      cur = null
      queue.length = 0
      send({ type: 'input_audio_buffer.clear' })
      if (live && ws) retire() // words of the cancelled audio may still be on their way (V#12)
      scheduleIdle()
    },
    close,
    get connected () { return !!(ws && ws.readyState === 1) },
  }
}

/** The microphone → 16 kHz PCM16 frames via the worklet. → { stop() } — stop() releases the audio graph (the caller
 *  owns the MediaStream and stops its tracks, as voiceInput.js already does for the on-device engine). */
export async function startCapture (stream, onFrame, { onError = () => {}, onDiagnostic = () => {}, stallMs = 5000 } = {}) {
  const AC = window.AudioContext || window.webkitAudioContext
  const ctx = new AC()
  const tracks = stream.getAudioTracks ? stream.getAudioTracks() : stream.getTracks()
  let src, node, timer, stopped = false, ready = false, resuming = false, lastFrame = Date.now()
  let mutedAt = tracks.some(tr => tr.muted) ? Date.now() : 0
  let resolveReady, rejectReady
  const firstFrame = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const trace = (text) => { try { onDiagnostic(text) } catch { /* */ } }
  const stop = () => {
    if (stopped) return
    stopped = true; clearInterval(timer)
    ctx.removeEventListener('statechange', stateChanged)
    for (const tr of tracks) {
      tr.removeEventListener('ended', ended)
      tr.removeEventListener('mute', muteChanged)
      tr.removeEventListener('unmute', muteChanged)
    }
    if (node) { node.port.onmessage = null; try { node.disconnect() } catch { /* */ } }
    try { src && src.disconnect() } catch { /* */ }
    try { Promise.resolve(ctx.close()).catch(() => {}) } catch { /* */ }
  }
  const fail = (error) => {
    if (stopped) return
    stop()
    if (!ready) rejectReady(error); else onError(error)
  }
  const resume = () => {
    if (stopped || resuming || ctx.state === 'running') return
    if (ctx.state === 'closed') { fail(new Error('microphone audio context closed')); return }
    resuming = true
    // WKWebView can interrupt an existing context. Resume when it changes state; the frame watchdog bounds a
    // resume() that never settles, or one that says "running" but produces no audio. Silence still produces frames.
    try { Promise.resolve(ctx.resume()).catch(fail).finally(() => { resuming = false }) } catch (e) { resuming = false; fail(e) }
  }
  function stateChanged () { trace('audio context ' + ctx.state); resume() }
  function ended () { fail(new Error('microphone track ended')) }
  function muteChanged () {
    const muted = tracks.some(tr => tr.muted)
    mutedAt = muted ? mutedAt || Date.now() : 0
    trace(muted ? 'microphone muted by system' : 'microphone unmuted')
    if (!muted) resume()
  }
  ctx.addEventListener('statechange', stateChanged)
  for (const tr of tracks) {
    tr.addEventListener('ended', ended)
    tr.addEventListener('mute', muteChanged)
    tr.addEventListener('unmute', muteChanged)
  }
  timer = setInterval(() => {
    if (mutedAt && Date.now() - mutedAt >= stallMs) fail(new Error('microphone stayed muted by system'))
    else if (Date.now() - lastFrame >= stallMs) fail(new Error('microphone stopped delivering audio (' + ctx.state + ')'))
  }, Math.min(500, stallMs))
  // Start audio activation before waiting for the worklet file. Do not swallow a failed resume and display a fake
  // recording state: startCapture resolves only after the first PCM frame really arrives.
  resume()
  ;(async () => {
    await ctx.audioWorklet.addModule(WORKLET_URL)
    if (stopped) return
    src = ctx.createMediaStreamSource(stream)
    node = new AudioWorkletNode(ctx, 'pcm16k', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    node.port.onmessage = (e) => {
      if (stopped) return
      lastFrame = Date.now()
      if (mutedAt) return // WebKit can keep delivering silence while iOS has muted the live microphone track.
      if (!ready) { ready = true; trace('first audio frame at ' + ctx.sampleRate + ' Hz'); resolveReady() }
      try { onFrame(e.data) } catch { /* */ }
    }
    src.connect(node)
    node.connect(ctx.destination) // output is silence; reaching the destination makes WebKit pull the graph
    if (tracks.some(tr => tr.readyState === 'ended')) ended()
  })().catch(fail)
  await firstFrame
  return { stop }
}
