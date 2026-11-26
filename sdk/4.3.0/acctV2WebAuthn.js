// acctV2WebAuthn.js — the security-key ceremonies of account recovery v2 (docs/account-recovery-protocol.md § 10), as the
// small adapter the client takes (acctV2Client.js `keys`): create(options) → the registration, get({challenge, allow}) →
// an assertion, everything in base64url. This file is the BROWSER's adapter (navigator.credentials); the tests pass a
// simulated key with the same shape. The relying party is always witbitz.chat: one credential per key, for every app (§ 10.2).
import { b64u, unb64u } from './acctV2Wire.js'

export const RP_ID = 'witbitz.chat'
const err = (code) => Object.assign(new Error(code), { code })
const ab = (x) => b64u(new Uint8Array(x))

// The screen's gate before each prompt: `fn(kind, call)` shows what to touch and runs `call()` (the navigator call) INSIDE
// the person's tap, returning its promise — Safari opens a security-key prompt only in answer to a tap, and these flows
// reach the prompt after network calls and an email code. Without a gate (tests, or no screen) the call runs directly.
// A Standard account's flows never reach a prompt, so the gate never shows for them.
let _onPrompt = null
export const onKeyPrompt = (fn) => { _onPrompt = fn }
const ceremony = (kind, call) => (_onPrompt ? _onPrompt(kind, call) : call())
const rethrow = (e) => { throw (e && e.code === 'cancelled' ? e : why(e)) }

/** Why a prompt failed, in the client's words: the person closed it, this client cannot (no WebAuthn), or it refused. */
function why(e) {
  if (e && e.name === 'NotAllowedError') return err('key_cancelled') // closed, timed out, or no matching key touched
  if (e && e.name === 'InvalidStateError') return err('key_already_registered') // excludeCredentials matched
  if (e && e.name === 'SecurityError') return err('key_wrong_site') // this origin may not use witbitz.chat (§ 10.2)
  return err('key_failed')
}

export function browserKeys({ rpId = RP_ID } = {}) {
  const available = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials
  return {
    available,
    /** § 10.1 step 2 → 3: the service's creation options in, the attestation out. */
    async create(pk) {
      if (!available()) throw err('webauthn_unavailable')
      const publicKey = {
        ...pk,
        challenge: unb64u(pk.challenge),
        user: { ...pk.user, id: unb64u(pk.user.id) },
        excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: unb64u(c.id) })),
      }
      let cred
      try { cred = await ceremony('create', () => navigator.credentials.create({ publicKey })) } catch (e) { rethrow(e) }
      if (!cred) throw err('key_cancelled')
      const r = cred.response
      return { attestationObject: ab(r.attestationObject), clientDataJSON: ab(r.clientDataJSON), transports: (r.getTransports && r.getTransports()) || [] }
    },
    /** An assertion over `challenge` (bytes) by one of `allow` ([{ id, transports }]). */
    async get({ challenge, allow }) {
      if (!available()) throw err('webauthn_unavailable')
      let a
      const publicKey = {
        rpId, challenge, userVerification: 'required', timeout: 120000,
        allowCredentials: (allow || []).map((c) => ({ type: 'public-key', id: unb64u(c.id), transports: c.transports || [] })),
      }
      try { a = await ceremony('get', () => navigator.credentials.get({ publicKey })) } catch (e) { rethrow(e) }
      if (!a) throw err('key_cancelled')
      const r = a.response
      return { credId: ab(a.rawId), clientDataJSON: ab(r.clientDataJSON), authenticatorData: ab(r.authenticatorData), signature: ab(r.signature) }
    },
  }
}
