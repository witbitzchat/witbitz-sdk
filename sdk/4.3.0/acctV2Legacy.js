// acctV2Legacy.js — the transcript a move from today's service signs (docs/account-recovery-protocol.md § 12.2): the attempt
// is the challenge, and the new account's counters are all 0. The same bytes as the service's legacyTranscript
// (control-plane/src/lib/acct/legacy.mjs); spaces/test/acctV2App.test.mjs holds them equal.
import { transcript } from './acctV2Wire.js'

export const transcriptForLegacy = (m, attempt, params) => transcript({ op: 'legacy_commit', acct: m.acct, params, challenge: attempt, nonce: m.nonce, exp: m.exp, pv: 0, rg: 0, ev: 0, epoch: 0 })

/** The silent JOIN's transcript (legacySilent.mjs joinTranscript): the join is the challenge, the account's counters as its
 *  intent answered them. spaces/test/acctV2App.test.mjs holds the bytes equal to the service's. */
export const transcriptForJoin = (j, attempt, params) => transcript({ op: 'legacy_join', acct: j.acct, params, challenge: attempt, nonce: j.nonce, exp: j.exp, pv: j.pv, rg: j.rg, ev: j.ev, epoch: j.epoch })
/** The account key's authorisation of a silent move, before anything is locked (legacySilent.mjs silentTranscript). */
export const transcriptForSilent = (m, attempt, deviceSpk) => transcript({ op: 'legacy_silent', acct: m.acct, params: { device_spk: deviceSpk }, challenge: attempt, nonce: m.nonce, exp: m.exp, pv: 0, rg: 0, ev: 0, epoch: 0 })
/** The account key's ask for a join (legacySilent.mjs joinAskTranscript): only a holder of the account key gets a challenge. */
export const transcriptForJoinAsk = ({ gid, deviceSpk, ts }) => transcript({ op: 'legacy_join_ask', acct: '', params: { gid, device_spk: deviceSpk, ts }, challenge: gid, nonce: '', exp: ts, pv: 0, rg: 0, ev: 0, epoch: 0 })
