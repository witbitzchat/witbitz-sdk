// sdkAttest.js — A DEVICE THAT PROVES ITSELF, through the SDK: new Witbitz({ attest: { bridge } }). Witbitz's own cloud device in its
// enclave (cloud-device/attestBridge.mjs; the owner, 2026-11-21) uses it to read and post in the person's attested Spaces. It is the
// app's own machinery, reused: the device half that binds a proof to the room's fresh challenge and the member's signing key
// (deviceAttest.js), and the read provider spaceClient asks before a read of an attested room.
//
// RETIRED in 4.0.0 (the owner, 2026-11-22: "We dont need any emulation rooms"): `attest: { app }` — a builder's page proving it was
// SERVED as its app with the browser emulation's public platform key. A web page vouching for itself is no client check.
import { makeDeviceAttest, noteChallenge } from './deviceAttest.js'
import { setReadAttestProvider } from './spaceClient.js'

/** makeSdkAttest({ bridge, app?, client: () => spaceClient, storage?, installRead? }) →
 *  { turnFields(room, spk) → { chal, attestation } | {}, notePoll(room, r), noteAnswer(r), lastWhy() }
 *  `bridge`: the device (deviceAttest.js's contract). `app`: a label only — it names where the SDK keeps this device's signing key. */
export function makeSdkAttest ({ app = 'device', bridge, client, storage, installRead = true, log = () => {} } = {}) {
  if (!bridge || typeof bridge.platform !== 'function') throw Object.assign(new Error('witbitz: attest is { bridge } — a device that proves itself'), { code: 'invalid_argument' })
  const da = makeDeviceAttest({ bridge: () => bridge, client: { attestEnroll: (a) => client().attestEnroll(a) }, ...(storage ? { storage } : {}), log })
  if (installRead) {
    // a read of an attested room (spaceClient asks): the proof bound to the room's newest challenge and to THIS room
    setReadAttestProvider(async (room, o) => {
      if (o && o.challenge) noteChallenge(room, { challenge: o.challenge })
      const a = await da.attestFor({ room, spk: { readRoom: String(room) } }).catch(() => null)
      return a && a.attestation ? { read: { chal: a.chal, attestation: a.attestation } } : null
    })
  }
  return {
    app,
    /** The fields a turn adds: { chal, attestation } — {} when there is no challenge from the room yet. */
    async turnFields (room, spk) { const a = await da.attestFor({ room, spk }).catch(() => null); return a && a.attestation ? a : {} },
    /** A poll answer carries the room's fresh challenge (an attested room). */
    notePoll (room, r) { if (r && typeof r.challenge === 'string' && r.challenge) noteChallenge(room, r) },
    noteAnswer: (r) => da.noteAnswer(r),
    lastWhy: () => da.lastWhy(),
  }
}
