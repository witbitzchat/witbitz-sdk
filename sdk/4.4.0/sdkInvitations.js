import { sendInvite } from './inviteSend.js'
import { inviteScope } from './sdkRekey.js'
import { validUsername } from './address.js'
import { EMAIL } from './memberChange.js'
import { boxApp } from './attestedBox.js'

const fail = (code, text) => Object.assign(new Error('witbitz: ' + text), { code })
export async function resendInvitation(sp, { email, username } = {}) {
  if (sp._sharedRoom) throw fail('lane', 'a private lane cannot invite another member')
  if (!!email === !!username || (email && !EMAIL.test(email)) || (username && !validUsername(username))) throw fail('invalid_argument', 'name one recipient by email or username')
  const wb = sp._wb, client = wb && wb._client
  if (!client || !wb._session || !wb._session.idToken) throw fail('sign_in_required', 'sign in before sending an invitation')
  // Never downgrade an attested invitation to a bearer link in a normal directory box.
  let attested
  try { attested = await client.attestedRoom(sp.room, sp._mk) } catch { throw fail('policy_unreadable', 'the device policy could not be read') }
  const cfg = await sp._gateConfig()
  if (cfg.admission === 'email') {
    if (!(await sp.isAdmin(wb._session.email)) && !(await sp.isOwner(wb._session.email))) throw fail('not_admin', 'only an owner or admin may resend an invitation')
  }
  if (attested) {
    if ((sp._client && sp._client.keyless) || typeof client.verifyGovernance !== 'function') throw fail('attested', 'resend this invitation from the attested app that holds its key')
    let verified
    try { verified = await client.verifyGovernance(sp.room, sp._mk, null) } catch { throw fail('policy_unreadable', 'the signed native-app policy could not be read') }
    const platforms = verified && verified.ok && verified.governed && verified.policy && verified.policy.requireAttestation && verified.policy.requireAttestation.platforms
    const kind = Array.isArray(platforms) && platforms.length && platforms.every((p) => ['ios', 'android', 'macos'].includes(p)) ? 'attested' : Array.isArray(platforms) && platforms.length && platforms.every((p) => p === 'windows') ? 'windows' : null
    if (!kind) throw fail('policy_unreadable', 'the signed native-app policy could not be verified')
    const fragment = new URLSearchParams(String(sp.shareLink || '').split('#')[1] || '')
    const us = sp._split ? fragment.get('us') : null, spc = us ? fragment.get('spc') || '' : ''
    if ((sp._split && !us) || (!sp._split && !sp._mk)) throw fail('no_key', 'this device does not hold this attested Space’s key or user share')
    return sendInvite({ email, username, room: sp.room, ...(us ? { us, spc } : { mk: sp._mk }), title: sp.title, from: sp._who(), gate: cfg.admission === 'email' ? 'email' : undefined, client, kind, app: boxApp(kind), scope: '' })
  }
  if (!sp.shareLink) throw fail('no_link', 'this device does not hold the current invitation link')
  return sendInvite({ email, username, room: sp.room, link: sp.shareLink, title: sp.title, from: sp._who(), gate: cfg.admission === 'email' ? 'email' : undefined, client, scope: inviteScope(wb._session.idToken) })
}
