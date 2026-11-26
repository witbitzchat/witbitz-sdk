// sdkPlan.js — say what a change to a room requires BEFORE making it (https://witbitz.chat/docs/sdk-roadmap.md, "Later": space.plan).
//
// A Space's settings live in three places, and a builder could not tell which from the outside:
//   · IN PLACE — the assistant's name, instructions and model, and the store's collections: `space.configure()`, for
//     every member, the history untouched;
//   · THE MEMBERS — a new member list (the email gate, admins, owners): since 2.3.0 IN PLACE too, `space.changeMembers()` — the
//     same room and history, a new key for the members on the list (sdkRekey.js). Only an email-gated room, by an owner or
//     admin; in a room with owners the owners must stay (emailFork.planGovernance). a Space no longer moves (`fork()` is retired);
//   · CREATE-TIME — the tier, a split key, the tools the assistant may use and which run without approval: a new room
//     (`wb.createSpace`), and the SDK carries no history into it.
// planChange() applies exactly those rules (the same functions configure() and fork() call) and changes nothing.
import { planGovernance, normAdmission, forkConfig, checkAdminCollections } from './emailFork.js'

const IN_PLACE_AGENT = ['name', 'instructions', 'model']
const CREATE_TIME = ['tier', 'key', 'tools', 'immediateTools']
const IN_PLACE_ROOM = ['platformTools', 'framing', 'dataWrites', 'safeMedia', 'lanes'] // safeMedia: Safe media on/off (sync sweep 2026-10-28) // configure()'s room settings — in place, admin-ruled (spaceService MUTABLE; sync sweep, 2026-10-10)
const RANK = { none: 0, in_place: 1, fork: 2, new_room: 3 }

/**
 * @param change { agent?: { name?, instructions?, model? }, data?, platformTools?, framing?, dataWrites?, admission?, tier?, key?, tools?, immediateTools? }
 * @param room   { cfg (the room's sealed config, or null), me (the signed-in email, or ''), lane (bool), checkData?(data) }
 * → { how: 'none'|'in_place'|'new_room'|'refused', history: 'kept'|'not_carried'|null, call, steps, reason? }
 */
export function planChange (change = {}, { cfg = null, me = '', lane = false, checkData = null, gatedUnread = false, signIn = 'wb.signIn' } = {}) { // signIn: the call that signs in here ('wb.vault.signIn' in a vault) // gatedUnread: a gated room answered only its stub (not signed in)
  const steps = []
  let members = false // the change includes a member list (in place: space.changeMembers)
  let how = 'none', refusal = null
  const need = (h) => { if (RANK[h] > RANK[how]) how = h }
  const refuse = (code, reason) => { if (!refusal) refusal = { code, reason } }
  // a private lane follows its Space's Safe media — refused as configure() refuses it (sync sweep 2026-11-02 #2), and FIRST, as
  // configure() checks it first: after the admin/sign-in checks a lane read signed out planned sign_in_required (2026-11-03 #6)
  if (lane && change.safeMedia !== undefined) refuse('lane_follows_space', 'a private lane follows its Space’s Safe media — set it on the Space')

  const agent = change.agent && typeof change.agent === 'object' ? change.agent : {}
  for (const k of Object.keys(agent)) {
    if (IN_PLACE_AGENT.includes(k)) { need('in_place'); steps.push(`agent.${k}: changed in place for every member (a system line says so)`) }
    else if (k === 'tools') { need('new_room'); steps.push('agent.tools: chosen at creation — a new room') }
    else refuse('unknown_field', `agent.${k} is not a setting of the assistant`)
  }
  for (const k of IN_PLACE_ROOM) if (change[k] !== undefined) { need('in_place'); steps.push(`${k}: changed in place for every member`) }
  if (change.data !== undefined) {
    need('in_place'); steps.push('data: the store\'s collections are declared or changed in place')
    if (typeof checkData === 'function') { try { checkData(change.data) } catch (e) { refuse(e.code || 'invalid_data', String(e.message || e)) } }
  }
  // THE SERVER'S IN-PLACE RULES (op 'config'; sync sweep, 2026-10-10 — the plan said "in place" for changes it refuses):
  // an owner-governed room changes by fork; a room with admins or owners takes a change from them only; an admins-only
  // collection needs admins or owners. Judged only when the room's config could be read.
  // only the IN-PLACE keys: `agent.tools` alone is a new room, not a change the room's admins must make
  if (Object.keys(agent).some((k) => IN_PLACE_AGENT.includes(k)) || change.data !== undefined || IN_PLACE_ROOM.some((k) => change[k] !== undefined)) {
    if (gatedUnread && !cfg) refuse('sign_in_required', 'an email-gated room takes a change only from a signed-in member (' + signIn + ')')
    else if (cfg && cfg.ownerPolicy && !(cfg.ownerPolicy.policy && cfg.ownerPolicy.policy.app === 'chat.witbitz')) refuse('governed_room', 'an owner-governed room changes by fork-and-replay') // the sealed field is ownerPolicy (it read cfg.policy, which no config carries — sync sweep 2026-11-09); a room under Witbitz's own rule changes in place, as the server allows (spaceService op config)
    else if (cfg) {
      const gov = [...lower(cfg.admins), ...lower(cfg.owners)], email = String(me || '').toLowerCase()
      if (gov.length && !gov.includes(email)) refuse(email ? 'not_admin' : 'sign_in_required', email ? "only this room's admins can change the assistant" : 'a room with admins takes a change only from a signed-in admin (' + signIn + ')')
      else if (change.data !== undefined) { try { checkAdminCollections(change.data, cfg) } catch (e) { refuse(e.code || 'admins_required', String(e.message || e).replace(/^witbitz: /, '')) } }
    }
  }
  for (const k of CREATE_TIME) if (change[k] !== undefined) { need('new_room'); steps.push(`${k}: chosen at creation — a new room, and the history does not come along`) }

  if (change.admission !== undefined) {
    if (lane) refuse('lane', "a lane is one member's own room — change its Space's members instead")
    else if (gatedUnread && !cfg) { need('in_place'); refuse('sign_in_required', 'a member change needs a signed-in member (' + signIn + ')') } // a gated room read signed out: it IS gated, its gate unread
    else if (!cfg || cfg.admission !== 'email') { need('new_room'); steps.push("admission: an open room's link IS its membership — gate a new room (createSpace({ admission })); the history does not come along") }
    else {
      // A gate fork() would refuse is a refusal here, never a throw (sync sweep, 2026-10-12: normAdmission throws).
      let gate = null, bad = null
      try { gate = normAdmission(change.admission) } catch (e) { bad = e }
      if (bad) refuse(bad.code || 'invalid_admission', String(bad.message || bad).replace(/^witbitz: /, ''))
      else if (!gate) refuse('invalid_admission', 'admission needs at least one address or domain')
      else {
        // ONLY IN PLACE (2.3.0; the owner, 2026-10-23: "only in place"): the same room and history, a new key for the members on
        // the list (sdkRekey.js, sdk-people.md#members). A Space no longer moves, so a change that names a `history` is refused by name.
        if (change.history !== undefined) refuse('use_change_members', 'a Space no longer moves to a new room — its members change in place, history and all (space.changeMembers)')
        need('in_place'); members = true; steps.push('admission: changed in place — the same room and history, a new key that only the members on the list receive (space.changeMembers)')
        const admins = lower(cfg.admins), owners = lower(cfg.owners), email = String(me || '').toLowerCase()
        if (!email) refuse('sign_in_required', 'a member change needs a signed-in member (' + signIn + ')')
        else if (!admins.length && !owners.length) refuse('not_admin', 'this Space has no owners or admins — only the Spaces app can change it (its creator)')
        else if ((admins.length || owners.length) && !admins.includes(email) && !owners.includes(email)) refuse('not_admin', "only this room's owners and admins change its members")
        else {
          // the same two checks space.fork() makes, in its order: governance, then an admins-only collection the
          // new room would keep with no admin or owner (emailFork.checkAdminCollections; sync sweep, 2026-10-10)
          try { planGovernance(cfg, gate, email, change.admission.admins !== undefined); const next = forkConfig(cfg, gate, ''); checkAdminCollections(next.dataSchema, next) } catch (e) { refuse(e.code || 'refused', String(e.message || e).replace(/^witbitz: /, '')) } }
      }
    }
  }

  if (refusal) return { how: 'refused', history: null, call: null, steps, reason: refusal.reason, code: refusal.code }
  const history = how === 'new_room' ? 'not_carried' : how === 'in_place' ? 'kept' : null
  const configures = steps.some((x) => !/^admission:/.test(x))
  const call = how === 'in_place' ? (members ? (configures ? 'space.configure(…) and space.changeMembers(admission)' : 'space.changeMembers(admission)') : 'space.configure(…)') : how === 'new_room' ? 'wb.createSpace(…)' : null
  return { how, history, call, steps }
}

const lower = (g) => (g && Array.isArray(g.emails) ? g.emails.map((x) => String(x).toLowerCase()) : [])
