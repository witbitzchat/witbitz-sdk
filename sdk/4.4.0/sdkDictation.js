// sdkDictation.js — wb.dictation(): press-to-talk for a builder's page, the same engine the Spaces app runs (sttCloud.js).
//
//   const mic = wb.dictation()
//   await mic.start({ onPartial: (t) => (input.value = t) })   // on press: asks for the mic, the words stream in
//   input.value = await mic.stop()                             // on release: the final text (~0.5 s)
//   mic.cancel()                                               // a press thrown away (its audio dropped server-side too)
//
// The microphone streams STRAIGHT from the page to Tinfoil's confidential realtime enclave (Voxtral Mini 4B Realtime) —
// never through Witbitz. Witbitz only mints the page a short-lived, capped key (op:'stt', agent/sttKey.mjs), and only for
// a signed-in person (wb.signIn) or a user the tenant's backend vouched for (wb.useUserToken). One connection is kept
// across presses and closed after 15 quiet minutes ($0.002 per connection, whatever is said on it). https://witbitz.chat/docs/sdk-assistant.md#dictation.
// ⚑ 13 languages, NOT Hebrew. ⚑ The page's own CSP must allow `connect-src wss://inference.tinfoil.sh` and the worklet
// script from this origin; the microphone needs a secure context and the browser's permission.

import { voicePayload } from './voiceCert.js'

const certifications = new WeakMap()
export function voiceForDictation(result, room) {
  const held = certifications.get(result)
  if (!held || held.room !== room) throw err('dictation_room_mismatch', 'use the dictation result from this room')
  return voicePayload(room, held.stt)
}

const err = (code, message) => Object.assign(new Error('witbitz: ' + message), { code })

export class Dictation {
  constructor(wb, { WebSocketImpl, getUserMedia } = {}) {
    this._wb = wb
    this._WS = WebSocketImpl
    this._gum = getUserMedia || ((c) => navigator.mediaDevices.getUserMedia(c))
    this._engine = null // sttCloud's engine, made on the first press
    this._mod = null
    this._stream = null
    this._capture = null
    this._live = false
  }

  /** true between start() and stop()/cancel(). */
  get listening() { return this._live }

  /** @private who the key is for: a signed-in session first (the person), else the tenant's user token. */
  async _who() {
    const wb = this._wb
    const sess = wb._session
    const idToken = sess && sess.idToken && !(sess.exp && sess.exp <= Date.now()) ? sess.idToken : ''
    let userToken = ''
    try { const t = typeof wb._userToken === 'function' ? await wb._userToken() : wb._userToken; userToken = typeof t === 'string' ? t : '' } catch { userToken = '' }
    if (!idToken && !userToken && !wb.vault) throw err('sign_in_required', 'dictation needs a signed-in user (wb.signIn) or a user token (wb.useUserToken)') // in a vault, the vault's sign-in mints the key
    return { idToken, userToken }
  }

  /** @private the page's key (op:'stt'). */
  async _key() {
    const epoch = this._payerEpoch
    const { idToken, userToken } = this._cloudRun?.auth || await this._who()
    const wb = this._wb
    const r = await wb._client.stt(idToken, userToken)
    if (epoch !== this._payerEpoch) throw err('account_changed', 'the voice payer changed')
    if (r && r.status === 200 && r.key) {
      this._stt = r.cert?.bundle ? { model: r.model, cert: structuredClone(r.cert), bundleGz: r.bundleGz } : null
      return r
    } // the endpoint itself is pinned in sttCloud.js, never taken from here
    const raw = (r && r.error) || 'stt_unavailable'
    const code = raw === 'signin_required' ? 'sign_in_required' : raw // the SDK's one spelling (sync sweep, 2026-10-10; the server says signin_required)
    throw err(code, code === 'sign_in_required' ? 'the sign-in or user token was refused — sign in again'
      : code === 'stt_rate_limited' ? `too many voice keys this hour — try again in ${(r && r.retryAfterS) || 60} s`
        : 'the voice service could not issue a key')
  }

  async _load() {
    if (!this._mod) this._mod = await import('./sttCloud.js')
    if (!this._engine) this._engine = this._mod.createCloudStt({ getKey: () => this._key(), ...(this._WS ? { WebSocketImpl: this._WS } : {}) })
    return this._engine
  }

  /** Begin a press. Resolves once the microphone is live and the connection is up (audio said meanwhile is queued).
   *  @param {{ onPartial?: (text:string)=>void, onLevel?: (rms:number)=>void }} [opts] */
  async start({ onPartial, onLevel, room, engine: choice = 'cloud' } = {}) {
    if (this._live) throw err('already_listening', 'dictation is already listening — stop() or cancel() first')
    if (choice === 'device') return this._startDevice(room, onPartial, onLevel)
    if (choice !== 'cloud') throw err('invalid_argument', 'choose cloud or device dictation')
    const run = { partial: '', error: null }
    this._cloudRun = run
    this._interrupted = null
    this._live = true
    this._room = typeof room === 'string' ? room : null
    const current = () => this._cloudRun === run
    const interrupted = error => {
      if (!current()) return
      run.error = error
      this.cancel()
      this._interrupted = { text: run.partial, room: this._room, stt: this._stt }
    }
    try {
      run.auth = await this._who()
      if (!current()) return
      const payer = run.auth.userToken || this._wb._session?.email || ''
      if (this._payer !== undefined && payer !== this._payer) {
        this._engine?.close(); this._engine = null; this._stt = null
      }
      this._payer = payer
      const engine = await this._load()
      if (!current()) return
      let stream
      try { stream = await this._gum({ audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true } }) }
      catch (e) { throw err('mic_denied', String(e?.message || e)) }
      if (!current()) { stream.getTracks().forEach(t => t.stop()); return }
      this._stream = stream
      const ready = engine.begin({ onPartial: text => {
        if (current()) { run.partial = text; try { onPartial?.(text) } catch {} }
      }, onError: interrupted })
      await Promise.all([ready, (async () => {
        const capture = await this._mod.startCapture(stream, ({ pcm, rms }) => {
          if (!current()) return
          engine.append(pcm)
          try { onLevel?.(rms) } catch {}
        }, { onError: interrupted })
        if (current()) this._capture = capture
        else capture.stop()
      })()])
    } catch (error) {
      if (!current() && !run.error) return
      if (current()) this.cancel()
      throw error?.code ? error : err('stt_unavailable', String(error?.message || error))
    }
  }

  async _startDevice(room, onPartial, onLevel) {
    const run = { committed: '', partial: '', transcriber: null }
    this._deviceRun = run; this._interrupted = null; this._live = true; this._room = room || null
    const text = () => [run.committed, run.partial].filter(Boolean).join(' ').trim()
    const update = () => { if (this._deviceRun === run) { try { onPartial?.(text()) } catch {} } }
    try {
      const M = await (this._deviceSdk ? this._deviceSdk() : import(new URL('/vendor/moonshine.web.mjs', globalThis.location.href).href))
      if (this._deviceRun !== run) return
      Object.assign(M.Settings.BASE_ASSET_PATH, { MOONSHINE: '/vendor/ms/', ONNX_RUNTIME: '/vendor/ms/ort/', SILERO_VAD: '/vendor/ms/vad/' })
      const t = new M.Transcriber('model/tiny', {
        onSpeechStart: () => { if (run.partial) { run.committed = text(); run.partial = '' } },
        onTranscriptionUpdated: value => { run.partial = value || ''; update() },
        onTranscriptionCommitted: value => { run.committed = [run.committed, value].filter(Boolean).join(' '); run.partial = ''; update() },
        onError: e => { run.error = e || new Error('voice model failed') },
      }, false)
      run.transcriber = t
      const stream = await this._gum({ audio: { channelCount: 1, echoCancellation: true, sampleRate: 16000 } })
      if (this._deviceRun !== run) { for (const track of stream.getTracks()) track.stop(); return }
      this._stream = stream
      t.attachStream(stream)
      await t.start()
      if (this._deviceRun !== run) { this._endDevice(run); return }
      if (onLevel && t.audioContext) {
        const ctx = t.audioContext
        const meter = ctx.createAnalyser()
        meter.fftSize = 256
        run.source = ctx.createMediaStreamSource(stream)
        run.source.connect(meter)
        const samples = new Float32Array(meter.fftSize)
        run.timer = setInterval(() => {
          meter.getFloatTimeDomainData(samples)
          let square = 0
          for (const sample of samples) square += sample * sample
          try { onLevel(Math.sqrt(square / samples.length)) } catch {}
        }, 50)
      }
    } catch (error) {
      if (this._deviceRun !== run) return
      this.cancel()
      throw err(/permission|denied|notallowed/i.test(String(error)) ? 'mic_denied' : 'stt_unavailable', String(error?.message || error))
    }
  }

  _endDevice(run) {
    const t = run.transcriber
    clearInterval(run.timer)
    try { run.source?.disconnect() } catch {}
    try { t?.stop() } catch {}
    try { const context = t?.audioContext; if (context && context.state !== 'closed') context.close().catch(() => {}) } catch {}
  }

  /** End the press. → the final text ('' if nothing was said). */
  async stop() {
    if (!this._live) { const interrupted = this._interrupted; this._interrupted = null; return interrupted?.text || '' }
    this._live = false
    this._cloudRun = null
    this._release()
    if (this._deviceRun) {
      const run = this._deviceRun; this._deviceRun = null
      this._endDevice(run)
      if (run.error) throw err('stt_unavailable', String(run.error.message || run.error))
      return [run.committed, run.partial].filter(Boolean).join(' ').trim()
    }
    return this._engine?.commit() || ''
  }

  /** Finish room-bound dictation and return the public certificate alongside the transcript. */
  async stopCertified() {
    if ((!this._live && !this._interrupted) || !this._room) throw err('dictation_room_required', 'start dictation with the destination room')
    const room = this._room, stt = this._deviceRun ? null : (this._interrupted?.stt || this._stt)
    const text = await this.stop()
    const result = Object.freeze({ text, room, certificate: stt?.cert ? structuredClone(stt.cert) : null })
    certifications.set(result, { room, stt })
    return result
  }

  /** Throw the press away. */
  cancel() {
    if (!this._live) return
    this._live = false
    this._cloudRun = null
    this._release()
    if (this._deviceRun) { const run = this._deviceRun; this._deviceRun = null; this._endDevice(run); return }
    try { this._engine.cancel() } catch { /* */ }
  }

  /** Close the connection now (otherwise it closes itself after 15 quiet minutes). */
  close() {
    this.cancel()
    try { this._engine && this._engine.close() } catch { /* */ }
  }

  _resetPayer() {
    this._payerEpoch = (this._payerEpoch || 0) + 1
    this.close()
    this._engine = null; this._stt = null; this._payer = undefined; this._interrupted = null
  }

  _release() {
    try { this._capture && this._capture.stop() } catch { /* */ }
    this._capture = null
    try { this._stream && this._stream.getTracks().forEach((t) => t.stop()) } catch { /* */ }
    this._stream = null
  }
}
