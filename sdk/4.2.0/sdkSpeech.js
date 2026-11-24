// sdkSpeech.js — wb.speak(text): text read aloud on a builder's page, the same player the Spaces app's "Play aloud" uses
// (speechOut.js).
//
//   await wb.speak('Your table is booked for 8.')   // resolves when it has finished playing
//   wb.speech.stop()                               // stop what is playing
//   wb.speech.playing                              // true while it plays
//
// The text goes STRAIGHT from the page to Tinfoil's attested speech model — never through Witbitz. Witbitz only mints the
// page a short-lived, capped key (op:'tts', agent/sttKey.mjs), and only for a signed-in person (wb.signIn) or a user the
// tenant's backend vouched for (wb.useUserToken), as dictation does. A long text is cut at sentence ends; each request is
// $0.002 whatever its length. https://witbitz.chat/docs/sdk-assistant.md#speak.
// ⚑ No Hebrew: Hebrew-dominant text is refused (`no_hebrew`) before anything is spent. ⚑ The page's own CSP must allow
// `connect-src https://inference.tinfoil.sh` and `media-src blob:`; playback needs a user gesture on most browsers.
import { createTtsPlayer } from './speechOut.js'

const err = (code, message) => Object.assign(new Error('witbitz: ' + message), { code })

export class Speech {
  constructor (wb, { fetchImpl, AudioImpl, URLImpl, checkKey } = {}) { // checkKey: a test seam — the page's own evidence check (voiceAttest.js) by default
    this._wb = wb
    this._player = createTtsPlayer({ getKey: () => this._key(), ...(checkKey ? { checkKey } : {}), ...(fetchImpl ? { fetchImpl } : {}), ...(AudioImpl ? { AudioImpl } : {}), ...(URLImpl ? { URLImpl } : {}) })
  }

  /** true while something is playing. */
  get playing () { return this._player.playing }

  /** @private the page's key (op:'tts'): a signed-in session first (the person), else the tenant's user token. */
  async _key () {
    const wb = this._wb, sess = wb._session
    const idToken = sess && sess.idToken && !(sess.exp && sess.exp <= Date.now()) ? sess.idToken : ''
    let userToken = ''
    try { const t = typeof wb._userToken === 'function' ? await wb._userToken() : wb._userToken; userToken = typeof t === 'string' ? t : '' } catch { userToken = '' }
    if (!idToken && !userToken && !wb.vault) throw err('sign_in_required', 'speak needs a signed-in user (wb.signIn) or a user token (wb.useUserToken)') // in a vault, the vault's sign-in mints the key
    const r = await wb._client.tts(idToken, userToken)
    if (!r || r.status !== 200 || !r.key) {
      const code = (r && r.error === 'signin_required') ? 'sign_in_required' : (r && r.status === 429) ? 'tts_rate_limited' : 'tts_unavailable'
      throw Object.assign(err(code, 'reading aloud is unavailable: ' + String((r && (r.reason || r.error)) || 'HTTP ' + (r && r.status))), { status: r && r.status })
    }
    return r
  }

  /** Read `text` aloud → resolves when it has played. Rejects with `code`: `no_hebrew`, `empty`, `sign_in_required`,
   *  `tts_rate_limited`, `tts_unavailable`, `http_<status>`, `audio` / `play` (the browser would not play it). A new call
   *  stops the one playing. */
  async play (text) {
    try { await this._player.play(String(text == null ? '' : text)) } catch (e) {
      if (e && e.code && !String(e.message || '').startsWith('witbitz:')) e.message = 'witbitz: ' + e.message
      throw e
    }
  }

  /** Stop what is playing (its promise resolves). */
  stop () { this._player.stop() }
}
