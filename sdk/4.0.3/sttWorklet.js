// sttWorklet.js — the microphone → 16 kHz mono PCM16 for press-to-talk's cloud engine (sttCloud.js), on the audio
// thread. Resamples from the context's own rate (a browser may refuse a 16 kHz AudioContext; iOS often runs at 48 kHz)
// by linear interpolation, and posts 100 ms frames plus their RMS level (which drives the honest "listening" bars).
class Pcm16k extends AudioWorkletProcessor {
  constructor () {
    super()
    this.ratio = sampleRate / 16000 // input samples per output sample
    this.pos = 0 // fractional read position into the carried input
    this.carry = new Float32Array(0)
    this.out = new Int16Array(1600) // 100 ms at 16 kHz
    this.n = 0
    this.sumSq = 0
  }

  process (inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    const buf = new Float32Array(this.carry.length + ch.length)
    buf.set(this.carry); buf.set(ch, this.carry.length)
    let p = this.pos
    while (p + 1 < buf.length) {
      const i = Math.floor(p), f = p - i
      const s = Math.max(-1, Math.min(1, buf[i] + (buf[i + 1] - buf[i]) * f))
      this.out[this.n++] = s < 0 ? s * 32768 : s * 32767
      this.sumSq += s * s
      if (this.n === this.out.length) {
        this.port.postMessage({ pcm: this.out.buffer.slice(0), rms: Math.sqrt(this.sumSq / this.n) })
        this.n = 0; this.sumSq = 0
      }
      p += this.ratio
    }
    const keep = Math.floor(p)
    this.carry = buf.slice(keep)
    this.pos = p - keep
    return true
  }
}
registerProcessor('pcm16k', Pcm16k)
