// roomSettings.js — a room's two PER-SPACE assistant settings, read the same way by the Spaces app and the SDK
// (sync sweep, 2026-10-10; spaces/test/roomSettings.test.mjs). Both are sealed, content-blind, last-writer-wins docs any
// member may write: `agentmode` (how the assistant replies) and `model` (which model answers, and its effort). Each turn
// carries them, so whichever client sends a message, the room answers the same way. The app's chips (agentMode.js,
// modelChip.js) and the SDK (witbitz-sdk.js) used to each keep their own copy — the SDK never read `model` at all, and
// read `agentmode` once — so one room answered with different models depending on who sent the message.

export const REPLY_MODES = ['auto', 'always', 'ondemand']
export const REPLY_MODE_LABEL = { auto: 'Auto', always: 'Always', ondemand: 'On demand' }

/** THE APP OFFERS TWO (the owner, 2026-11-12: "hide the auto mode … It is not working well. Let's stay with always and on demand").
 *  `auto` stays in REPLY_MODES for the SDK and builders' apps; the app's chip lists these. */
export const APP_REPLY_MODES = ['always', 'ondemand']
/** A Space's mode when nobody picked one: a verified Space with several people → On demand; one person, or
 *  a Space that is not verified → Always (the owner's rule). `members` null = not counted yet: a verified Space counts as a group,
 *  so a group is never answered on every message by mistake. */
export function defaultReplyMode ({ verified = false, members = null } = {}) {
  if (!verified) return 'always'
  return members === null || members > 1 ? 'ondemand' : 'always'
}
/** THE ONE DEFAULT, from a room's settings — the app (agentMode.js) and the server (agent/spaceService.mjs) both ask this (sync
 *  sweep 2026-11-13 #1, #4; the owner: "A room with no stored mode uses the app's default for everyone — SDK, Siri and outside
 *  agents included"). `cfg`: the room's config (verified = admission 'email'); `participants`: what rosterParticipants counts,
 *  WITH the room's sign-in record (`seen`) — null when the rule cannot count (a domain), which a verified Space reads as a group. */
export const roomDefaultReplyMode = (cfg, participants = null) => defaultReplyMode({
  verified: !!cfg && cfg.admission === 'email',
  members: typeof participants === 'number' && Number.isFinite(participants) ? participants : null,
})
/** The mode the app shows and each turn carries: the room's stored mode — Auto included (the owner, 2026-11-13: "A stored 'auto'
 *  stays Auto (an SDK builder chose it) and the app's chip shows it as Auto"; the chip OFFERS only APP_REPLY_MODES) — else the default. */
export const appReplyMode = (stored, dflt) => (REPLY_MODES.includes(stored) ? stored : dflt)
/** The mode a turn runs in on the server: the room's stored mode (Auto included), else a valid mode the turn sent, else the
 *  room's default (roomDefaultReplyMode) — never a silent Auto. */
export const turnReplyMode = (stored, sent, dflt) => (REPLY_MODES.includes(stored) ? stored : REPLY_MODES.includes(sent) ? sent : dflt)

/** The `agentmode` doc (as `state(room, 'agentmode')` returns it) → a reply mode, or null (no doc / unknown). */
export function modeFromDoc(d) {
  const m = d && d.state && d.state.mode
  return REPLY_MODES.includes(m) ? m : null
}

/** The `model` doc → `undefined` (no doc: nobody picked), `null` (picked "the room's own model"), or the pick
 *  `{ catalog, wire, label, effort? }`. */
export function modelPickFromDoc(d) {
  const s = d && d.state
  if (!s || typeof s !== 'object' || !('catalog' in s)) return undefined
  return s.catalog ? { catalog: String(s.catalog), wire: String(s.wire || ''), label: String(s.label || ''), ...(s.effort ? { effort: String(s.effort) } : {}) } : null
}

/** What a turn carries for a pick (agent/modelCatalog.mjs turnModelPick). `efforts`: the catalog's measured list for that
 *  model when known — an effort outside it is dropped; unknown (null) → sent, and the server fits it. */
export function turnModelOf(pick, efforts = null) {
  if (!pick || !pick.catalog) return undefined
  const effort = pick.effort && (!Array.isArray(efforts) || efforts.map(String).includes(pick.effort)) ? pick.effort : ''
  return { catalog: pick.catalog, ...(pick.wire ? { wire: pick.wire } : {}), ...(effort ? { params: { reasoning_effort: effort } } : {}) }
}

/** The `model` doc's state for a pick (null = back to the room's own model). */
export function modelDocOf(pick) {
  return { catalog: pick ? pick.catalog : '', wire: pick ? (pick.wire || '') : '', label: pick ? (pick.label || '') : '', effort: pick ? (pick.effort || '') : '', at: Date.now() }
}
