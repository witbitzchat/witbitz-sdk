// laneConfig.js — what a PRIVATE LANE's assistant is, one definition for the Spaces app and the SDK (docs/sdk-convergence.md,
// phase 8b). The two had drifted into two personas (the app's said "never paste a message for the others as a normal
// reply"; the SDK's did not). Pure — no DOM, no network.
export const LANE_AGENT_NAME = 'Your assistant'
export const LANE_PERSONA = "You are the member's PRIVATE assistant for a shared room they're in. Messages other people send in that room appear here labeled 'from the shared room'. Help the member privately — understand what's going on, think it through, plan, research, and draft. When you have a message MEANT FOR THE SHARED ROOM, send it by calling the cross_to_shared tool with the full message in `text` — it becomes a Draft the member approves and signs; never paste a message for the others as a normal reply. Normal replies are private to the member: analysis, options, planning, drafts, questions. Everything here is private unless a crossing is approved."

/** ⛔ NOT THE ITINERARY (state machines pass 8 P#5; sync sweep 2026-11-12 #3): the plan is ONE doc of the shared Space, sealed under
 *  a key a lane's turn does not hold — in a lane these tools wrote the lane's own copy, which nothing shows ("I've updated the
 *  itinerary", nothing changed). The server withholds them from a lane's turn (agent/toolUpgrade.mjs LANE_WITHHELD — the same
 *  names; laneInheritsGate.test holds the two equal), which covers the lanes already made; a lane made from now on does not
 *  carry them at all — also one whose requests name no Space (a lane on the other tier), which the server cannot tell from a Space. */
export const LANE_WITHHELD = new Set(['set_itinerary', 'add_to_itinerary', 'edit_itinerary', 'read_itinerary'])
const toolName = (t) => (t && typeof t === 'object' ? t.name : t)

/** The shared room's tools a lane takes on (the app's lanes do: the member's assistant can search what the room's can). */
export function inheritToolsFrom (sharedConfig) {
  const c = sharedConfig && typeof sharedConfig === 'object' ? sharedConfig : null
  if (!c || !Array.isArray(c.tools)) return {}
  const tools = c.tools.filter((t) => !LANE_WITHHELD.has(toolName(t)))
  if (!tools.length) return {}
  const immediate = Array.isArray(c.immediateTools) ? c.immediateTools.filter((n) => !LANE_WITHHELD.has(n)) : []
  return { tools, ...(immediate.length ? { immediateTools: immediate } : {}) }
}

/** WHAT A PRIVATE LANE TAKES FROM ITS SPACE: everything but the members (the owner, 2026-10-15: "the private lane inherits
 *  all the properties of the shared lane without the members" → "also other types like attested rooms should be the
 *  same"). The tools, and a VERIFIED Space's gate narrowed to the one member it belongs to. The tier and the region are
 *  the create's own options (enclave / the region in the id), so the caller copies those.
 *  Never a DOWNGRADE — the rule a confidential Space's lane already follows. Where the lane cannot be made as strict as
 *  its Space, it is not made yet (`wait`), rather than made weaker:
 *    · a verified Space and no signed-in email to admit (`wait: 'email'`);
 *    · an ATTESTED Space (its owner-signed policy requires an attested app — attestedRooms.js): only the attested app itself
 *      makes its lane, under the same signed rule (`attestedLane`, below); a caller that cannot waits (`wait: 'attested'`).
 *  `email` = the member's signed-in address; `attested` = the Space requires an attested app. */
//  `attestedLane` (the owner, 2026-11-08: "An attested private lane. It inherits the same app requirement"): the caller can make
//  the lane under the Space's own signed app rule (the app does, on a device whose bridge serves that kind) → `attest: true`,
//  the caller's job to sign and mark it. Without it (the SDK today): still `wait: 'attested'`.
export function laneInherits (sharedConfig, { email, attested, attestedLane = false } = {}) {
  const c = sharedConfig && typeof sharedConfig === 'object' ? sharedConfig : null
  // `lane: true` — A LANE SAYS SO IN ITS OWN SEALED SETTINGS (sync sweep 2026-11-18 #4 #5): the server knew a lane only by a sealed
  // `bridge` or the request's `bridgeRoom`, and a cross-tier lane sends neither (so it was offered the schedules); the cloud device
  // could not tell a solo verified lane from a Space. Lanes made before this carry no mark.
  const config = { ...inheritToolsFrom(c), lane: true }
  if (attested && !attestedLane) return { config, gate: null, wait: 'attested' }
  if (attested) {
    const g = laneInherits(c, { email }) // a VERIFIED attested Space: its lane is verified too — the email rule, unchanged
    return g.wait ? g : { ...g, attest: true }
  }
  if (!c || c.admission !== 'email') return { config, gate: null }
  const em = String(email || '').trim().toLowerCase()
  if (!em || em.indexOf('@') < 1) return { config, gate: null, wait: 'email' }
  return { config, gate: { admission: 'email', allow: { emails: [em] } } }
}

/** The pre-sign-in answer of a verified Space's settings — "it is gated", nothing else (spaceClient.js getConfig): not its settings.
 *  ONE rule for the app (roomSync), the SDK and the vault kit (sync sweep 2026-11-09, still open P3: it was written three times). */
export const gatedStub = (c) => !!c && c.gated === true && !c.allow && c.lanes === undefined
