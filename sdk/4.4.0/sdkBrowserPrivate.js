import { browseKey, channelFor, sealCtl, open, readCtl, KIND_CTL } from './browseSeal.js'
import { RELAY_URL } from './codeRelay.js'

const fail = (code, message) => Object.assign(new Error('witbitz: ' + message), { code })
/** The owner's existing encrypted browser control channel; resolves only after the publisher reports the requested state. */
export async function setSessionPrivate(cloud, session, on, { WebSocket: Socket = globalThis.WebSocket, timeoutMs = 10_000 } = {}) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(session || '')) || typeof on !== 'boolean') throw fail('invalid_argument', 'private browsing needs a session id and a boolean')
  if (!cloud || !cloud.browse || !Socket) throw fail('not_supported', 'this computer has no browser control channel')
  const key = await browseKey(cloud.browse), channel = await channelFor(cloud.browse)
  const relay = new URL(cloud.relay || RELAY_URL)
  if (!['ws:', 'wss:'].includes(relay.protocol)) throw fail('invalid_argument', 'the browser relay must use WebSocket')
  return new Promise((resolve, reject) => {
    let ws, done = false, sent = false
    const finish = (e) => { if (done) return; done = true; clearTimeout(timer); if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; try { ws.close() } catch {} } e ? reject(e) : resolve(true) }
    const timer = setTimeout(() => finish(fail('timeout', 'the browser did not confirm session privacy; its state is unknown')), timeoutMs)
    try {
      ws = new Socket(relay.href.replace(/\/$/, '') + '/c/' + channel)
      ws.binaryType = 'arraybuffer'
      ws.onopen = async () => { try { const msg = await sealCtl(key, { wb: 'private', session, on }); if (!done) { sent = true; ws.send(msg) } } catch { finish(fail('offline', 'the browser control channel failed')) } }
      ws.onmessage = async (event) => {
        if (!sent || done) return
        const msg = await open(key, event.data), ctl = msg && msg.kind === KIND_CTL && readCtl(msg.bytes)
        if (ctl && ctl.wb === 'session' && ctl.session === session && ctl.private === on) finish()
      }
      ws.onerror = ws.onclose = () => finish(fail('offline', 'the browser control channel disconnected'))
    } catch { finish(fail('offline', 'the browser control channel could not connect')) }
  })
}
