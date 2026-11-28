// witbitz-sdk.js — the small, stable Witbitz application SDK.
//
// Witbitz is a runtime: a shared room with humans, an AI agent, sealed persistent state, identity and authority. This
// SDK is the thin surface over it — the sealing, the room key, the op-dispatch and the poll loop all disappear, so a
// static page can stand up a private, agent-backed, link-shared room in a few lines:
//
//   import { Witbitz } from 'https://witbitz-spaces.pages.dev/witbitz-sdk.js'
//   const wb = new Witbitz()
//   const space = await wb.createSpace({ agent: { name: 'Helper', instructions: 'You help plan trips.' } })
//   space.on('message', (m) => render(m))          // m = { from, text, self, id, ts }
//   await space.send('Plan me a weekend in Kyoto') // the agent answers on its own turn → arrives via on('message')
//   console.log(space.shareLink)                    // the link IS the auth — hand it to someone to let them in
//
// It re-exports the SAME reference client the production Spaces app runs on (nothing forked, nothing reimplemented): a
// cross-origin import of this one URL pulls the transitive crypto from this origin automatically. The room key never
// reaches the server — only its commitment — and reads are content-blind (the client opens the sealed ledger locally).
// `space.sealedProof()` returns the exact opaque bytes the server stores, so an app can PROVE that at rest.
import { mirrorBatches } from './mirrorBatch.js'
import { makeSpaceClient } from './spaceClient.js'
import { ownAdmissionEntries } from './emptySpaces.js'
import { memberHash } from './rosterHash.js'
import { verifyAttestation } from './nitroVerify.js' // devRoot: the dev server's Sentinel, checked under its root
import { AccountBackup } from './sdkBackup.js'
import { linkLanes, laneLinkTool } from './sdkLaneLink.js' // lane.link(other): two of a member's assistants ask each other
import { InviteAccount, adoptGrant as adoptRoomGrant, changeMembers as changeMembersInPlace, rotateKey as rotateKeyInPlace, relink } from './sdkRekey.js' // a verified room changes its members in place (https://witbitz.chat/docs/sdk-people.md#members)
import { TemporaryRooms } from './sdkTemporaryRooms.js'
import { Computers } from './sdkComputers.js' // wb.computers: the person's cloud computers (docs/sdk-cloud-computers.md)
import { opensEnvelopes, sealsIdentity } from './reqEnvelope.js' // the sealed request envelope: does a live enclave open it
import { SpaceSafeMedia } from './sdkSafeMedia.js' // space.safeMedia: photos and PDFs shown from copies an attested enclave made safe (docs/safe-media.md)
import { SpaceSchedules } from './sdkSchedules.js'
import { CloudDevice, SpaceAlwaysOn, assertNotKept, disconnectRoomLanes } from './sdkCloudDevice.js'
import { linkKeptAgent, unlinkKeptAgent } from './sdkKeptAgent.js'
import { otherWaysRows, typedMcpUrl, spacesUsingConnection, grantStatus } from './connOtherWays.js'
import { CATALOG as CONNECTION_CATALOG } from './connCatalog.js'
import { resendInvitation } from './sdkInvitations.js'
import { removedCopy, sharedRemovedCopy } from './removedMessage.js'
import { entryKeyOf as removedEntryKey } from './ledgerView.js'
import { fileReport, REPORT_REASONS } from './sdkReport.js' // space.report(): the Spaces app's Report (App Store rule 1.2; docs/report-and-block.md §3)
import { safeMediaReady } from './safeMedia.js'
import { A2AAccount, LaneA2A, VaultLaneA2A, refreshVaultA2AViews, pendingOf } from './sdkA2A.js' // wb.a2a + lane.a2a: outside agents into a private lane (https://witbitz.chat/docs/sdk-agents.md#a2a)
import { makeSdkAttest } from './sdkAttest.js' // attest: { bridge } — a device that proves itself (the cloud device)
import { Builds } from './sdkBuilds.js' // wb.builds: which enclave build THIS PERSON accepts ('mine'), or any Witbitz publishes (default)
import { Erasure } from './sdkErase.js' // wb.erasure: the deletion commitment, the membership mark, the filed erase list (https://witbitz.chat/docs/sdk-builder.md#user-erasure)
import { AccountIndex } from './sdkAccount.js'
import { receiptFor } from './usageReceipts.js' // a turn's usage receipt address (docs/usage-receipts.md) // wb.account: the live index between the account's devices
import { aguiRun, aguiHistory, aguiAgent } from './sdkAgui.js' // a Space as an AG-UI 1.0 agent, in the builder's page (https://witbitz.chat/docs/sdk-agents.md#ag-ui)
export { aguiRun, aguiHistory, aguiAgent }
export { verifyEat, fetchAndVerifyEat, EAT_PROFILE } from './eat.js' // RATS/EAT: check a Witbitz enclave with a standard token (https://witbitz.chat/docs/sdk-keys.md#eat)
import { Speech } from './sdkSpeech.js' // wb.speak(): text read aloud, the Spaces app's "Play aloud" player (speechOut.js)
import { Dictation, voiceForDictation } from './sdkDictation.js' // wb.dictation(): press-to-talk, the mic straight to Tinfoil's realtime enclave
import { Protect } from './sdkProtect.js' // wb.protect: what the app keeps on the device, sealed under a passkey-derived key
import { boxesHash, bareEC, jkey } from './spaceFork.js' // the membership fork's notice format, shared with the app
import { normAdmission, checkAdminCollections, judgeMove, newRoomKeepsGov } from './emailFork.js' // the gate's rules with the app; following a move an OLDER client made (a Space no longer moves: #members)
import { deleteOwnRoom } from './roomDelete.js'
import { sealTo, openBox, commit as keyCommit } from './e2ee.js'
import { roomUsageRecords, summarizeUsage, usageCsv } from './usageSummary.js'
import { stillOnList } from './memberChange.js'
import { ROSTER_DOC, selfRow, ensureSelf, unseenIn, entriesMissing, announcedIn, privateInvitationMatches, listRoster, verifiedPosters, verifiedSigningIds, membersView } from './roomRoster.js'
import { reconstructMk } from './splitKeyClient.js' // the split-key combine + the mandatory commitment check
// The account half — sign-in, connections, the Siri inbox — reuses the SAME modules the Spaces app runs (nothing
// forked): the Sentinel attestation + grant sealing (connections.js), the Siri record and collector (siri.js), and the
// sealing primitives. The SDK adds only the session and the state the app used to keep in its own store.
import { postWithPendingKey, attachConnection, listConnections, detachConnection, attestStandingSentinel, roomEntry, CONNECTION_HOST, STANDING_SENTINEL_PCR0, startMcpSignIn, finishMcpSignIn, attachMcp as attachMcpServer, listMcpTools, isCurated } from './connections.js'
import { listGrantTools } from './agentDoorTools.js'
import { readsAutoFor } from './connCatalog.js'
import { lockConnections, wrapProof } from './connWrap.js' // move 3: the old-form connections locked under their key
import { dispKeyOf, sealDisp } from './connDisp.js' // step 2: a connection's name sealed to the account's devices (docs/standing-sentinel.md)
import { recommendedChoice } from './mcpRecommended.js' // an MCP server's recommended tools: reads run on their own, changes ask (as the app)
import { roomTool, roomJob } from './connectionEntry.js' // one MCP tool's bounded room form
import { withBook, bookTheRest } from './toolBooks.js' // an MCP connection's tools as a sealed tool book, as the app
import { uniqueAlias, siriAliasesDiffer, siriRecordFor, collectSiriDrops, newSiriKey, SIRI_ENDPOINT } from './siri.js'
import { sealTo as sealToEnclave } from './sealShare.js'
import { genRecipientKey } from './e2ee.js'
import { genKeypair, spkNonce } from './entrySig.js'
import { normSiriAlias } from './store.js'
// ── THE CONFIDENTIAL TIER (2026-09-27, a builder: "enclave tier in createSpace and privateLane, so the room key never
// reaches the relay"). Every piece below is the SAME module the Spaces app runs — the attestation (enclaveRoute), the
// room's acceptance block and its ENFORCEMENT (enclaveAccept gatedKey), the claim parser. Nothing about the security of
// this tier is reimplemented here; the SDK supplies the session and the choreography the app kept inline in its page.
import { attestEnclave } from './enclaveRoute.js'
import { publishedKey } from './enclaveAccept.js'
import { enclaveClaim } from './enclaveClaim.js'
// ROOM STREAMS (https://witbitz.chat/docs/sdk-rooms.md#live): the reply as it is written, and "the ledger grew", pushed down a
// socket on the relay instead of found by polling. The SAME reader the Spaces app runs; the SDK connects on /s/ — the
// relay's path for pages on any origin (a builder's app is not a Witbitz origin).
import { openRoomStream } from './roomStreamClient.js'
import { makeEmailPost, emailStart, emailVerify, emailRefresh } from './emailSignIn.js' // the email-code protocol the vault and the Spaces app use
import { answerDeviceCall } from './deviceCall.js' // one way to answer a device call, shared with the Spaces app
import { LANE_PERSONA, LANE_AGENT_NAME, inheritToolsFrom, laneInherits, gatedStub } from './laneConfig.js'
import { renderSharedViews, viewsNamedIn, SHARED_VIEWS_DOC } from './sharedViews.js'
import { receiptOf } from './sealedReceipt.js' // a verified room's sealedProof, computed by the member
import { replyQuote } from './replyQuote.js' // the reply quote — one rule with the app's reply strip
import { makeLedgerView, needsTailResync, REACTION_RESYNC_TAIL, entryKeyOf, readAllPages } from './ledgerView.js' // how the Spaces app merges a room's entries
import { roomInviteFlags, applySkills, roomEmbed } from './roomEmbed.js'
import { turnVerdict, QUEUE_RETRY_MS, QUEUE_MAX_TRIES, CONTINUATION_WINDOW_MS } from './turnVerdict.js' // the send hold + answer reading the Spaces app uses
/** A turn's answer with `ok` always a boolean: posted / silent / pending → true; anything with an error, or busy, refused,
 *  failed, no answer → false (Space#_turnHeld). */
const withTurnOk = (r) => { const k = turnVerdict(r).kind; return withUsage({ ...(r || {}), ok: !(r && r.error) && (k === 'ok' || k === 'silent' || k === 'pending') }) }
/** The server's usage record → { tokensIn, tokensOut, tokensCached, costMicros, costUsd, calls, models, source } (sdkTurn turnUsage). */
const withUsage = (r) => { if (r && r.usage) { const u = turnUsage(r.usage); if (u) r.usage = u; else delete r.usage } return r }
import { renameRefusalText } from './renameRefusal.js' // why a rename was refused — the app's words
import { isTitleEntry, latestTitle, titleFromDoc, sendRename as sendRoomRename, cleanTitle, isDirect, directPeer, isLaneCopy as laneCopy } from './roomName.js' // a room's NAME — the same rule the Spaces app reads it by
import { pollVerdict } from './pollVerdict.js' // one verdict on a poll answer, shared with the Spaces app
import { hide, redacted, REDACTED } from './sdkRedact.js'
import { WitbitzAdmin } from './witbitz-admin.js'
import { Turn, turnUsage } from './sdkTurn.js' // space.turn(): a turn you can hold (sdk-roadmap item 6)
import { planChange } from './sdkPlan.js'
import { schemaProblem } from './rowSchema.js' // a collection's row schema — the same verdict as the server
export { assistantTemplates } from './spaceTemplates.js'
import { scopedAccount, tokenApp, tokenClaims, firstPartyAppOf, sentinelAccount, VAULTED_APP } from './accountScope.js' // the account a sign-in may act on — the same derivation as the Lambda
import { connectVault } from './sdkVault.js' // a builder-hosted vault holds the keys; this page never does (docs/sdk-vault-mode.md)
import { makeTurnFeed } from './turnFeed.js' // one reading of a running turn, shared with the Spaces app
import { roomRegion, regionCode, DEFAULT_REGION, newRoomId } from './regions.js' // a room's home region is in its id (docs/multi-region.md)

// The room's reply mode and model pick: ONE module with the Spaces app (roomSettings.js — the same names, the same sealed
// `agentmode` and `model` docs), so the SDK and the app are one setting, not two that drift.
import { REPLY_MODES, REPLY_MODE_LABEL, modeFromDoc, modelPickFromDoc, turnModelOf, roomDefaultReplyMode } from './roomSettings.js'
import { TOOLRULES_DOC, RULE_VALUES, toolRulesDocOf, rulesFromDoc } from './toolRules.js' // which tools run on their own (space.toolRules)
import { rosterParticipants } from './rosterCount.js' // the server's count (agent/rosterCount.mjs) — replyMode()'s default
const NAME_RECHECK_EVERY = 20 // = roomTitle.js RETITLE_EVERY / agent/spaceService.mjs RETITLE_AFTER
const SETTINGS_FRESH_MS = 20_000 // a member may change either from another client; a long-lived handle re-reads them before a turn after this long
const DEFAULT_ENDPOINT = 'https://api.witbitz.chat/v1/space' // the public, self-authenticating Space endpoint (a Space authenticates by its key-commitment, not a tenant account)
const DEFAULT_VIEWER = 'https://witbitz-spaces.pages.dev' // shareLink base — the reference Spaces app ORIGIN (the client appends `/space?room=…#…`). Override to point links at your own viewer origin.

const DEFAULT_ASSIST = LANE_PERSONA // laneConfig.js — the Spaces app's lane persona; one definition for both

// Turn friendly `actions` into the client-tool wire shape + a handler map. Each action = { name, description, input?, run }.
// A write is `mode: 'propose'` → the agent can only PROPOSE it; a human approves before `run` executes on the device.
// Honored only on a private LANE (client-executed tools are lane-only server-side).
// An action may also be a READ — `mode: 'await'` — which the agent calls DURING a turn for something only the device
// knows; the SDK runs `run` and hands the result back to the turn. Anything else stays a proposal a human approves.
// PER-TURN INSTRUCTIONS (a builder, 2026-09-29): prepending the app's context block to every message stored ~30 copies of
// it in the window the assistant re-reads each turn (~30k tokens), and moving it into a tool description made the facts
// usable but the INSTRUCTIONS unheeded. `instructions` rides the turn, reaches the model as its own labelled section for
// this reply, and is never stored. Bounded by the server too (8,000 characters).
const stopOpt = (k) => (typeof k === 'string' && /^[A-Za-z0-9]{8,64}$/.test(k) ? { stopKey: k } : {}) // the turn's cancel nonce (https://witbitz.chat/docs/sdk-assistant.md#turn); only space.turn() mints one
// A REPLY quotes the message it answers (agent/asyncTurn.mjs keeps { key, name, excerpt }, bounded) — the app's shape.
// `replyTo`: a Message from 'message' / snapshot(). The key is ledgerView.js entryKeyOf, the app's rule.
// A ROOM CLIENT THAT HEALS ITS ENCLAVE KEY (sync sweep, 2026-10-10). In a confidential room every keyed call (a send, a
// reaction, a row, an approval, a rename, a run, a gated poll) can meet a key the enclave no longer holds — `401
// bad_mkseal` after the enclave was replaced — or none at all ("enclave key unavailable": the room was opened while its
// enclave slept). The app re-attests and retries in both cases (space.js); here every call does, once: `heal()` attests
// (shared, throttled) and says whether a fresh key is in hand. Non-functions and open rooms pass through unchanged.
const RAW_CLIENT = Symbol('witbitz.rawClient')
// A ROOM RE-KEYED IN PLACE (https://witbitz.chat/docs/sdk-people.md#members): a call with the room's old key is answered `stale_key`;
// `keys.adopt()` takes this account's grant (sdkRekey.js) and the call runs once more with the new key in place of the old one.
function healingClient(c, heal, keys = null) {
  if (!c || typeof c !== 'object') return c
  c = c[RAW_CLIENT] || c // a fork's or a lane's Space is handed its parent's client: wrap the RAW one, or the parent's heal (its own room) ran first
  return new Proxy(c, {
    get(t, k) {
      if (k === RAW_CLIENT) return t
      const v = t[k]
      if (typeof v !== 'function') return v
      return async (...a) => {
        let r
        try { r = await v.apply(t, a) } catch (e) {
          if (/enclave key unavailable/i.test(String(e && e.message))) {
            if (await heal()) return v.apply(t, a)
            if (e && typeof e === 'object' && !e.code) e.code = 'enclave_unavailable' // its enclave is asleep or could not be verified: try again shortly
          }
          throw e
        }
        if (r && (r.status === 401 || r.status === 200) && r.error === 'bad_mkseal' && await heal()) return v.apply(t, a) // 200: the confidential host front once flattened every status
        // A CONFIDENTIAL ROOM THIS CLIENT DID NOT KNOW (an old unmarked link): the standard tier refuses it `confidential_room`.
        // Learn the tier, as the app does (l1.js learnTier), and send it once more to the enclave — sealed from then on
        // (sweep 11-06, unclear #3: until then every call sent the room key readable to the Lambda).
        if (r && r.error === 'confidential_room' && keys && typeof keys.learnTier === 'function' && typeof a[0] === 'string' && await keys.learnTier(a[0]).catch(() => false)) return v.apply(t, a)
        if (r && (r.status === 401 || r.status === 200) && r.error === 'stale_key' && keys && k !== 'grant') {
          const got = await keys.adopt(a)
          if (got) return v.apply(t, a.map((x) => (typeof x === 'string' && got.old.has(x) ? got.mk : x)))
        }
        return r
      }
    },
  })
}

// A poll refusal no retry cures (pollVerdict 'gated' with these reasons): the poll slows to HELD_POLL_MS (sync sweep, 2026-10-10).
const PERMANENT_REFUSALS = new Set(['not_on_list'])
const isPurged = (e) => !!(e && e.kind === 'purged') // a deleted mail's place in the history (agent/mailPurge.mjs) — never a message
const HELD_POLL_MS = 60000
const KEY_WAIT_POLL_MS = 15000 // on the list of a re-keyed room but holding no key it can open (sdkRekey.js 'pending'): a fresh link or a restored invite key may come
// A quote: replyQuote.js, the app's reply strip's own rule; no `excerpt` when there is nothing to show.
const replyRef = (m) => { const q = m && m.id != null ? replyQuote(m) : null; return q && (q.excerpt ? q : { key: q.key, name: q.name }) } // the SDK quotes only a message with an id
const promptOpt = (on) => (on === true ? { showPrompt: true } : {}) // send(…, { showPrompt: true }) → the answer's `prompt`: exactly what the model was sent (sdk-assistant.md#builder-mode)
const perTurn = (instructions) => (typeof instructions === 'string' && instructions.trim() ? { instructions: instructions.trim().slice(0, 8000) } : {})

// ⛔ SILENT CUTS COST A BUILDER A DAY (2026-09-29): "the model read two calendars of four because the list at the end of
// a description was gone." The server bounds what an app declares and CUTS or DROPS the excess without a word
// (agent/spaceHandlerCommon.mjs sanitizeClientTools, agent/dataTools.mjs sanitizeDataSchema). The SDK now refuses at
// DECLARATION time, naming the limit, so it surfaces while the app is being built. It checks nothing stricter than the
// server — sdkLimits.test.mjs holds these numbers equal to the server's.
/** This SDK's version: 'dev' on the live build, the release number in /sdk/<version>/ (tools/sdk-release.mjs sets it). */
export { isLaneCopy } from './roomName.js' // is this message a lane's copy of its shared room's line? (the app's own test, sdk-agents.md#lanes)
export { Protect } // device storage protection, usable before a client exists (sdkProtect.js, #protect)
export const SDK_VERSION = '4.4.0'
// Every error the SDK throws carries a `code` (sdk-reference.md#errors): an argument it cannot use is `invalid_argument`.
const sdkError = (message, code = 'invalid_argument') => Object.assign(new Error(message), { code })
/** What this SDK build can do — for feature detection (wb.capabilities()). Names only grow; a removed one is a major version. */
const FEATURES = Object.freeze(['spaces', 'turn', 'replay-option', 'store', 'proposals', 'lanes', 'lane-links', 'a2a', 'admission', 'admins', 'owners', 'plan', 'enclave', 'split-key', 'certificates', 'connections', 'siri', 'dictation', 'speech', 'backup', 'protect', 'erasure', 'builds', 'account-index', 'usernames', 'agui', 'eat', 'admin-sdk', 'rekey', 'tool-rules', 'lanes-configure', 'chat-locks', 'session-browser', 'schedules', 'invite-resend', 'connection-catalog', 'chat-lock-pin', 'session-browser-private', 'email-move', 'mirror-removals'])
export const LIMITS = Object.freeze({
  actions: 32, actionName: 64, actionDescription: 2000, actionInputSchema: 8000,
  collections: 16, fieldsPerCollection: 32, name: 40, collectionDescription: 300, fieldDescription: 200,
  // What one turn may carry — the server's own caps (agent/spaceHandlerCommon.mjs parseMedia / sanitizeLinks), which it
  // applies by DROPPING the excess silently. The SDK refuses instead, so a file never vanishes without a word.
  images: 4, imageBytes: 1_100_000, files: 2, fileBytes: 3_700_000, links: 16,
})
const n = (x) => x.toLocaleString('en-US')
const limitError = (msg) => { const e = new Error('witbitz: ' + msg); e.code = 'limit_exceeded'; return e }
/** A refusal from the room, with the server's own error as `code` — `not_admin`, `not_authorized`, … — so an app can
 *  tell "you may not" from "it failed". `status` and `reason` ride along. */
const refused = (what, r) => { const e = new Error(`witbitz: ${what} refused: ${r ? r.status : '?'} ${(r && (r.reason || r.error)) || ''}`.trim()); e.code = (r && r.error) || 'failed'; if (r) { e.status = r.status; if (r.reason) e.reason = r.reason } return e }
// ATTACHMENTS on a turn (2026-10-02). Each is `{ b64, mime, name? }` or `{ bytes, mime, name? }` (a Uint8Array or an
// ArrayBuffer). Base64 is what travels; the server stores it out of line, sealed under the room key. Sizes are checked
// against the server's caps in BYTES (base64 is 4/3 of that) and refused here rather than dropped there.
const B64_MAX = { images: 1_500_000, files: 5_000_000 }
function toB64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(bin)
}
function mediaList(list, kind) {
  if (list === undefined || list === null) return undefined
  if (!Array.isArray(list)) throw sdkError(`witbitz: \`${kind}\` takes an array of { b64 | bytes, mime, name? }`, 'invalid_argument')
  const max = LIMITS[kind]
  if (list.length > max) throw limitError(`${list.length} ${kind} on one message; the limit is ${max}`)
  const out = list.map((a, i) => {
    if (!a || typeof a !== 'object') throw sdkError(`witbitz: ${kind}[${i}] is not an attachment`, 'invalid_argument')
    const b64 = typeof a.b64 === 'string' && a.b64 ? a.b64 : (a.bytes instanceof Uint8Array || a.bytes instanceof ArrayBuffer ? toB64(a.bytes) : '')
    if (!b64) throw sdkError(`witbitz: ${kind}[${i}] needs \`b64\` or \`bytes\``, 'invalid_argument')
    if (typeof a.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(a.mime)) throw sdkError(`witbitz: ${kind}[${i}] needs a \`mime\` type, like ${kind === 'images' ? 'image/jpeg' : 'application/pdf'}`, 'invalid_argument')
    if (b64.length > B64_MAX[kind]) throw limitError(`${kind}[${i}] is ${n(Math.floor(b64.length * 3 / 4))} bytes; the limit is ${n(kind === 'images' ? LIMITS.imageBytes : LIMITS.fileBytes)} per ${kind === 'images' ? 'image' : 'file'}`)
    return { b64, mime: a.mime, ...(a.name ? { name: String(a.name).slice(0, 120) } : {}) }
  })
  return out.length ? out : undefined
}
// WHO WROTE A MIRRORED LINE, as its Space knew them (the app's mirrorLoop.js byOf, rule for rule; the lane's Block reads it,
// blockView markMirrored): a person's message only — never the agent's, nor an outside agent's line relayed under a member's
// key (a SIGNED relay only: an unverified poster who types those words is still blockable) — and only what the server
// stamped. The signing key in that Space for ANY poster; for a verified one also the @username and the email the room
// verified (senderNames.js attestedIdentity: not on a `keyOnly` entry). The app also reads the room's roster record for the
// key; the SDK keeps none, so an entry without a stamped email carries the key alone (sync sweep 11-13 P1: the SDK stamped
// nothing for an unverified poster and never the email). mirrorLoop.js is not imported: it pulls the app's shell with it.
const RELAYED_AGENT_LINE = /^🤖 (.{1,80}?) \(via A2A\): /
const MIRROR_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
function mirrorBy(room, e) {
  if (!e || e.self === true || e.kind === 'agent') return {}
  const verified = e.verified === true
  if (verified && RELAYED_AGENT_LINE.test(String(e.text || ''))) return {}
  const k = e.vspk || e.spk
  const sid = k && k.x && k.y ? `${k.x}.${k.y}` : '' // profilePhoto.js rowIdOfKey
  const user = verified && typeof e.user === 'string' && /^@?[a-z0-9_.-]{1,40}$/i.test(e.user) ? e.user.replace(/^@/, '') : ''
  const email = verified && e.keyOnly !== true && MIRROR_EMAIL.test(String(e.email || '').trim()) ? String(e.email).trim().toLowerCase() : ''
  const by = { ...(email ? { email } : {}), ...(user ? { user } : {}), ...(sid && room ? { room, sid } : {}) }
  return Object.keys(by).length ? { by } : {}
}
/** Attachments a COPY must carry as bytes: a stored one points at a blob sealed to the SOURCE room's key, which would
 *  never open in the room it is copied to. A failed source read leaves the batch pending for the next mirror, for a few passes. */
async function withBytes(from, list) {
  if (!Array.isArray(list) || !list.length) return undefined
  return Promise.all(list.map(async (a) => {
    if (!a || typeof a !== 'object' || (typeof a.b64 === 'string' && a.b64)) return a
    const { ref, parts, size, ...rest } = a
    if (!ref && !parts) return rest
    const key = ref || (Array.isArray(parts) ? parts.join(',') : '')
    const misses = _copyMisses.get(from) || new Map()
    let o = null
    try { o = await from.attachment(a) } catch { o = null }
    if (o?.b64) { misses.delete(key); return { ...rest, b64: o.b64, mime: a.mime || o.mime } }
    // A few passes, then without the bytes (second review, 2026-11-27; the app's rule, mirrorLoop.js inlineForMirror): a blob that is
    // gone failed every pass, the batch never landed, and no later message reached the lane — with no `error` event either.
    const n = (misses.get(key) || 0) + 1
    misses.set(key, n); _copyMisses.set(from, misses)
    if (n < COPY_TRIES) throw sdkError('attachment bytes could not be copied', 'attachment_unavailable')
    return rest
  }))
}
const COPY_TRIES = 3
const _copyMisses = new WeakMap() // per source Space, this page's memory only
const withMedia = (msg, images, files) => {
  const im = mediaList(images, 'images'), fl = mediaList(files, 'files')
  return { ...msg, ...(im ? { images: im } : {}), ...(fl ? { files: fl } : {}) }
}
/** Throws `limit_exceeded` for a list of actions OFFERED TO ONE TURN that the server would cut or drop. */
export function checkActions(actions) {
  const list = Array.isArray(actions) ? actions.filter((a) => a && a.name && typeof a.run === 'function') : []
  if (list.length > LIMITS.actions) throw limitError(`${list.length} actions offered to one turn; the limit is ${LIMITS.actions} per turn — the rest would be dropped`)
  checkActionItems(list)
}
// ★ THE COUNT IS PER TURN, NOT PER REGISTRATION (a builder, 2026-09-29: "We build the Lane with all 30 of our actions, so
// an approved card still finds its handler after a reload, but a turn is offered only 19–24"). The server caps the
// clientTools a TURN carries; a lane may register more, so an approved proposal finds its handler after a reload. So a
// registration checks each action; the count is checked in send(), on what that turn actually offers.
function checkActionItems(list) {
  for (const a of list) {
    if (typeof a.name !== 'string' || !new RegExp(`^[a-zA-Z0-9_]{1,${LIMITS.actionName}}$`).test(a.name)) throw limitError(`action name ${JSON.stringify(a.name)} must be letters, digits and _ (up to ${LIMITS.actionName}) — otherwise the tool is dropped`)
    const d = String(a.description || a.name)
    if (d.length > LIMITS.actionDescription) throw limitError(`the description of action "${a.name}" is ${n(d.length)} characters; the limit is ${n(LIMITS.actionDescription)} — the rest would be cut before the assistant sees it`)
    const schemaLen = JSON.stringify(a.input || { type: 'object', properties: {} }).length
    if (schemaLen > LIMITS.actionInputSchema) throw limitError(`the input schema of action "${a.name}" is ${n(schemaLen)} characters of JSON; the limit is ${n(LIMITS.actionInputSchema)} — over it the whole tool would be dropped`)
  }
}
// REASONING EFFORT is per MODEL, and per route: DeepSeek V4.1 takes `medium` on the standard tier and refuses it on the
// confidential one; Mistral Large takes no effort at all. The platform measures each (tools/effort-probe.mjs) and
// publishes the list on `wb.models()`; the server fits a value the model does not take back to its default rather than
// fail a turn, so without this check a builder's `medium` would silently run as `low`. Refused here, naming the list.
export const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const effortError = (msg) => { const e = new Error('witbitz: ' + msg); e.code = 'invalid_effort'; return e }
/** Throws `invalid_effort` when `model` names a reasoning_effort that the model it names does not take. `catalog` is
 *  `wb.models()`' rows; a model it does not list (BYO, a new wire name) is checked only against the ladder. */
export function checkModelEffort(model, catalog = []) {
  const effort = model && typeof model === 'object' && model.params && typeof model.params === 'object' ? model.params.reasoning_effort : undefined
  if (effort === undefined || effort === null) return
  if (!EFFORTS.includes(effort)) throw effortError(`reasoning_effort ${JSON.stringify(effort)} is not an effort level; the levels are ${EFFORTS.join(', ')}, and each model takes some of them — see wb.models()`)
  const key = model.catalog || model.wire
  const row = (catalog || []).find((m) => m && (m.id === key || m.wire === key))
  if (!row || !Array.isArray(row.efforts)) return
  if (!row.efforts.length) throw effortError(`${row.id} takes no reasoning_effort — drop the field`)
  if (!row.efforts.includes(effort)) throw effortError(`${row.id} does not take reasoning_effort "${effort}"; it takes ${row.efforts.join(', ')}`)
}
/** Throws `limit_exceeded` for a `data` schema the server would cut, drop or rename. */
export function checkDataSchema(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  const cols = Object.entries(data)
  if (cols.length > LIMITS.collections) throw limitError(`${cols.length} collections; the limit is ${LIMITS.collections} — the rest would be dropped`)
  const okName = (k) => new RegExp(`^[A-Za-z0-9_.\\-]{1,${LIMITS.name}}$`).test(k)
  for (const [col, v] of cols) {
    if (!okName(col)) throw limitError(`collection name ${JSON.stringify(col)} must be letters, digits, _ . - (up to ${LIMITS.name}) — otherwise it is renamed`)
    if (v && typeof v === 'object' && typeof v.description === 'string' && v.description.length > LIMITS.collectionDescription) throw limitError(`the description of collection "${col}" is ${n(v.description.length)} characters; the limit is ${LIMITS.collectionDescription} — the rest would be cut`)
    if (v && typeof v === 'object' && 'write' in v) {
      if (v.write !== 'admins' && v.write !== 'members') throw sdkError(`witbitz: collection "${col}" write is 'admins' or 'members'`, 'invalid_argument')
      if (!v.fields && !v.schema) throw sdkError(`witbitz: collection "${col}" declares write — give its fields as { fields: {…}, write } (or a schema), or "write" would be read as a field`, 'invalid_argument')
    }
    if (v && typeof v === 'object' && 'schema' in v) { // a ROW SCHEMA (rowSchema.js): refused here exactly as the server would refuse it
      const why = schemaProblem(v.schema)
      if (why) throw Object.assign(new Error(`witbitz: the schema of collection "${col}" cannot be enforced — ${why}`), { code: 'invalid_schema' })
    }
    const fields = v && typeof v === 'object' && v.fields && typeof v.fields === 'object' ? v.fields : (v && typeof v === 'object' && !('fields' in v) && !('description' in v) && !('schema' in v) ? v : {})
    const fe = Object.entries(fields)
    if (fe.length > LIMITS.fieldsPerCollection) throw limitError(`collection "${col}" has ${fe.length} fields; the limit is ${LIMITS.fieldsPerCollection} — the rest would be dropped`)
    for (const [f, d] of fe) {
      if (!okName(f)) throw limitError(`field name ${JSON.stringify(f)} in "${col}" must be letters, digits, _ . - (up to ${LIMITS.name}) — otherwise it is renamed`)
      const dl = String(d == null ? '' : d).length
      if (dl > LIMITS.fieldDescription) throw limitError(`the description of field "${f}" in "${col}" is ${n(dl)} characters; the limit is ${LIMITS.fieldDescription} — the rest would be cut`)
    }
  }
}

function buildActions(actions = []) {
  checkActionItems((Array.isArray(actions) ? actions : []).filter((a) => a && a.name && typeof a.run === 'function')) // each action; the per-turn COUNT is checked in send()
  const defs = []; const handlers = {}; const reads = {}; const names = []; const readNames = []
  for (const a of (Array.isArray(actions) ? actions : [])) {
    if (!a || !a.name || typeof a.run !== 'function') continue
    const mode = a.mode === 'await' ? 'await' : 'propose'
    defs.push({ name: a.name, description: String(a.description || a.name), inputSchema: a.input || { type: 'object', properties: {} }, mode })
    if (mode === 'await') { reads[a.name] = a.run; readNames.push(a.name) } else { handlers[a.name] = a.run; names.push(a.name) }
  }
  const readGuidance = readNames.length ? ` You can also READ from the member's device with: ${readNames.join(', ')} — call them when you need that information; they answer within the turn.` : ''
  const guidance = names.length
    ? `You also have effectful actions you can PROPOSE (never run directly): ${names.join(', ')}. When the member asks for something these cover, propose the action(s) with concrete arguments; a human approves before anything runs. Do not claim an action is done — say it is proposed and awaiting approval.`
    : ''
  return { defs, handlers, reads, guidance: guidance + readGuidance }
}

// AN ATTESTED SPACE IS COPIED ONLY INTO AN ATTESTED LANE (sync sweep 2026-11-15 #5; the app's mirrorLoop.js since 9b3853a35): a lane
// mirrors its Space's messages, so an ordinary lane of an attested Space would hand them to any device holding the lane's key — the
// app's proof every read of the Space needs would no longer protect them. A read that fails refuses (never "not attested").
async function refuseAttestedIntoPlain(client, sharedRoom, sharedMk, laneRoom, laneMk) {
  if (!client || typeof client.attestedRoom !== 'function') return
  const ask = async (room, mk) => { try { return !!(await client.attestedRoom(room, mk)) } catch (e) { throw sdkError('witbitz: whether this Space requires an attested app could not be read, so its lane waits — try again (' + ((e && e.message) || e) + ')', 'policy_unreadable') } }
  if (!(await ask(sharedRoom, sharedMk))) return
  if (!(await ask(laneRoom, laneMk))) throw sdkError('witbitz: this Space requires an attested app, so it is copied only into a lane that requires one too — this lane does not', 'attested')
}
/** A Witbitz client bound to an endpoint. Stateless besides the transport; make one and reuse it. */
export class Witbitz {
  /** @param {object} [opts] { endpoint?, tenantEndpoint?, viewer?, app?, tenant?, tenantKey?, session?, userToken?, live?, loginBase?,
   *  sentinel?, siri?, backup?, vaultApi?, deviceName?, appShare?, a2a?, a2aEndpoint?, invite?, protect?, region?, builds?, attest?,
   *  enclaveClaim?, fetchImpl?, WebSocketImpl? } —
   *  `tenant` is your tenant's PUBLIC id (never a key): Spaces this page creates are attributed to it when the page's origin
   *  is one the tenant declared. The full list, with defaults: https://witbitz.chat/docs/sdk-reference.md#configuration. */
  constructor({ endpoint = DEFAULT_ENDPOINT, tenantEndpoint, viewer = DEFAULT_VIEWER, app, tenant, tenantKey, session, loginBase, sentinel, fetchImpl, siri, live, WebSocketImpl, userToken, backup, keepTemporaryRooms = false, enclaveClaim: encClaimUrl, vaultApi, appShare, deviceName, a2a, a2aEndpoint, invite, protect, region, builds, attest, client: pluggedClient, _roomPass, _renewSignIn, _appShareMember, devRoot } = {}) {
    // THE DEV SERVER'S ATTESTATION ROOT (devserver/, the Witbitz dev server with a confidential tier): base64 DER. It REPLACES the
    // pinned AWS root for this client's confidential tier — so a client given it trusts only that local server's enclave, never
    // Witbitz's (shipped by mistake, it fails closed). Never set by default; nothing else reads it.
    this._devRoot = null
    if (devRoot) {
      try { this._devRoot = Uint8Array.from(atob(String(devRoot).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) } catch { throw sdkError('witbitz: devRoot is not base64 — pass the root the dev server printed', 'invalid_argument') }
    }
    this._region = regionCode({ region }) // where createSpace homes a new room (regions.js); an unknown code → the default region
    // `attest: { bridge }` — a device that proves itself with its own hardware or enclave (the cloud device, cloud-device/worker.mjs).
    // `attest: { app }` (a page proving it was served as your app) is RETIRED in 4.0.0 (the owner, 2026-11-22: "We dont need any
    // emulation rooms"): a web page vouching for itself is no client check.
    if (attest !== undefined && attest && typeof attest === 'object' && typeof attest.app === 'string' && !attest.bridge) throw sdkError('witbitz: attest: { app } is retired — a web page cannot prove which app it is (sdk-changes.md, 4.0.0)', 'attest_app_retired')
    if (attest !== undefined) { if (!attest || typeof attest !== 'object' || !(attest.bridge && typeof attest.bridge.platform === 'function')) throw sdkError('witbitz: attest is { bridge } — a device that proves itself', 'invalid_argument'); this._attest = makeSdkAttest({ bridge: attest.bridge, app: 'device', client: () => this._client }) } // attest.bridge: a device that proves itself (Witbitz's cloud device; not for builders)
    // LIVE (room streams): on by default in a browser; `live: false` turns it off (polling only). Needs your page's CSP
    // to allow connect-src wss://code-relay.witbitz.chat — if the socket cannot open, the SDK simply keeps polling.
    const wsImpl = WebSocketImpl || (typeof window !== 'undefined' && typeof WebSocket === 'function' ? WebSocket : null)
    this._live = live === false || !wsImpl ? null : { WebSocketImpl: wsImpl }
    this._viewer = viewer.replace(/\/+$/, '')
    // `enclaveClaim`: where the enclave's PUBLISHED measurement is served when your links point at a `viewer` of your own that
    // does not serve /enclave-claim.json itself (the error below named this option for a week before it existed, 2026-10-03). https only.
    this._encClaimUrl = typeof encClaimUrl === 'string' && /^https:\/\//.test(encClaimUrl) ? encClaimUrl : ''
    // ★ THE `auth` HOOK IS WHAT MAKES AN EMAIL-GATED ROOM USABLE (2026-09-27, a builder: "every room a secure room").
    // For a gated Space the server gates EVERY op, reads included — so identity that reaches only `turn` yields a room
    // you can write to and cannot poll. makeSpaceClient asks per room; this answers from the session, and answers
    // EMPTILY when there is none or it has expired, so an open room still works with no sign-in at all.
    // PER-USER BILLING: the token YOUR backend minted for the signed-in user (wb.users.token on your server). A string or a
    // function the SDK calls before each op that can spend, so you can refresh it there. Set later with useUserToken().
    this._userToken = userToken || null
    this._clientOpts = {
      endpoint,
      ...(app ? { app } : {}),
      ...(tenant ? { tenant } : {}),
      userToken: () => (typeof this._userToken === 'function' ? this._userToken() : this._userToken),
      delCommit: (room) => (this.erasure ? this.erasure._commitFor(room) : null), // only this account can later delete a room it created (sdkErase.js)
      // INTERNAL — a builder's VAULT (vault-core.js) only: the room pass of its account on the Witbitz account service (roomPass.js,
      // docs/device-gate-design.md) on this client's verified-Space requests. Not an option for pages.
      ...(_roomPass && typeof _roomPass.fieldsFor === 'function' ? { roomPass: _roomPass } : {}),
      ...(typeof _renewSignIn === 'function' ? { renewSignIn: _renewSignIn } : {}), // INTERNAL (the vault): renew the session once on `pass: app_unnamed`
      auth: async () => {
        const sess = this._session
        if (!sess || !sess.idToken || !sess.sign || !sess.sign.pub) return {}
        if (sess.exp && sess.exp <= Date.now()) return {}
        return { idToken: sess.idToken, spk: sess.sign.pub }
      },
      // ── THE CONFIDENTIAL TIER, per room. `enclave` marks a room's ops for the relay; `mkPub` is the ATTESTED key the
      // room key is sealed to, so the relay only ever carries opaque bytes. Both are per-room because a tier is fixed at
      // creation and one client may hold rooms of both kinds.
      // ★ mkPub goes through enclaveAccept.publishedKey: the room key is sealed only to a build Witbitz publishes (the
      // claim's pins, a rollover's set included). Rooms carry no acceptance block any more — in the Spaces app which build
      // is accepted is each PERSON's choice (trustedBuilds.js); the SDK's is wb.builds (sdkBuilds.js — 'mine' = theirs, 'published' = any published).
      enclave: (room) => this._enc.rooms.has(room),
      mkPub: (room) => {
        // the key of THIS room's region's enclave (docs/multi-region.md); the last-attested key stands in only for a
        // default-region room — a room elsewhere never borrows another region's key (its enclave could not open the seal)
        const k = this._enc.byRegion.get(roomRegion(room)) || (roomRegion(room) === DEFAULT_REGION && this._enc.key ? { key: this._enc.key, attested: this._enc.attested, platform: this._enc.platform } : null)
        if (!this._enc.rooms.has(room) || !k) return null
        return this.builds ? this.builds._key({ key: k.key, attested: k.attested, platform: k.platform, room }) : publishedKey({ key: k.key, attested: k.attested, platform: k.platform, room }) // wb.builds: the person's own list in 'mine' mode
      },
      // THE SEALED REQUEST ENVELOPE (reqEnvelope.js): this room's live enclave says, in its MEASURED policy, that it opens them
      envelope: (room) => {
        const k = this._enc.byRegion.get(roomRegion(room)) || (roomRegion(room) === DEFAULT_REGION ? { attested: this._enc.attested } : null)
        if (!this._enc.rooms.has(room)) return false
        return k ? opensEnvelopes(k.attested) : null // no attested facts here = UNKNOWN, never plaintext
      },
      // option B: the live enclave takes the sign-in from inside the envelope (its measured policy, SEALED_IDENTITY)
      identity: (room) => {
        const k = this._enc.byRegion.get(roomRegion(room)) || (roomRegion(room) === DEFAULT_REGION ? { attested: this._enc.attested } : null)
        return !!(this._enc.rooms.has(room) && k && sealsIdentity(k.attested))
      },
    }
    /** The confidential tier's session: the published claim, what the live enclave attested, and the key mk seals to. */
    this._enc = { claim: null, attested: null, platform: null, key: null, rooms: new Map(), byRegion: new Map() } // byRegion: region → { key, attested, platform }
    // A PLUGGED-IN CLIENT (docs/sdk-vault-mode.md, phase 1): a page that does not hold its rooms' keys hands the SDK a
    // client whose ops take no key — the keys live where that client sends the ops (a vault's worker). `keyless: true`
    // on it tells every Space so; the default is the direct client, which holds them here.
    this._client = pluggedClient && typeof pluggedClient === 'object' ? pluggedClient : makeSpaceClient(this._clientOpts)
    /** @type {VaultSession|null} set by {@link Witbitz.inVault}: the vault that holds this page's keys */
    this.vault = null
    // ── THE ACCOUNT HALF (2026-09-27, a builder: "our app has no Witbitz accounts — what is the intended path?").
    // A connection and a Siri key belong to an ACCOUNT: the verified email on a sign-in token, never a field a page
    // names. So the SDK signs in the same way the Spaces app's "Email me a code" does — an emailed six-digit code,
    // any address, any origin (the endpoints answer cross-origin) — and keeps the SESSION the app may persist and hand
    // back (`new Witbitz({ session })`). `loginBase` is where the code endpoints live (the reference app's origin).
    this.temporaryRooms = new TemporaryRooms(this, keepTemporaryRooms)
    this._endpoint = endpoint
    this._tenant = tenant || ''
    this._tenantKey = tenantKey || '' // SERVER-SIDE ONLY (https://witbitz.chat/docs/connections.md) — a wsk_ key in a page is a leak
    this._tenantEndpointOverride = tenantEndpoint ? String(tenantEndpoint) : '' // builder ops; derived from `endpoint` when absent
    this._loginBase = String(loginBase || viewer).replace(/\/+$/, '')
    this._fetch = typeof fetchImpl === 'function' ? fetchImpl : ((...a) => fetch(...a))
    // SPLIT-KEY ROOMS, BUILDER-HOSTED (the main path, https://witbitz.chat/docs/sdk-keys.md#split-key): the URL of YOUR function that holds
    // the app half (spaces/templates/appshare). Absent ⇒ the Witbitz-held key, for a builder who cannot host one.
    this._appShareUrl = appShare ? String(appShare) : ''
    // @private A MEMBER'S OWN DEVICE (the cloud device, which keeps only a split Space's user share): (room) → { status, appShare, commit }
    // — the app half asked with the member's proof (spaces/functions/api/appshare.js op 'member'), per open, never kept.
    this._appShareMember = typeof _appShareMember === 'function' ? _appShareMember : null
    this._session = sessionOf(session)
    if (this._session && this._session.idToken) queueMicrotask(() => this._prefetchIdentity()) // a restored session (option B: sweep 11-06 #9)
    // Advanced: a tenant running its OWN standing Sentinel pins its image here (and its Lambda's SENTINEL_HOP_PCRS);
    // `verify` is the attestation verifier (tests inject one; production uses nitroVerify through connections.js).
    // A NEW WITBITZ SENTINEL BUILD IS FOLLOWED (2.2.3; sync sweep 10-16 #4: every earlier release could only fail once its
    // pinned build was retired): `follow` 'published' (default — the app's "Accept new Witbitz builds automatically") takes
    // a build Witbitz publishes at /sentinel-claim.json; 'ask' calls `onNewBuild(pcr0)` → true to accept; 'off' keeps the
    // pins as they are. Your own `pins` are never followed.
    const fmode = sentinel && ['published', 'ask', 'off'].includes(sentinel.follow) ? sentinel.follow : 'published'
    const ownPins = !!(sentinel && Array.isArray(sentinel.pins))
    // With `devRoot` (the dev server's root): its Sentinel is checked under that root, and its builds are followed from ITS claim
    // (`viewer`/sentinel-claim.json) — never Witbitz's. Without it, as before.
    const devVerify = this._devRoot && !(sentinel && typeof sentinel.verify === 'function') ? { verify: (doc, o) => verifyAttestation(doc, { ...o, root: this._devRoot }) } : {}
    const claimDefault = this._devRoot ? String(viewer).replace(/\/+$/, '') + '/sentinel-claim.json' : DEFAULT_VIEWER + '/sentinel-claim.json'
    this._sentinel = { pins: ownPins ? sentinel.pins : STANDING_SENTINEL_PCR0, ...(sentinel && typeof sentinel.verify === 'function' ? { verify: sentinel.verify } : devVerify),
      follow: ownPins || fmode === 'off' ? null : { auto: () => fmode === 'published', ask: async (p) => !!(sentinel && typeof sentinel.onNewBuild === 'function' && await sentinel.onNewBuild(p)), claimUrl: String((sentinel && sentinel.claimUrl) || claimDefault), fetch: (u, o) => this._fetch(u, o) } }
    this._siri = siriStateOf(siri) // { token, defaultRoom, rooms: { [room]: { alias, label, pub, priv, at } } } — the app persists it (wb.siri.state)
    this.connections = new Connections(this)
    /** The person's cloud computers: list, create, open (sessions, approvals, questions, files, events), remove — sdkComputers.js. */
    this.computers = new Computers(this)
    // BUILDER OPS (tenant secret key) live in witbitz-admin.js now (sdk-roadmap item 5). These names delegate there and
    // keep working; on your server prefer `new WitbitzAdmin({ tenant, tenantKey })`, where `users` is `customers`.
    this._admin = new WitbitzAdmin({ tenant, tenantKey, endpoint, tenantEndpoint, fetchImpl: (...a) => this._fetch(...a), sentinel })
    this.providers = this._admin.providers
    this.hosts = this._admin.hosts
    this.origins = this._admin.origins
    this.rooms = this._admin.rooms
    this.users = this._admin.customers
    this.billing = this._admin.billing
    if (tenantKey && typeof window !== 'undefined' && typeof document !== 'undefined') {
      // A wsk_ key in a page is readable by every visitor. Not refused (a local tool may do this on purpose), but said.
      try { console.warn('witbitz: a tenant SECRET key was passed to new Witbitz() in a browser page — anyone who opens the page can read it. Use WitbitzAdmin on your server (witbitz-admin.js).') } catch { /* */ }
    }
    this.siri = new SiriAccount(this)
    /** The signed-in member's @username (global across Witbitz): claim / release / mine / resolve. */
    this.usernames = new Usernames(this)
    /** The ACCOUNT BACKUP (sdkBackup.js): `enable()` → a recovery code; rooms are recorded as this client creates and
     *  opens them; `restore({ code })` on a new device hands them back. `backup` is a prior `wb.backup.state`. */
    this.backup = new AccountBackup({ fetch: this._fetch, tenant: this._tenant, ...(vaultApi ? { base: vaultApi } : {}), state: backup || null, email: () => (this._session && this._session.email) || '' })
    this._archiveGeneration = 0
    this.backup._onEnabled = master => {
      for (const sp of this._archiveHandles || []) if (!sp._archiveMaster && sp._archiveEmail === (this._session?.email || '') && sp._archiveGeneration === this._archiveGeneration) sp._archiveMaster = master
    }
    /** @type {Erasure} the tenant's erase of a user reaches the rooms this account created (sdkErase.js) */
    this.erasure = new Erasure(this)
    /** Which enclave build this person accepts (sdkBuilds.js): `new Witbitz({ builds: 'mine' })` = their own list, the app's rules. */
    this.builds = new Builds(this, typeof builds === 'string' ? { mode: builds } : (builds && typeof builds === 'object' ? builds : {}))
    /** DEVICE STORAGE PROTECTION (sdkProtect.js): what the app keeps on the device — the session, room snapshots, the Siri /
     *  A2A / backup state — sealed under a key a platform passkey derives, nowhere on disk. `protect`: { storage, storeKey,
     *  rpId, rpName } (localStorage and this page's host by default). Off until `wb.protect.enable()`. */
    // An app opens its protected storage BEFORE it builds the client (the session and the backup state are constructor
    // options): `new Protect()` → unlock → load → `new Witbitz({ protect, session, backup })` adopts that same object.
    // Recognised by what it does, not instanceof: a page that loaded sdkProtect.js under another URL has another class object.
    const isProtect = (x) => x instanceof Protect || !!(x && typeof x === 'object' && ['unlock', 'lock', 'seal', 'open', 'save', 'load'].every((m) => typeof x[m] === 'function'))
    this.protect = isProtect(protect) ? protect : new Protect({ ...(protect && typeof protect === 'object' ? protect : {}), backup: this.backup })
    if (!this.protect._backup) this.protect._backup = this.backup
    /** A2A into private lanes (sdkA2A.js): the account's record — which lanes outside agents may reach. Persist
     *  `wb.a2a.state` (it holds the lanes' inbox private keys) and hand it back as `new Witbitz({ a2a })`. */
    this.a2a = new A2AAccount(this, { state: a2a || null, ...(a2aEndpoint ? { endpoint: a2aEndpoint } : {}) })
    /** This account's INVITE KEY for this app (sdkRekey.js, https://witbitz.chat/docs/sdk-people.md#members): published at sign-in, it is
     *  what a member change in place seals a Space's new key to. Persist `wb.invite.state` (a private key) as you persist the
     *  session and hand it back as `new Witbitz({ invite })`; with a backup on, it rides the backup too. */
    this.invite = new InviteAccount(this, { state: invite || null })
    this.cloudDevice = new CloudDevice(this)
    /** The account's LIVE index (sdkAccount.js): the rooms, archived/forgotten marks and devices, kept in step between every
     *  device that holds the backup. In a browser it syncs on its own once the backup is on; `sync()` any time. */
    this.account = new AccountIndex({ backup: this.backup, client: () => this._client, deviceName: deviceName || '', viewer: this._viewer, live: () => this._live, version: SDK_VERSION })
    this.account._deleteLockTarget = async (kind, target, current, approved, afterRemoval) => {
      if (kind === 'code') return this.computers._deleteLockedSession(target, current)
      if (kind !== 'room' || !current()) return false
      const fresh = await this.account.sync()
      if (!current() || !fresh?.ok) return false
      const children = this.backup.rooms.filter(r => r.shared === target && !r.detachedLane)
      if (children.some(r => r.laneOrigin === 'minted' && !approved.has(r.room))) return false
      for (const child of children) {
        if (child.laneOrigin === 'minted') this.account.forget(child.room)
        else this.backup._detachLane(child.room, target)
      }
      this.account.forget(target)
      const synced = await this.account.sync()
      if (!current() || !synced?.ok) return false
      await this.backup.save()
      if (!current() || this.backup.rooms.some(r => r.room === target || r.shared === target)) return false
      if (afterRemoval) for (const child of children) {
        if (!current()) return false
        if (child.laneOrigin === 'minted') await afterRemoval('room', child.room)
      }
      return current()
    }
    this.account._pruneAgents = () => this.a2a._pruneForgotten()

    this.account._emptyHooks = () => this._emptySpaceHooks()
    this.account._readName = async row => {
      const { mk } = await this._openLink(row.link)
      const [history, doc] = await Promise.all([
        readAllPages(since => this._client.poll(row.room, mk, undefined, since)),
        this._client.state(row.room, mk, 'title').catch(() => null),
      ])
      if (history.incomplete) return null
      return { entries: history.entries, doc }
    }
    this.backup._afterMigration = async ({ signed = false } = {}) => {
      const state = this.backup._s, current = () => { if (this.backup._s !== state) throw sdkError('witbitz: the account changed during migration', 'account_changed') }
      this.account._spk = await this.backup._v2.deviceSpk(this.backup); current()
      const read = await this.account.sync(); current()
      if (!read || !read.ok) throw sdkError('witbitz: the account index could not be read; retry migration', 'index_unavailable')
      if (signed) return
      for (const d of this.account.devices) if (d.id !== this.account.deviceId) this.account.signOut(d.id, { reason: 'moved' })
      const saved = await this.account.sync(); current()
      if (!saved || !saved.ok) throw sdkError('witbitz: other devices could not be signed out; retry migration', 'index_unavailable')
    }
    if (typeof window !== 'undefined' && this.backup.enabled) this.account.start()
    // Credentials stay readable by name and out of Object.keys / JSON / error-reporter walks (sdkRedact.js).
    hide(this, ['_session', '_tenantKey', '_userToken', '_siri', '_clientOpts', '_client', '_enc', '_admin', 'backup', 'account', 'a2a', 'invite', 'protect', 'erasure'])
  }

  /** IN A VAULT (docs/sdk-vault-mode.md): this page is framed by a vault YOU host on another origin, which keeps every room
   *  key in its own worker — the page never holds one (no `space.key`, no key in a link, nothing in its storage). Sign-in,
   *  creating a Space and sharing it happen in the vault; reading and sending work here as everywhere else.
   *  @param {object} opts { vault, ...the usual options } — `vault`: the vault's origin, e.g. 'https://vault.example.com'.
   *  @returns {Promise<Witbitz>} a client whose `vault` is the {@link VaultSession}; rejects `not_in_vault` when the page is
   *   not framed by that origin. */
  static async inVault({ vault, ...opts } = {}) { return Witbitz._withVault(await connectVault({ vault }), opts) }
  /** @private a client over an open vault connection (connectVault's) — tests hand in their own. */
  static _withVault(conn, opts = {}) {
    // REFUSED BY NAME, BEFORE ANYTHING IS MADE (sync sweep 11-09 #17, #24): a session handed to inVault would be adopted
    // although the vault keeps the session (useSession is refused here, so this was the way round it); and `attest` cannot
    // work in a vault — the keyless client has no enrolment, the vault answers no read proof, and a proof would bind the
    // page's key, not the vault's (hosting.md § Rooms only your app may use)
    if (opts && opts.session !== undefined && opts.session !== null) throw sdkError('witbitz: in a vault, the vault keeps the session — do not pass one to Witbitz.inVault (wb.vault.signIn() / wb.vault.info.email)', 'vault_signs_in')
    for (const name of ['devRoot', 'enclaveClaim']) if (opts?.[name] !== undefined) throw sdkError('witbitz: the vault supplies ' + name, 'vault_unsupported')
    if (opts && opts.sentinel !== undefined) throw sdkError('witbitz: the vault supplies the Sentinel trust settings', 'vault_unsupported')
    if (opts && opts.attest !== undefined) throw sdkError("witbitz: attest is not available in a vault — attest is { bridge }, for a device that proves itself with its own hardware or enclave (a page's own proof, attest: { app }, was retired in 4.0.0)", 'vault_unsupported') // sync sweep 2026-11-23 #19: it pointed to the retired feature
    // THE ACCOUNT'S STATE IS THE VAULT'S (sync sweep 11-13 P7): a persisted `backup` / `siri` / `a2a` / `invite` state was taken
    // into the page — the backup's master secret, the Siri and A2A inboxes' private keys, the invite key — and a backup that was
    // on started the page's own account loop beside the vault's. The vault keeps them (its getters read null here, `restore`
    // refuses): refused by name, before anything is made. null = none, as for `session`.
    for (const k of ['backup', 'siri', 'a2a', 'invite']) if (opts && opts[k] !== undefined && opts[k] !== null) throw sdkError(`witbitz: in a vault, the vault keeps the account's ${k} state — do not pass \`${k}\` to Witbitz.inVault`, 'vault_unsupported')
    // PER-USER BILLING REACHES THE VAULT (sync sweep, 10-17 #5): the vault's worker asks for the token on each op that can
    // spend, and the vault had none to give — billing was silently off, and requireUserToken refused every vault turn. The
    // page hands its current token to the vault right before each such op; the vault keeps it in memory only.
    const vc = conn.client && { ...conn.client }
    if (vc && typeof conn.userToken === 'function') {
      const queueKey = Symbol.for('witbitz.vault.legacyBilling')
      const queues = globalThis[queueKey] ||= new Map()
      const scope = conn.origin || conn
      const tokenSlot = { turn: 5, title: 4, decide: 6, importChat: 3, importWhatsApp: 3 }
      for (const op of Object.keys(tokenSlot)) {
        const orig = vc[op]; if (typeof orig !== 'function') continue
        vc[op] = async (...args) => {
          const source = wb._userToken
          let token = ''
          try {
            const value = typeof source === 'function' ? await source() : source
            if (typeof value === 'string' && value.length <= 4096) token = value
          } catch { /* a missing billing token follows this operation's normal authorization rules */ }
          args[tokenSlot[op]] = token
          if (conn.info?.billingPerCall) return orig(...args)
          const run = (queues.get(scope) || Promise.resolve()).then(async () => {
            try { await conn.userToken(token) }
            catch (error) { if (token || error?.code !== 'vault_refused') throw error }
            return orig(...args)
          })
          const settled = run.catch(() => {})
          queues.set(scope, settled)
          settled.then(() => { if (queues.get(scope) === settled) queues.delete(scope) })
          return run
        }
      }
    }
    const wb = new Witbitz({ ...opts, builds: typeof opts.builds === 'object' && opts.builds ? { mode: opts.builds.mode } : opts.builds, ...(conn.info && conn.info.endpoint ? { endpoint: conn.info.endpoint } : {}), live: false, client: vc })
    wb._vaultLive = opts.live !== false // the page's own socket stays off (live: false); the vault streams for it unless the page said live: false
    wb.vault = new VaultSession(wb, conn)
    refuseInVault(wb)
    return wb
  }

  /** PER-USER BILLING, in the PAGE: bill this user's turns to their own key. `token` is what your backend got from
   *  `wb.users.token(userId)` — a string, or a function (sync or async) returning a fresh one; null stops sending it.
   *  It is sent only on ops that can spend (a turn, a title, approving an action, an import). A token that does not hold
   *  is REFUSED (code user_token_invalid / user_key_unavailable), never billed to you. */
  _forgetVoice() { this._dictation?._resetPayer(); this._speech?._resetPayer() }
  useUserToken(token) { if (this._userToken !== (token || null)) this._forgetVoice(); this._userToken = token || null; return this }

  /** The signed-in session `{ email, idToken, exp, sign }`, or null. JSON-safe: persist it and pass it back as
   *  `new Witbitz({ session })`. It carries a private signing key — keep it where you keep secrets. */
  get session() { return this._session }
  /** Adopt a session persisted earlier (or drop it with null). */
  useSession(session) {
    const next = sessionOf(session)
    const scope = s => { const c = tokenClaims(s?.idToken); return firstPartyAppOf(c) === 'vaulted' ? VAULTED_APP : tokenApp(c) }
    if (this._session?.email !== next?.email || scope(this._session) !== scope(next)) {
      // The generation marks handles of the account that is LEAVING, so nothing of it runs on into the next one. A first sign-in
      // (nobody → an account) leaves no account: bumped all the same, every Space opened before signing in — the usual order on a
      // page that opens by link — had its handle closed for embed, assistant memory, linkPrivateRoom and the offline export
      // (second review, 2026-11-27).
      if (this._session) this._archiveGeneration++
      this._forgetVoice()
      if (this._session) { this._forgetSiriAccount(); this.a2a?._resetAccount() }
    }
    this._session = next
    if (next?.idToken) this._prefetchIdentity()
    return this
  }
  _forgetSiriAccount() {
    const backup = this.backup?._s
    if (backup && this._session?.email) {
      this._siriBackupOwners ||= new WeakMap()
      if (!this._siriBackupOwners.has(backup)) this._siriBackupOwners.set(backup, this._session.email)
    }
    this._siri = siriStateOf(null)
  }
  /** The ACCOUNT this sign-in acts on (accountScope.js): the email for a sign-in made on Witbitz's own pages; an account of
   *  this app's own (`dana@x.com.app-…`) for one made on yours — connections, Siri and A2A here are this app's, and the user's
   *  own Witbitz account is not reachable from your page. '' when nobody is signed in. */
  // ⛔ A SIGN-IN MADE IN THE HOSTED APP acts on the hosted app's own account (`…app-<hash of app.witbitz.chat>`), as the Lambda
  //   derives it (sentinelAccount by origin; SENTINEL_APP_BY_TOKEN holds the token's app to it). The plain email here made the
  //   cloud device's a2areply for a hosted account refused (sentinel_refused) — the job ran, its answer never got back
  //   (the owner's iPhone, 2026-11-25).
  async _account() { const s = this._session; if (!s || !s.email) return ''; const c = tokenClaims(s.idToken); return firstPartyAppOf(c) === 'vaulted' ? sentinelAccount(s.email, c, { origin: VAULTED_APP }) : scopedAccount(s.email, c) }

  /** Sign in with an emailed code, in two calls. `signIn({ email })` sends a six-digit code and returns a pending
   *  `{ ticket, email }`; `signIn({ email, ticket, code })` verifies it and returns the session (also kept on this
   *  client). The token is issued by Witbitz's own email provider and verifies like a Google token; any address works.
   *  @returns {Promise<{ ticket:string, email:string } | { email:string, idToken:string, exp:number, sign:object }>} */
  async signIn({ email, code, ticket, room = '' } = {}) {
    const result = await this._signInResult({ email, code, ticket, room })
    if (!code) return result
    this.useSession(result)
    this._enrollInvite()
    return result
  }

  async _signInResult({ email, code, ticket, room = '' } = {}) {
    const addr = String(email || '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw sdkError('witbitz: signIn needs a valid email address', 'invalid_argument')
    const post = this._emailPost() // emailSignIn.js — the protocol the vault and the Spaces app sign in with
    if (!code) {
      // A fresh signing key per session, bound into the token through the nonce (the same binding the app uses), so a
      // later slice can sign with it; nothing else reads it today.
      const g = await genKeypair(); const sign = { priv: g.priv, pub: g.pub }
      const nonce = await spkNonce(sign.pub)
      let ticket
      try { ({ ticket } = await emailStart(post, { email: addr, room, nonce, tenant: this._tenant })) } catch (e) {
        throw Object.assign(new Error(e.code === 'not_configured' ? 'witbitz: email codes are not available on this deployment' : 'witbitz: could not send a code' + (e.reason ? ` (${e.reason})` : '')), { code: e.code, reason: e.reason, hint: e.message })
      }
      this._pendingSignIn = { ticket, email: addr, sign }
      return { ticket, email: addr }
    }
    const pend = this._pendingSignIn && (!ticket || this._pendingSignIn.ticket === ticket) ? this._pendingSignIn : null
    const tk = ticket || (pend && pend.ticket)
    if (!tk) throw sdkError('witbitz: signIn({ email }) first — the code needs the ticket it was sent for', 'invalid_argument')
    let v
    try { v = await emailVerify(post, { ticket: tk, code }) } catch (e) {
      throw Object.assign(new Error('witbitz: the code was not accepted' + (e.reason ? ` (${e.reason})` : '')), { code: e.code, reason: e.reason, hint: e.message })
    }
    if ((v.email && v.email !== addr) || (pend && pend.email !== addr)) throw sdkError('The code belongs to a different address', 'account_changed')
    this._pendingSignIn = null
    return { email: v.email || addr, idToken: v.jwt, exp: v.exp, ...(pend && pend.sign ? { sign: pend.sign } : {}) }
  }
  /** Renew the session WITHOUT a new code — before it expires (`wb.session.exp`): a fresh signing key, and the old one
   *  proves this is the device that verified (the same renewal the Spaces app runs). Throws code 'refresh_failed' when
   *  the server will not renew it (expired, revoked) → sign in again. Persist the result like the session itself. */
  async refreshSession() {
    const s = this._session
    if (!s || !s.idToken || !s.sign) throw Object.assign(new Error('witbitz: refreshSession needs a session from signIn() on this client'), { code: 'no_session' })
    const g = await genKeypair(); const sign = { priv: g.priv, pub: g.pub }
    const r = await emailRefresh(this._emailPost(), { throwOnRefusal: true, token: s.idToken, kpOld: s.sign, newNonce: await spkNonce(sign.pub), ...(this._tenant ? { tenant: this._tenant } : {}) }) // tenant: the renewed token names this app (§ 12.1)
    if (!r) throw Object.assign(new Error('witbitz: the session could not be renewed — sign in again'), { code: 'refresh_failed' })
    if (this._session !== s) throw sdkError('witbitz: the session changed during renewal', 'account_changed')
    this._session = { email: r.email || s.email, idToken: r.jwt, exp: r.exp, sign }
    this._enrollInvite()
    return this._session
  }
  // the invite key is published in the background: a sign-in never waits on it, a failure costs only a later member change
  _enrollInvite() { try { this._inviteP = this.invite.enroll().catch(() => null) } catch { /* */ } this._prefetchIdentity() }
  // OPTION B: this sign-in's hints are fetched IN THE BACKGROUND — a few seconds after sign-in (and on a restored session), then
  // hourly — never right before a room request, so the fetch's timing does not tie it to a room (docs/confidential-identity-
  // option-b.md; sweep 11-06 #9: nothing ever called it, so the first fetch went just before the first room request).
  _prefetchIdentity(delayMs = 2000 + Math.floor(Math.random() * 8000)) {
    try {
      clearTimeout(this._idPrefetchT)
      this._idPrefetchT = setTimeout(() => {
        const s = this._session, c = this._client
        if (s && s.idToken && c && typeof c.prefetchIdentity === 'function') c.prefetchIdentity(s.idToken).catch(() => {})
        if (s && s.idToken) this._prefetchIdentity(50 * 60_000 + Math.floor(Math.random() * 10 * 60_000))
      }, delayMs)
      if (this._idPrefetchT && typeof this._idPrefetchT.unref === 'function') this._idPrefetchT.unref() // never keeps a Node process alive
    } catch { /* the next sealed request fetches them */ }
  }
  _emailPost() { return makeEmailPost(this._loginBase, { fetchImpl: (...a) => this._fetch(...a) }) }
  /** Forget the session on this client (the token simply expires server-side). */
  signOut() { this.a2a?._resetAccount(); this._forgetSiriAccount(); this._forgetVoice(); this._archiveGeneration++; this._session = null; return this }

  /** Press-to-talk: `const mic = wb.dictation(); await mic.start({ onPartial }); const text = await mic.stop()`. The
   *  microphone streams straight from the page to Tinfoil's confidential realtime enclave — never through Witbitz — on a
   *  short-lived key Witbitz mints for the signed-in user (wb.signIn) or the user your backend vouched for
   *  (wb.useUserToken). One per client; 13 languages, not Hebrew. Your page's CSP must allow
   *  `connect-src wss://inference.tinfoil.sh`. https://witbitz.chat/docs/sdk-assistant.md#dictation.
   *  @returns {Dictation} */
  dictation() {
    return (this._dictation = this._dictation || new Dictation(this, this._live ? { WebSocketImpl: this._live.WebSocketImpl } : {}))
  }

  /** Text read aloud: `await wb.speak('Your table is booked.')`; `wb.speech.stop()`, `wb.speech.playing`. The same player as
   *  the Spaces app's "Play aloud": the text goes straight from the page to Tinfoil's attested speech model on a short-lived
   *  key Witbitz mints for the signed-in user (wb.signIn) or the user your backend vouched for (wb.useUserToken). Not
   *  Hebrew. Your page's CSP must allow `connect-src https://inference.tinfoil.sh` and `media-src blob:`.
   *  https://witbitz.chat/docs/sdk-assistant.md#speak. @returns {Speech} */
  get speech() {
    return (this._speech = this._speech || new Speech(this))
  }
  /** Read `text` aloud → resolves when it has played (wb.speech.play). */
  speak(text) { return this.speech.play(text) }

  /** @private the sentinel door: `{ idToken }` for a live session, or a clear error. */
  _auth(what = 'connections and the Siri inbox belong') {
    const sess = this._session
    if (!sess || !sess.idToken) throw Object.assign(new Error(`witbitz: sign in first (${signInHow(this)}) — ${what} to an account`), { code: 'sign_in_required' })
    if (sess.exp && sess.exp <= Date.now()) throw Object.assign(new Error(`witbitz: the sign-in has expired — ${signInHow(this)} again`), { code: 'sign_in_required' })
    return { idToken: sess.idToken }
  }
  _sentinelPost() { return (body) => this._client.sentinel(body.sentinel, body.idToken) }
  /** With `devRoot` (the dev server): the cloud device is the dev server's — its attestation checked under that root, against the
   *  measurement the dev server publishes at <viewer>/cloud-device-claim.json; never Witbitz's pins or followed images. Else
   *  undefined: Witbitz's own pins, unchanged. */
  async _cloudDeviceOpts() {
    if (!this._devRoot) return undefined
    if (!this._cdDev) {
      const url = this._viewer.replace(/\/+$/, '') + '/cloud-device-claim.json'
      const r = await this._fetch(url)
      if (!r.ok) throw sdkError(`witbitz: the dev server's cloud device could not be found (${url} answered ${r.status})`, r.status === 404 ? 'not_in_dev_server' : 'offline')
      const claim = await r.json()
      const pins = Array.isArray(claim && claim.pcr0) ? claim.pcr0.filter((p) => /^[0-9a-f]{96}$/.test(p)) : []
      if (!claim || claim.dev !== true || !pins.length) throw sdkError(`witbitz: ${url} is not a dev server's cloud-device claim`, 'attestation')
      this._cdDev = { pins, verify: (doc, o) => verifyAttestation(doc, { ...o, root: this._devRoot }), follow: null }
    }
    return this._cdDev
  }
  /** The models this deployment offers on a tier, each with the reasoning efforts it takes:
   *  `[{ id, label, wire, efforts, defaultEffort, default }]`. `efforts: []` = the model takes none; `null` = not measured.
   *  Pass `model: { catalog: id, params: { reasoning_effort } }` to `createSpace` / `configure` to choose one.
   *  @param {object} [opts] { tier?: 'standard' | 'enclave' } */
  async models({ tier } = {}) {
    const all = await this._modelCatalog()
    if (!all) { const e = new Error('witbitz: the model catalog could not be fetched'); e.code = 'unavailable'; throw e }
    return tierIsEnclave(tier) ? all.confidential : all.regular
  }

  /** Both tiers' rows, fetched once; null (and not remembered) when the endpoint does not answer. */
  async _modelCatalog() {
    if (this._models) return this._models
    const r = await this._encPost({ op: 'models' }).catch(() => null)
    if (!r || !Array.isArray(r.regular)) return null
    this._models = { regular: r.regular, confidential: Array.isArray(r.confidential) ? r.confidential : [], tempRooms: r.tempRooms === true } // tempRooms: this deployment wipes temporary rooms (createSpace({ temporary }))
    return this._models
  }

  /** checkModelEffort against the live catalog. A catalog that cannot be fetched checks the ladder only — the server
   *  fits the value either way, so an unreachable list must not block creating a room. */
  async _checkModel(model) {
    const effort = model && typeof model === 'object' && model.params ? model.params.reasoning_effort : undefined
    if (effort === undefined || effort === null) return
    const all = await this._modelCatalog()
    checkModelEffort(model, all ? [...all.regular, ...all.confidential] : [])
  }

  // ── THE CONFIDENTIAL TIER ────────────────────────────────────────────────────────────────────────────────────────
  /** One POST straight at the Space endpoint, for the enclave ops the room client does not model (attest, wake, and
   *  handing the enclave its own copy of the config). */
  async _encPost(body) {
    const r = await this._fetch(this._endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try { return await r.json() } catch { return null }
  }

  /** Fetch the platform's PUBLISHED claim — what it says it currently runs — and verify the LIVE enclave against it.
   *  Refreshes the key mk seals to, which changes on every wake, so this runs again after one. */
  /** The platform's PUBLISHED claim document. ★ FAILS LOUDLY, BY CODE. `viewer` is documented as the share-link base
   *  and doubles as this URL's origin, so a builder who points links at their own origin — the documented thing to do —
   *  used to get a failed fetch that `createSpace` swallowed, and a room minted with NOTHING pinned, reported as
   *  success. That is the tier's whole promise turned off by a cosmetic setting. The derivation stays (a staging viewer
   *  needs a staging claim); what changes is that anything other than a claim document now refuses and says which URL
   *  it tried. Distinct from a LIVE attestation failure, which is a legitimate cold start and stays soft. */
  async _encClaimDoc() {
    if (this._enc.claim) return this._enc.claim
    const url = (this._encClaimUrl || (this._viewer.replace(/\/+$/, '') + '/enclave-claim.json'))
    const bad = (why) => {
      const e = new Error(`witbitz: the enclave's published measurement could not be read from ${url} — ${why}. That URL comes from \`viewer\`; if your links point at your own origin, pass the claim's real URL as \`new Witbitz({ enclaveClaim })\`. Refusing rather than minting a confidential room that pins nothing.`)
      e.code = 'enclave_claim_unavailable'
      return e
    }
    let r
    try { r = await this._fetch(url, { cache: 'no-store' }) } catch { throw bad('it could not be fetched') } // never a cached copy: a stale measurement rejects a legitimately rebuilt enclave
    if (r && r.ok === false && r.status === 404) { // the Witbitz dev server (devserver/) has no confidential tier, and says so
      const j = await r.json().catch(() => null)
      if (j && j.error === 'not_in_dev_server') throw sdkError('witbitz: confidential Spaces are not available on the Witbitz dev server — create a standard Space there, or use Witbitz itself for this tier', 'not_in_dev_server')
    }
    if (!r || r.ok === false) throw bad(`it answered ${(r && r.status) || 'nothing'}`)
    let claim
    try { claim = await r.json() } catch { throw bad('it did not answer JSON — an app shell or a 404 page, most likely') }
    if (!claim || typeof claim !== 'object' || !claim.enclave) throw bad('it answered JSON that is not a claim document')
    this._enc.claim = claim
    this._enc.claimUrl = url // the policy text it names is fetched from HERE, not from the page — see _policyFetcher
    return claim
  }

  /** ⛔ THE POLICY TEXT COMES FROM THE CLAIM'S ORIGIN, BOUNDED (a builder, 2026-09-29: openSpace on a confidential room
   *  hung for ever in headless Firefox after "enclave-claim.json, one /v1/space request, then nothing"). The claim names
   *  its policy by a RELATIVE url; attestEnclave's default fetch() resolves that against the PAGE, so on a builder's site
   *  it went to the builder's server — never the right bytes, and on a server that holds the request open, a hang with
   *  no timeout. Node and the Witbitz app never showed it: there the page origin is the viewer, or there is no page. */
  _policyFetcher(claimUrl) {
    return async (u) => {
      const url = new URL(String(u), claimUrl).href
      const ac = typeof AbortController === 'function' ? new AbortController() : null
      const timer = ac ? setTimeout(() => ac.abort(), this._policyTimeoutMs ?? 10000) : null
      try {
        const r = await this._fetch(url, { cache: 'no-store', ...(ac ? { signal: ac.signal } : {}) }) // network-only: a cached policy text is a stale one
        if (!r || r.ok === false) throw sdkError(`enclave: policy text ${(r && r.status) || 'unreachable'} at ${url}`, 'enclave_claim_unavailable')
        return new Uint8Array(await r.arrayBuffer())
      } finally { if (timer) clearTimeout(timer) }
    }
  }

  /** Attest the enclave that serves `room` (its region's — the request names the room, so the front forwards it), and keep
   *  its key under that region. No room (a room not minted yet): the facts of whichever enclave answers — every region
   *  runs the same measured build — and the key is kept under the default region only when no room says otherwise. */
  async _encAttest(room) {
    await this._encClaimDoc()
    const { recipientJwk, attested } = await attestEnclave({ room, send: (b) => this._encPost(b), claim: this._enc.claim, ...(this._devRoot ? { root: this._devRoot } : {}), fetchPolicy: this._policyFetcher(this._enc.claimUrl || (this._viewer.replace(/\/+$/, '') + '/enclave-claim.json')) })
    let platform = null
    try { const c = enclaveClaim(this._enc.claim); platform = c ? { pcrs: c.pcrs } : null } catch { platform = null }
    this._enc = { ...this._enc, attested, platform, key: recipientJwk }
    if (room) this._enc.byRegion.set(roomRegion(room), { key: recipientJwk, attested, platform })
    else if (!this._enc.byRegion.has(DEFAULT_REGION)) this._enc.byRegion.set(DEFAULT_REGION, { key: recipientJwk, attested, platform })
    try { if (this.builds) this.builds._attested(room ? roomRegion(room) : DEFAULT_REGION, attested, platform) } catch { /* first use / automatic is best-effort; the gate decides */ }
    return attested
  }

  /** Route an EXISTING room's ops to the enclave, before anything is asked of it. Provisional on purpose: it is what
   *  makes the very next call — the open — an enclave call rather than the 404 against the standard relay. */
  async _encAdopt(room) {
    if (!room || this._enc.rooms.has(room)) return
    await this._encAttestSoft(room)
    this._enc.rooms.set(room, true)
  }

  /** Attest before a NEW confidential room is made. Two failures look alike from the outside and must not be treated alike:
   *  a LIVE attestation failure is the documented cold start (mint in follow mode, pin nothing, wake it next), while a
   *  CONFIGURATION failure means we never saw a measurement at all — and swallowing that mints a confidential room
   *  whose acceptance pins nothing, which is the one outcome this tier exists to prevent. Soft for the first, loud for
   *  the second. */
  async _encAttestSoft(room) {
    try { return await this._encAttest(room) } catch (e) {
      if (e && (e.code === 'enclave_claim_unavailable' || e.code === 'not_in_dev_server')) throw e // a configuration answer, never a cold start
      // A document that ARRIVED but does not chain to the trusted root (or is not signed by its own certificate) is never a cold
      // start: no enclave of ours can produce one. A measurement mismatch stays soft — a rebuilt enclave meets a claim that lags.
      if (e && typeof e.message === 'string' && /^(chain: |attestation: COSE signature does not verify)/.test(e.message)) {
        throw sdkError(`witbitz: the enclave's attestation does not chain to the trusted root (${e.message}) — refusing to trust it`, 'attestation_untrusted')
      }
      return null
    }
  }

  /** Wait until the enclave is up AND attested. Returns the attestation, or throws when it never came. */
  async _encWake(room, { tries = 45, waitMs = 8000 } = {}) {
    for (let i = 0; i < tries; i++) {
      try { await this._encPost({ op: 'wake', enclave: true, room }) } catch { /* keep trying */ }
      try { return await this._encAttest(room) } catch { /* not up yet */ }
      await new Promise((res) => setTimeout(res, waitMs))
    }
    throw Object.assign(new Error('witbitz: the enclave did not come up — the Space exists, but nothing has been sent to it'), { code: 'enclave_unavailable' })
  }

  /** ★ Hand the enclave its OWN copy of the sealed config, BEFORE the first turn. The enclave reads the room record
   *  from its own store, which holds only the mk-commitment — without this the turn runs a DEFAULT agent instead of the
   *  one that was asked for, and it is too late once a turn has run. */
  async _encSealConfig(room, commit, configSealed) {
    if (!configSealed) return false
    const r = await this._encPost({ op: 'create', enclave: true, room, ...(commit ? { commit } : {}), configSealed })
    return !!(r && (r.ok || r.status === 200 || r.created || r.exists || r.error === 'exists')) // 409 { error: 'exists' }: the create already carried it there (spaceRoom.mjs)
  }

  /** Feature detection, mostly for on-prem deployments: this SDK's version and features, the declaration limits, which
   *  tiers this deployment serves (the confidential tier = its published measurement can be read) and its models.
   *  → { sdk, endpoint, features, limits, tiers: { standard, enclave }, models: { regular, confidential } | null } */
  async capabilities() {
    const models = await this._modelCatalog().catch(() => null)
    let enclave = this.vault ? null : false
    if (this.vault?._c?.info?.tierQuery) enclave = await this.vault._c.enclaveAvailable().catch(() => null)
    if (!this.vault) try { await this._encClaimDoc(); enclave = true } catch { /* no published claim: no confidential tier here */ }
    const ids = (l) => (Array.isArray(l) ? l.map((m) => m && m.id).filter(Boolean) : [])
    return { sdk: SDK_VERSION, endpoint: this._endpoint, features: [...FEATURES], limits: { ...LIMITS }, tiers: { standard: true, enclave }, models: models ? { regular: ids(models.regular), confidential: ids(models.confidential) } : null }
  }

  /** Is this tenant key good, and whose is it? → `{ ok: true, tenant }` or `{ ok: false, reason }`. See WitbitzAdmin. */
  async verifyTenantKey() { return this._admin.verifyTenantKey() }
  _roomDeleteEndpoint() {
    const endpoint = this._tenantEndpoint()
    if (!/\/tenant-space(?=$|[?#])/.test(endpoint)) throw sdkError('witbitz: room deletion requires a tenant-space endpoint', 'invalid_endpoint')
    return endpoint.replace(/\/tenant-space(?=$|[?#])/, '/spaces/rooms/delete')
  }
  _tenantEndpoint() { return this._admin._tenantEndpoint() }
  _tenantRest(...a) { return this._admin._tenantRest(...a) }
  _tenantPost() { return this._admin._tenantPost() }

  /** Create a shared, private, agent-backed Space. → a live {@link Space}.
   *  @param {object} [opts]
   *  @param {object} [opts.agent] { name, instructions, tools?, model? }
   *  @param {object[]} [opts.tools] your app's tool definitions { name, description?, inputSchema?, readOnly?, autoRun? } (the platform's own tools: opts.platformTools)
   *  @param {string[]} [opts.immediateTools] the subset it may call WITHOUT human approval (others become proposals)
   *  @param {string|object} [opts.model] a model id, or { catalog, params: { reasoning_effort } } (checkModelEffort)
   *  @param {object} [opts.data] the store's collections { col: { description?, fields: { f: 'what it is' }, write?: 'admins' } }
   *  @param {object} [opts.admission] { emails, domains, advertise?, admins?, owners? } — the email gate, create-time only
   *  @param {string} [opts.tier] 'standard' (default) | 'enclave' — the confidential tier, create-time only
   *  @param {string} [opts.key] 'standard' (default) | 'split' — a split-key room (needs `appShare` or `tenant`)
   *  @param {string} [opts.region] the room's home region, a code from regions.js (e.g. 'us'); default: `new Witbitz({ region })`, else the default region
   *  @param {boolean} [opts.safeMedia] SAFE MEDIA: others' photos and PDFs are shown only from copies an attested enclave made safe (space.safeMedia)
   *  @param {boolean} [opts.lanes] A PRIVATE ASSISTANT FOR EVERYONE, as the app's New Space option: sealed in the room, and the link says so (space.lanes) */
  async recreateSpace(bundle, opts = {}) {
    const { recreateExport } = await import('./sdkExports.js')
    return recreateExport(this, bundle, opts)
  }
  async saveOfflineReader() {
    const { saveOfflineReader } = await import('./sdkExports.js')
    return saveOfflineReader()
  }
  async exportOfflineArchive({ recoveryKeys = false, rooms, destination = 'download' } = {}) {
    if (!['download', 'clipboard'].includes(destination) || (destination === 'clipboard' && recoveryKeys !== true)) throw sdkError('Clipboard export requires recoveryKeys', 'invalid_argument')
    if (rooms !== undefined && (!Array.isArray(rooms) || rooms.some(sp => !sp || sp._wb !== this || sp._stopped || !sp.room))) throw sdkError('select open Spaces from this SDK client', 'invalid_argument')
    if (this.vault) return this.vault._c.account('backup', 'exportArchive', recoveryKeys === true, rooms?.map(sp => sp.room), ...(destination === 'clipboard' ? [destination] : []))
    const { saveAccountArchive } = await import('./sdkExports.js')
    const session = this._session, generation = this._archiveGeneration, backup = this.backup._s
    const selected = new Map((rooms === undefined ? this.backup.rooms : []).map(r => [r.room, r]))
    const opened = [...(this._archiveHandles || [])].filter(sp => sp._archiveGeneration === this._archiveGeneration && sp._archiveEmail === (session?.email || '') && sp._archiveMaster === (backup?.master || null))
    if (rooms?.some(sp => !opened.includes(sp))) throw sdkError('select Spaces opened for this account', 'invalid_argument')
    for (const sp of rooms ?? opened) {
      if (!sp || sp._wb !== this || sp._stopped || !sp.shareLink) throw sdkError('select open Spaces from this SDK client', 'invalid_argument')
      selected.set(sp.room, { room: sp.room, link: sp.shareLink, title: sp.title, held: sp })
    }
    return saveAccountArchive([...selected.values()], async (r, keysOnly) => {
      const { room, mk } = r.held?._mk ? { room: r.room, mk: r.held._mk } : await this._openLink(r.link)
      if (room !== r.room) throw sdkError('witbitz: a saved link opens another Space', 'wrong_room')
      if (keysOnly) return { key: mk }
      const saved = await this._client.exportSealed(room, mk)
      if (saved?.status !== 200) throw sdkError('witbitz: this Space\u2019s history could not be read just now', 'unavailable')
      return { key: mk, ledger: saved.sealed, count: saved.count }
    }, recoveryKeys === true, () => this._archiveGeneration === generation && (this.backup._s?.master || null) === (backup?.master || null), destination)
  }
  async createSpace({ agent = {}, tools, immediateTools, clientTools, agentReplies, skills, model, data, admission, tier, key, platformTools, region, framing, dataWrites, direct, temporary, usernames, safeMedia, lanes, owner } = {}) {
    // A TEMPORARY ROOM (docs/visitor-limits.md): a `tmp-` room the deployment wipes when it is idle — `true`: after about half
    // an hour, as the app's temporary Spaces; `{ days }` (1–7): that many days after its last question (a help desk on a
    // public page, kept while the visitor comes back). Refused rather than faked where it cannot be wiped.
    const temporaryScope = this.vault ? null : this.temporaryRooms._scope()
    let lapseDays = 0
    if (temporary !== undefined && temporary !== false) {
      if (temporary !== true && !(temporary && typeof temporary === 'object' && Number.isInteger(temporary.days) && temporary.days >= 1 && temporary.days <= 7)) throw sdkError('witbitz: temporary takes true or { days } — a whole number of days from 1 to 7', 'invalid_temporary')
      if (this.vault) throw sdkError('witbitz: a temporary room is not available in a vault yet', 'vault_unsupported')
      lapseDays = temporary === true ? 0 : temporary.days
    }
    if (safeMedia !== undefined && typeof safeMedia !== 'boolean') throw sdkError('witbitz: safeMedia takes true or false', 'invalid_argument')
    // RETIRED in 4.0.0 (the owner, 2026-11-22: "We dont need any emulation rooms"): `owner` made a room only a page SERVED as your app
    // could use — a web page vouching for itself, which anyone can copy. Client verification is the Witbitz apps' hardware proof.
    if (owner !== undefined) throw sdkError('witbitz: createSpace({ owner }) is retired — a web page cannot prove which app it is (sdk-changes.md, 4.0.0)', 'owner_rule_retired')
    if (clientTools !== undefined && !Array.isArray(clientTools)) throw sdkError('clientTools must be an array', 'invalid_argument')
    if (agentReplies !== undefined && typeof agentReplies !== 'boolean') throw sdkError('agentReplies must be a boolean', 'invalid_argument')
    if (lanes !== undefined && typeof lanes !== 'boolean') throw sdkError('witbitz: lanes takes true or false', 'invalid_argument')
    if (lanes === true && temporary !== undefined && temporary !== false) throw sdkError('witbitz: a temporary room has no private lanes — a lane is a durable room, and its copies would outlive the wipe', 'temporary_room') // as the app (space.js)
    if (safeMedia === true && temporary !== undefined && temporary !== false) throw sdkError('witbitz: a temporary room has no Safe media — the Spaces app never offers it there (New Space, ⋯ → This Space)', 'temporary_room') // newSpaceAssistants.js paintSafeOpt (sync sweep 2026-11-13)
    if (safeMedia === true && !safeMediaReady()) throw sdkError('witbitz: no safe-media enclave is accepted in this release yet', 'safe_media_unavailable')
    if (this.vault) return this.vault._create({ agent, tools, immediateTools, clientTools, agentReplies, skills, model, data, admission, tier, key, platformTools, region, framing, dataWrites, direct, usernames, safeMedia, lanes }) // vault-core CREATE_FIELDS takes safeMedia and lanes
    // A DIRECT CHAT (the Spaces app's, directChat.js): a verified Space with exactly you and one other person, you its owner,
    // `direct: true` sealed in — the server refuses its rename and each side calls it by the other person (space.directPeer).
    if (direct !== undefined) admission = directAdmission(direct, admission, this._session)
    // ★ THE CREATOR IS THE OWNER, as in the app (space.js gatedBase; docs/verified-room-members.md): a verified room names its
    //   signed-in creator as its first owner when they are on its list and no owners were given — authority then follows that
    //   email onto every device (sync sweep, 10-12). Not on the list, or not signed in: unchanged (an owner who cannot open it
    //   would be no owner).
    { const me = this._session && this._session.email && !(this._session.exp && this._session.exp <= Date.now()) ? String(this._session.email).trim().toLowerCase() : ''
      const listed = admission && typeof admission === 'object' && Array.isArray(admission.emails) ? admission.emails.map((e) => String(e).trim().toLowerCase()) : []
      if (me && listed.includes(me) && !(Array.isArray(admission.owners) && admission.owners.length)) admission = { ...admission, owners: [me] } }
    const gate = normAdmission(admission)
    const enc = tierIsEnclave(tier)
    const split = splitKeyChoice(key)
    if (split && !this._appShareUrl && !this._clientOpts.tenant) throw Object.assign(new Error("witbitz: a split-key room needs your app-half function — new Witbitz({ appShare: '/api/appshare' }) — or, with the Witbitz-held key, your tenant — new Witbitz({ tenant: 't_…' })"), { code: 'tenant_required' })
    await this._checkModel(model || agent.model)
    const cfg = roomConfig({ agent, tools, immediateTools, model, data, gate, platformTools, framing, dataWrites }, { agentName: 'Assistant', persona: '' })
    applySkills(cfg, skills)
    if (Array.isArray(clientTools)) cfg.clientTools = clientTools
    if (agentReplies !== undefined) cfg.agentReplies = agentReplies
    if (direct !== undefined) cfg.direct = true
    if (usernames === false && gate?.admission === 'email') cfg.usernames = false
    if (safeMedia === true) cfg.safeMedia = true // sealed with the rest (spaceClient.js create); a room without it is sealed exactly as before
    if (lanes === true) cfg.lanes = true // every member's app makes them a private lane (roomSync.js ensureOwnLane reads it from the sealed config)
    cfg.region = region || this._region // the room's home region is in its id (regions.js, docs/multi-region.md)
    if (temporary !== undefined && temporary !== false) {
      const all = await this._modelCatalog().catch(() => null)
      if (!(all && all.tempRooms)) throw sdkError('witbitz: temporary rooms are not available on this deployment', 'temporary_unavailable')
      cfg.room = newRoomId(cfg.region, { prefix: 'tmp' }) // the whole stack keys off the prefix (the app's tempRooms.js mints the same shape)
    }
    // Attest FIRST (a configuration failure is loud, a cold enclave is not — _encAttestSoft); mint; only then wake and hand
    // the enclave its config.
    if (enc) await this._encAttestSoft()
    const { room, mk, links, commit, configSealed, userShare, enclaveCreated } = await this._client.create(cfg, { base: this._viewer, ...(enc && !split ? { enclave: true } : {}), ...(split ? this._splitOpts() : {}), ...(lapseDays ? { lapseDays } : {}) })
    if (enc) {
      this._enc.rooms.set(room, true) // from here the client marks this room's ops enclave:true and seals mk to the attested key
      await this._encWake(room)
      // The create went to the enclave carrying the sealed config, and the enclave answered that it made the room — so its record
      // already holds the config (agent/spaceRoom.mjs). Handing it over again was a second round trip answered `409 exists` on every
      // confidential create (~0.4 s; the HN demo's timeline, 2026-11-06). Without that answer (an older server), as before.
      if (!enclaveCreated && !(await this._encSealConfig(room, commit, configSealed))) throw sdkError('the new confidential Space could not receive its configuration', 'enclave_seal_failed')
    }
    const base = split ? splitLinkOf(links[0], userShare, commit) : links[0]
    const link = lanes === true ? markLanesLink(gate ? markGateLink(base) : base) : gate ? markGateLink(base) : base // lanes=1: the app's hint — an invitee's app makes their lane without first reading the room's settings
    const sp = new Space(this._client, { room, mk, link: enc ? markEncLink(link) : link, viewer: this._viewer, wb: this, gated: !!gate, split })
    sp.safeMedia._learn(safeMedia === true, 0) // a new room's setting is what it was made with
    if (sp.temporary) await this.temporaryRooms._remember(sp, temporaryScope, { days: lapseDays, title: temporary?.title })
    const made = String(room).startsWith('tmp-') ? sp : this._backedUp(sp) // a temporary room is never in the account backup (it is wiped), as the app's
    if (direct !== undefined) await made.setReplyMode('ondemand').catch(() => {}) // the assistant is in the chat and answers when @mentioned, as in the app
    return made // an enclave room's link says so, or a fresh client cannot know (see ENC_MARK)
  }

  /** @private how a split room is created: through the builder's function when there is one (`via`), else here. */
  setAssistantMemory(spaces = []) {
    if (!Array.isArray(spaces) || spaces.length > LIMITS.links + 1) throw sdkError('witbitz: choose a bounded list of Spaces for assistant memory', 'invalid_argument')
    const group = new Map()
    for (const sp of spaces) {
      if (!(sp instanceof Space) || sp._wb !== this || sp._memoryOwner !== (this.vault ? this._memoryGeneration : this._archiveGeneration) || sp._sharedRoom || sp._detachedLane || sp.temporary || wasLaneRoom(this, sp.room)) throw sdkError('witbitz: choose ordinary Spaces opened by this SDK instance', 'invalid_argument')
      group.set(sp.room, sp)
    }
    this._assistantMemory = { group, generation: this._archiveGeneration, vaultGeneration: this._memoryGeneration }
  }

  _memoryFor(sp) {
    const m = this._assistantMemory
    if (!m || sp._memoryOwner !== (this.vault ? this._memoryGeneration : this._archiveGeneration) || m.generation !== this._archiveGeneration || m.vaultGeneration !== this._memoryGeneration || !m.group.has(sp.room) || sp.temporary || sp._sharedRoom || sp._detachedLane) return []
    return [...m.group.values()].filter(other => other.room !== sp.room && other._isEnclave() === sp._isEnclave() && !other._detachedLane && (this.vault || other._mk)).map(other => ({
      room: other.room, ...(this.vault ? {} : { mk: other._mk }), label: other.title || 'Space',
    }))
  }

  _splitOpts() { return { split: true, ...(this._appShareUrl ? { via: (body) => this._appShareCall(body) } : {}) } }

  /** @private one call to the builder's app-half function → { status, ...answer }. Same-origin by design: the function
   *  answers its own origin only. */
  async _appShareCall(body) {
    let r
    try { r = await this._fetch(this._appShareUrl, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } catch { return { status: 0, error: 'appshare_unreachable' } }
    const j = await r.json().catch(() => ({}))
    return { ...(j && typeof j === 'object' ? j : {}), status: r.status }
  }

  /** @private every room this client creates or opens is recorded in the account backup (a no-op until enabled). */
  _backedUp(sp) {
    if (!this.vault && sp.shareLink && !sp.room.startsWith('tmp-')) {
      (this._archiveHandles ||= new Set()).add(sp)
      sp._archiveGeneration = this._archiveGeneration
      sp._archiveEmail = this._session?.email || ''; sp._archiveMaster = this.backup._s?.master || null
    }
    try { this.backup.add(sp) } catch { /* the backup must never cost the room */ }
    try { this.erasure._seen(sp) } catch { /* nor the erase list */ }
    return sp
  }

  /** Open a Space you (or a member) hold a link to. The link's fragment carries the key; it never touches the server.
   *  @param {string} link a Space share link (or the current page URL, if it is one).
   *  @param {object} [opts] { resume? } — a prior {@link Space#snapshot}, so this open resumes past what you already
   *   have instead of replaying the whole ledger (see `resume` on the {@link Space} constructor). → a live {@link Space}. */
  async openSpace(link, { resume, tier } = {}) {
    if (this.vault) throw sdkError('witbitz: in a vault, a link is opened by the vault (the link points at it) — then wb.vault.openRoom(room)', 'vault_opens_links')
    const temporaryScope = this.temporaryRooms._scope()
    const { room, mk, link: s, split } = await this._openLink(link, { tier })
    const sp = new Space(this._client, { room, mk, link: s, viewer: this._viewer, resume, wb: this, split })
    if (sp.temporary) await this.temporaryRooms._remember(sp, temporaryScope)
    return this._backedUp(sp)
  }

  /** Reopen a member's existing private lane — the link {@link Space#privateLane} returned (`lane.shareLink`) — on
   *  its shared Space, with its actions. One call: it opens the lane's link once and returns a live {@link Lane}.
   *  A lane of a confidential Space is confidential, exactly as privateLane made it, even from an older unmarked link.
   *  @param {string} laneLink the lane's link
   *  @param {object} opts { space, actions?, resume?, tier? } — `space`: the shared {@link Space} this lane belongs to
   *   (its crossings are posted there, so it is required); `resume`: a prior {@link Space#snapshot} of the lane. */
  async openLane(laneLink, { space, actions, resume, tier, mirror = false } = {}) {
    if (space && !this.vault) await assertNotKept(space)
    if (space && space.temporary) throw sdkError('witbitz: a temporary room has no private lane — the lane is a durable room, and its copies of the room would outlive the wipe', 'temporary_room') // as the app (roomSync.js ensureOwnLane; sync sweep 2026-10-27 #3)
    if (space && (space._sharedRoom || space._detachedLane || wasLaneRoom(this, space.room))) throw sdkError('witbitz: a private lane has no lane of its own — open the lane on its Space', 'lane_of_lane') // as privateLane (sync sweep 11-08: openLane took a lane as the Space)
    if (this.vault) return this.vault._openLane(laneLink, { space, actions, resume, tier, mirror })
    if (!(space instanceof Space) || !space.room || !space._mk) throw sdkError('witbitz: openLane needs `space`, the shared Space the lane belongs to (from createSpace or openSpace) — a lane posts its crossings there', 'invalid_argument')
    if (roomFromLink(String(laneLink)) === space.room) throw sdkError('witbitz: that is the Space\'s own link, not a lane of it — open it with openSpace', 'invalid_argument') // a Space recorded as its own lane (sweep P1)
    const sharedIsEnclave = !!(this._enc && this._enc.rooms.has(space.room))
    // THE LANE'S OWN TIER (sweep 11-06 #6): a lane of a confidential Space was always taken as confidential — right for an old
    // unmarked privateLane link, wrong for a regular room the app LINKED to it (drawer.js), whose ops then went to an enclave
    // that does not hold it. The link's mark or `tier` decide; an unmarked link is asked of the standard tier (keyless: op
    // policy is public) — it answers for its own rooms and refuses a confidential one.
    let laneEnclave = sharedIsEnclave
    if (sharedIsEnclave && !tier && !ENC_MARK.test(String(laneLink))) { const has = await this._standardHas(roomFromLink(String(laneLink))); if (has === true) laneEnclave = false }
    const { room, mk, link: s, split } = await this._openLink(laneLink, { tier, enclave: laneEnclave })
    await assertNotKept({ room, _mk: mk, _wb: this, _client: this._client })
    // ACROSS TIERS (the owner: 2026-10-11 for the app, 2026-10-23 "make it also in the sdk"). The two tiers keep separate
    // stores and a confidential room's key never rides the standard tier, so a lane of the other tier gets NO bridge: this
    // device copies the Space into it (the mirror, on whatever was asked), as the Spaces app does (roomSync.laneBridge).
    const laneIsEnclave = !!(this._enc && this._enc.rooms.has(room))
    const crossTier = laneIsEnclave !== sharedIsEnclave
    await refuseAttestedIntoPlain(this._client, space.room, space._mk, room, mk) // sync sweep 2026-11-15 #5: as the app's mirrorLoop.js
    const known = this.backup.rooms.find(r => r.room === room)
    if (space._wb !== this || known?.detachedLane || (known?.shared && known.shared !== space.room)) {
      throw sdkError('Open this private room with its recorded parent Space.', 'lane_space_mismatch')
    }
    return this._backedUp(new Lane(this._client, { room, mk, link: s, viewer: this._viewer, sharedRoom: space.room, sharedMk: space._mk, actions, resume, wb: this, shared: space, mirror: crossTier ? (mirror || true) : mirror, split, crossTier }))
  }

  /** Does the STANDARD tier hold `room`? → true · false (it refused it as confidential) · null (cannot tell). Keyless. */
  async _standardHas(room) {
    if (!room) return null
    try {
      const r = await this._client.policyOf(room, null)
      if (!r) return null
      if (r.error === 'confidential_room' || r.confidential === true || r.tier === 'enclave') return false // tier: the tier guard's word on a keyless policy (agent/tierGuard.mjs)
      // ONLY A DEFINITIVE YES (sweep 11-07 #3): a confidential room's mirror row and a missing room both answer an EMPTY 200 here
      // (agent/spaceRoom.mjs), and taking that for "standard" sent the lane's first keyed op — its key readable — to the Lambda
      if (r.status === 200) return r.configSealed || r.gated === true || r.lanes === true || r.policy ? true : null
      if (r.status === 401 || r.status === 403) return true
      return null
    } catch { return null }
  }

  /** Open a link to { room, mk, link }. An enclave room is adopted BEFORE the open (on one, the open is itself an
   *  enclave op), and the room the open answered after. ★ A link minted before the marker existed can still be adopted with
   *  `{ tier: 'enclave' }` — rooms created by an earlier build have unmarked links and would otherwise be unopenable. */
  _emptySpaceHooks() {
    const b = this.backup, state = b._s, session = this._session
    const current = () => !!state && b._s === state && this._session === session
    const records = () => current() ? state.rooms || [] : []
    const remove = async (room, options) => {
      const key = await this.erasure._key()
      return key && current() ? deleteOwnRoom(room, { ...options, url: this._roomDeleteEndpoint(), keys: [key], dropKeys: this.erasure._dropKeys(), fetchImpl: (...a) => this._fetch(...a) }) : { status: 0, body: { error: 'no_account_key' } }
    }
    return {
      rooms: () => records().map(r => ({ room: r.room, title: r.label || 'Space', pinned: !!r.pinned })),
      me: () => this.erasure._account(),
      keep: room => records().some(r => r.room === room && (r.kind === 'lane' || r.help) || r.shared === room),
      read: async room => {
        const row = records().find(r => r.room === room)
        if (!row) return null
        const { mk } = await this._openLink(row.link)
        const config = await this._client.getConfig(room, mk, { plainMark: true })
        if (current() && (config?.help || config?.lane || config?.bridge)) return { excluded: true }
        const v = await readAllPages(since => this._client.poll(room, mk, undefined, since))
        return current() && config && !config.help && !config.lane && !config.bridge && v.status === 200 && !v.incomplete ? { config, entries: v.entries, etag: v.etag, selfEntries: await ownAdmissionEntries(config, this.erasure._account(), () => this._client.state(room, mk, 'roster')), selfHash: this.erasure._account() ? await memberHash(this.erasure._account(), room) : null } : null
      },
      prepare: room => remove(room, { check: true, reviewPolicy: true }),
      deleteOnServer: (room, reviewedEtag, reviewedPolicy) => remove(room, { reviewedEtag, reviewedPolicy }),
      checkDeletion: room => remove(room, { check: true }),
      forget: async room => { if (current()) this.account.forget(room) },
      gone: async room => (await remove(room, { check: true })).body?.deleted === true,
    }
  }

  async _openLink(link, { tier, enclave = false } = {}) {
    const s = String(link)
    const enc = tierIsEnclave(tier) || ENC_MARK.test(s) || enclave
    if (SPLIT_MARK.test(s)) {
      // A SPLIT link is half a key. The account backup may hold the whole key (§3.4 — never hostage to the app half);
      // otherwise the room's tenant serves the app half to THIS page only if its origin is declared. Either way the
      // combine must match the room's commitment before it is used (§6.4).
      const room = roomFromLink(s), userShare = fragParam(s, 'us'), want = fragParam(s, 'spc')
      if (!room || !userShare) throw sdkError('witbitz: that link is not a Space link (or its key is incomplete)', 'invalid_link')
      const kept = this.backup.keyFor(room)
      // ⚑ A SPLIT ENCLAVE SPACE (the hosted app makes them: a backend create, then the enclave seal — the owner, 2026-11-25: "Keep this
      //   Space always on" on a hosted Enclave Space ended "could not read this Space's gate"). The app half is the standard tier's to serve,
      //   as for any split room; once the key is whole, the room's ops go to its enclave. It used to be refused here outright.
      if (kept && want && await keyCommit(kept) === want) { if (enc) await this._encAdopt(room); return { room, mk: kept, link: s, split: true } }
      const r = this._appShareMember ? await this._appShareMember(room).catch(() => ({ status: 0, error: 'appshare_unreachable' })) : this._appShareUrl ? await this._appShareCall({ op: 'get', room }) : await this._client.appSharePage(room)
      if (!r || r.status !== 200 || !r.appShare) {
        const code = (r && r.error) || 'split_unopenable'
        throw Object.assign(new Error(code === 'origin_not_declared'
          ? "witbitz: this room's other key half is served only to its tenant's declared origins (wb.origins), and this page is not on one"
          : `witbitz: the room's other key half could not be fetched (${code})`), { code, status: r && r.status })
      }
      const mk = await reconstructMk({ userShare, appShare: r.appShare, expectedCommit: want || r.commit })
      if (!mk) throw Object.assign(new Error('witbitz: the two key halves do not make this room’s key — refused'), { code: 'split_mismatch' })
      if (enc) await this._encAdopt(room) // after the halves are whole: its ops route to the enclave
      return { room, mk, link: s, split: true }
    }
    if (enc) await this._encAdopt(roomFromLink(s))
    const { room, mk } = await this._client.open(s)
    if (!room || !mk) throw sdkError('witbitz: that link is not a Space link (or its key is incomplete)', 'invalid_link')
    if (enc) await this._encAdopt(room) // the room the open answered (a link need not name it) — its ops route to the enclave
    return { room, mk, link: s }
  }
}

/** A live handle to one Space. Emits `message` as entries arrive (yours, other members', and the agent's), and
 *  `error` on a transient poll failure. Backed by a content-blind poll loop that opens the sealed ledger locally. */
export class Space {
  /** @param {object} opts { room, mk, link, viewer?, resume? } — `resume` is a prior {@link Space#snapshot} (or the
   *   same shape you built yourself: `{ count, etag, messages, rows }`, all optional). Passing it seeds this Space
   *   from what you already have instead of replaying the ledger from entry 0: `pollSealed`'s `sinceCount` already
   *   slices server-side, so the first live poll asks for only what is new. Malformed input never throws — a bad or
   *   partial `resume` just resumes as much of it as parses, exactly as if the missing parts had not been passed. */
  constructor(client, { room, mk, link, viewer = DEFAULT_VIEWER, resume, wb = null, live, gated = false, split = false, poll = true, handlers, lanes = false }) {
    /** @type {string} the server-visible room id */
    if (typeof resume?.room === 'string' && resume.room !== room) resume = null
    this.room = room
    this._lanesHint = lanes === true // in a vault the page holds no link: the vault's room list says it (sync sweep 2026-10-29 #3)
    this.epoch = null // latest key rotation observed by this handle
    this._a2aResume = resume && Array.isArray(resume.a2a) ? resume.a2a : null
    this._a2aReceipts = Array.isArray(resume?.a2aReceipts) ? resume.a2aReceipts.filter(key => typeof key === 'string' && key.length < 512).slice(-512) : []
    if ((this._a2aResume?.length || this._a2aReceipts.length) && wb) (wb._agentHandles ||= new Set()).add(this)
    this._gated = !!gated || roomInviteFlags(link).gated // an email-gated room (see markGateLink) — no config fetch to know it
    this._split = !!split || SPLIT_MARK.test(String(link || '')) // a split-key room: its link is half a key (https://witbitz.chat/docs/sdk-keys.md#split-key)
    this._liveOpts = live !== undefined ? live : (wb && wb._live) || null // room streams (null → polling only)
    this._stream = null; this._streamFrameAt = 0; this._partial = { text: null }; this._feed = makeTurnFeed() // turnFeed.js: the room's word on a running turn, read the same way the Spaces app reads it
    this._memoryOwner = wb?.vault ? wb._memoryGeneration : wb?._archiveGeneration
    this._wb = wb // the Witbitz client that opened this Space — its session and Siri state (null for a bare handle)
    /** This Space's connections: what ITS assistant may spend. `grant` needs a connection from `wb.connections`. */
    this.connections = new SpaceConnections(this)
    /** The Siri inbox for THIS Space: enable an alias, collect what was said, disable. Needs a signed-in `wb`. */
    this.siri = new SpaceSiri(this)
    /** SAFE MEDIA in this Space: the setting, verified safe copies of photos and PDFs, making one (sdkSafeMedia.js). */
    this.safeMedia = new SpaceSafeMedia(this)
    this.schedules = new SpaceSchedules(this)
    this.alwaysOn = new SpaceAlwaysOn(this)
    /** @type {string} the share link — hand it to someone to let them in (the link IS the auth) */
    this.shareLink = link
    /** @type {Array} every message seen so far, oldest first */
    // ledgerView.js — how the Spaces app merges a room's entries: a new id is added, a known one REWRITTEN in place (a
    // reaction, a caption, a reply's widgets) is updated where it stands and announced on 'update'.
    this._view = makeLedgerView()
    this.messages = this._view.list
    this._oldKeys = new Set() // this room's keys before a change in place (sdkRekey.js): a call still carrying one runs again with the new
    this._client = healingClient(client, () => this._reattest(), { adopt: (args) => this._adoptKey(args), learnTier: async (room) => { const wb = this._wb; if (!room || !wb || !wb._enc || wb._enc.rooms.has(room) || typeof wb._encAdopt !== 'function') return false; await wb._encAdopt(room); return wb._enc.rooms.has(room) && !!wb._enc.key } }) // a stale / missing enclave key heals on ANY keyed call (below); a re-keyed room's old key too
    this._mk = mk
    this._viewer = viewer
    this._subs = {}
    this._etag = null
    this._count = 0
    this._timer = null
    this._inflight = false
    this._stopped = false
    this._lastActive = 0
    /** Resolves once the WHOLE history has been read (every page of a long room) — by then `messages` (and `data.rows()`) hold what the room had. A refused
     *  poll (a warming enclave, a gated read before sign-in) does not count; those keep retrying and raise `error`.
     *  Rejects only when this key can never open the room (`code: 'cannot_open'`), the room requires a room pass this client cannot
     *  get (`code: 'pass_required'`), or the handle is closed first (`code: 'closed'`). A builder waited on `_inflight`/`_timer` for this and drew an empty room on a refused poll. */
    this.ready = new Promise((resolve, reject) => { this._readyResolve = resolve; this._readyReject = reject })
    this.ready.catch(() => {}) // an unawaited ready that rejects must not become an unhandled rejection
    // REPLY MODE (spaces/test/sdkReplyMode.test.mjs) — 'auto' | 'always' | 'ondemand', carried on each turn. The room's
    // setting lives in the sealed, content-blind `agentmode` doc that the Spaces app already writes
    // (spaces/public/agentMode.js), so a builder and our own UI mean the SAME thing by "Always" rather than running two
    // parallel mechanisms. Read ONCE here, at construction, because a rebuilt handle from a saved link must already
    // carry it on its FIRST send — a remedy that only takes effect on the second message is not a remedy. Best-effort:
    // `_modeReady` never rejects, and a room with no doc simply sends no mode (⇒ the room's default, roomSettings.js roomDefaultReplyMode).
    // THE ROOM'S NAME (https://witbitz.chat/docs/sdk-rooms.md#room-name) — roomName.js, the module the Spaces app reads it with:
    // the newest { kind:'title' } entry in the log (a rename, a generated name), else the room's shared title doc. Title
    // entries are not messages: they never enter `messages` and never fire 'message'; they set `title` and fire 'title'.
    this._title = null; this._titleTs = -Infinity; this._titleDocAt = Date.now(); this._titleDocEvery = SETTINGS_FRESH_MS // the doc is read again on the settings' cadence (_maybeTitleDoc)
    if (!this._hostDriven && poll !== false) Promise.resolve().then(async () => { // the doc: for a room with no title entry yet
      try { const t = titleFromDoc(await client.state(room, mk, 'title')); if (t && this._titleTs === -Infinity && !this._title) this._setTitle({ title: t.title, manual: t.manual, by: '', ts: -Infinity }) } catch { /* the name is a convenience */ }
    })
    this._mode = null; this._modelPick = undefined; this._settingsAt = 0
    this._modeReady = Promise.resolve().then(() => this._readSettings())
    // Proposals (the agent's data writes, a lane's crossings and actions) + device-side reads, on every Space:
    this._writes = {}; this._reads = {}; this._pendingActions = {}; this._inflightPending = false; this._pendingTimer = null; this._devDone = new Set()
    // HOST-DRIVEN: `poll: false` — the page that holds this handle runs its own poll loop (the
    // Spaces app does) and asks for proposals with pending(); the Space starts no timer of its own. `handlers`: device
    // actions by type, run here when a member approves one (the same as a lane's propose-mode actions).
    this._hostDriven = poll === false
    if (handlers && typeof handlers === 'object') for (const [k, fn] of Object.entries(handlers)) if (typeof fn === 'function') this._writes[k] = fn
    this._pendingList = []; this._pendingSig = null
    // THE ROOM AS A STORE — the replayed rows: Map<collection, Map<id, { row, updated, by }>>. Built from the ledger's
    // `data` entries as they stream in (the same replay the agent's data_query runs server-side), so `rows()` is exactly
    // what the Space holds — no second copy, nothing to sync.
    this._rows = new Map()
    const self = this
    /** `space.data`: rows(collection) · get(collection, id) · put(collection, row, { id? }) · delete(collection, id) */
    this.data = {
      // `_v`: the row's VERSION — the id of the ledger entry that last wrote it. Hand it back as `ifVersion` on a put or
      // delete and the write is refused (error.code 'row_changed', with the row's current version) if the row changed
      // since you read it — across devices, since the check runs on the server inside the ledger's own conditional
      // write. `ifVersion: null` means "only if the row does not exist". (2026-09-26, a builder's move-a-task race.)
      rows(collection) { const m = self._rows.get(String(collection)); return m ? [...m].map(([id, v]) => ({ id, ...v.row, _updated: v.updated, _by: v.by, _v: v.v || null, ...rowMarks(v) })) : [] },
      get(collection, id) { const v = self._rows.get(String(collection))?.get(String(id)); return v ? { id: String(id), ...v.row, _updated: v.updated, _by: v.by, _v: v.v || null, ...rowMarks(v) } : null },
      async put(collection, row, { id, from, ifVersion } = {}) { from = self._who(from); return self._write([{ op: 'put', collection, ...(id ? { id } : {}), row, ...(ifVersion !== undefined ? { ifVersion } : {}) }], from) },
      async delete(collection, id, { from, ifVersion } = {}) { from = self._who(from); return self._write([{ op: 'del', collection, id, ...(ifVersion !== undefined ? { ifVersion } : {}) }], from) },
      /** several rows in ONE entry (one line in the room, one ordering point) */
      async batch(ops, { from } = {}) { return self._write(ops, self._who(from)) },
    }
    // The key and the link ARE the admission: readable as space.key / space.shareLink, never enumerable (sdkRedact.js).
    hide(this, ['_mk', 'shareLink', '_client', '_wb', '_oldKeys'])
    // IN A VAULT the vault follows a re-keyed room (vault-core.js followKey) and says so: the same events as here
    try { const v = wb && wb.vault && wb.vault._c; if (v && typeof v.on === 'function') {
        // removed / pending HOLD the poll as a direct Space's _keyWait does (the vault's own retries stay its own); rekeyed lets go
        // (sync sweep 11-08 #27: the event was passed on and the page kept polling at full speed)
        const held = (kind, reason) => { this._keyWait = kind === 'removed' ? 'removed' : (reason || 'pending'); this._pollHeld = true }
        const known = wb.vault._keyState && wb.vault._keyState.get(this.room)
        if (known) held(known.kind, known.reason) // said before this Space was opened
        this._vaultKeyOff = v.on((d) => { if (d && d.ev === 'key' && d.room === this.room && ['rekeyed', 'removed', 'pending'].includes(d.kind)) { this._gateCfg = null; if (d.kind === 'rekeyed') { this.epoch = Number(d.epoch) || 0; this._keyWait = null; this._pollHeld = false; this._etag = null; if (!this._stopped) Promise.resolve().then(() => this._kick()) } else held(d.kind, d.reason); this._emit(d.kind, { room: this.room, ...(d.kind === 'rekeyed' ? { epoch: this.epoch } : {}), ...(d.reason ? { reason: d.reason } : {}) }) } })
      } } catch { /* */ }
    if (resume) this._resume(resume) // seed count/etag/messages/rows BEFORE the first poll, so it asks for only what is new
    if (new.target === Space && this._a2aResume?.length) void this.a2a
    if (this._hostDriven) this._settleReady(); else this._poll() // start streaming immediately; a fresh Space is empty, a resumed one continues, an opened-with-no-resume one replays its history here
  }

  // Seed from a prior snapshot() (or the same shape built by hand). Best-effort and defensive on every field
  // independently — a malformed/partial resume must never throw or block opening, it just resumes whatever parsed
  // and starts the rest fresh, exactly as if `resume` had not been passed at all.
  _resume(s) {
    if (!s || typeof s !== 'object') return
    if (typeof s.room === 'string' && s.room !== this.room) return // V#8: another room's snapshot (a wrong cache key): its messages, and its count — which skips this room's first entries — are not this room's. A snapshot from before the field has none and is taken as before.
    try {
      if (Array.isArray(s.messages)) {
        this._removedMessages = new Map((Array.isArray(s.removed) ? s.removed : s.messages.filter((e) => e && e.removedByWitbitz)).map((e) => [removedEntryKey(e), { id: e.id, ts: e.ts }]))
        this._removedSourceMessages = new Map((Array.isArray(s.sourceRemovals) ? s.sourceRemovals : s.messages.filter((e) => e && e.sourceRemoved)).map((e) => [removedEntryKey(e), { id: e.id, ts: e.ts }]))
        for (let m of s.messages) {
          if (!m || typeof m !== 'object') continue
          if (this._removedMessages.has(removedEntryKey(m))) m = removedCopy(m)
          else if (this._removedSourceMessages.has(removedEntryKey(m))) m = sharedRemovedCopy(m)
          if (isTitleEntry(m)) { this._noteTitle(m); continue }
          if (this.safeMedia && this.safeMedia._note(m)) continue // the line that moved Safe media is read (and stays a message: _note → false)
          this._view.apply([m]) // a live poll's overlap with what you already had is never re-pushed or re-emitted
        }
      }
      if (s.title && typeof s.title === 'object' && cleanTitle(s.title.title)) { const ts = Number(s.title.ts); this._title = { title: cleanTitle(s.title.title), manual: !!s.title.manual, by: String(s.title.by || ''), ts: Number.isFinite(ts) ? ts : -Infinity }; if (Number.isFinite(ts)) this._titleTs = Math.max(this._titleTs, ts) }
      // the SAFE COPIES the poll kept beside their photos (never messages): a resumed Space polls only what is new, so without them
      // every older photo had no copy (sync sweep backlog P7)
      if (Array.isArray(s.safeCopies) && this.safeMedia) for (const e of s.safeCopies.slice(0, 2000)) { if (e && typeof e === 'object' && e.kind === 'safe') this.safeMedia._note(e) }
      if (Number.isInteger(s.count) && s.count >= 0) this._count = s.count
      if (typeof s.etag === 'string' && s.etag) this._etag = s.etag
      if (Array.isArray(s.rows)) {
        for (const entry of s.rows) {
          if (!Array.isArray(entry) || entry.length !== 2) continue
          const [collection, rows] = entry
          if (typeof collection !== 'string' || !Array.isArray(rows)) continue
          const m = new Map()
          for (const r of rows) {
            if (!Array.isArray(r) || r.length !== 2) continue
            const [id, v] = r
            if (typeof id !== 'string' || !v || typeof v !== 'object') continue
            m.set(id, { row: ownFields(v.row), updated: Number(v.updated) || 0, by: v.by || '', v: typeof v.v === 'string' ? v.v : '', ...stampsOf(v) })
          }
          this._rows.set(collection, m)
        }
      }
    } catch { /* resume is a convenience — a bad shape resumes as much as it parsed, never blocks opening */ }
  }

  /** A resumable, JSON-safe snapshot of everything this Space holds: `{ count, etag, messages, rows }`. Persist it
   *  (e.g. `localStorage.setItem(key, JSON.stringify(space.snapshot()))`) and hand it back as `resume` next time —
   *  to {@link Witbitz#openSpace} or the {@link Space} constructor directly — so reopening this Space continues from
   *  here instead of replaying the whole ledger. Call it whenever suits your app (on `message`/`data`, or on close);
   *  it is a plain read of current state, not a network call. */
  /** TURN CERTIFICATES (https://witbitz.chat/docs/sdk-keys.md#eat): in a confidential (enclave) room every assistant reply is signed inside
   *  the enclave by an attested key, with the build's measurement, each model call's verified receipt and each tool call.
   *  This checks the whole loaded history on the device (the Nitro attestation, the published audit verdict, every
   *  signature, every reply's text) → { verified, failed: [{ id, reason }], unchecked, before, copies, builds, calls, tools }.
   *  `copies`: a private lane's copies of its Space's replies — the lane's enclave never signed them, so they are counted, not failed.
   *  A regular room has none: { verified: 0, failed: [], before: <its replies> }. */
  async certificates() {
    const { verifyRoom } = await import('./turnCerts.js')
    const r = await verifyRoom(this.messages, { room: this.room })
    // "REBUILT FROM SOURCE" (the app's row, encSource.js; the owner, 2026-11-06: SDK too): each build the replies came from, looked
    // up in the build enclave's published releases — the commit it was rebuilt from and its public Rekor entry, or null
    const builds = [...r.builds.values()]
    try {
      const { releaseFor, rekorUrl, RELEASES_LOG } = await import('./encSource.js')
      const url = new URL(RELEASES_LOG, String(import.meta.url).startsWith('blob:') ? location.href : import.meta.url).href // root-absolute: Witbitz's own log, also from a versioned copy
      const res = await fetch(url, { cache: 'no-cache' })
      const text = res && res.ok ? await res.text() : null
      for (const b of builds) { const rel = text == null ? undefined : releaseFor(text, b && b.pcr16); b.source = rel ? { commit: rel.commit, logIndex: rel.logIndex, rekor: rekorUrl(rel.logIndex) } : (rel === null ? null : undefined) }
    } catch { /* the log could not be read: `source` stays absent — not "not rebuilt" */ }
    return { verified: r.verified, failed: r.failed, unchecked: r.unchecked, before: r.before, copies: r.copies, builds, calls: Object.fromEntries(r.calls), tools: Object.fromEntries(r.tools) } // unchecked: the proof is in history this instance has not read — not a failure; copies: a lane's copies of its Space's replies (turnCerts.js)
  }

  snapshot() {
    return {
      room: this.room,
      ...((!this._wb?.a2a?._draftsSuspended && (this._a2a?._posted.size || this._a2aReceipts?.length)) ? { a2aReceipts: [...(this._a2a?._posted || this._a2aReceipts)].slice(-512) } : {}),
      ...(!this._wb?.a2a?._draftsSuspended && pendingOf(this._a2a ? this._a2a._pending : this._a2aResume).length ? { a2a: pendingOf(this._a2a ? this._a2a._pending : this._a2aResume) } : {}),
      count: this._count,
      etag: this._etag,
      messages: this.messages,
      removed: this._removedMessages ? [...this._removedMessages.values()] : [],
      sourceRemovals: this._removedSourceMessages ? [...this._removedSourceMessages.values()] : [],
      safeCopies: this.safeMedia && this.safeMedia._copies ? [...this.safeMedia._copies.values()].flat() : [],
      rows: [...this._rows].map(([collection, rows]) => [collection, [...rows]]),
      title: this._title ? { title: this._title.title, manual: this._title.manual, by: this._title.by, ts: Number.isFinite(this._titleTs) ? this._titleTs : null } : null,
    }
  }

  /** The room's name, the same on every device and in the Spaces app: the newest rename or generated name in the room's
   *  log, else its shared title doc; null while it has none. 'title' fires when it changes. */
  get title() { return this._title ? this._title.title : null }

  /** Rename the room for every member and device: appended to the room's log (a rename line in the Spaces app). →
   *  { ok, title } — `ok` false: an older server took it into the room's shared doc only (members see it when they open). */
  async rename(name, { by } = {}) {
    by = this._who(by)
    const title = cleanTitle(name)
    if (!title) { const e = new Error('witbitz: a room name is 1–80 characters'); e.code = 'bad_request'; throw e }
    const r = await sendRoomRename({ title: (t, b) => this._client.title(this.room, this._mk, false, { title: t, by: b }), writeDoc: (st, summary) => this._client.state(this.room, this._mk, 'title', st, summary) }, title, by)
    if (r.refused) { const e = new Error('witbitz: ' + renameRefusalText(r)); e.code = r.refused; if (r.reason) e.reason = r.reason; throw e } // the app's words, its reason kept (renameRefusal.js; sync sweep, 2026-10-11)
    if (r.unavailable) { const e = new Error('witbitz: the room could not take the new name right now — try again'); e.code = 'unavailable'; if (r.reason) e.reason = r.reason; throw e } // nothing stored (0 / 5xx): never shown as taken
    this._setTitle({ title, manual: true, by, ts: this._titleTs }) // shown now; its entry arrives with the next poll
    return { ok: r.took, title }
  }

  _noteTitle(e) {
    const t = latestTitle([e]); if (!t || t.ts < this._titleTs) return // an older name read later never wins
    this._titleTs = t.ts
    this._setTitle(t)
  }
  /** @private THE NAME DOC, AGAIN (sync sweep 10-26 #4; the app's eccc6b28): it was read once, at open — a member who opened the
   *  room before it was named (a joiner still signing in) never got the name. Re-read on the settings' cadence while no title
   *  ENTRY has named the room; never once one has. */
  _maybeTitleDoc() {
    if (this._titleTs !== -Infinity || this._titleDocBusy || this._hostDriven || Date.now() - this._titleDocAt < this._titleDocEvery) return
    this._titleDocBusy = true; this._titleDocAt = Date.now()
    Promise.resolve(this._client.state(this.room, this._mk, 'title'))
      .then((d) => { const t = titleFromDoc(d); if (t && this._titleTs === -Infinity) this._setTitle({ title: t.title, manual: t.manual, by: '', ts: -Infinity }) }, () => {})
      .finally(() => { this._titleDocBusy = false })
  }
  _setTitle(t) {
    const same = this._title && this._title.title === t.title && this._title.manual === !!t.manual
    this._title = { title: t.title, manual: !!t.manual, by: t.by || '', ts: t.ts }
    if (!same && this.temporary && this._temporaryScope) this._wb.temporaryRooms._title(this)
    if (!same) this._emit('title', { title: t.title, manual: !!t.manual, by: t.by || '' })
  }

  async _write(ops, from) {
    const bad = [...new Set((Array.isArray(ops) ? ops : []).flatMap((o) => (o && o.row && typeof o.row === 'object' ? Object.keys(o.row).filter(isReserved) : [])))]
    if (bad.length) throw Object.assign(new Error(`witbitz: a row may not set ${bad.join(', ')} — \`id\` is the row's key (pass it as { id }) and \`_\` names are the room's marks`), { code: 'reserved_field' })
    const r = await this._client.data(this.room, this._mk, ops, from)
    if (r && r.status === 409 && r.error === 'row_changed') { // a conditional write lost: the caller re-reads and decides
      const e = new Error('row_changed: ' + (r.conflicts || []).map((c) => `${c.collection}/${c.id} is now ${c.version === null ? 'absent' : c.version}`).join(', '))
      e.code = 'row_changed'; e.conflicts = r.conflicts || []
      throw e
    }
    if (!r || r.status !== 200) throw refused('data write', r)
    this._kick() // the entry comes back through the poll → the reducer + the 'data' event, same as every other member
    return { ok: true, id: r.id, ops: r.ops || [] }
  }

  // The device half of an `await` action: the turn parked a call for THIS device; run the handler, return the result.
  async _runDeviceCall(dc) { // deviceCall.js — answered the way the Spaces app answers it
    return answerDeviceCall(dc, { done: this._devDone, find: (name) => this._reads[name], send: (result) => this._client.toolResult(this.room, this._mk, dc.callId, result) })
  }

  /** The room master key (base64url). You rarely need it — use {@link shareLink} — but it lets you build custom links. */
  // KEYLESS: what still needs the room key in the page refuses clearly over a worker-held key,
  // until its phase moves it behind the client.
  _needKey(what) {
    if (!(this._client && this._client.keyless)) return
    if (this._client.vault) throw sdkError(`witbitz: ${what} is not available in a vault yet`, 'vault_unsupported')
    throw Object.assign(new Error(`witbitz: ${what} is not available yet over a worker-held key`), { code: 'keyless' })
  }
  get key() { return this._client && this._client.keyless ? null : this._mk } // KEYLESS: the key lives in the app's worker, never here
  /** True for a temporary room (`createSpace({ temporary })`): wiped when idle, never in the account backup. */
  get temporary() { return String(this.room || '').startsWith('tmp-') }
  /** True when this room gives every member a private assistant (`createSpace({ lanes: true })`, or a link that says so): the
   *  Spaces app makes its users theirs; in your app, `privateLane()`. */
  get lanes() { return this._lanesSetting === undefined ? this._lanesHint || roomInviteFlags(this.shareLink).lanes : this._lanesSetting }
  /** Outside-agent door for a solo verified Space; group and open Spaces refuse on enable/collect. */
  get a2a() { return this._a2a || (this._a2a = this._wb && this._wb.vault ? new VaultLaneA2A(this, this._wb.vault._c) : new LaneA2A(this)) }

  /** Subscribe to `message` ({ from, text, self, id, ts, widgets? } — `name` carries the same value as `from`, it is
   *  what the sealed ledger calls the field) or `error` (Error). Chainable. */
  on(event, cb, { replay = true } = {}) {
    // `{ replay: false }` on 'message': only what arrives AFTER the room's history was read (sdk-roadmap item 6) — for
    // notifications, analytics and side effects, which must not fire once per old message on every open.
    const fn = event === 'message' && replay === false ? Object.assign((m) => { if (this._historyRead) cb(m) }, { _orig: cb }) : cb
    ;(this._subs[event] ||= []).push(fn)
    if (event === 'a2a') { const agents = this.a2a; Promise.resolve().then(() => agents._flushHeld()) }
    if ((event === 'proposal' || event === 'proposals') && !this._hostDriven && !this._pendingTimer && !this._stopped) this._pendingTimer = setInterval(() => this._pollPending(), 1500) // proposals arrive on their own channel (pending), not the ledger — polled once someone listens
    // Returns an UNSUBSCRIBE function. It still chains (`.on(…).on(…)`), because on() returned the space until 2026-10-05.
    const off = () => { this.off(event, cb); return this }
    return Object.assign(off, { on: (...a) => this.on(...a), off: (...a) => this.off(...a) })
  }
  /** Remove a listener added with on(). The last 'proposal' listener stops the proposals poll that on() started. */
  off(event, cb) {
    const l = this._subs[event]; if (!l) return this
    this._subs[event] = cb === undefined ? [] : l.filter((x) => x !== cb && x._orig !== cb) // no cb: every listener for the event
    // the proposals poll runs while anyone listens for 'proposal' OR 'proposals' — and on a Lane always (pass 5, V#14: the last
    // 'proposal' listener stopped a Lane's always-on poll, and the last 'proposals' listener never stopped a Space's)
    if ((event === 'proposal' || event === 'proposals') && !this._keepsProposals && !(this._subs.proposal || []).length && !(this._subs.proposals || []).length && this._pendingTimer) { clearInterval(this._pendingTimer); this._pendingTimer = null }
    return this
  }
  _emit(event, arg) { if (this._stopped) return; for (const cb of (this._subs[event] || [])) { try { cb(arg) } catch { /* a listener throwing must not break the loop */ } } }

  /** Post a message from a member. The agent decides whether to answer and does so on its OWN turn — the reply (and
   *  any others) arrive via `on('message')`, not as a return value.
   *  While the assistant is still replying to an earlier message, this one is HELD and resent until the room takes it
   *  (up to ~3 min); if it never gets in, the result is `{ ok: false, error: 'busy' }`. A turn longer than ~30 s is cut
   *  at the API front door while the server finishes it: the result then carries `pending: true` and the reply still
   *  arrives on 'message' — do not resend it.
   *  `instructions` (a string, up to 8,000 characters) reaches the assistant as instructions for THIS reply only — today's
   *  date, what is waiting, "answer in Hebrew" — and is NEVER stored, so it is not re-read from old messages every turn.
   *  @param {string} text @param {object} [opts] { from, mode, instructions, images, files } — `from`: the display name to sign this
   *  message as (default 'You'); `images` (≤ 4) / `files` (≤ 2) are { b64 | bytes, mime, name? }, refused over LIMITS at the call */
  linkPrivateRoom(target, { allowStandardDestination = false } = {}) {
    return this._privateRoomChange(target, false, allowStandardDestination === true)
  }
  unlinkPrivateRoom(target) { return this._privateRoomChange(target, true, false) }
  async _privateRoomChange(target, unlink, allowStandardDestination) {
    const wb = this._wb, room = target?.room
    const generation = () => wb?.vault ? wb._memoryGeneration : wb?._archiveGeneration
    const check = () => {
      if (!wb || target?._wb !== wb || target._memoryOwner !== generation() || this._memoryOwner !== generation())
        throw sdkError('Open both Spaces in the same account', 'account_changed')
    }
    check()
    if (!room || room === this.room || this.temporary || target.temporary || this._sharedRoom || this._detachedLane || wasLaneRoom(wb, this.room))
      throw sdkError('Choose a parent Space and a different durable private room.', 'invalid_argument')
    const method = unlink ? 'unlink' : 'link'
    if (wb.vault) return wb.vault._c.roomAccount(this.room, 'privateRoom', method, room, { allowStandardDestination })
    if (!wb.account.enabled) throw sdkError('Enable account backup to sync this room link.', 'backup_required')
    const sync = async () => {
      const r = await wb.account.sync()
      check()
      if (!r?.ok) throw sdkError('The room link could not be synced. Try again.', 'index_unavailable')
    }
    await sync()
    const record = wb.backup.rooms.find(r => r.room === room)
    if (!record || !wb.backup.rooms.some(r => r.room === this.room)) throw sdkError('Add both Spaces to this account first.', 'not_in_account')
    if (record.shared && record.shared !== this.room) throw sdkError('This private room is linked to a different Space.', 'already_linked')
    if (unlink) {
      if (!record.shared && !record.detachedLane) throw sdkError('This room is not linked to this Space.', 'not_linked')
      wb.backup._detachLane(room, this.room)
      for (const lane of wb._openLanes || []) if (lane.room === room && lane._sharedRoom === this.room) lane._detachShared()
    } else {
      if (wb.backup.rooms.some(r => r.shared === room && !r.detachedLane)) throw sdkError('A Space with private rooms cannot become a private room.', 'lane_of_lane')
      const cfg = await this._client.getConfig(this.room, this._mk, { plainMark: true })
      if (!cfg || gatedStub(cfg)) throw sdkError('Could not read the parent Space settings.', 'lane_wait')
      if (cfg.lanes === false) throw sdkError('Private assistants are disabled in this Space.', 'lanes_disabled')
      await assertNotKept(this); await assertNotKept(target)
      const confidential = sp => wb._enc.rooms.has(sp.room) || ENC_MARK.test(sp.shareLink || '')
      if (confidential(this) && !confidential(target) && !allowStandardDestination) throw sdkError('The private room uses the standard tier. Confirm before linking it.', 'tier_mismatch')
      await refuseAttestedIntoPlain(this._client, this.room, this._mk, room, target._mk)
      check()
      wb.backup._attachLane(room, this.room)
    }
    await sync()
    const accepted = wb.backup.rooms.find(r => r.room === room)
    if (!accepted || (unlink ? accepted.shared === this.room : accepted.detachedLane || accepted.shared !== this.room))
      throw sdkError('A different room link won the account sync. Reopen the room and try again.', 'association_changed')
    return { room, parent: this.room, linked: !unlink }
  }
  get embed() { return (this._embed ||= roomEmbed(this, () => wasLaneRoom(this._wb, this.room))).api }
  async invokeSkill(name, args = {}) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || !args || typeof args !== 'object' || Array.isArray(args)) throw sdkError('Choose a named skill and supply an arguments object.', 'invalid_argument')
    return this.send('', { _skill: { name: name.trim(), args } })
  }

  async send(text, { from = 'You', mode, instructions, dictation, images, files, stopKey, showPrompt, replyTo, tools, _onAttempt, _aborted, _skill } = {}) {
    { const f = arguments[1] && arguments[1].from; if (typeof f === 'string' && !arguments[1]._peerPost) this._who(f) } // remember the name this member uses
    // PER-QUESTION TOOLS on a plain room (docs/visitor-limits.md: a help desk's "search the guide", "which screen am I on"):
    // the same action shape a Lane takes, offered for THIS question only; an `await` action is answered by this page while
    // the turn waits (the device call), a `propose` one after the member approves.
    let toolOpts = {}
    if (Array.isArray(tools) && tools.length) {
      const extra = buildActions(tools)
      if (extra.defs.length > LIMITS.actions) throw limitError(`${extra.defs.length} actions offered to this turn; the limit is ${LIMITS.actions} per turn`)
      Object.assign(this._writes, extra.handlers); Object.assign(this._reads, extra.reads)
      if (extra.defs.length) toolOpts = { clientTools: extra.defs, clientGuidance: extra.guidance }
    }
    if (this._feed) this._feed.sent() // a new turn: its own words are never held back by the previous answer (turnFeed.js; the app does the same — sync sweep 10-16 #10)
    const msg = withMedia({ from, ...(_skill ? { mcp: _skill } : { text: String(text) }), ...(dictation ? { voice: voiceForDictation(dictation, this.room) } : {}) }, images, files) // `images` ≤ 4, `files` ≤ 2 — see LIMITS
    const rt = replyRef(replyTo); if (rt) msg.replyTo = rt // a reply quotes the message it answers, as the app's do
    await this.safeMedia._prepare(msg) // a Safe media room: its photos' and PDFs' safe copies start now, and go beside it once stored
    const opts = { ...(await this._turnOpts(mode)), ...toolOpts, ...perTurn(instructions), ...stopOpt(stopKey), ...promptOpt(showPrompt) }
    const r = await this._turnHeld(() => this._provenTurn(msg, opts), _onAttempt, _aborted)
    this._kick() // poll faster so the reply lands quickly
    if (r && r.ok) this._askName()
    return r
  }

  // THE ROOM'S NAME FOLLOWS THE CONVERSATION (sdk-rooms.md#room-name: "one is generated after the first exchange"), the way the
  // Spaces app asks for it (roomTitle.js maybeGenerateTitle): after the first exchange on this handle, and again every
  // NAME_RECHECK_EVERY sends. The SERVER decides whether a name may be generated (roomName.js mayAutoName — one person in
  // the room, no name set by hand) and appends it to the log, where it arrives as the 'title' event. It was never asked
  // from the SDK, so a room used only through it stayed unnamed (sync sweep, 2026-10-10). Fire-and-forget.
  _askName() {
    if (this._title && this._title.manual) return
    // COUNTED IN THE ROOM'S ENTRIES, as the app's roomTitle.js and the server's RETITLE_AFTER count them — not this handle's
    // own sends: a room others write in was re-asked too rarely (or a busy handle too often) (sync sweep, 10-12)
    const at = Math.max(Number(this._count) || 0, (this.messages || []).length)
    if (this._naming || (this._namedAt !== undefined && at - this._namedAt < NAME_RECHECK_EVERY)) return
    // The recheck window starts on any ANSWER — the server's "not yet / not here" (a 200 with no title: a group, a
    // direct chat, too few entries) included, as the app's roomTitle.js does. Only a failed ask (thrown, non-200: asleep,
    // offline) is asked again at the next send.
    this._naming = true
    Promise.resolve(this._client.title && this._client.title(this.room, this._mk, !!this._title))
      .then((r) => { if (r && (r.status === 200 || r.title)) this._namedAt = at })
      .catch(() => {}).finally(() => { this._naming = false })
  }

  /** React to a message with an emoji (or take your reaction off): `await space.react(message, '👍')`,
   *  `react(message, '👍', { off: true })`. The reaction is written ON the message — no new entry, no assistant turn —
   *  and arrives on every device as an 'update'. In a verified room it belongs to your signed-in key: nobody else can
   *  take it off. → { ok, reactions } (reactions = { emoji: [names] }), or { ok: false, error }. */
  async react(message, emoji, { off = false, from } = {}) {
    from = this._who(from)
    if (!message || typeof message !== 'object' || message.id == null) throw sdkError('witbitz: react(message, emoji) takes a Message (from "message" or snapshot())', 'invalid_argument')
    if (typeof emoji !== 'string' || !emoji.trim() || emoji.length > 16) throw sdkError('witbitz: react needs one emoji', 'invalid_argument')
    // One retry on a transport failure (a throw, or no status), as the app's reaction does (space.js); a refusal is an
    // answer, never thrown — the result is `{ ok: false, error }` as typed (sync sweep, 2026-10-10).
    const send = () => this._client.react(this.room, this._mk, { target: entryKeyOf(message), emoji: emoji.trim(), ...(off ? { off: true } : {}) }, from)
    let r
    try { r = await send() } catch { r = null }
    if (!r || !r.status) { await new Promise((ok) => setTimeout(ok, 400)); try { r = await send() } catch (e) { r = { status: 0, error: (e && e.code) || 'unavailable' } } }
    this._kick()
    return r && r.status === 200 ? { ok: true, reactions: r.reactions || {} } : { ok: false, error: String((r && r.error) || (r && r.status === 404 ? 'not_found' : 'failed')) }
  }

  /** Send, and hold THIS turn: `{ status, text, result, on('partial'|'done'), finished, abort() }` (sdkTurn.js).
   *  `finished` resolves `{ status: 'done'|'silent'|'failed'|'aborted'|'timeout', reply, text, proposed, error? }` and
   *  never rejects. Takes send()'s options plus `timeoutMs` (default ~16 min, the app's wait — sdkTurn.js TURN_TIMEOUT_MS; on timeout the turn is stopped). */
  turn(text, opts = {}) {
    const t = new Turn(this, text, opts)
    // close() settles a turn still running (pass 5, V#17: its listeners went silent and `finished` waited for its timeout)
    if (t.status === 'running') { (this._turns ||= new Set()).add(t); t.finished.then(() => { this._turns.delete(t) }) }
    return t
  }

  /** THE ASSISTANT AS A FUNCTION (sdk-assistant.md#run): run this room's assistant once on `input` and get the answer back —
   *  nothing is written to the room (no message, no reply, no card, no notification). The room is the container that
   *  admits and bills it, and its store is readable to the assistant (data_query). The assistant sees `input`, not the
   *  room's conversation, and only the tools that need no approval.
   *  `schema` asks for structured output: `{ field: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' }`
   *  (all required) or a JSON Schema object; the result's `output` then fits it, or the run fails `no_structured_output`.
   *  ⚑ A run must finish within ~30 s on the hosted endpoint: past that the answer cannot be returned and nothing was
   *  kept, so the result is `{ ok: false, error: 'too_slow' }` — shorten the task or lower the effort.
   *  → { ok, text, output?, usage?, prompt?, error?, detail? } — never throws for a refusal. */
  async run(input, { instructions, schema, images, from = 'app', showPrompt } = {}) {
    const msg = withMedia({ from, text: String(input) }, images, undefined)
    await this._freshSettings(); const model = turnModelOf(this._modelPick) // a run answers with the room's model, like its turns
    let r
    // a transport failure is an ANSWER, as send()'s is (sync sweep, 2026-10-10: run() threw): { ok: false, error, detail }
    try { r = await this._provenTurn(msg, { ...(await this._receipt()), ...perTurn(instructions), ...promptOpt(showPrompt), run: true, ...(schema ? { schema } : {}), ...(model ? { model } : {}), ...this._runExtra() }) } catch (e) { return { ok: false, error: String((e && e.code) || 'unavailable'), detail: String((e && e.message) || e).replace(/^witbitz: /, '').slice(0, 200) } }
    const extra = { ...(r && r.usage ? { usage: r.usage } : {}), ...(r && r.prompt ? { prompt: r.prompt } : {}) }
    if (r && r.status === 200 && r.run) return { ok: true, text: String(r.reply || ''), ...(r.output !== undefined ? { output: r.output } : {}), ...extra }
    if (r && r.status === 503 && !r.error) return { ok: false, error: 'too_slow', detail: 'the run did not finish within the endpoint\'s ~30 s; nothing was kept — shorten the task or lower the effort', ...extra }
    if (r && r.status === 200) return { ok: false, error: 'run_unsupported', detail: 'this server answered a turn, not a run (an older deployment)' }
    return { ok: false, error: String((r && r.error) || 'failed'), ...(r && r.reason ? { detail: String(r.reason) } : {}), ...(r && r.reply ? { text: String(r.reply) } : {}), ...(r && Number.isFinite(r.retryAfter) ? { retryAfter: r.retryAfter } : {}), ...extra } // rate_limited: retryAfter (s)
  }

  // ⛔ A MESSAGE SENT WHILE THE ASSISTANT WAS REPLYING WAS LOST, AND send() SAID ok (a builder, 2026-09-29). The server
  // QUEUES by design (agent/spaceTransport.mjs §QUEUE): while a reply runs it stores nothing new and answers `busy`, and
  // the CLIENT holds the message and resends when the room frees. The app has done that since the queue shipped
  // (space.js: 1.5 s × 120 ≈ 180 s — longer than a 150 s turn); the SDK returned the busy answer as the result, a builder
  // read `ok: true`, and the message was gone. Now: held and resent the same way, and one that could not get in comes
  // back `ok: false, error: 'busy'` — never ok:true.
  // ★ And the 30 s cut: the API front door ends a request at ~30 s while the server finishes the turn (150 s) and the
  // reply arrives on 'message'. That 503 carries none of OUR error codes; it is marked `pending: true` so it does not
  // read as a failure — and it is NOT resent, because the first message is still being answered.
  // ⛔ AND EVERY RESULT SAYS ok (2026-10-07; a builder: "user_token_required comes back as { ok: true, error }"). A refusal
  // from the server is { status, error, message } with NO ok, while a success usually carries the server's own ok:true —
  // so `r.ok !== false` read every refusal as a success. Now ok is always a boolean, read as turnVerdict reads the turn:
  // posted, silent and pending are ok; busy, refused, failed and no answer are not; an error field is never ok.
  async _turnHeld(doTurn, onAttempt, aborted, noHold, deadline) { // noHold: a link's ask — the first busy answer comes back (the app's tell_lane says "busy"); sync sweep, 2026-10-10 // aborted(): space.turn()'s abort() — a held message is never resent after it (sync sweep, 2026-10-10) // turnVerdict.js — the hold policy and the reading the Spaces app's send uses
    const run = doTurn
    // A transport failure (no network, an enclave that cannot be reached or verified) is an ANSWER too: `send()` does not
    // throw (sdk.md) — it resolves { ok: false, status: 0, error } (sync sweep, 2026-10-10). Bad arguments still throw
    // before this point (limit_exceeded and the like), as documented.
    doTurn = async () => {
      if (onAttempt) { try { onAttempt() } catch { /* */ } } // space.turn() marks where ITS reply can start
      try { return await run() } catch (e) { return { status: 0, error: String((e && e.code) || 'unavailable'), detail: String((e && e.message) || e).replace(/^witbitz: /, '').slice(0, 200) } }
    }
    let r = await doTurn()
    for (let i = 0; turnVerdict(r).kind === 'busy' && !noHold; i++) {
      if (deadline ? Date.now() >= deadline : i >= (this._queueMaxTries ?? QUEUE_MAX_TRIES)) return { ...r, ok: false, error: 'busy', detail: 'the assistant was still replying; the message was not stored — send it again' }
      this._kick()
      await new Promise((res) => setTimeout(res, Math.min(this._queueRetryMs ?? QUEUE_RETRY_MS, deadline ? deadline - Date.now() : Infinity)))
      if (deadline && Date.now() >= deadline) return { ...r, ok: false, error: 'busy' }
      if (this._stopped) return { ...r, ok: false, error: 'closed', detail: 'the Space was closed while the assistant was busy — the message was not stored' } // V#17: a closed handle does not keep resending for ~3 min
      if (aborted && aborted()) return { ...r, ok: false, error: 'aborted', detail: 'aborted while the assistant was busy — the message was not stored' }
      r = await doTurn()
    }
    if (turnVerdict(r).kind === 'pending') return { ...r, pending: true, ok: true }
    return withTurnOk(r)
  }

  /** How the assistant decides whether to reply, for THIS room and every member of it:
   *   'auto'     — it answers when you are alone with it or address it, and uses a judgement call in a group so it does
   *                not interject while people are talking to each other. Only a builder sets it; the Witbitz app shows it
   *                as Auto but offers only the two below.
   *   'always'   — it answers every message. In a 1:1 room this is usually what you want.
   *   'ondemand' — it answers only when you @-mention it (`@ai`, or `@` + its name); talking ABOUT it does not count.
   *  A room with no stored mode uses the Witbitz app's default, for every sender: 'ondemand' in a verified room with more
   *  than one person (or one whose people cannot be counted, such as a domain), 'always' otherwise.
   *  Sealed to the room like everything else, so it survives a reload, converges across members, and matches the
   *  setting in the Witbitz app. Pass `mode` to `send()` instead to override it for a single message in a room with no stored mode. */
  async setReplyMode(mode) {
    if (!REPLY_MODES.includes(mode)) throw sdkError(`unknown reply mode ${JSON.stringify(mode)} — one of ${REPLY_MODES.join(', ')}`, 'invalid_argument')
    // A PRIVATE LANE ALWAYS REPLIES (the server: spaceService respondMode — a bridged lane is 'always'; the app hides the chip there):
    // a mode stored on it changed nothing and was reported back as if it did (sync sweep 2026-11-14 P1, owner: yes)
    if (this._sharedRoom || this._detachedLane || wasLaneRoom(this._wb, this.room)) throw sdkError('witbitz: a private lane always replies — its reply mode cannot be set', 'lane')
    const r = await this._client.state(this.room, this._mk, 'agentmode', { mode }, REPLY_MODE_LABEL[mode])
    if (!r || r.status !== 200) throw refused('setReplyMode', r) // every error carries a code (sync sweep, 2026-10-10)
    this._mode = mode
    return { mode }
  }

  /** The room's reply mode as it stands now: the stored one, else the room's default — the server's rule (roomSettings.js
   *  roomDefaultReplyMode, sync sweep 2026-11-13 #1), counted with the room's sign-in record as the server counts. */
  /** WHICH TOOLS RUN ON THEIR OWN HERE (docs/approvals-model.md; the same setting as the Witbitz app's ⋯ → Tools). Each tool of the
   *  room's assistant either runs on its own or asks first (a card a person approves); the server enforces it on every turn,
   *  whoever sends the message.
   *    await space.toolRules.get()              → { tools: [{ name, about, default, now, rule? }], rules: { name: 'auto'|'ask' } }
   *    await space.toolRules.set(name, 'auto')  → runs on its own;  'ask' → asks first;  null → back to its default
   *  In a room with admins only an admin may set them (error code `not_admin`). */
  get toolRules () {
    const sp = this
    return {
      get: async () => {
        const r = await sp._client.toolRules(sp.room, sp._mk, typeof sp._bridgeOpts === 'function' ? sp._bridgeOpts() : {})
        if (!r || r.status !== 200) throw refused('toolRules.get', r)
        return { tools: Array.isArray(r.tools) ? r.tools : [], rules: r.rules || {} }
      },
      // ⛔ 10·S#2 / S#4 (pass 10): built on the version it read (`ifV`; a conflict reads again), never on a failed read taken as
      //   "no rules" (that erased every other rule), and it answers the rules it wrote (the write's answer carries none).
      set: async (name, mode) => {
        let cur = await sp._client.state(sp.room, sp._mk, TOOLRULES_DOC).catch((e) => ({ status: 0, error: String((e && e.message) || e) }))
        if (typeof name !== 'string' || !name) throw sdkError('witbitz: toolRules.set needs a tool name', 'invalid_argument')
        if (mode !== null && !RULE_VALUES.includes(mode)) throw sdkError(`witbitz: a tool rule is 'auto', 'ask' or null (its default) — not ${JSON.stringify(mode)}`, 'invalid_argument')
        for (let i = 0; i < 4; i++) {
          if (i) cur = await sp._client.state(sp.room, sp._mk, TOOLRULES_DOC).catch((e) => ({ status: 0, error: String((e && e.message) || e) }))
          if (!cur || (cur.status && cur.status !== 200)) throw refused('toolRules.set', cur)
          const rules = { ...rulesFromDoc(cur) }
          if (mode === null) delete rules[name]; else rules[name] = mode
          const r = await sp._client.state(sp.room, sp._mk, TOOLRULES_DOC, toolRulesDocOf(rules), 'Tool settings changed', undefined, Number(cur.v) || 0)
          if (r && r.status === 409) continue
          if (!r || r.status !== 200) throw refused('toolRules.set', r)
          return { rules }
        }
        throw sdkError('witbitz: toolRules.set — the rules kept changing elsewhere; try again', 'conflict')
      },
    }
  }

  async replyMode() {
    if (this._sharedRoom || this._detachedLane || wasLaneRoom(this._wb, this.room)) return 'always' // a private lane: the server always replies there
    await this._modeReady
    if (this._mode) return this._mode
    let cfg = null
    try { cfg = typeof this._client.getConfig === 'function' ? await this._client.getConfig(this.room, this._mk, { plainMark: true }) : null } catch { cfg = null }
    // a room whose settings could not be read is NOT an unverified room (sync sweep 2026-11-14 #7: it answered 'always'; a verified
    // group is 'ondemand') — refuse, as the server's answer is unknown. A PLAIN room (no settings at all) reads `{ plain: true }`.
    if (cfg && cfg.plain === true) cfg = null
    else if (!cfg || typeof cfg !== 'object' || gatedStub(cfg)) throw sdkError('witbitz: this Space\u2019s settings could not be read just now, so its reply mode is not known — try again', 'config_unavailable')
    let members = null
    if (cfg && cfg.admission === 'email') {
      const seen = await Promise.resolve(this._client.state(this.room, this._mk, 'roster')).then((d) => (d && d.seen) || null).catch(() => null)
      members = await rosterParticipants(cfg, this.room, { seen }).catch(() => null)
    }
    return roomDefaultReplyMode(cfg, members)
  }

  // The turn options every send builds on. A per-turn mode rides along but does NOT overwrite the room's setting — and the server
  // lets a STORED mode win over it (roomSettings.js turnReplyMode); otherwise the room's own mode rides along. REFUSES an unknown mode rather than dropping it — this whole feature
  // exists because an option that is silently discarded reads exactly like one that does not work.
  /** The signed-in member, in the shape `spaceClient.turn` expects — or null when nobody is signed in.
   *  A GATED room needs this on every turn: without it the server cannot tell who is writing and refuses. An OPEN room
   *  is unaffected, which is why this returns null rather than throwing. */
  // A TURN WITH YOUR APP'S PROOF (B8): only in a room the server said needs one ('attestation: missing' — learned once, then
  // every turn there carries it). The proof binds the member's signing key and the room's fresh challenge; a member with no
  // sign-in signs with a key of this page's own (as the app's attested rooms do). Every other room: exactly as before.
  async _provenTurn(msg, opts) {
    const live = this._embed?.context()
    if (live) opts = { ...opts, context: [opts.context, live].filter(Boolean).join('\n\n').slice(0, 4000) }
    const att = this._wb && this._wb._attest
    const send = async () => {
      if (!this._needsProof || !att) return this._client.turn(this.room, this._mk, msg, this._identity(), opts)
      const id = this._identity() || await this._deviceIdentity(msg.from)
      let f = await att.turnFields(this.room, id.sign.pub)
      if (!f.attestation) { att.notePoll(this.room, await this._client.pollSealed(this.room, this._mk, null, 0).catch(() => null)); f = await att.turnFields(this.room, id.sign.pub) }
      const r = await this._client.turn(this.room, this._mk, { ...msg, ...f }, id, opts)
      att.noteAnswer(r)
      return r
    }
    let r = await send()
    if (att && !this._needsProof && r && r.status === 403 && /^attestation: missing/.test(String(r.reason || ''))) { this._needsProof = true; r = await send() }
    return r
  }
  async _deviceIdentity(name) {
    // ONE KEY PER APP on this origin (the review: one key linked a person's attested rooms across apps); a failed generation is
    // not kept, so the next turn tries again
    const slot = 'witbitz:attest-sign:' + String((this._wb._attest && this._wb._attest.app) || '')
    if (!this._wb._attestSign) {
      let kept = null
      try { kept = JSON.parse(globalThis.localStorage.getItem(slot) || 'null') } catch { /* none */ }
      this._wb._attestSign = kept && kept.priv && kept.pub ? Promise.resolve(kept)
        : genKeypair().then((k) => { const v = { priv: k.priv, pub: k.pub }; try { globalThis.localStorage.setItem(slot, JSON.stringify(v)) } catch { /* memory only */ } return v })
          .catch((e) => { this._wb._attestSign = null; throw e })
    }
    return { attestKey: true, name: String(name || 'You'), sign: await this._wb._attestSign }
  }

  _identity() {
    const sess = this._wb && this._wb._session
    if (!sess || !sess.idToken || !sess.email || !sess.sign || !sess.sign.priv || !sess.sign.pub) return null
    if (sess.exp && sess.exp <= Date.now()) return null
    return { email: sess.email, googleIdToken: sess.idToken, sign: sess.sign }
  }

  // THE ROOM'S SETTINGS (roomSettings.js): read on open, and again before a turn once they are SETTINGS_FRESH_MS old — the
  // app re-reads them on its poll tick, so a member's change from any client converges here too. Best-effort: a doc that
  // cannot be read keeps the last value; a room with no docs sends no mode (⇒ 'auto') and no model (⇒ its own).
  async _readSettings() {
    try {
      const [a, b] = await Promise.all([this._client.state(this.room, this._mk, 'agentmode').catch(() => null), this._client.state(this.room, this._mk, 'model').catch(() => null)])
      const m = modeFromDoc(a); if (m) this._mode = m
      const p = modelPickFromDoc(b); if (p !== undefined) this._modelPick = p
    } catch { /* a convenience; never let it break sending */ }
    this._settingsAt = Date.now()
  }
  async _freshSettings() {
    await this._modeReady
    if (Date.now() - this._settingsAt > SETTINGS_FRESH_MS) { this._modeReady = this._readSettings(); await Promise.race([this._modeReady, new Promise((r) => setTimeout(r, 1500))]) }
  }
  async _turnOpts(mode, extra = {}) {
    if (mode !== undefined && !REPLY_MODES.includes(mode)) throw sdkError(`unknown reply mode ${JSON.stringify(mode)} — one of ${REPLY_MODES.join(', ')}`, 'invalid_argument')
    await this._freshSettings()
    const m = mode !== undefined ? mode : this._mode
    const model = turnModelOf(this._modelPick) // the room's model pick (the app's model chip) — over its create-time model, as every app turn does
    const memory = extra.links ? [] : this._wb?._memoryFor?.(this) || []
    return { ...(memory.length ? { links: memory } : {}), ...extra, ...(m ? { mode: m } : {}), ...(model ? { model } : {}), ...(await this._receipt()) }
  }
  /** @private THE ACCOUNT'S USAGE RECEIPT for a turn here (docs/usage-receipts.md; the owner, 2026-10-23: a builder's app
   *  records the account's usage too): the address the server seals this turn's cost to, from the account's usage key
   *  (wb.account) — none until the account is on. In a vault the vault adds it (it holds the key). */
  async _receipt() {
    try {
      if (this._client && this._client.vault) return {}
      const k = this._wb && this._wb.account && typeof this._wb.account._usageKey === 'function' ? this._wb.account._usageKey() : null
      return k ? { receipt: await receiptFor(k, this.room) } : {}
    } catch { return {} }
  }

  // ★ WHO DID IT, on the lines other members read (sync sweep, 2026-10-10). approve, deny, rename, react, configure, row
  //   writes and connection grants defaulted to "You" — so the other members read "You renamed…", "You approved…". The
  //   app passes the member's name. Here: the name passed, else the name this member last sent or acted under, else
  //   "A member". (send()'s documented default stays "You".)
  _who(from) {
    // 'you' in any case is nobody's name — other members would read it (sync sweep, 2026-10-10)
    if (typeof from === 'string' && from.trim() && from.trim().toLowerCase() !== 'you') { this._memberName = from.trim().slice(0, 80); return this._memberName }
    return this._memberName || 'A member'
  }

  /** What the server ACTUALLY stores for this room — the opaque, sealed ledger. Content-blind at rest, provable: the
   *  server holds ciphertext and is NOT a recipient. Fetch it with no key (reading ciphertext reveals nothing) and show
   *  a user exactly what leaves their device. → { bytes, recipients, sha256, alg, sealed } | null (null before the first
   *  message). `recipients` names who can decrypt — in a normal Space it is `['room']`; the operator is never in it. */
  async exportFile() {
    if (this._wb?.vault) return this._wb.vault._c.roomAccount(this.room, 'portable', 'export')
    const { saveRoomExport } = await import('./sdkExports.js')
    const generation = this._wb?._archiveGeneration
    return saveRoomExport(this, this._wb?._enc?.rooms.has(this.room) || ENC_MARK.test(this.shareLink || '') ? 'enclave' : 'standard', () => this._wb?._archiveGeneration === generation)
  }
  async sealedProof() {
    if (!(this._client && this._client.vault)) this._needKey('sealedProof') // a vault reads the stored boxes for the page (ciphertext only)
    // A VERIFIED room refuses the keyless read to everyone (a non-member must not get its ciphertext): a member reads the
    // same stored bytes with the key and computes the proof here (sealedReceipt.js; sync sweep, 2026-10-10).
    if (this._gated && typeof this._client.exportSealed === 'function') {
      const x = await this._client.exportSealed(this.room, this._mk).catch(() => null)
      return x && x.status === 200 ? receiptOf(x.sealed) : null
    }
    const r = await this._client.sealed(this.room)
    // A 404 may be a GATED room opened from a link with no gate marker (its config not read yet): the refusal looks like
    // "nothing stored" on purpose. Ask as a member before saying there is nothing (sync sweep, 2026-10-10).
    if (r && r.status === 404 && typeof this._client.exportSealed === 'function') { const x = await this._client.exportSealed(this.room, this._mk).catch(() => null); if (x && x.status === 200 && x.sealed != null) return receiptOf(x.sealed) }
    if (!r || r.status !== 200) return null
    return { bytes: r.bytes, recipients: Array.isArray(r.recipients) ? r.recipients : [], sha256: r.sha256, alg: r.alg, sealed: r.sealed }
  }

  _isEnclave() { return !!(this._wb && this._wb._enc && this._wb._enc.rooms.has(this.room)) }
  // A STALE ENCLAVE KEY (`bad_mkseal`: the enclave was replaced, so what this page sealed to the old one cannot be opened)
  // is healed by attesting the new enclave — the app does the same on a read and on a send (space.js). Throttled to once
  // per 10 s; true when a fresh key is in hand (sync sweep, 2026-10-10: the SDK stayed on the dead key until a reload).
  // ONE attest at a time, shared by every caller: a send that meets a stale key while the poll is already re-attesting
  // waits for that attest and is resent, instead of losing its retry to the throttle (sync sweep, 2026-10-10). Within
  // 10 s of the last attest its answer stands (the key is as fresh as it gets) — never a second attest.
  /** A VERIFIED ROOM'S MEMBERS, CHANGED IN PLACE (https://witbitz.chat/docs/sdk-people.md#members): the same room, link, history and
   *  lanes, and from now on a NEW key that only the people still on the list receive — each member's device takes it on its next
   *  request ('rekeyed'); a removed member's sees 'removed'. `admission`: { emails, domains?, admins?, owners?, advertise? }, the
   *  list stated in FULL, as fork() takes it. Needs a signed-in owner or admin of an email-gated Space, and each member's invite
   *  key for THIS app (wb.invite, published at their sign-in) — anyone without one is listed in `unreachable` and their device is
   *  told to ask for a fresh link ('pending'): send them `link`. → { inPlace:true, epoch, link, removed, added, unreachable } */
  async changeMembers(admission = {}) {
    if (this._sharedRoom) throw Object.assign(new Error("witbitz: a lane is one member's own room — change its Space's members instead"), { code: 'lane' })
    if (this._wb && this._wb.vault) return this._wb.vault._c.changeMembers(this.room, admission) // the vault holds the key: it asks the person, makes the new key, keeps it
    return changeMembersInPlace(this, admission)
  }
  async resendInvite(recipient) {
    if (this._wb && this._wb.vault) return this._wb.vault._c.roomAccount(this.room, 'invitations', 'resend', recipient)
    return resendInvitation(this, recipient)
  }
  /** Rotate the key now: the same members, a new key (a lost phone, a link sent to the wrong place) — whoever holds only a copy
   *  of the old key reads nothing written after. → { inPlace:true, rotated:true, epoch, link, unreachable } */
  async rotateKey() {
    if (this._sharedRoom) throw Object.assign(new Error("witbitz: a lane is one member's own room — rotate its Space's key instead"), { code: 'lane' })
    if (this._wb && this._wb.vault) return this._wb.vault._c.rotateKey(this.room)
    return rotateKeyInPlace(this)
  }
  /** @private a call met `stale_key`: take this account's grant once (shared), never more than every 15 s while it waits. */
  async _adoptKey(args) {
    if ((args || []).some((x) => typeof x === 'string' && this._oldKeys.has(x)) && this._mk && !this._oldKeys.has(this._mk)) return { mk: this._mk, old: this._oldKeys } // the key was already taken
    if (this._keyP) return this._keyP
    if (this._keyWait && Date.now() - (this._keyAt || 0) < 15000) return null
    // a grant that did not come (grant_unavailable sets no _keyWait) is asked again after 2 s, 4, 8 … up to a minute — not on
    // every op the room answers stale, ~1/s (the app's l1.js STALE_BACKOFF_MS; sync sweep 11-08 #31)
    if (this._keyMiss && Date.now() < this._keyMiss.until) return null
    this._keyAt = Date.now()
    this._keyP = adoptRoomGrant(this).then((got) => {
      if (got) { this._keyMiss = null; return { mk: this._mk, old: this._oldKeys } }
      const n = ((this._keyMiss && this._keyMiss.n) || 0) + 1
      this._keyMiss = { n, until: Date.now() + GRANT_BACKOFF_MS[Math.min(n, GRANT_BACKOFF_MS.length) - 1] }
      return null
    }, () => null).finally(() => { this._keyP = null })
    return this._keyP
  }
  /** @private this room's key changed (a member change or a rotation, here or on another device) */
  _setKey(mk, epoch, split = null) {
    this._gateCfg = null
    if (this._mk && this._mk !== mk) this._oldKeys.add(this._mk)
    this._mk = mk
    this.epoch = Number(epoch) || 0
    this.shareLink = relink(this.shareLink, split || { mk })
    this._etag = null // a read with the old key can have raced the change and answered the NEW etag: read again from here
    this._keyWait = null; this._keyMiss = null; this._pollHeld = false
    try { if (this._wb && this._wb.invite) this._wb.invite._waiting.delete(this) } catch { /* */ }
    if (this._stream) { try { this._stream.stop() } catch { /* */ } this._stream = null } // the stream opens with the room key
    // ★ A CLOSED HANDLE (pass 6, K#6): a grant adopted after close() re-added a room the person had just forgotten, with a newer
    //   `at` than its tombstone — it came back on every device. Closed, the backup only follows a room it still holds.
    const keep = !this._stopped || (() => { try { return this._wb.backup.rooms.some((r) => r.room === this.room) } catch { return false } })()
    try { if (keep && this._wb && this._wb.backup) this._wb.backup.add(this) } catch { /* the backup must never cost the room */ }
    this._emit('rekeyed', { room: this.room, epoch: this.epoch, link: this.shareLink })
  }

  async _reattest() {
    if (this._client?.keyless || this._client?.vault || !this._isEnclave()) return false
    if (this._reattestP) return this._reattestP
    if (Date.now() - (this._reattestAt || 0) < 10000) return !!this._reattestLast
    this._reattestAt = Date.now()
    this._reattestP = Promise.resolve().then(() => this._wb._encAttest(this.room)).then(() => true, () => false)
      .then((ok) => { this._reattestLast = ok; this._reattestP = null; return ok })
    return this._reattestP
  }

  /** RETIRED in 3.0.0 — MEMBERS CHANGE ONLY IN PLACE (the owner, 2026-10-23: "only in place"). A Space never moves to a new
   *  room any more: `space.changeMembers(admission)` changes who is in, in the same room, with a new key only the remaining
   *  members receive (#members). A move an OLDER client made is still followed (`_maybeMoved`). Throws `use_change_members`. */
  async fork() {
    throw sdkError('witbitz: a Space no longer moves to a new room — members change in place: space.changeMembers(admission) (https://witbitz.chat/docs/sdk-people.md#members)', 'use_change_members')
  }
  /** @private announce this device in the room's guest book under its signing key, once per open: the email gate then
   *  vouches for the address behind it (the server's `seen`), which is how a fork finds the remaining members' devices. */
  async _announce() {
    if (!this._gated && !this._client?.vault) return
    this._announced = true
    if (this._client && this._client.vault && this._wb && this._wb.vault) { if (!this._sharedRoom) this._wb.vault._c.announce(this.room).catch(() => {}); return } // the vault's device, by its own rule
    const sess = this._wb && this._wb._session
    if (this._sharedRoom || !sess || !sess.sign || !sess.sign.pub || typeof this._client.state !== 'function') return
    try {
      // Only in an EMAIL-GATED room — the only kind that forks, and where this key already rides the member's own posts.
      // The SDK signs with ONE key per session, so announcing it in open rooms would let them be linked to each other.
      // Known without a fetch (the creation, the link's marker, or a gate already read) — every open is not a config read.
      if (!this._gated) return
      if (this._wb && !this._wb._inviteP && this._wb.invite.status !== 'enrolled') this._wb._enrollInvite() // a member of a verified room on a restored session: its invite key is published once per client, so a change in place reaches it
      // TWO MEMBERS ANNOUNCING AT ONCE: each writes the book it read, and the last write wins — read it back, and announce again
      // while this row (or the gate's record of it, roomRoster.unseenIn) is missing; a member change in place names members by it
      const self = selfRow({ signPub: sess.sign.pub })
      for (let i = 0; i < 3; i++) {
        const r = await this._client.state(this.room, this._mk, ROSTER_DOC)
        if (!r || r.status !== 200) return
        const { roster, changed } = ensureSelf(r.state, self)
        if (!changed && !unseenIn(r.seen, self.id) && !entriesMissing(r.seen, self.id, this.room)) return // entries: one more announce per page, never retried
        if (this._stopped || this._wb._session !== sess) return
        // THE SHAPE THE ROOM ALREADY HAS (second review, 2026-11-27): the app's book is { people: [...] }, an SDK room's was the list itself.
        // SDK 4.3.0 wrote the app's shape everywhere (c48d05a35) — but a 4.2.0 page (published, unchangeable) reads only a list: in a
        // builder's room with both open it saw nobody and wrote back only itself. A list stays a list; anything else is the app's shape.
        const written = await this._client.state(this.room, this._mk, ROSTER_DOC, Array.isArray(r.state) ? roster : { people: roster }, '', 'member', r.v || 0)
        if (written?.status === 409) continue
        if (written?.status !== 200) return
        announcedIn(this.room, self.id)
        await new Promise((res) => setTimeout(res, 200 + Math.floor(Math.random() * 600)))
      }
    } catch { /* the guest book is best-effort; it never costs the room */ }
  }

  /** @private a fork notice arrived: follow it only if the gate stamped it (and, in a room with admins, an admin posted
   *  it), its boxes match its signed hash, and one box opens with THIS device's key → emit `moved`. */
  async _maybeMoved(e) {
    try {
      if (this._client && this._client.vault && this._wb && this._wb.vault) { // the vault reads the notice from the room and judges it
        const r = await this._wb.vault._c.follow(this.room, e.id)
        if (r && r.refused) this._emit('moveRefused', { from: this.room, at: e.ts, reason: r.refused, ...(r.code ? { code: r.code } : {}) }) // code: vault_unsupported for a confidential move in a vault (sdk.md)
        else if (r && r.room) this._emit('moved', { room: r.room, link: null, from: this.room, at: e.ts }) // open it with wb.vault.openRoom(room)
        return
      }
      const sess = this._wb && this._wb._session
      if (!sess || !sess.sign || !sess.sign.priv) return
      const cfg = await this._gateConfig()
      const v = await judgeMove(e, { cfg, signPriv: sess.sign.priv, room: this.room, forkAuthority: (cfg && cfg.forkAuthority) || null }) // emailFork.js — the app's rule, its forkAuthority included (a room with no admins follows only a move its creator key signed)
      if (!v) return
      if (v.refuse) { this._emit('moveRefused', { from: this.room, at: e.ts, reason: v.refuse }); return }
      const o = v.follow
      // A CONFIDENTIAL move: the new room's ops (its config read included) go to the enclave — adopt it first, under the
      // acceptance block its own sealed config carries.
      if (this._wb && (this._isEnclave() || ENC_MARK.test(String(o.link || '')))) { await this._wb._encAdopt(o.room) }
      if (v.needsGovCheck && !(await this._newRoomKeepsGov(o.room, o.mk, e.gov))) { this._emit('moveRefused', { from: this.room, room: o.room, at: e.ts, reason: 'the new room\'s owners or admins are not what the move declared' }); return }
      this._emit('moved', { room: o.room, link: o.link, from: this.room, at: e.ts })
    } catch { /* a notice that cannot be checked is not followed */ }
  }

  /** @private OWNERS: does the NEW room's sealed config name exactly the owners and admins the move declared, and admit
   *  each of them? Read with the new room's key on this device. Anything unreadable is a no. */
  async _newRoomKeepsGov(room, mk, gov) {
    try { return await newRoomKeepsGov(await this._client.getConfig(room, mk), gov, room) } catch { return false }
  }

  /** READ THE GATE (2026-10-02). Who this Space admits, from its own sealed config — the list the server enforces, read
   *  with this Space's key on this device. → `{ gated: false }` for an open room, else `{ gated: true, emails, domains,
   *  usernames, hidden }`: `emails`/`usernames` are the ADVERTISED entries (see `admission.advertise` on createSpace),
   *  `hidden` counts the entries stored only as a room-salted hash, which no member can read back — check one with
   *  {@link Space#admits}. Throws `config_unavailable` when the config cannot be read, never a guess. */
  /** A direct chat's OTHER person, read from its sealed allow-list (only the two of you can post — the gate checks it):
   *  `{ email }` (or `{ username }` for an older room), or null when this is not a direct chat you are in. Call the chat by
   *  them, as the Spaces app does; nobody renames a direct chat (`rename()` → `direct_chat`). Needs a signed-in session. */
  async directPeer() {
    const sess = this._wb && this._wb._session
    let cfg
    try { cfg = await this._gateConfig() } catch (e) { if (e && e.code === 'sign_in_required') throw e; return null }
    const me = this._wb && this._wb.vault ? ((await this._wb.vault.whoami()) || {}).email : sess && sess.email // in a vault, its signed-in member
    return isDirect(cfg) && cfg.admission === 'email' ? directPeer(cfg, me) : null
  }

  _invitationMatches(cfg, seen) {
    return privateInvitationMatches(cfg, this.room, seen, {
      resolveUsers: async users => ({ resolved: await Promise.all(users.map(async username => {
        const found = await this._client.userResolve?.(username).catch(() => null)
        return { username, ...(found?.handle ? { handle: found.handle } : {}) }
      })) }),
      userTag: (name, room) => this._client.userTag(name, room),
    })
  }

  async _roomHistory() {
    const poll = this._client.pollSealed || this._client.poll
    if (!poll) return { entries: [], incomplete: true }
    return readAllPages(since => poll.call(this._client, this.room, this._mk, undefined, since))
  }

  async usage() {
    const [history, title] = await Promise.all([
      this._roomHistory(), this._client.state(this.room, this._mk, 'title').catch(() => null),
    ])
    const entries = history.entries || [], titles = title?.state?.usage || []
    const records = roomUsageRecords(entries, titles)
    return {
      records: records.map(e => ({ at: e.ts, kind: e.title ? 'title' : 'reply', usage: e.usage })),
      summary: summarizeUsage(entries, { titles }), csv: usageCsv(records),
      incomplete: !!history.incomplete || title?.status !== 200,
    }
  }

  async roster() {
    if (this._wb?.vault?._c?.roomAccount) {
      try { return await this._wb.vault._c.roomAccount(this.room, 'roster', 'list') }
      catch (err) { if (err?.code !== 'vault_refused') throw err }
    }
    const cfg = await this._gateConfig({ plainMark: true })
    const book = await this._client.state(this.room, this._mk, ROSTER_DOC)
    if (book?.status !== 200) throw sdkError('witbitz: the room roster could not be read', 'roster_unavailable')
    const seen = Object.fromEntries(Object.entries(book.seen || {}).filter(([, p]) => p && !p.left))
    const claims = (Array.isArray(book.state) ? book.state : book.state?.people || []).some(row => row?.verified)
    const history = claims || cfg.admission === 'email' ? await this._roomHistory() : { entries: [] }
    const entries = history.entries || []
    const attested = verifiedSigningIds(entries)
    const posters = verifiedPosters(entries, book.seen || {})
    const rows = listRoster(book.state, { attested: row => !!seen[row.id] || attested.has(row.id) })
    if (cfg.admission !== 'email') return {
      gated: false, incomplete: !!history.incomplete, members: rows.map(row => ({ label: row.label, verified: row.verified })), pending: [], domains: [], unopenedPrivateInvites: 0,
    }
    const onList = await stillOnList(cfg, this.room, [...Object.values(seen), ...posters])
    const { hiddenUnseen, seenHandles } = await this._invitationMatches(cfg, [...Object.values(seen), ...posters])
    const { items, hidden } = membersView({
      allow: cfg.allow, rows: rows.filter(row => seen[row.id]), seenPerson: id => seen[id],
      posters: [...Object.values(seen), ...posters], hiddenUnseen, seenHandles, onList,
    })
    const person = ({ label, address, user }) => ({ label, ...(address ? { address } : {}), ...(user ? { username: user } : {}) })
    return {
      gated: true, incomplete: !!history.incomplete, members: items.filter(i => i.tag === 'signed in').map(i => ({ ...person(i), verified: true })),
      pending: items.filter(i => i.tag === 'not yet opened').map(person),
      domains: (cfg.allow?.domains || []).filter(d => typeof d === 'string'), unopenedPrivateInvites: hidden,
    }
  }

  async admission() {
    if (this._wb?.vault?._c?.roomAccount) {
      try { return await this._wb.vault._c.roomAccount(this.room, 'roster', 'admission') }
      catch (err) { if (err?.code !== 'vault_refused') throw err }
    }
    const cfg = await this._gateConfig({ plainMark: true })
    const lanesOn = cfg.lanes === true ? { lanes: true } : {} // a Space whose members get private lanes (createSpace({ lanes }), the app's option) — sealed
    if (cfg.admission !== 'email') return { gated: false, ...(cfg.lane === true || cfg.bridge ? { lane: true } : {}), ...lanesOn }
    const a = cfg.allow || {}
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
    const legacy = Array.isArray(a.users) ? a.users.length : 0 // a legacy room's @username entries: counted as hidden — no username is read back (2026-10-11)
    const admins = cfg.admins && Array.isArray(cfg.admins.emails) ? cfg.admins.emails.filter((x) => typeof x === 'string') : []
    const owners = cfg.owners && Array.isArray(cfg.owners.emails) ? cfg.owners.emails.filter((x) => typeof x === 'string') : []
    let unopenedPrivateInvites = 0
    if (list(a.mh).length) {
      const book = await Promise.resolve().then(() => this._client.state(this.room, this._mk, ROSTER_DOC)).catch(() => null)
      unopenedPrivateInvites = undefined
      if (book?.status === 200) {
        const history = await this._roomHistory()
        if (!history.incomplete) {
          const seen = book.seen || {}
          const people = [...Object.values(seen).filter(p => p && !p.left), ...verifiedPosters(history.entries, seen)]
          const matches = await this._invitationMatches(cfg, people)
          unopenedPrivateInvites = matches.hiddenUnseen ?? list(a.mh).length
        }
      }
    }
    return { ...(unopenedPrivateInvites !== undefined ? { unopenedPrivateInvites } : {}), gated: true, emails: list(a.emails), domains: list(a.domains), hidden: list(a.mh).length + legacy, admins, owners, ...(cfg.lane === true || cfg.bridge ? { lane: true } : {}), ...lanesOn } // lane: a private lane, not a Space (laneConfig.js)
  }

  /** Is `email` one of this room's ADMINS? The room enforces it (2026-10-02): with admins, only they change the
   *  assistant, write a collection declared `write: 'admins'`, or approve a card that does either or calls a
   *  connection. A non-admin's attempt is refused
   *  with `code: 'not_admin'`. A room without admins has none (every member may do all of it, as before). */
  async isAdmin(email) {
    const e = String(email || '').trim().toLowerCase()
    const cfg = await this._gateConfig({ plainMark: true })
    const has = (o) => !!(o && Array.isArray(o.emails) && o.emails.some((x) => String(x).trim().toLowerCase() === e))
    return has(cfg.admins) || has(cfg.owners) // an owner is an admin
  }

  /** Is `email` one of this room's OWNERS (a level above admins, enforced by the room)? An owner can do all an admin can,
   *  and only an owner can change the owners or lower or remove an admin when the room is moved ({@link Space#fork}). */
  async isOwner(email) {
    const e = String(email || '').trim().toLowerCase()
    const cfg = await this._gateConfig({ plainMark: true })
    return !!(cfg.owners && Array.isArray(cfg.owners.emails) && cfg.owners.emails.some((x) => String(x).trim().toLowerCase() === e))
  }

  /** Does this Space's gate admit `email`? Checked on this device against the sealed list: an advertised address, a
   *  hidden (hashed) one, or the address's domain. An open room admits everyone. ⚑ A member admitted by @username alone
   *  cannot be checked here — that match needs the server's key — so it reads `false` for them. */
  async admits(email) {
    const e = String(email || '').trim().toLowerCase()
    const at = e.indexOf('@')
    if (at < 1 || at === e.length - 1) throw sdkError(`witbitz: "${email}" is not an email address`, 'invalid_argument')
    const cfg = await this._gateConfig({ plainMark: true })
    if (cfg.admission !== 'email') return true
    const a = cfg.allow || {}
    if ((Array.isArray(a.emails) ? a.emails : []).some((x) => String(x).trim().toLowerCase() === e)) return true
    if (Array.isArray(a.mh) && a.mh.length && a.mh.includes(await memberHash(e, this.room))) return true
    const domain = e.slice(at + 1)
    return (Array.isArray(a.domains) ? a.domains : []).some((d) => String(d).trim().toLowerCase().replace(/^@/, '') === domain)
  }

  /** Who is signed in here — the vault's member in a vault, else this page's session — or ''. Never throws. */
  async _signedInEmail() {
    try {
      if (this._wb && this._wb.vault) { const w = await this._wb.vault.whoami(); return w && w.email ? String(w.email) : '' }
      const s = this._wb && this._wb._session; return s && s.email ? String(s.email) : ''
    } catch { return '' }
  }

  async _gateConfig({ fresh = false, plainMark = false } = {}) {
    const owner = this._wb?.vault ? this._wb._vaultGeneration : this._wb?._session
    const key = this._mk, epoch = this.epoch
    if (!fresh && this._gateCfg && this._gateOwner === owner) return this._gateCfg
    const cfg = typeof this._client.getConfig === 'function' ? await this._client.getConfig(this.room, this._mk, plainMark ? { plainMark: true } : undefined) : null
    if (key !== this._mk || epoch !== this.epoch || owner !== (this._wb?.vault ? this._wb._vaultGeneration : this._wb?._session)) throw sdkError('the room or account changed during the read', 'account_changed')
    if (cfg && typeof cfg.lanes === 'boolean') this._lanesSetting = cfg.lanes
    if (!cfg || typeof cfg !== 'object') { const err = new Error("witbitz: could not read this Space's gate (its sealed config did not load) — try again"); err.code = 'config_unavailable'; throw err }
    // A gated room answers a caller who has not signed in with only { admission: 'email', gated: true } — not the config.
    // That stub is never cached, so the read after sign-in gets the real one.
    if (cfg.gated === true && !cfg.allow) { if (!this._gated) { this._gated = true; if (this._announced) this._announce() } const me = await this._signedInEmail(); const e = new Error(me ? `witbitz: this Space is email-gated and ${me} is not on its list — only its members read its gate` : 'witbitz: this Space is email-gated — sign in (' + signInHow(this._wb) + ') to read its gate'); e.code = 'sign_in_required'; throw e } // signed in but not admitted: the server answers the same stub, and "sign in" was wrong there (sync sweep 11-14 P7: a signed-in vault)
    this._gateOwner = owner
    this._gateCfg = cfg // the gate is sealed at creation and never changes in place (membership change = a new room)
    if (cfg.admission === 'email' && !this._gated) { this._gated = true; if (this._announced) this._announce() } // a room that predates the link marker announces once its gate is read
    return cfg
  }

  /** A FILE OF THIS SPACE BY ITS NAME (the app's file links, fileLinks.js; the owner, 2026-11-06: SDK too). The assistant names the
   *  room's attachments by name — `[Plan.pdf](Plan.pdf)` — so a link in its reply can be opened: → `{ message, att }`, the newest
   *  message carrying a file or image of that name (case-insensitive), or null. Read its bytes with `space.attachment(att)`.
   *  In a lane, a copy of the Space's line is not one of the lane's files (as in the app). */
  fileNamed(name) {
    const want = String(name || '').trim().toLowerCase()
    if (!want) return null
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]
      if (laneCopy(m)) continue // a lane's COPY of its Space's line is not a file of this room: the app links none (its copy is rendered apart, fileLinks.js) — sync sweep 11-08
      for (const att of [...(Array.isArray(m && m.files) ? m.files : []), ...(Array.isArray(m && m.images) ? m.images : [])]) {
        if (att && typeof att.name === 'string' && att.name.trim().toLowerCase() === want) return { message: m, att }
      }
    }
    return null
  }

  /** Did THIS signed-in session send `message`? (the app's own-message marking; the owner, 2026-11-06: SDK too). True for a
   *  message the server verified as signed with this session's key — never by a typed name. A message from before a
   *  `refreshSession()` (a new key) or from another device of yours reads false. */
  isMine(message) {
    const m = message
    if (!m || m.verified !== true) return false
    const id = (k) => (k && k.kty && k.crv && k.x != null && k.y != null ? `${k.kty}:${k.crv}:${k.x}:${k.y}` : null) // = agentIdentity.keyIdOf
    // IN A VAULT the session is the vault's: it hands the page its key's PUBLIC id (welcome, whoami, its events) — this read
    // false there for every message (sweep 11-07 #9)
    const v = this._wb && this._wb.vault
    let mine = null
    if (v) { const i = v.info || {}; mine = i.signedIn !== false && typeof i.keyId === 'string' && i.keyId ? i.keyId : null }
    else { const sess = this._wb && this._wb._session; mine = sess && sess.sign ? id(sess.sign.pub) : null }
    return !!mine && id(m.vspk || m.spk) === mine
  }

  /** WHO WROTE `message`, as Block knows a person (the Spaces app's blocks.js; docs/report-and-block.md §4) → `{ email?, user?,
   *  room?, sid? }`, or null when nothing proves it (a typed name, the assistant, an outside agent's relayed line): the verified
   *  email and @username the server stamped, and the key that signed it in this Space. A lane's copy of its Space's line names
   *  the Space's writer (`by`, the mirror's). Pass it to `wb.account.blocks.block()` / `.has()`. */
  blockIdentity(message) {
    const m = message
    if (!m || typeof m !== 'object') return null
    const b = /^sh:/.test(String(m.id || '')) && m.by && typeof m.by === 'object' ? m.by : (mirrorBy(this.room, m).by || null)
    if (!b) return null
    const out = { ...(b.email ? { email: String(b.email).toLowerCase() } : {}), ...(b.user ? { user: String(b.user).replace(/^@/, '').toLowerCase() } : {}), ...(b.room && b.sid ? { room: String(b.room), sid: String(b.sid) } : {}) }
    return Object.keys(out).length ? out : null
  }

  /** REPORT a message, a person or the assistant's answer to Witbitz (App Store rule 1.2; sdk-people.md#report) — what the
   *  Spaces app's Report sends: the message and, with `context: true`, the 5 before it. Needs a signed-in session; the room
   *  checks membership first. `reason`: one of `Space.REPORT_REASONS`. → `{ ok: true, id }` | `{ ok: false, error, detail? }`
   *  (`not_member`, `sign_in`, `budget` — 20 a day). Throws `invalid_argument`, `sign_in_required`; in a vault `vault_unsupported`. */
  async report(message, { reason, note, context = false } = {}) { return fileReport(this, message, { reason, note, context }) }
  static get REPORT_REASONS() { return REPORT_REASONS }

  /** THIS SPACE'S ATTESTED LINE (the app's ⋯ → This Space): does it take only a page proved to be one named app (an attested
   *  app, B8 — `createSpace({ owner })`, or the Witbitz apps' own rooms)? Read from the room's public policy. →
   *  `{ required, confidential }`. A read that fails throws `policy_unreadable` — never "no". In a vault: `vault_unsupported`. */
  async attested() {
    if (this._client && this._client.vault) throw sdkError('witbitz: attested() is not available in a vault yet', 'vault_unsupported')
    if (!this._client || typeof this._client.attestedRoom !== 'function') throw sdkError('witbitz: this Space cannot read its policy here', 'policy_unreadable')
    let required
    try { required = !!(await this._client.attestedRoom(this.room, this._mk)) } catch (e) { throw sdkError('witbitz: whether this Space requires an attested app could not be read — try again (' + String((e && e.message) || e).slice(0, 80) + ')', 'policy_unreadable') }
    return { required, confidential: this._isEnclave() }
  }

  /** The bytes of an attachment on a message (`message.images[i]` / `message.files[i]`) → `{ b64, mime, name? }`. The
   *  room stores attachments OUT OF LINE, sealed under its key, so a message carries a reference; this fetches the
   *  sealed parts and opens them here. Throws `attachment_unavailable` if a part is missing or will not open. */
  async importChat(url) {
    if (typeof url !== 'string' || !url.trim()) throw sdkError('witbitz: importChat() needs a shared chat URL', 'invalid_argument')
    const r = await this._client.importChat(this.room, this._mk, url.trim())
    if (!r || r.status !== 200) throw refused('importChat', r)
    this._kick()
    return { imported: r.imported, title: r.title, entries: r.entries }
  }

  async importWhatsApp(text) {
    if (typeof text !== 'string' || !text.trim()) throw sdkError('witbitz: importWhatsApp() needs the exported chat text', 'invalid_argument')
    const r = await this._client.importWhatsApp(this.room, this._mk, text)
    if (!r || r.status !== 200) throw refused('importWhatsApp', r)
    this._kick()
    return { imported: r.imported, title: r.title, entries: r.entries }
  }

  async attachment(att) {
    if (!att || typeof att !== 'object') throw sdkError('witbitz: attachment() takes an entry from message.images or message.files', 'invalid_argument')
    if (typeof att.b64 === 'string' && att.b64) return { b64: att.b64, mime: att.mime || 'application/octet-stream', ...(att.name ? { name: att.name } : {}) }
    const refs = Array.isArray(att.parts) && att.parts.length ? att.parts : (att.ref ? [att.ref] : [])
    if (!refs.length) throw sdkError('witbitz: that attachment has neither bytes nor a reference', 'invalid_argument')
    const got = await Promise.all(refs.map((ref) => this._client.blob(this.room, this._mk, ref)))
    if (got.some((r) => !r || r.status !== 200 || typeof r.b64 !== 'string')) { const err = new Error('witbitz: the attachment could not be fetched or opened'); err.code = 'attachment_unavailable'; throw err }
    return { b64: got.map((r) => r.b64).join(''), mime: att.mime || got[0].mime || 'application/octet-stream', ...(att.name ? { name: att.name } : {}) }
  }

  /** Attach a PRIVATE assistant lane to this shared Space, for the current member. The lane is the member's OWN room:
   *  its agent sees this shared room's messages (labeled) — and queries its rows, read-only, when it declares `data` — and thinks/drafts with the member privately, but can post
   *  into the shared room only through a crossing the member APPROVES. Give it `actions` and it can also propose
   *  effectful client-side actions the member approves before they run (the agent never runs anything unilaterally).
   *  @param {object} [opts] { agent:{name,instructions,model?}, actions?:[{name,description,input?,run(args)}] } → a {@link Lane} */
  async privateLane({ agent = {}, actions = [], tools, immediateTools, model, data, admission, tier, mirror = false, platformTools, framing, dataWrites } = {}) {
    if (this.temporary) throw sdkError('witbitz: a temporary room has no private lane — the lane is a durable room, and its copies of the room would outlive the wipe', 'temporary_room') // as the app (roomSync.js ensureOwnLane; sync sweep 2026-10-27 #3)
    // A LANE HAS NO LANE (sweep P1): a lane of a lane was minted — a third room carrying the member's thinking one hop further,
    // which nothing in the app makes and nothing reads back
    if (this._client && this._client.vault) return this._vaultLane({ agent, actions, tools, immediateTools, model, data, admission, tier, mirror, platformTools, framing, dataWrites }) // the vault refuses a lane of a lane itself (vault-core createLane)
    if (this._sharedRoom || this._detachedLane || wasLaneRoom(this._wb, this.room)) throw sdkError('witbitz: a private lane has no lane of its own — ask from its Space', 'lane_of_lane') // …nor a room that WAS one, opened as a Space (openSpace(laneLink)) — as the app (roomSync.js isLaneRoom; sync sweep 11-11 #3)
    await assertNotKept(this)
    this._needKey('privateLane')
    let gate = normAdmission(admission) // a lane can be gated too — it is the member's OWN room
    const wb = this._wb
    if (wb) await wb._checkModel(model || agent.model)
    const asked = tierIsEnclave(tier) // FIRST, so an unknown tier still throws and can never be read as "inherit"
    // ★ A LANE OF A CONFIDENTIAL SPACE IS CONFIDENTIAL, without being asked. The tier used to come only from this
    // argument, so a lane attached to an enclave-tier Space was an ORDINARY room on the standard relay unless the tier
    // was passed again — and it failed silently, because the lane works either way. That is a DOWNGRADE, not a choice:
    // a lane holds the member's private thinking, drafts and research, often more sensitive than the shared room
    // everyone present can already read. ADMISSION inherits too, without the members (laneInherits, below): a verified
    // Space's lane admits its one member.
    // An explicit `tier:'standard'` here REFUSES rather than downgrading, for the same reason an unknown tier throws.
    const sharedIsEnclave = !!(wb && wb._enc && wb._enc.rooms.has(this.room))
    if (sharedIsEnclave && !asked && tier !== undefined && tier !== null) {
      throw Object.assign(new Error("witbitz: this Space is confidential, so its private lane is too — a lane holds the member's own drafts, and silently downgrading it would be worse than refusing. Omit `tier` to inherit, or attach the lane to a standard Space."), { code: 'tier_mismatch' })
    }
    const enc = asked || sharedIsEnclave
    if (enc && !wb) throw Object.assign(new Error('witbitz: an enclave-tier lane needs the Witbitz client that opened this Space'), { code: 'no_client' })
    // ★ WHAT A LANE TAKES FROM ITS SPACE: everything but the members (laneConfig.js laneInherits — the app's rule; the owner,
    //   10-15). The shared room's tools unless you name the lane's own, and a VERIFIED Space's gate narrowed to the signed-in
    //   member — an SDK lane of a verified Space was an OPEN room (sync sweep, 10-16 #1). Never weaker than its Space: no
    //   sign-in to admit, or an `admission` that would open it, is refused by name.
    let sharedCfg = null, cfgRead = typeof this._client.getConfig !== 'function' // a client that cannot read settings: as before
    // …except for a Space known to be verified or confidential: its lane must be as strict as it, and a client that cannot read
    // its settings cannot make it so — refused, never an open lane (sweep 11-04 P1)
    if (cfgRead && (this._gated || sharedIsEnclave)) throw sdkError("witbitz: this client cannot read the Space's settings, so a private lane of a verified or confidential Space cannot be made as strict as it", 'lane_wait')
    // A SLEEPING CONFIDENTIAL SPACE is woken first, as the vault does (vault-core createLane): asleep, its settings read fails, and
    // a failed read now waits — so privateLane() on one always ended in lane_wait (sync sweep 11-04 #4)
    if (!cfgRead && sharedIsEnclave && wb && typeof wb._encWake === 'function') { try { await wb._encWake(this.room, { tries: 8 }) } catch { /* the read below says what is wrong */ } }
    if (!cfgRead) { try { sharedCfg = await this._client.getConfig(this.room, this._mk, { plainMark: true }) } catch { sharedCfg = null } }
    if (sharedCfg && sharedCfg.lanes === false) throw sdkError('witbitz: private lanes are disabled for this Space', 'lanes_disabled')
    if (sharedCfg && sharedCfg.plain === true) { sharedCfg = null; cfgRead = true } // a plain room: read, and it has no settings
    // the placeholder a verified Space's settings read gives before the sign-in admits (gated, no allow) is not its settings:
    // read as such, the lane got none of its Space's tools (sync sweep 2026-10-29 #9; the app: roomSync gatedStub)
    // the member's words whether or not the link says gated (sync sweep 11-10 #10: a gated link got the generic "could not be read")
    if (gatedStub(sharedCfg)) { sharedCfg = null; { const sess = this._wb && this._wb._session; throw sdkError(sess && sess.email ? "witbitz: this Space's settings open only to an admitted member — you are signed in as " + sess.email + ", but its gate has not admitted you yet, so its private lane cannot be made — ask an admin of the Space, then try again" : "witbitz: this Space's settings need a sign-in that admits you before its private lane can be made — sign in (" + signInHow(this._wb) + "), then try again", 'lane_wait') } } // the words for who is asking (sync sweep 11-09)
    // a read that FAILED waits, whatever the link says — as the vault and the app do (sync sweep 2026-11-03: an old unmarked
    // link of a verified Space whose first read failed got an OPEN lane)
    // A REMOVED MEMBER is not "try again" (as the vault, sync sweep 11-10 #10): the settings read answers nothing for a key the room no
    // longer holds, and the room's grant tells removed from re-keyed — a new key taken is read once more; removed is said by name
    if (!sharedCfg && !cfgRead && this._mk) {
      const took = await this._adoptKey([this._mk]).catch(() => null)
      if (took) { try { sharedCfg = await this._client.getConfig(this.room, this._mk, { plainMark: true }) } catch { sharedCfg = null } if (sharedCfg && sharedCfg.plain === true) { sharedCfg = null; cfgRead = true } }
      if (this._keyWait === 'removed') throw sdkError('witbitz: you are no longer a member of this Space, so it has no private lane for you', 'removed')
    }
    if (!sharedCfg && (this._gated || !cfgRead)) throw sdkError("witbitz: this Space's settings could not be read, so its private lane cannot be made as strict as it yet — try again", 'lane_wait')
    const sess = wb && wb._session
    const me = sess && sess.email && !(sess.exp && sess.exp <= Date.now()) ? String(sess.email).trim().toLowerCase() : ''
    // An ATTESTED Space (its owner policy requires an attested app): its lane is made only by the attested app itself (the Witbitz app on
    // the device, since 10ed84f3), under the same rule — never by the SDK
    // (sync sweep 2026-10-19 #3: an SDK lane of one was an ordinary room bridged to it).
    let attested = false
    if (typeof this._client.attestedRoom === 'function') { try { attested = !!(await this._client.attestedRoom(this.room, this._mk)) } catch { throw sdkError("witbitz: whether this Space requires an attested app could not be read, so its private lane waits — try again", 'lane_wait') } } // a failed read is not 'not attested' (sync sweep 11-08)
    const inh = laneInherits(sharedCfg, { email: me, attested })
    if (inh.wait === 'attested') throw sdkError('witbitz: this Space requires an attested app, so its private lane is made only by that app (the Witbitz app on the device), under the same rule — not by the SDK', 'attested')
    if (tools === undefined && immediateTools === undefined && agent?.tools === undefined) { tools = inh.config.tools; immediateTools = inh.config.immediateTools }
    if (platformTools === undefined) platformTools = inh.config.platformTools
    if (sharedCfg && sharedCfg.admission === 'email') {
      if (admission === undefined) {
        if (inh.wait === 'email') throw sdkError("witbitz: this Space is verified, so its private lane is gated to you — sign in first (" + signInHow(wb) + ")", 'sign_in_required')
        gate = normAdmission({ emails: inh.gate.allow.emails })
      } else if (!(gate && gate.admission === 'email')) throw sdkError("witbitz: this Space is verified, so its private lane must be too — an open lane would let anyone with its link read the member's private assistant. Omit `admission` to gate it to the signed-in member.", 'lane_downgrade')
    }
    const cfg = roomConfig({ agent, tools, immediateTools, model, data, gate, platformTools, framing, dataWrites }, { agentName: LANE_AGENT_NAME, persona: framingOpt(framing) ? '' : DEFAULT_ASSIST }) // builder mode: no Spaces lane persona either
    cfg.lane = true // a lane says so in its own sealed settings, as the app's (laneConfig.js; sync sweep 11-19 P1)
    cfg.region = roomRegion(this.room) // a lane lives where its shared room does — the server refuses a bridge across regions
    if (enc) await wb._encAttestSoft()
    const split = this._split // a lane of a split Space is split too — its own userShare and app half
    const { room, mk, links, commit, configSealed, userShare, enclaveCreated } = await this._client.create(cfg, { base: this._viewer, ...(enc && !split ? { enclave: true } : {}), ...(split ? (wb ? wb._splitOpts() : { split: true }) : {}) })
    if (enc) { wb._enc.rooms.set(room, true); await wb._encWake(room); if (!enclaveCreated && !(await wb._encSealConfig(room, commit, configSealed))) throw sdkError('the new confidential lane could not receive its configuration', 'enclave_seal_failed') }
    const laneBase = split ? splitLinkOf(links[0], userShare, commit) : links[0]
    // A confidential lane of a STANDARD Space (`tier: 'enclave'` asked) is across tiers, as openLane's: the enclave does not
    // hold the standard room, so its turns carry no bridge and this device mirrors the Space into it (the docs audit,
    // 2026-10-24 — it sent the standard room as a bridge the enclave could not find, and its assistant never saw the room).
    const crossTier = enc !== sharedIsEnclave
    const lane = new Lane(this._client, { room, mk, link: enc ? markEncLink(laneBase) : laneBase, viewer: this._viewer, sharedRoom: this.room, sharedMk: this._mk, actions, wb: this._wb, shared: this, mirror: crossTier ? (mirror || true) : mirror, split, crossTier })
    lane._laneOrigin = 'minted'
    return wb ? wb._backedUp(lane) : lane
  }

  /** IN A VAULT the vault makes the lane (it keeps the key) and records it as this Space's lane; the page gets a keyless
   *  Lane whose bridge key the vault's worker fills in by room. A confidential Space's lane is confidential too (the vault
   *  makes it so — docs/sdk-vault-mode.md § As built, "Confidential Spaces in a vault"); asking for another tier is refused below. */
  async _vaultLane({ agent, actions, tools, immediateTools, model, data, admission, tier, mirror, platformTools, framing, dataWrites }) {
    const wb = this._wb
    if (tier !== undefined && tier !== null) { // a lane's tier is its Space's (the vault makes it so); a different one is refused, never a silent change
      const asked = tierIsEnclave(tier), it = (await wb.vault.rooms()).find((r) => r.room === this.room), isEnc = !!(it && it.tier === 'enclave')
      if (asked !== isEnc) throw tierMismatch(isEnc ? 'this Space is confidential, so its private lane is too — omit `tier` to inherit' : 'this Space is not confidential — a lane is on its Space\'s tier')
    }
    if (wb) await wb._checkModel(model || agent.model)
    const gate = normAdmission(admission)
    const inheritCustom = tools === undefined && immediateTools === undefined && agent?.tools === undefined
    const inheritPlatform = platformTools === undefined
    if (inheritCustom || inheritPlatform) {
      try {
        const inherited = inheritToolsFrom(await this._client.getConfig(this.room, null))
        if (inheritCustom) { tools = inherited.tools; immediateTools = inherited.immediateTools }
        if (inheritPlatform) platformTools = inherited.platformTools
      } catch { /* the vault reads the settings before creating the lane */ }
    }
    const cfg = roomConfig({ agent, tools, immediateTools, model, data, gate, platformTools, framing, dataWrites }, { agentName: LANE_AGENT_NAME, persona: framingOpt(framing) ? '' : DEFAULT_ASSIST })
    cfg.region = roomRegion(this.room)
    // an `admission` that opens the lane reaches the vault as `{ open }` (an open room's config names no admission, so the vault
    // could not tell it from none): in a verified Space it is refused by name, as outside a vault (lane_downgrade)
    const options = { ...(admission !== undefined && !(gate && gate.admission === 'email') ? { open: true } : {}), inheritCustom, inheritPlatform }
    const { room } = await wb.vault._c.createLane(this.room, cfg, options)
    if (wb._enc.rooms.has(this.room)) wb._enc.rooms.set(room, true)
    return refuseSpaceInVault(new Lane(this._client, { room, mk: null, link: null, viewer: this._viewer, sharedRoom: this.room, sharedMk: null, actions, wb, shared: this, mirror })) // its connections and Siri go through the vault, as a Space's
  }

  /** Change the assistant IN PLACE — name, instructions, model, the store's collections, which platform tools it gets —
   *  for every member, visibly: a system line lands in the Space ("⚙️ You changed the assistant's instructions") and the
   *  next turn runs on the new settings. Your own tools, admission and governance stay as created (a move — fork() — or a new room).
   *  @param {object} opts { agent: { name?, instructions?, model? }, data?, platformTools?, framing?, dataWrites?, safeMedia?, lanes?, from? } → { changed: string[] } */
  async configure({ agent = {}, data, platformTools, framing, dataWrites, safeMedia, lanes, from, ...rest } = {}) {
    from = this._who(from)
    if (lanes === true && this.room.startsWith('tmp-')) throw sdkError('witbitz: temporary Spaces cannot have private lanes', 'temporary_room')
    if (lanes === true && !this._client.vault) await assertNotKept(this)
    // what plan() judges, refused the same way (sync sweep, 2026-10-11: they were dropped without a word)
    for (const k of Object.keys(rest)) {
      if (['tools', 'immediateTools', 'tier', 'key'].includes(k)) throw Object.assign(new Error(`witbitz: ${k} is chosen when a room is made — make a new room (plan() says so)`), { code: 'create_time' })
      if (k === 'admission') throw this._sharedRoom ? Object.assign(new Error("witbitz: a lane is one member's own room — change its Space's members instead"), { code: 'lane' }) : Object.assign(new Error('witbitz: a new member list is changed with space.changeMembers(admission)'), { code: 'use_fork' })
      throw Object.assign(new Error(`witbitz: ${k} is not a setting configure() changes`), { code: 'unknown_field' })
    }
    // the keys plan() judges, refused the same way (sync sweep, 2026-10-10: configure ignored them, plan refused them)
    for (const k of Object.keys(agent || {})) {
      if (k === 'tools') throw Object.assign(new Error("witbitz: agent.tools are chosen when a room is made — make a new room (plan() says so)"), { code: 'create_time' })
      if (!['name', 'instructions', 'model'].includes(k)) throw Object.assign(new Error(`witbitz: agent.${k} is not a setting of the assistant`), { code: 'unknown_field' })
    }
    // a private lane follows its Space's Safe media — refused here as safeMedia.set refuses it (sync sweep 2026-10-31 #2)
    if (safeMedia !== undefined && this._sharedRoom) throw sdkError('witbitz: a private lane follows its Space’s Safe media — set it on the Space', 'lane_follows_space')
    if (safeMedia === true && this.temporary) throw sdkError('witbitz: a temporary room has no Safe media — the Spaces app never offers it there', 'temporary_room') // as createSpace (sync sweep 2026-11-13)
    const patch = {}
    if (platformTools !== undefined) patch.platformTools = platformToolsOpt(platformTools) ?? null // true/null → all again
    if (framing !== undefined) patch.framing = framingOpt(framing) ?? null // 'builder' → the app's prompt only; null → the Spaces framing again
    if (dataWrites !== undefined) patch.dataWrites = dataWrites === false ? false : null // false → data_query only
    if (safeMedia !== undefined) { if (typeof safeMedia !== 'boolean') throw sdkError('witbitz: safeMedia takes true or false', 'invalid_argument'); if (safeMedia && !safeMediaReady()) throw sdkError('witbitz: no safe-media enclave is accepted in this release yet', 'safe_media_unavailable'); patch.safeMedia = safeMedia ? true : null } // as createSpace (sync sweep 2026-10-28) // SAFE MEDIA on/off for everyone (docs/safe-media.md)
    // PRIVATE ASSISTANTS ON OR OFF IN PLACE (docs/always-on-agent-plan.md Phase 0b): a Space made with them can turn them off (and on);
    // members' existing private rooms stay as Spaces of their own. A lane has none of its own.
    if (lanes !== undefined) { if (typeof lanes !== 'boolean') throw sdkError('witbitz: lanes takes true or false', 'invalid_argument'); if (this._sharedRoom || this._detachedLane || wasLaneRoom(this._wb, this.room)) throw sdkError("witbitz: a private lane has no private assistants of its own — set it on the Space", 'lane'); patch.lanes = lanes }
    if ('name' in agent) patch.agentName = agent.name
    if ('instructions' in agent) patch.persona = agent.instructions
    if ('model' in agent) { if (this._wb) await this._wb._checkModel(agent.model); patch.model = agent.model }
    if (data !== undefined) { checkDataSchema(data); patch.dataSchema = data } // declare or change the store's collections (null → none); refused if over LIMITS
    const r = await this._client.setConfig(this.room, this._mk, patch, from)
    if (!r || r.status !== 200) throw refused('configure', r)
    if (lanes !== undefined) this._lanesSetting = lanes
    if (lanes === false) {
      if (this._wb?.vault) {
        for (const lane of this._wb._openLanes || []) if (lane._sharedRoom === this.room) lane._detachShared()
      } else await disconnectRoomLanes(this._wb, this.room)
    }
    if (safeMedia !== undefined) this.safeMedia._learn(safeMedia, Date.now())
    return { changed: Array.isArray(r.changed) ? r.changed : [] }
  }

  /** What a change would REQUIRE, before you make it — and nothing is changed (sdkPlan.js). `change` takes
   *  configure()'s, fork()'s and createSpace()'s fields: { agent, data, admission, tier, key, tools, immediateTools }.
   *  → { how: 'none'|'in_place'|'fork'|'new_room'|'refused', history: 'kept'|'carried'|'not_carried'|null, call, steps,
   *      reason?, code? } */
  async plan(change = {}) {
    let cfg = null, gatedUnread = false
    if (change && change.admission !== undefined && !this._sharedRoom) { this._gateCfg = null; try { cfg = await this._gateConfig() } catch (e) { if (e && e.code === 'sign_in_required') gatedUnread = true; else if (e && e.code !== 'config_unavailable') throw e } } // signed out in a gated room: a refusal, not a throw (sdk-assistant.md#changing-the-assistant)
    else if (change && (change.agent || change.data !== undefined || change.platformTools !== undefined || change.framing !== undefined || change.dataWrites !== undefined || change.safeMedia !== undefined || change.lanes !== undefined) && typeof this._client.getConfig === 'function') { try { const c = await this._client.getConfig(this.room, this._mk); gatedUnread = !!(c && c.gated === true && !c.allow); cfg = c && typeof c === 'object' && !gatedUnread ? c : null } catch { cfg = null } } // the in-place rules need the room's admins (sdkPlan.js)
    const sess = this._wb && this._wb._session
    const me = this._wb && this._wb.vault ? String(((await this._wb.vault.whoami()) || {}).email || '') // in a vault, its signed-in member (sync sweep 10-15 #2)
      : sess && (!sess.exp || sess.exp > Date.now()) ? String(sess.email || '') : ''
    const out = planChange(change, { cfg, me, lane: !!(this._sharedRoom || this._detachedLane || wasLaneRoom(this._wb, this.room)), activeLane: !!this._sharedRoom, checkData: checkDataSchema, gatedUnread, signIn: signInHow(this._wb) })
    if (out.how === 'in_place' && change.agent && change.agent.model && this._wb) { try { await this._wb._checkModel(change.agent.model) } catch (e) { return { how: 'refused', history: null, call: null, steps: out.steps, reason: String(e.message || e), code: e.code || 'invalid_model' } } }
    return out
  }

  /** Approve a proposal → the runtime executes it (a data write lands in the Space; a lane's crossing posts to the shared
   *  room), or, for one of your own `actions`, runs your handler on this device.
   *  `{ recordResult: false }` — for a connection call whose answer you hand to the assistant yourself: the room records
   *  the call (who approved, what was called, how it went) but not the answer body. */
  // `from`: the approver's name as it appears on what the approval DOES — a crossing lands in the shared room under it.
  // A name is a claim; in an email-gated room the server adds `verified` + the attested @username beside it.
  approve(id, { recordResult, from } = {}) { return this._decide(id, true, { recordResult, from: this._who(from) }) }
  /** Deny a proposal → drop it (the agent is told, so it won't re-propose the same thing). */
  deny(id, { from } = {}) { return this._decide(id, false, { from: this._who(from) }) }
  _decideExtra() { return {} } // a Lane adds its bridge fields
  _runExtra() { return {} } // a Lane adds its bridge fields — a lane's run sees its shared room, as its turns do

  /** Stop the poll loop and release the handle. */
  close() { this._stopped = true; this._embed?.close(); this._wb?._agentHandles?.delete(this); this._wb?._archiveHandles?.delete(this); try { if (this._wb && this._wb.invite) this._wb.invite._waiting.delete(this); if (this._vaultKeyOff) this._vaultKeyOff() } catch { /* */ } for (const t of [...(this._turns || [])]) { try { t._settle('failed', { error: 'closed' }) } catch { /* */ } } clearTimeout(this._timer); this._timer = null; if (this._stream) { this._stream.stop(); this._stream = null } if (this._pendingTimer) { clearInterval(this._pendingTimer); this._pendingTimer = null } this._settleReady(Object.assign(new Error('witbitz: the Space was closed before its first poll'), { code: 'closed' })) }
  _settleReady(err) { if (!this._readyResolve) return; const [ok, no] = [this._readyResolve, this._readyReject]; this._readyResolve = this._readyReject = null; if (err) no(err); else ok(this) }

  async _decide(id, approve, { recordResult, from = 'You' } = {}) {
    const act = this._pendingActions[id]
    const isClientWrite = approve && act && typeof this._writes[act.type] === 'function'
    const r = await this._client.decide(this.room, this._mk, id, approve, String(from || 'You'), {
      ...this._decideExtra(),
      ...(isClientWrite ? { deviceExec: true } : {}), // a client action: the server approves but does NOT run it — we do, below
      ...(recordResult === false ? { recordResult: false } : {}),
    })
    // A REFUSED decision (2026-10-02 — `not_admin` in a room with admins) leaves the card pending, for someone who may
    // decide it. It used to fall through: the card was dropped here and `resolved` fired with approved:true.
    // …and so does NO answer: OHTTP's failure is { status: 0 }, which a truthy-status test waved through as approved (sync sweep, 2026-10-11)
    // …and a 200 that decided nothing (a proxy's error page, a body that lost its fields) is no decision either: every real
    // answer names the card's new status in `decided` (spaceService op decide; sync sweep, 2026-10-11)
    if (!r || r.status !== 200 || !r.decided) throw refused(approve ? 'approve' : 'deny', r)
    let result
    if (isClientWrite && r && r.deviceExec) {
      try { result = await this._writes[act.type](act) } catch (e) { result = { error: String((e && e.message) || e) } }
    } else if (approve && r && r.execution) {
      result = r.execution // a server-executed proposal (an approved crossing, a data write)
    }
    delete this._pendingActions[id]
    this._emit('resolved', { id, approved: !!approve, action: act && act.type, result })
    this._kick()
    // THE ASSISTANT CONTINUES (the Spaces app's pendingProposals.js → space.js continueAfterApproval; sync sweep 2026-11-13): a call
    // the SERVER ran left its result in the room, so the assistant is asked to go on from it — a turn with no message, `cont`: this
    // card (the server admits it only for a card approved and run in the last 10 minutes, once). Not for a crossing (it is the
    // message itself), a write this page applied, or a result you hand to the assistant yourself (`recordResult: false`). Its
    // reply arrives on 'message'; approve() does not wait for it.
    // ⚑ Not over the Spaces app's own worker client (keyless, no vault): its pendingProposals.js sends the continuation itself
    // (space.js continueAfterApproval, with the app's wake and proofs) — two would race for the one admission.
    const appWorker = !!(this._client && this._client.keyless && !this._client.vault)
    const ran = !appWorker && approve && !isClientWrite && recordResult !== false && act && act.type !== 'cross_to_shared' && r.execution && r.execution.ok === true
    if (ran) { this._continueAfter(id, from).catch(() => {}); return { ...r, result, continued: true } }
    return { ...r, result }
  }
  /** @private the continuation turn after an approved call ran (see _decide) — the same proofs and options as a send. */
  async _continueAfter(id, from) {
    const deadline = Date.now() + CONTINUATION_WINDOW_MS
    const opts = await this._turnOpts(undefined, this._runExtra()) // a lane's bridge and links, as its turns
    const r = await this._turnHeld(() => this._provenTurn({ from: String(from || 'You'), text: '', cont: id }, opts), undefined, undefined, false, deadline)
    this._kick()
    return r
  }

  _proposalOf(pid, act) {
    return {
      id: pid,
      kind: act.type === 'cross_to_shared' ? 'message' : 'action',
      action: act.type || '',
      args: act,
      text: act.text || act.why || '',
      approve: (opts) => this.approve(pid, opts),
      deny: (opts) => this.deny(pid, opts),
    }
  }
  /** Ask the room for its waiting proposals now → the current list (what `proposals` carries). */
  async pending() {
    if (this._inflightPending) { try { await this._inflightPending } catch { /* */ } }
    await this._pollPending()
    return this._pendingList.slice()
  }
  async _pollPending() {
    // A room that refused this reader for good (_pollHeld: not on the list, removed) refuses `pending` too — the proposals
    // poll follows the main poll's minute instead of asking every 1.5 s (sync sweep, 2026-10-10).
    if (this._pollHeld && Date.now() - (this._pendingHeldAt || 0) < HELD_POLL_MS) return
    if (this._pollHeld) this._pendingHeldAt = Date.now()
    if (this._stopped || this._inflightPending) return
    let done; this._inflightPending = new Promise((r) => { done = r })
    try {
      const r = await this._client.pending(this.room, this._mk)
      // A read that FAILED says nothing about the cards: keep the last list (sync sweep, 2026-10-10 — one 5xx emptied every
      // waiting card, here and in the app, which draws from this, and the next good read re-fired every 'proposal').
      if (!(r && r.status === 200 && Array.isArray(r.pending))) return
      const list = r.pending
      const live = new Set()
      for (const p of list) {
        const pid = p && p.id; if (!pid) continue
        live.add(pid)
        if (pid in this._pendingActions) continue // already surfaced
        const act = p.action || {}
        this._pendingActions[pid] = act
        this._emit('proposal', this._proposalOf(pid, act))
      }
      for (const pid of Object.keys(this._pendingActions)) if (!live.has(pid)) delete this._pendingActions[pid] // resolved elsewhere
      // THE WHOLE LIST, for a page that draws a card of everything waiting (the Spaces app's): `proposals` fires when the
      // set or a text changes — including a proposal resolved on another device, which `proposal` never tells.
      this._pendingList = list.filter((p) => p && p.id).map((p) => this._proposalOf(p.id, p.action || {}))
      const sig = this._pendingList.map((p) => p.id + ':' + (p.text || p.action)).join('\u241f')
      if (sig !== this._pendingSig) { this._pendingSig = sig; this._emit('proposals', this._pendingList.slice()) }
    } catch { /* transient */ } finally { this._inflightPending = false; done() }
  }

  async _poll() {
    if (this._stopped) return
    // a kick while a poll is out (a send, the stream's "the ledger grew") is not dropped: one more poll at once when it settles
    // (pass 5, V#15 — a finished reply landed up to 3 s late)
    if (this._inflight) { this._pollAgain = true; return }
    this._inflight = true
    let read = false // this poll was a 200: only then may `_more` ask for the next page at once
    try {
      const r = await this._client.pollSealed(this.room, this._mk, this._etag, this._count)
      if (this._stopped) return // V#7: answered after close(): nothing of it is applied, announced, or run (a device call included)
      if (!this._sharedRoom && r && r.status === 200 && Date.now() - (this._lanesCheckedAt || 0) > 30000 && typeof this._client.getConfig === 'function') {
        this._lanesCheckedAt = Date.now()
        try {
          const cfg = await this._client.getConfig(this.room, this._mk, { plainMark: true })
          if (this._stopped) return
          if (cfg?.admission === 'email' || cfg?.gated === true) this._gated = true
          if (cfg && !gatedStub(cfg) && (typeof cfg.lanes === 'boolean' || cfg.plain === true)) {
            this._lanesSetting = cfg.lanes === true
            if (this._gateCfg && typeof cfg.lanes === 'boolean') this._gateCfg.lanes = cfg.lanes
          }
        } catch { /* retain the last confirmed setting */ }
      }
      if (this._wb && this._wb._attest) this._wb._attest.notePoll(this.room, r) // a room that requires your app: its fresh challenge
      // ⛔ A REFUSED POLL LOOKED LIKE AN EMPTY ROOM (a builder, 2026-09-29). A poll carrying an error code — in a 200 (the
      // confidential tier's host front flattened every status to 200) or in a 4xx/5xx — used to take the success path,
      // find no entries and say nothing. Now it raises 'error' with the code, ONCE per distinct refusal (a poll runs every
      // ~600 ms), and a good poll clears it so the same refusal later is reported again. (422 keeps its own message.)
      const verdict = pollVerdict(r) // pollVerdict.js — the same verdict the Spaces app reaches on the same answer
      // a moment's wait is not a refusal (sync sweep 2026-11-14 P5, owner: yes — the app stays silent there too): an enclave starting
      // (`warming`) or a check that could not be made just now (`unavailable`: the verifier, the tier, the store, a delete finishing)
      // raises no 'error' — the poll asks again on its own.
      const transient = verdict.kind === 'warming' || verdict.kind === 'unavailable'
      const refusal = verdict.kind !== 'ok' && verdict.kind !== 'cannot_open' && verdict.kind !== 'no_answer' && !transient ? verdict.code : null
      if (refusal) {
        const key = refusal + '|' + (r.reason || '')
        if (this._pollRefusal !== key) {
          this._pollRefusal = key
          const e = new Error(`witbitz: the room could not be read (${refusal}${r.reason ? ': ' + r.reason : ''})`)
          e.code = refusal; if (r.reason) e.reason = r.reason; e.status = r.status
          this._emit('error', e)
        }
        // A refusal a retry cannot cure — not on the room's list, removed, the room's settings unreadable — slows the
        // poll to once a minute (the app stops it, sync sweep 2026-10-10): a re-admission is still noticed, nothing
        // hammers. `_kick()` (a send, the stream) polls at once as before.
        this._pollHeld = PERMANENT_REFUSALS.has(r.reason) || refusal === 'gate_unreadable' || !!this._keyWait // removed from a re-keyed room, or waiting for a fresh link
        // NO ROOM PASS where the room requires one (agent/roomPass.mjs, the cutoff: this address is on passes): the client already asked for
        // a fresh pass and tried again (spaceClient.js), so a retry here cannot cure it — this client is not on the account service, or
        // this device was signed out there. `ready` rejects by name instead of waiting for ever (devserver/test/roomPassCutoff.test.mjs,
        // 2026-11-26: a refused client was never told); the poll is held to once a minute, as for any refusal a retry cannot cure.
        if (!r.passRetryable && /^pass: (pass_required|app_unnamed)/.test(String(r.reason || ''))) {
          this._pollHeld = true
          this._settleReady(Object.assign(new Error('witbitz: this Space requires a room pass for this address, and this client has none — its account is not on the account service here, or this device was signed out'), { code: 'pass_required', reason: r.reason, status: r.status }))
        }
        return
      }
      this._pollRefusal = null; this._pollHeld = false
      if (r && r.status === 200) {
        if (r.etag) this._etag = r.etag
        const clearedRemoval = Array.isArray(r.removed) && this._removedMessages?.size && [...this._removedMessages.keys()].some(key => !r.removed.some(e => removedEntryKey(e) === key))
        if (Array.isArray(r.removed)) {
          this._removedMessages = new Map(r.removed.filter((e) => e && e.id != null && e.ts != null).map((e) => [removedEntryKey(e), e]))
          for (const e of [...this.messages]) if (this._removedMessages.has(removedEntryKey(e)) && !e.removedByWitbitz) {
            const m = removedCopy(e), { updated } = this._view.apply([m])
            for (const u of updated) this._emit('update', { id: u.id, message: u.entry, fields: u.fields })
          }
        }
        if (r.changed && Array.isArray(r.entries)) {
          for (let e of r.entries) {
            if (this._removedMessages && this._removedMessages.has(removedEntryKey(e))) e = removedCopy(e)
            else if (e.sourceRestored === true) {
            this._removedSourceMessages?.delete(removedEntryKey(e))
            if (e.id?.startsWith('sh:')) this._removalsMirrored?.delete(removedEntryKey({ id: e.id.slice(3), ts: e.ts }))
          }
            else if (this._removedSourceMessages && this._removedSourceMessages.has(removedEntryKey(e))) e = sharedRemovedCopy(e)
            // `from` IS THE DOCUMENTED FIELD (see the header and `on()` below) — the ledger calls it `name`, and this
            // emitted the raw entry, so an author test written from the docs (`m.from === me`) silently matched
            // NOTHING and every delivered message read as "not mine". Reported by the first outside builder after it
            // cost him an afternoon (2026-09-21). The `data` event one line down has always done this translation;
            // this is the one that forgot. `name` is kept for anyone who worked out the real shape by inspection, and
            // an entry that already carries `from` is left alone. `messages` gets the SAME object as the event — two
            // shapes for one thing is how this happened.
            if (isTitleEntry(e)) { this._noteTitle(e); continue } // the room's NAME, not a message (roomName.js)
            if (isPurged(e)) continue // a DELETED MAIL's place (agent/mailPurge.mjs): nothing is left of it — the app draws nothing either (sync sweep 11-22 #9)
            if (this.safeMedia._note(e)) continue // a photo's SAFE COPY, kept beside it — never a message (sdkSafeMedia.js); the line that moved the setting is read and stays a message
            const m = e && e.from === undefined && e.name !== undefined ? { ...e, from: e.name } : e
            const { added, updated } = this._view.apply([m])
            if (updated.length) { const u = updated[0]; this._emit('update', { id: u.id, message: u.entry, fields: u.fields }); continue } // a reaction / caption / widgets on a message you already have
            if (!added.length) continue // the same entry again
            this._emit('message', m)
            this.safeMedia._arrived(m) // a message this handle sent: its safe copies go beside it
            if (m && !m.self && typeof m.text === 'string') this._feed.landed(m.text) // a stored answer: its own late stream frames are not a partial (turnFeed.js; sync sweep 10-15 #16)
            if (e && e.kind === 'fork') this._maybeMoved(e) // a membership fork: is this device one of the keepers?
            if (e && e.kind === 'data' && Array.isArray(e.ops)) { applyDataEntry(this._rows, e); this._emit('data', { ops: e.ops, from: e.name || '', self: !!e.self, text: e.text || '', ts: e.ts }) }
          }
          if (typeof r.version === 'number') this._count = r.version
          // `more`: another page follows (a long room loads in pages) — read it at once, and until it has, the history is
          // not whole: a lane mirror must not take a short list for another history (sync sweep, 2026-10-10)
        }
        if (clearedRemoval) { this._count = 0; this._etag = null }
        this._more = !!(clearedRemoval || (r.changed && r.more)); read = true // the NEXT poll (in `finally`, at once) reads the next page
        this._maybeTitleDoc()
        if (needsTailResync(r, this._count) && Date.now() - (this._resyncAt || 0) > 1500) { this._resyncAt = Date.now(); this._tailResync().catch(() => {}) } // an in-place change pages as nothing
        if (r.deviceCall) this._runDeviceCall(r.deviceCall) // an `await` action the turn is waiting on — answer from this device
        this._partialFromPoll(r)
        this._liveFeed(r)
        // READY = the WHOLE history, every page (sync sweep, 2026-10-10: it fired after the first, and a `replay: false`
        // listener heard page two's old messages as new)
        if (!this._more) {
          this._settleReady() // after the entries are applied, so what the polls carried is already in `messages`
          this._historyRead = true // on('message', cb, { replay: false }) hears from here on
        }
        if (!this._announced) this._announce()
      } else if (r && r.status === 422) {
        this._emit('error', Object.assign(new Error('witbitz: this key cannot open the room history'), { code: 'cannot_open' }))
        this._settleReady(Object.assign(new Error('witbitz: this key cannot open the room history'), { code: 'cannot_open' }))
      }
    } catch (err) {
      // THE VAULT DROPPED THIS SPACE (forget, a sign-out): a refusal a retry cannot cure — said ONCE and the poll held to once a
      // minute, as a permanent refusal is (sync sweep 2026-11-23: every ~3 s tick raised `not_in_vault` again, for ever)
      if (err && err.code === 'not_in_vault') {
        if (this._pollRefusal !== 'not_in_vault|') { this._pollRefusal = 'not_in_vault|'; this._emit('error', err) }
        this._pollHeld = true
        return
      }
      // a failure with no code of its own (the network, a thrown read) is `unavailable`: a poll error is transient (sdk-reference.md#errors)
      this._emit('error', err instanceof Error ? (err.code ? err : Object.assign(err, { code: 'unavailable' })) : sdkError(String(err), 'unavailable'))
    } finally {
      this._inflight = false
      // ONE timer: the next page at once while the history is still loading, else the usual interval. A refusal, a 422, a
      // transport failure or a throw ends the paging (sync sweep, 2026-10-10: `_more` stayed true and it polled at 0 ms,
      // past the held one-a-minute poll of a permanent refusal) — the usual poll reads the next page when it can.
      if (!read) this._more = false
      const again = this._pollAgain && !this._hostDriven; this._pollAgain = false
      if (!this._stopped) { clearTimeout(this._timer); this._timer = setTimeout(() => this._poll(), (this._more || again) && !this._hostDriven ? 0 : this._interval()) }
    }
  }

  // THE IN-PLACE CHANGE (ledgerView.js): the ledger moved and brought no entry — a reaction or a caption rewrote one you
  // hold. Re-read a short tail and announce what changed; its etag is NOT adopted (a reply landing in between would be lost).
  async _tailResync() {
    const r = await this._client.pollSealed(this.room, this._mk, null, Math.max(0, this._count - REACTION_RESYNC_TAIL))
    if (!(r && r.status === 200 && Array.isArray(r.entries))) return
    for (let e of r.entries) {
      if (this._removedMessages && this._removedMessages.has(removedEntryKey(e))) e = removedCopy(e)
      else if (e.sourceRestored === true) {
            this._removedSourceMessages?.delete(removedEntryKey(e))
            if (e.id?.startsWith('sh:')) this._removalsMirrored?.delete(removedEntryKey({ id: e.id.slice(3), ts: e.ts }))
          }
      else if (this._removedSourceMessages && this._removedSourceMessages.has(removedEntryKey(e))) e = sharedRemovedCopy(e)
      if (isTitleEntry(e)) { this._noteTitle(e); continue }
      if (isPurged(e)) continue // a deleted mail's place, written over its entry in that slot: no `update` (sync sweep 11-22 #9)
      const m = e && e.from === undefined && e.name !== undefined ? { ...e, from: e.name } : e
      const { updated } = this._view.apply([m])
      for (const u of updated) this._emit('update', { id: u.id, message: u.entry, fields: u.fields })
    }
  }

  // Poll fast right after activity (a live exchange), then back off while idle so a quiet Space costs almost nothing.
  // While the room's stream is DELIVERING (a frame in the last 3 s), the frames carry the reply: poll only as a net.
  _interval() { if (this._pollHeld) return this._keyWait && this._keyWait !== 'removed' ? KEY_WAIT_POLL_MS : HELD_POLL_MS; return Date.now() - this._streamFrameAt < 3000 ? 3000 : Date.now() - this._lastActive < 8000 ? 900 : 3000 }

  // ── the reply as it is written: `partial` ({ text, step }) — text is the reply so far ('' before the first words, with
  // `step` saying what the assistant is doing: { phase:'thinking'|'writing'|'deciding' } or { tool }); `text: null` once there is no
  // reply in progress (the finished one arrives as a `message`). From the room's stream when it is delivering, and from
  // every poll regardless — the two are ordered by sequence number, so an older one never rewinds a newer one.
  // `partial` carries { text, step }: the reply so far, or ('' + a step) what the turn is doing, or (null) none any more.
  // The ORDER and the sequence rules are turnFeed's; this only draws them as events.
  _emitPartial(text, step) {
    const p = this._partial
    if (text === p.text && !step) return
    p.text = text
    this._emit('partial', { text, step: step || null })
  }
  _clearPartial() { if (this._partial.text === null) return; this._partial = { text: null }; this._emit('partial', { text: null, step: null }) }
  _drawFeed(o) {
    if (o.text) this._emitPartial(o.text, null)
    else if (o.status) this._emitPartial('', o.status)
  }
  _partialFromPoll(r) {
    const o = this._feed.poll(r)
    if (o.text || o.status) return this._drawFeed(o)
    // No turn in progress — but a poll can lag a live stream, so clear only once the stream has been quiet a moment.
    if (o.text === null && !o.status && Date.now() - this._streamFrameAt > 1500) this._clearPartial()
  }
  // Open the room's stream after the first successful poll (a gated room's grants ride that poll), then keep it in step.
  _liveFeed(r) {
    // IN A VAULT the socket lives in the vault's worker, which keeps it in step from the polls it runs for this Space
    const raw = this._client && (this._client[RAW_CLIENT] || this._client) // the stream handle is not a room op: past the healing wrapper, which makes every function async
    if (raw && raw.vault && typeof raw.streamOpen === 'function') {
      if (!this._stream && !this._stopped && !(this._wb && this._wb._vaultLive === false)) this._stream = raw.streamOpen(this.room, (ev) => this._onStreamEvent(ev))
      return
    }
    if (!this._liveOpts || this._stopped || (this._client && this._client.keyless)) return // a keyless Space has no key to open the stream with — it polls
    if (!this._stream) {
      this._stream = openRoomStream({ mk: this._mk, grants: Array.isArray(r.streamGrants) ? r.streamGrants : null, path: 's', WebSocketImpl: this._liveOpts.WebSocketImpl, ...(this._liveOpts.relay ? { relay: this._liveOpts.relay } : {}), onEvent: (ev) => this._onStreamEvent(ev) })
      return
    }
    if (Array.isArray(r.streamGrants)) this._stream.setGrants(r.streamGrants)
    this._stream.sync(typeof r.partialText === 'string' ? r.partialText : '')
  }
  _onStreamEvent(ev) {
    if (this._stopped) return
    this._streamFrameAt = Date.now()
    // ★ AND THE CARDS (2026-09-30, the owner: "why doesn't it include the proposal cards"). A proposal is not a ledger
    // entry — it lives in the sealed authority doc — so a stream signal fetched the reply live and left the card to the
    // 1.5 s proposals poll. A card made during a turn exists before that turn's `end` and "the ledger grew", so both ask
    // for proposals too, whenever anyone listens for them (a lane always does).
    const o = this._feed.stream(ev)
    if (o.refetch) { clearTimeout(this._timer); this._timer = null; this._poll(); if (this._pendingTimer) this._pollPending(); return } // the ledger grew: fetch it now
    if (o.end) {
      // "No reply in progress." A status with no words yet (Auto deciding, and deciding not to) ends HERE — it used to stay
      // on screen; words already shown stay until the finished entry replaces them on the poll below.
      if (this._partial.text === '') this._clearPartial()
      if (!this._inflight) { clearTimeout(this._timer); this._timer = null; this._poll() } if (this._pendingTimer) this._pollPending(); return // the finished reply is in: pick it up
    }
    this._drawFeed(o)
  }
  _kick() { this._lastActive = Date.now(); clearTimeout(this._timer); this._timer = null; if (!this._hostDriven) this._poll(); if (this._pendingTimer) this._pollPending() }
}

/** A PRIVATE assistant lane — a member's own room, bridged to a shared {@link Space}. It IS a Space (its private
 *  thread streams on `message`), and adds human-in-the-loop authority:
 *   • `proposal` ({ id, kind:'message'|'action', action, args, text, approve(), deny() }) — the agent proposed a
 *      crossing to the shared room (`kind:'message'`) or an effectful client action (`kind:'action'`). NOTHING happens
 *      until a human calls approve() (posts the crossing / runs your handler on this device) or deny().
 *   • `resolved` ({ id, approved, action, result? }) — after a decision. */
export class Lane extends Space {
  constructor(client, { room, mk, link, viewer, sharedRoom, sharedMk, actions, resume, wb = null, shared = null, mirror = false, split = false, poll, handlers, live, crossTier = false }) {
    if (typeof resume?.room === 'string' && resume.room !== room) resume = null
    super(client, { room, mk, link, viewer, resume, wb, split, poll, handlers, ...(live !== undefined ? { live } : {}) }) // `live`: as a Space's (a vault's own handle opens no stream) // `resume`: a prior snapshot() — see Space; was dropped here for a Lane (2026-09-25)
    this._sharedRoom = sharedRoom
    if (this._wb && sharedRoom) (this._wb._openLanes ||= new Set()).add(this)
    this._sharedMk = sharedMk
    this._sharedSpace = shared instanceof Space ? shared : null // lane.safeMedia follows its Space's setting (sdkSafeMedia.js; sync sweep 2026-10-27 #1)
    this._crossTier = !!crossTier // a lane of the other tier: mirrored by this device, no bridge on its turns (openLane)
    hide(this, ['_sharedMk'])
    this._sharedOffs = [] // its hooks on the Space, taken off by close() (sweep 11-07 #12: they outlived the lane)
    if (shared instanceof Space && sharedMk) this._sharedOffs.push(shared.on('rekeyed', () => { this._sharedMk = shared._mk })) // the shared room re-keyed in place: its crossings carry the new key
    // a lane's Safe media follows its Space's: when the Space's setting moves, the lane says so too (sweep P1: its 'safeMedia'
    // event never fired for the Space's changes, though lane.safeMedia.on had moved)
    if (shared instanceof Space) this._sharedOffs.push(shared.on('safeMedia', (e) => { try { this._emit('safeMedia', { ...(e || {}), on: this.safeMedia ? this.safeMedia.on : (e && e.on), via: 'space' }) } catch { /* */ } }))
    // THE MIRROR (2026-10-02) — see _runMirror. The cursor is how many of the shared room's messages this lane already
    // holds; it rides snapshot()/resume as `mirrored`, and the server dedups by id, so a cursor that is off only resends.
    this._mirrorAnchor = resume?.mirrorAnchor || null
    this._mirrorCursor = resume && Number.isFinite(Number(resume.mirrored)) ? Math.max(0, Number(resume.mirrored)) : 0
    if (mirror && shared instanceof Space) {
      this._mirrorFrom = shared
      // Messages only by default (2026-10-02, a builder: every row write in a busy team room filled the lane as a "▦ …
      // saved …" line). `mirror: { data: true }` carries the data lines too. Filtered at SEND, so the cursor still counts
      // the same list and a saved `mirrored` cursor stays right.
      this._mirrorData = !!(mirror && typeof mirror === 'object' && mirror.data === true)
      this._mirrorSub = () => this._scheduleMirror()
      shared.on('message', this._mirrorSub)
      shared.on('update', this._mirrorSub) // a late image caption is an update: the catch-up below re-sends it
      shared.ready.then(() => this._scheduleMirror(), () => {})
      // A change to a VIEW (the plan, the map) is not a message: on a timer too, as the app's mirror loop (sync sweep,
      // 2026-10-10 — a lane learned of an edited itinerary only when someone next spoke). The pass reads views at most
      // every 15 s, so a quiet room costs one cheap pass per tick.
      this._viewsTick = setInterval(() => { if (!this._stopped && !this._mirrorFrom?._stopped) this._scheduleMirror(); else clearInterval(this._viewsTick) }, 15_000); try { this._viewsTick.unref?.() } catch { /* a browser timer has no unref */ }
    }
    const built = buildActions(actions)
    this._clientTools = built.defs
    this._writes = { ...this._writes, ...built.handlers } // propose-mode actions (+ any `handlers` given): run on this device after the member approves
    this._reads = built.reads     // await-mode actions: run on this device DURING the turn, the result goes back to it
    this._guidance = built.guidance
    this._keepsProposals = true // off() never stops it (V#14)
    if (!this._pendingTimer && !this._hostDriven) this._pendingTimer = setInterval(() => this._pollPending(), 1500) // a lane always listens for proposals
    if (!this._hostDriven) setTimeout(() => this._pollPending(), 0) // and asks ONCE right away (2026-09-26): a proposal already waiting is on screen at open, not 1.5 s later. Next tick, not now: the caller attaches its `proposal` listener right after `new Lane(...)`, and an emit inside the constructor would fire before it
    // RESUMED WITH OUTSIDE-AGENT TASKS WAITING (sync sweep 10-26 #8): lane.a2a is built now — it watches for the drafts still
    // coming and sends an 'auto' peer's — not only once the page reads lane.a2a; a draft for the member waits for the 'a2a' listener
    if (this._a2aResume && this._a2aResume.length) void this.a2a
  }

  /** Replace the STANDING actions (what every turn is offered) while keeping every handler ever registered — a card
   *  approved after a reload still finds its handler. `setActions([])` leaves the lane offering nothing until a turn
   *  brings its own `tools`. (2026-09-26: builders used to set lane._clientTools = [] for this.) */
  setActions(actions = []) {
    const built = buildActions(actions)
    this._clientTools = built.defs
    this._guidance = built.guidance
    Object.assign(this._writes, built.handlers); Object.assign(this._reads, built.reads)
    return this
  }

  /** Post a private message to your assistant. Its reply is private; anything it wants the shared room to see, or any
   *  effectful action, it must PROPOSE (→ the `proposal` event) — the member approves before it happens. */
  async send(text, { from = 'You', mode, tools, dictation, replace = false, instructions, images, files, links, stopKey, showPrompt, replyTo, _onAttempt, _aborted, _linkPost, _peerPost, _noHold, _skill } = {}) {
    if (this._feed) this._feed.sent() // a new turn: its own words are never held back by the previous answer (turnFeed.js; sync sweep 10-16 #10)
    { const f = arguments[1] && arguments[1].from; if (!_linkPost && !_peerPost && typeof f === 'string' && f.trim() && f.trim().toLowerCase() !== 'you') this._memberName = f.trim().slice(0, 80) } // the name this member uses — a crossing they approve lands under it (never a linked room's or an outside agent's post: _linkPost, _peerPost)
    // PER-TURN TOOLS (2026-09-25): `tools` takes the same action shape the constructor takes, offered for THIS turn only
    // — a builder whose actions depend on the subject of the conversation (views vs skills) no longer has to reach
    // into _client.turn. Defs and guidance ride beside the standing ones (a per-turn action with a standing action's
    // name wins for the turn); the handlers are registered so a proposal or an in-turn read for them can run.
    // `replace: true` (2026-09-26): the turn is offered ONLY `tools` — a skill runs with its own set — while every
    // standing handler stays registered, so a proposal approved later still runs. `replace` with no tools ⇒ no tools.
    let additions
    let defs = this._clientTools, guidance = this._guidance
    if (replace) { defs = []; guidance = '' }
    // LINKED LANES (sdkLaneLink.js): while this lane is linked, every turn is offered tell_lane — `replace` included, since
    // an answer the other assistant sends back must still be able to reach the member through this one.
    const linkTool = laneLinkTool(this)
    if (linkTool && !defs.some((d) => d.name === 'tell_lane')) { defs = [...defs, linkTool.def]; guidance = [guidance, linkTool.guidance].filter(Boolean).join(' ') }
    if (Array.isArray(tools) && tools.length) {
      const extra = buildActions(tools)
      if (extra.defs.length) {
        const names = new Set(extra.defs.map((d) => d.name))
        defs = [...defs.filter((d) => !names.has(d.name)), ...extra.defs]
        additions = extra
        guidance = [guidance, extra.guidance].filter(Boolean).join(' ')
      }
    }
    if (defs.length > LIMITS.actions) throw limitError(`${defs.length} actions offered to this turn; the limit is ${LIMITS.actions} per turn — the rest would be dropped (register as many as you like; offer at most ${LIMITS.actions} with send's { tools, replace })`)
    if (additions) { Object.assign(this._writes, additions.handlers); Object.assign(this._reads, additions.reads) }
    const opts = await this._turnOpts(mode, {
      ...this._bridgeOpts(), // the lane observes the shared room + can cross into it (keyless: the worker holds the shared room's key)
      ...this._linksOpt(links),
      ...(defs.length ? { clientTools: defs, clientGuidance: guidance } : {}),
      ...perTurn(instructions), // this reply only, never stored — see Space.send
      ...stopOpt(stopKey),
      ...promptOpt(showPrompt),
    })
    const msg = withMedia({ from, ...(_skill ? { mcp: _skill } : { text: String(text) }), ...(dictation ? { voice: voiceForDictation(dictation, this.room) } : {}) }, images, files)
    { const rt = replyRef(replyTo); if (rt) msg.replyTo = rt }
    await this.safeMedia._prepare(msg)
    const r = await this._turnHeld(() => {
      const { bridgeRoom, bridgeMk, viewSource, links: oldLinks, ...rest } = opts
      return this._provenTurn(msg, { ...rest, ...this._bridgeOpts(), ...this._linksOpt(links) })
    }, _onAttempt, _aborted, _noHold) // held + resent while the assistant is busy — see Space._turnHeld; with your app's proof where the room requires it, as Space.send (sync sweep 11-09 #18)
    this._kick()
    if (r && r.ok) this._askName() // a lane is named like any room: the app's roomTitle.js does not skip lanes (sync sweep, 2026-10-10)
    return r
  }

  /** ONE LANE, SEVERAL ROOMS (2026-10-02). Besides the shared Space it crosses into, a lane's assistant can READ other
   *  rooms the member holds — a person in two teams has one lane that sees both. `setLinks([spaceB, { space: spaceC,
   *  label: 'Design team' }])` sets them for every turn; `send(text, { links })` replaces them for one turn. The
   *  assistant gets the last messages of each, read-only; it can cross only into the lane's own shared Space. Each
   *  linked room applies ITS OWN gate: a gated room is read only when the signed-in member is on its list. Same tier
   *  only — a confidential room cannot be read from a standard lane, or the reverse. */
  setLinks(links = []) { this._links = this._normLinks(links); return this }

  async linkKept(space, opts = {}) {
    if (!(space instanceof Space) || space._sharedRoom) throw sdkError('witbitz: linkKept needs an always-on Space', 'invalid_argument')
    if (this._wb && this._wb.vault) return this._wb.vault._c.roomAccount(this.room, 'keptAgent', 'link', space.room, opts)
    return linkKeptAgent(this, space, opts)
  }
  async unlinkKept(space, link) {
    if (!(space instanceof Space) || space._sharedRoom) throw sdkError('witbitz: unlinkKept needs its kept Space', 'invalid_argument')
    if (this._wb && this._wb.vault) return this._wb.vault._c.roomAccount(this.room, 'keptAgent', 'unlink', space.room, link)
    return unlinkKeptAgent(this, space, link)
  }

  /** LINK TWO OF THE MEMBER'S LANES (2026-10-03): each assistant can ask the other with `tell_lane`, asynchronously — the
   *  question crosses framed, the other assistant is woken to answer, and the answer comes back and wakes this one. All
   *  on this device, while both lanes are open here. `to` is what THIS assistant calls the other, `as` what the other
   *  calls this one; `cap` bounds a chain of assistants asking each other (default 3, 0 = none). → a link with
   *  `unlink()`, `run()` and `state` (pass it back as `resume` after a reload). Lanes of either tier. */
  link(other, { to, as, cap, resume } = {}) {
    if (!(other instanceof Lane)) throw sdkError('witbitz: link takes another private Lane, not a shared Space', 'not_a_lane')
    const l = linkLanes(this, other, { to, as, cap, resume }, { tierMismatch })
    const acct = this._wb && this._wb.account
    if (acct && acct.enabled && typeof acct._noteLink === 'function') { acct._noteLink(this.room, other.room, l.cap); l._onUnlink = () => acct._dropLink(this.room, other.room) }
    return l
  }

  _normLinks(links) {
    if (!Array.isArray(links)) throw sdkError('witbitz: links takes an array of Spaces (or { space, label })', 'invalid_argument')
    if (links.length > LIMITS.links) throw limitError(`${links.length} linked rooms; the limit is ${LIMITS.links}`)
    const enc = this._isEnclave()
    return links.map((x, i) => {
      const sp = x instanceof Space ? x : (x && x.space)
      if (!(sp instanceof Space) || !sp.room || !(sp._mk || (this._client && this._client.vault))) throw sdkError(`witbitz: links[${i}] is not a Space (from openSpace or createSpace)`, 'invalid_argument')
      if (sp.room === this.room) throw sdkError(`witbitz: links[${i}] is this lane itself`, 'invalid_argument')
      if (sp._isEnclave() !== enc) throw tierMismatch(enc ? 'this lane is confidential and the linked room is not' : 'the linked room is confidential and this lane is not')
      const label = x instanceof Space ? undefined : (x.label ? String(x.label).slice(0, 80) : undefined)
      return { room: sp.room, ...(sp._mk ? { mk: sp._mk } : {}), ...(label ? { label } : {}) } // no key in a vault: its worker fills it by room
    })
  }

  _linksOpt(perTurn) {
    const list = perTurn !== undefined ? this._normLinks(perTurn) : (this._links || [])
    return list.length ? { links: list } : {}
  }

  /** THE MIRROR (2026-10-02) — the SDK twin of the app's mirrorLoop.js. With `mirror: true` (privateLane / openLane),
   *  this device copies the shared Space's messages into the lane as they arrive, so the lane's OWN ledger holds the
   *  whole shared history and its assistant reads it like any other history — not just the newest 20 the server shows a
   *  lane turn. Each copy arrives on the lane as a message with `source: 'shared'` and an `sh:` id — `isLaneCopy(m)` (filter those out to keep a lane UI
   *  private-only). Only this device can do it: it holds both keys, and the server never joins the two rooms. It runs
   *  while both handles are open; a lane reopened later catches up from its cursor. Attachments cross as bytes, stored
   *  again under the lane's key (a pointer sealed to the shared room would never open here). */
  async mirrorNow() { return this._runMirror() }

  _scheduleMirror() {
    if (!this._mirrorFrom || this._mirrorFrom._stopped || this._stopped) return
    clearTimeout(this._mirrorTimer)
    this._mirrorTimer = setTimeout(() => { this._runMirror().catch(() => {}) }, 250) // a burst of messages → one pass
  }

  async _runMirror() {
    this._checkShared()
    const from = this._mirrorFrom
    const attached = () => { this._checkShared(); return this._mirrorFrom === from && !from._stopped && !this._stopped }
    if (!from || from._stopped || this._stopped) return { mirrored: 0 }
    if (this._mirrorInFlight) { this._mirrorAgain = true; return { mirrored: 0 } }
    this._mirrorInFlight = true
    let sent = 0
    try {
      const canReadConfig = typeof from._client.getConfig === 'function'
      const cfg = canReadConfig ? await from._client.getConfig(from.room, from._mk, { plainMark: true }) : {}
      if (!cfg || gatedStub(cfg)) return { mirrored: 0 }
      if (cfg.lanes === false) { from._lanesSetting = false; this._detachShared(); return { mirrored: 0 } }
      const all = (from.messages || []).filter((e) => e && !e.sys && !e.mcp && e.kind !== 'mcp' && e.kind !== 'fork' && (e.text || (Array.isArray(e.files) && e.files.length) || (Array.isArray(e.images) && e.images.length)))
      if (from._more || !(from._historyRead || from._hostDriven)) return { mirrored: 0 } // not the whole shared history yet (a failed page leaves _more false) // the shared room is still loading its pages: a cursor past what has arrived is not another history
      const anchorOf = e => e ? removedEntryKey(e) : null
      if (this._mirrorCursor && (this._mirrorCursor > all.length || this._mirrorAnchor !== anchorOf(all[this._mirrorCursor - 1]))) {
        const anchor = this._mirrorAnchor ? all.findIndex(e => anchorOf(e) === this._mirrorAnchor) : -1
        this._mirrorCursor = anchor + 1
      } // a cursor from another history: start over; the server's id-dedup makes it a resend, never a double
      const copyEntry = async e => ({
        sourceRoom: from.room,
        id: 'sh:' + (e.id || ('t' + e.ts)), // the entry id alone, no room prefix — stable across a fork (the app's rule)
        from: e.name || e.from || 'party', ...(e.self === true ? { self: true } : {}), ...(e.md === true ? { md: true } : {}),
        ...(typeof e.fr === 'string' ? { fr: e.fr, frRoom: from.room } : {}), // the Space's franking record + which Space: a report of the copy names the ORIGINAL (the app's mirrorLoop.js; sync sweep 11-19 P1)
        ...(e.self && Array.isArray(e.sources) ? { sources: e.sources.slice(0, 12) } : {}),
        ...mirrorBy(from.room, e), // WHO WROTE IT, as the Space verified them — Block collapses their copy in the lane too (the app's mirrorLoop.js byOf; sync sweep 11-08)
        ...(Number.isFinite(e.ts) ? { ts: e.ts } : {}), ...(e.replyTo && e.replyTo.key ? { replyTo: e.replyTo } : {}), // when it was said, and what it answers (sync sweep, 2026-10-10)
        text: e.text, files: await withBytes(from, e.files), images: await withBytes(from, e.images),
        ...(e.removedByWitbitz ? { sourceRemoved: true } : {}),
      })

      // Apply removals before fresh attachments, which can fail to load.
      if (!this._stopped && !from._stopped) {
        this._removalsMirrored = this._removalsMirrored || new Set()
        const removed = all.filter((e) => e.removedByWitbitz && (!from._removedMessages || from._removedMessages.has(removedEntryKey(e))) && !this._removalsMirrored.has(removedEntryKey(e)))
        for (let i = 0; i < removed.length && !from._stopped && !this._stopped; i += 25) {
          const batch = removed.slice(i, i + 25), patches = batch.map((e) => ({ id: 'sh:' + e.id, ts: e.ts, sourceRoom: from.room, sourceRemoved: true }))
          if (!attached()) return { mirrored: sent }
          const r = await this._client.mirror(this.room, this._mk, patches)
          if (!r || r.status !== 200) break
          if (!Array.isArray(r.sourceRemovals)) {
            if (!this._removalUnsupported) { this._removalUnsupported = true; this._emit('error', sdkError('witbitz: this server did not acknowledge source removals; the mirror will retry', 'mirror_removal_unsupported')) }
            break
          }
          this._removalUnsupported = false
          for (const e of batch) if (r.sourceRemovals.some((a) => a && a.id === 'sh:' + e.id && a.ts === e.ts)) {
            this._removalsMirrored.add(removedEntryKey(e))
            this._removedSourceMessages = this._removedSourceMessages || new Map()
            const target = { id: 'sh:' + e.id, ts: e.ts }, key = removedEntryKey(target)
            this._removedSourceMessages.set(key, target)
            const cur = this.messages.find((m) => removedEntryKey(m) === key)
            if (cur) for (const u of this._view.apply([sharedRemovedCopy(cur)]).updated) this._emit('update', { id: u.id, message: u.entry, fields: u.fields })
          }
          this._kick()
        }
      }
      while (this._mirrorCursor < all.length && !from._stopped && !this._stopped) {
        const slice = all.slice(this._mirrorCursor, this._mirrorCursor + 25)
        const batch = this._mirrorData ? slice : slice.filter((e) => e.kind !== 'data')
        if (!batch.length) { this._mirrorCursor += slice.length; this._mirrorAnchor = anchorOf(slice.at(-1)); continue }
        const entries = await Promise.all(batch.map(copyEntry))
        // A REFUSAL THAT THROWS is still a refusal (sync sweep 11-16 #16): a vault refuses an attested Space's copy into an ordinary
        // lane by throwing, and the timer's catch swallowed it — every message tried again, silently. Said once, like the others.
        const start = this._mirrorCursor
        let accepted = 0
        for (const part of mirrorBatches(entries)) {
          if (!attached() || from._stopped || this._stopped) return { mirrored: sent }
          let r
          try { r = await this._client.mirror(this.room, this._mk, part) }
          catch (error) { r = { status: 0, error: error?.code || 'mirror_failed', reason: String(error?.message || '').slice(0, 300) } }
          if (r?.status !== 200) {
            const key = String(r?.error || r?.status || 'no_answer')
            if (this._mirrorRefusal !== key) { this._mirrorRefusal = key; this._emit('error', refused('mirror', r)) }
            return { mirrored: sent }
          }
          this._mirrorRefusal = null
          accepted += part.length; sent += part.length
          this._mirrorCursor = start + slice.indexOf(batch[accepted - 1]) + 1
          this._mirrorAnchor = anchorOf(all[this._mirrorCursor - 1])
        }
        this._mirrorCursor = start + slice.length
        this._mirrorAnchor = anchorOf(slice.at(-1))
      }
      if (!this._stopped && !from._stopped) {
        // A cleared moderation list triggers a fresh source read. Cached message text is never a restoration.
        const hiddenCopies = new Set(this.messages.filter(e => e.sourceRemoved).map(removedEntryKey))
        const candidates = all.filter(e => hiddenCopies.has(removedEntryKey({ id: 'sh:' + e.id, ts: e.ts })) && !from._removedMessages?.has(removedEntryKey(e)))
        if (candidates.length && attached()) {
          const history = await from._roomHistory()
          if (!history.incomplete && Array.isArray(history.removed)) {
            const hidden = new Set(history.removed.map(removedEntryKey))
            const wanted = new Set(candidates.map(removedEntryKey))
            const originals = history.entries.filter(e => wanted.has(removedEntryKey(e)) && !hidden.has(removedEntryKey(e)) && !e.removedByWitbitz && e.kind !== 'fork')
            for (let i = 0; i < originals.length; i += 25) {
              const attempts = await Promise.allSettled(originals.slice(i, i + 25).map(copyEntry))
              const entries = attempts.filter(result => result.status === 'fulfilled').map(result => result.value)
              if (!entries.length) continue
              if (!attached()) break
              for (const part of mirrorBatches(entries.map(e => ({ ...e, restoreSource: true })))) {
                if (!attached()) return { mirrored: sent }
                const r = await this._client.mirror(this.room, this._mk, part)
                if (r?.status !== 200) return { mirrored: sent }
                for (const e of r.sourceRestorations || []) {
                  this._removedSourceMessages?.delete(removedEntryKey(e))
                  this._removalsMirrored.delete(removedEntryKey({ id: e.id.slice(3), ts: e.ts }))
                }
                if (r.sourceRestorations?.length) { this._count = 0; this._etag = null; this._kick() }
              }
            }
          }
        }
        // CAPTION CATCH-UP (the app's rule, mirrorLoop.js): a shared photo is described by the shared room's assistant AFTER
        // it first crossed. Once the description lands, re-send it as a description-only patch so the lane's assistant gets
        // what the shared room has. Recent entries, once per id (sync sweep, 2026-10-10 — the SDK never sent it).
        this._descMirrored = this._descMirrored || new Set()
        const patches = []
        for (const e of all.slice(-40)) {
          if (!(e && Array.isArray(e.images) && e.images.some((i) => i && typeof i.desc === 'string' && i.desc.trim()))) continue
          const key = 'sh:' + (e.id || ('t' + e.ts))
          if (this._descMirrored.has(key)) continue
          patches.push({ id: key, from: e.name || e.from || 'party', images: e.images.map((i) => (i && typeof i.desc === 'string' && i.desc.trim() ? { desc: String(i.desc).slice(0, 2000) } : {})) })
        }
        if (patches.length && attached()) { const r = await this._client.mirror(this.room, this._mk, patches).catch(() => null); if (r && r.status === 200) for (const p of patches) this._descMirrored.add(p.id) }
      }
      // THE SHARED ROOM'S VIEWS (sharedViews.js): this handle holds both keys, so it reads the shared room's itinerary and
      // map docs and writes them, as text, into the lane's `sharedviews` doc — the lane's turn reads it. Only on a change.
      if (!from._stopped && !this._stopped && typeof this._client.state === 'function' && Date.now() - (this._viewsAt || 0) > 15_000) { // at most every 15 s: a busy room must not re-read every view on every message
        this._viewsAt = Date.now()
        try {
          const views = []
          for (const v of viewsNamedIn(from.messages)) { const d = await this._client.state(from.room, from._mk, v.name).catch(() => null); if (!d?.state || (d.status && d.status !== 200)) { this._viewsAt = 0; throw sdkError('shared view unavailable', 'state_unavailable') } views.push({ label: v.label, state: d.state }) }
          const text = renderSharedViews(views, from.room)
          if (attached() && (text !== this._sharedViews || this._sharedViewsSource !== from.room)) { const r = await this._client.state(this.room, this._mk, SHARED_VIEWS_DOC, { source: from.room, text }, text.slice(0, 200), 'device'); if (r && r.status === 200) { this._sharedViews = text; this._sharedViewsSource = from.room } }
        } catch { /* never break the mirror */ }
      }
    } finally {
      this._mirrorInFlight = false
      if (this._mirrorAgain) { this._mirrorAgain = false; this._scheduleMirror() }
    }
    if (sent) this._kick()
    return { mirrored: sent }
  }

  snapshot() {
    return { ...super.snapshot(), ...(this._mirrorFrom ? { mirrored: this._mirrorCursor, mirrorAnchor: this._mirrorAnchor } : {}) }
  }

  close() {
    this._wb?._openLanes?.delete(this)
    for (const off of this._sharedOffs || []) { try { off() } catch { /* */ } }
    this._sharedOffs = []
    for (const l of [...(this._laneLinks || [])]) l._stop() // stops here; the link itself (in wb.account) stays
    if (this._mirrorFrom && this._mirrorSub) for (const ev of ['message', 'update']) { const l = this._mirrorFrom._subs[ev]; if (l) { const i = l.indexOf(this._mirrorSub); if (i >= 0) l.splice(i, 1) } }
    clearTimeout(this._mirrorTimer); clearInterval(this._viewsTick)
    if (this._ownsSharedSpace && this._sharedSpace) { try { this._sharedSpace.close() } catch { /* */ } } // a Space vault.openRoom(laneId) opened for it
    return super.close()
  }

  /** @private the bridge to its Space — none across tiers (a confidential room's key never rides the standard tier). */
  _detachShared() {
    if (!this._sharedRoom) return
    for (const off of this._sharedOffs || []) { try { off() } catch {} }
    this._sharedOffs = []
    if (this._mirrorFrom && this._mirrorSub) for (const ev of ['message', 'update']) {
      const listeners = this._mirrorFrom._subs?.[ev], index = listeners?.indexOf(this._mirrorSub) ?? -1
      if (index >= 0) listeners.splice(index, 1)
    }
    if (this._ownsSharedSpace) this._sharedSpace?.close()
    this._detachedLane = true
    this._sharedRoom = null; this._sharedMk = null; this._mirrorFrom = null; this._sharedSpace = null
    clearTimeout(this._mirrorTimer); clearInterval(this._viewsTick)
    this._emit('disconnected', { reason: 'lanes_disabled' })
  }
  _checkShared() {
    if (!this._sharedRoom) return
    const rec = this._wb?.backup?.rooms?.find(r => r.room === this.room)
    if (rec && (rec.detachedLane || rec.kind !== 'lane' || (rec.shared && rec.shared !== this._sharedRoom))) this._detachShared()
  }
  _bridgeOpts() { this._checkShared(); if (!this._sharedRoom) return {}; return this._crossTier ? { viewSource: this._sharedRoom } : { ...(this._sharedMk ? { bridgeMk: this._sharedMk } : {}), bridgeRoom: this._sharedRoom } }
  _runExtra() { return { ...this._bridgeOpts(), ...this._linksOpt() } } // sync sweep, 2026-10-10: Lane.run had no bridge, then no linked rooms
  _decideExtra() { return this._bridgeOpts() } // keyless: the worker holds the shared room's key // a crossing posts into the shared room on approve
}

// THE ROOM AS A STORE — the device-side replay, the same reducer the agent's data_query runs server-side
// (agent/dataTools.mjs rowsFromEntries): puts upsert, deletes remove, in ledger order.
function applyDataEntry(rows, e) {
  for (const o of e.ops) {
    if (!o || !o.collection) continue
    const c = String(o.collection)
    let m = rows.get(c); if (!m) { m = new Map(); rows.set(c, m) }
    if (o.op === 'del') m.delete(String(o.id))
    else if (o.op === 'put' && o.row && typeof o.row === 'object') m.set(String(o.id), { row: ownFields(o.row), updated: Number(e.ts) || 0, by: e.name || '', v: typeof e.id === 'string' ? e.id : '', ...stampsOf(e) }) // v: the entry that last wrote the row (⇄ the server's rowsFromEntries)
  }
}

// `_verified` / `_user` on a row: set only when the SERVER stamped the write — its author passed the room's email gate
// (agent/spaceService.mjs data op). `_by` stays the name the writer chose, a claim; these two are not.
// Absent, not false, on an unmarked row, so a row's shape is unchanged for rooms with no email gate.
// `_email`: the writer's VERIFIED email, stamped beside `_verified` (most members have no @username). `_carriedBy`: the
// verified email of the member who carried the row here (a fork). `_carried`: the room the row was written in and the marks
// the server gave it THERE ({ from, verified?, user?, email? }) — set when the server carried the move (op 'carry'); a
// device's carry keeps none. Every one of these comes from the server's stamp on the ledger entry, never from the row.
function rowMarks(v) {
  return { ...(v.verified === true ? { _verified: true, ...(v.user ? { _user: v.user } : {}), ...(v.email ? { _email: v.email } : {}) } : {}), ...(v.carriedBy ? { _carriedBy: v.carriedBy } : {}), ...(v.carried ? { _carried: v.carried } : {}) }
}
/** The server's stamps on an entry (or a resumed row), each only in the shape the server writes it. */
function stampsOf(e) {
  const ok = (x) => typeof x === 'string' && x
  const c = e.carried && typeof e.carried === 'object' && ok(e.carried.from) ? e.carried : null
  return { ...(e.verified === true ? { verified: true, ...(ok(e.user) ? { user: e.user } : {}), ...(ok(e.email) ? { email: e.email } : {}) } : {}), ...(ok(e.carriedBy) ? { carriedBy: e.carriedBy } : {}), ...(c ? { carried: { from: c.from, ...(c.verified === true ? { verified: true, ...(ok(c.user) ? { user: c.user } : {}), ...(ok(c.email) ? { email: c.email } : {}) } : {}) } } : {}) }
}
// RESERVED row fields (⇄ agent/dataTools.mjs reservedRowFields): `id` is the row's key and `_` names are the marks above.
// A row is read WITHOUT them — a row stored before the server refused them must not pose as the server's stamp.
const isReserved = (k) => k === 'id' || k.startsWith('_')
function ownFields(row) { return Object.fromEntries(Object.entries(row || {}).filter(([k]) => !isReserved(k))) }

export default Witbitz

// ── The account half: session helpers, connections, the Siri inbox ──────────────────────────────────────────────
/** `{ emails?, domains? }` → the sealed config's `admission` + `allow`, or null for an OPEN Space.
 *
 *  The gate and the allow-list ride INSIDE the sealed config, so the platform can read that a room is gated and never
 *  who is admitted. Validation is here rather than at the first refused read because an allow-list that admits nobody
 *  locks the CREATOR out too, and a room cannot be converted afterwards — the cheapest place to catch that is the call. */
/** `tier` → is this the confidential (enclave) tier? A typo must not silently mint a PLAIN room that a builder then
 *  believes is confidential — so anything unrecognised throws. */
const tierIsEnclave = (tier) => {
  if (tier === undefined || tier === null || tier === 'standard') return false
  if (tier === 'enclave' || tier === 'confidential') return true
  throw sdkError(`witbitz: unknown tier ${JSON.stringify(tier)} — 'enclave' or 'standard'`, 'invalid_argument')
}

const tierMismatch = (why) => { const e = new Error(`witbitz: a lane and the rooms it reads must be on the same tier — ${why}. Open both from links of the same tier (an enclave link carries #enc=1).`); e.code = 'tier_mismatch'; return e }

/** ★ AN ENCLAVE ROOM'S LINK SAYS SO. Enclave-ness lived only in `_enc.rooms`, an in-memory Map on the client that
 *  created the room, so a FRESH client — a builder's app on every launch — treated the room as standard, talked to the
 *  standard relay and got `404 create_required` (reported 2026-09-27). The app has the same Map plus two things a
 *  builder's client has not: a durable copy in the account's room list, and an open-time probe. A fresh client holds
 *  only the link, so the link is where the marker belongs; the fragment already carries `gate=email` (and `lanes=1` for a room that gives every member a private lane, createSpace({ lanes })).
 *  Unknown fragment keys are ignored by every existing reader, so an older client is unaffected. */
const ENC_MARK = /[?#&]enc=1(?:[&#]|$)/ // in the fragment (markEncLink) OR the query: the hosted vault marks a link it hands the cloud device `…&enc=1#us=…` (vault-loader encLink) — read as standard until 2026-11-25
const markEncLink = (l) => (ENC_MARK.test(String(l)) ? String(l) : String(l) + (String(l).includes('#') ? '&' : '#') + 'enc=1')
/** An email-gated room's link says so too (the app's own convention, inviteLinks.js): a client opening it knows to sign
 *  in, and the SDK knows to announce its device in the room's guest book (see Space#fork). Never sent to the server. */
const markGateLink = (l) => (roomInviteFlags(l).gated ? String(l) : String(l) + (String(l).includes('#') ? '&' : '#') + 'gate=email')
/** A room that gives every member a private assistant: its link says so (the app's grammar, inviteLinks.js `&lanes=1`). */
const markLanesLink = (l) => (roomInviteFlags(l).lanes ? String(l) : String(l) + (String(l).includes('#') ? '&' : '#') + 'lanes=1')
/** SPLIT-KEY links (https://witbitz.chat/docs/sdk-keys.md#split-key) — the app's own grammar (inviteLinks.js): `#us=<userShare>&spc=<commit>` in
 *  place of `#mk=`. The link is HALF a key; the other half comes only to a page on an origin the room's tenant declared. */
const SPLIT_MARK = /[#&]us=/
const GRANT_BACKOFF_MS = [2000, 4000, 8000, 16000, 32000, 60000] // = l1.js STALE_BACKOFF_MS
const splitLinkOf = (link, userShare, commit) => String(link).split('#')[0] + '#us=' + encodeURIComponent(userShare) + (commit ? '&spc=' + encodeURIComponent(commit) : '')
const fragParam = (link, k) => { const m = new RegExp('[#&]' + k + '=([^&]*)').exec(String(link)); return m ? decodeURIComponent(m[1]) : '' }
const splitKeyChoice = (key) => {
  if (key === undefined || key === null || key === 'standard') return false
  if (key === 'split') return true
  throw sdkError(`witbitz: unknown key ${JSON.stringify(key)} — 'split' or 'standard'`, 'invalid_argument')
}
/** The room id straight from the link's query — needed BEFORE `open()` is called, because on an enclave room the open
 *  itself is the request that must already be routed to the enclave. */
const roomFromLink = (l) => { const m = /[?&]room=([^&#]+)/.exec(String(l)); return m ? decodeURIComponent(m[1]) : '' }

/** ONE config builder for BOTH a shared Space and a private lane. They were built by two separate pieces of code and
 *  drifted: a lane could not declare `data`, so its assistant truthfully reported having no data_query (a builder hit
 *  this on the confidential tier, 2026-09-27). ★ A lane always HAD tools — `spaceService` gives every room the platform
 *  set, plus cross_to_shared on a bridged lane, plus its `actions`; what a lane could not have was the two
 *  CONFIG-BORNE sources, the builder's own `tools`/`immediateTools` and `dataSchema`. The owner's rule is that a lane
 *  is exactly a room, so the shape is built here once and neither caller may grow a field the other lacks.
 *  `gate` is passed in already normalised, so an invalid admission still throws before anything else is decided.
 *  `defaults` carries the only two things that legitimately differ: the assistant's name and its fallback persona. */
/** createSpace({ direct }): the gate a direct chat is made with — the signed-in member and one other address, both shown,
 *  the member its owner (the app's New Space with one person and no name). */
/** How a page signs in: in a vault the vault does it (wb.vault.signIn) — the error must name the call that works there (sync sweep, 10-16). */
const signInHow = (wb) => (wb && wb.vault ? 'wb.vault.signIn' : 'wb.signIn') // the call that signs in HERE (sync sweep 10-20 #11: in a vault it is the vault's)
function directAdmission(direct, admission, sess, signIn = 'wb.signIn') {
  if (admission !== undefined) throw sdkError('witbitz: a direct chat sets its own members — pass direct OR admission, not both')
  const me = sess && sess.email && !(sess.exp && sess.exp <= Date.now()) ? String(sess.email).trim().toLowerCase() : ''
  if (!me) throw sdkError('witbitz: a direct chat needs a signed-in member (' + signIn + ')', 'sign_in_required')
  const peer = String(direct || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(peer)) throw sdkError('witbitz: direct takes the other person\'s email address')
  if (peer === me) throw sdkError('witbitz: a direct chat is with someone else — for a room of your own, use admission: { emails: [you] }')
  return { emails: [me, peer], advertise: true, owners: [me] }
}

function roomConfig({ agent = {}, tools, immediateTools, model, data, gate, platformTools, framing, dataWrites }, defaults) {
  checkDataSchema(data) // refuse what the server would cut, drop or rename — see LIMITS
  // `write: 'admins'` means nothing in a room with no admins or owners: the server enforces it only where there are some
  // (spaceService hasAdmins), so every member would write it. Refused here rather than accepted and ignored (sync sweep, 2026-10-10).
  checkAdminCollections(data, gate)
  const pt = platformToolsOpt(platformTools)
  const fr = framingOpt(framing)
  const t = tools || agent.tools
  return {
    agentName: (agent.name || defaults.agentName).slice(0, 80),
    persona: String(agent.instructions || agent.persona || defaults.persona).slice(0, 4000),
    ...(Array.isArray(t) && t.length ? { tools: t } : {}),
    ...(Array.isArray(immediateTools) && immediateTools.length ? { immediateTools } : {}),
    ...(model || agent.model ? { model: model || agent.model } : {}),
    ...(gate || {}), // email admission: the gate + the allow-list, sealed with the rest (undefined ⇒ an OPEN room, sealed exactly as before)
    ...(pt !== undefined ? { platformTools: pt } : {}), // which platform tools the assistant gets: absent = all, false = none, a list = only those
    ...(fr ? { framing: fr } : {}), // BUILDER MODE: the prompt is your instructions and tools only (sdk-assistant.md#builder-mode)
    ...(dataWrites === false ? { dataWrites: false } : {}), // the assistant reads the store (data_query) but proposes no writes
    ...(data && typeof data === 'object' ? { dataSchema: data } : {}), // THE ROOM AS A STORE: declared collections + field rules → the agent gets data_query / data_put / data_delete. On a LANE this is the LANE's OWN store, under the lane's own key — never the shared room's (deliberate, 2026-09-27: shared-collection reads are a separate feature).
  }
}


/** `framing` → 'builder' | undefined; anything else refused (a typo must not silently keep the Spaces framing). */
function framingOpt(v) {
  if (v === undefined || v === null || v === 'spaces') return undefined
  if (v === 'builder') return 'builder'
  throw sdkError("witbitz: framing is 'builder' (your instructions and tools only) or omitted (the Spaces framing)", 'invalid_argument')
}

/** `platformTools` → what the sealed config carries: undefined (all — the default), false (none) or a list of names. */
function platformToolsOpt(v) {
  if (v === undefined || v === null || v === true) return undefined
  if (v === false) return false
  if (!Array.isArray(v) || v.some((n) => typeof n !== 'string' || !n || n.length > 64) || v.length > 64) throw Object.assign(new Error("witbitz: platformTools is true (all, the default), false (none) or a list of tool names, e.g. ['web_search', 'read_file']"), { code: 'bad_platform_tools' })
  return [...new Set(v)]
}

const sessionOf = (x) => (x && typeof x === 'object' && typeof x.idToken === 'string' && x.idToken && typeof x.email === 'string')
  ? { email: String(x.email).toLowerCase(), idToken: x.idToken, exp: Number(x.exp) || 0, ...(x.sign && typeof x.sign === 'object' ? { sign: x.sign } : {}) } : null
/** Was this room a private lane? The account's backup keeps a lane's kind even after it is re-added as a Space (sdkBackup.js
 *  `wasLane`) — the SDK's record, as the app's is `space:lane-rooms`. Without the backup the SDK knows only the Lane handle. */
function wasLaneRoom (wb, room) {
  try { const b = wb && wb.backup; if (!b || !b.enabled || !room) return false; const r = (b.rooms || []).find((x) => x && x.room === room); return !!(r && (r.detachedLane || r.kind === 'lane')) } catch { return false }
}
const siriStateOf = (x, allowPending = true) => {
  const o = x && typeof x === 'object' ? x : {}
  const rooms = {}
  for (const [room, r] of Object.entries(o.rooms && typeof o.rooms === 'object' ? o.rooms : {})) {
    if (!r || typeof r !== 'object' || !r.alias || !r.pub || !r.priv) continue
    rooms[room] = { alias: String(r.alias), label: String(r.label || ''), pub: { x: r.pub.x, y: r.pub.y }, priv: r.priv, at: Number(r.at) || 0 }
  }
  const pending = Array.isArray(o.pendingRemovals) ? [...new Set(o.pendingRemovals.filter(id => typeof id === 'string' && Object.hasOwn(rooms, id)))] : []
  const setup = allowPending && o.pendingSetup ? siriStateOf(o.pendingSetup, false) : null
  const rotation = allowPending && o.pendingRotation
  return { ...(rotation && rotation.from === o.token && typeof rotation.to === 'string' && rotation.to ? { pendingRotation: { from: rotation.from, to: rotation.to } } : {}), ...(setup && Object.keys(setup.rooms).length ? { pendingSetup: setup } : {}), ...(pending.length ? { pendingRemovals: pending } : {}), ...(Number(o.rev) > 0 ? { rev: Number(o.rev) } : {}), token: typeof o.token === 'string' ? o.token : '', defaultRoom: typeof o.defaultRoom === 'string' && rooms[o.defaultRoom] ? o.defaultRoom : '', rooms }
}

/** `wb.usernames` — the member's @username. One name means one person across ALL of Witbitz (not per app): it is
 *  bound to the person's email-derived handle, and a room's email gate admits by it. Claim/release/mine act as the
 *  signed-in member (the server derives who from the sign-in token, never from the page). `publish: true` also lists
 *  the person in the public directory under that name; off by default. A released name is held for 30 days, and what
 *  a member wrote keeps the `_user` it was stamped with. */
// What console.log / JSON.stringify / util.inspect show (sdkRedact.js): the room, never its key or link. In a vault the
// sign-in is the vault's (sweep 10-24 #10: it read signedIn: false there).
redacted(Witbitz.prototype, (w) => ({ viewer: w._viewer, ...(w._tenant ? { tenant: w._tenant } : {}), signedIn: w.vault ? !!(w.vault.info && w.vault.info.signedIn) : !!(w._session && w._session.email), ...(w._tenantKey ? { tenantKey: REDACTED } : {}) }))
redacted(Space.prototype, (sp) => ({ room: sp.room, shareLink: REDACTED, messages: Array.isArray(sp.messages) ? sp.messages.length : 0, ...(sp instanceof Lane ? { lane: true, sharedRoom: sp._sharedRoom || null } : {}) }))

class Usernames {
  constructor(wb) { this._wb = wb }
  async claim(name, { publish = false, name: display } = {}) {
    const { idToken } = this._wb._auth('a username belongs')
    const u = bareName(name)
    const r = await this._wb._client.userClaim(u, idToken, publish ? { publish: true, ...(display ? { name: display } : {}) } : {})
    if (!r || r.status !== 200) throw userError(r, `could not claim @${u}`)
    return { username: r.username || u }
  }
  async release() {
    const { idToken } = this._wb._auth('a username belongs')
    const r = await this._wb._client.userRelease(idToken)
    if (!r || r.status !== 200) throw userError(r, 'could not release the username')
    return { username: null }
  }
  /** → { username: string | null, published } */
  async mine() {
    const { idToken } = this._wb._auth('a username belongs')
    const r = await this._wb._client.userWhoami(idToken)
    if (!r || r.status !== 200) throw userError(r, 'could not read the username')
    return { username: r.username || null, published: r.published === true }
  }
  /** Is this @name taken? Public, rate-limited, no sign-in. → { username, exists } */
  async resolve(name) {
    const u = bareName(name)
    const r = await this._wb._client.userResolve(u)
    if (r && r.status === 404) return { username: u, exists: false }
    if (!r || r.status !== 200) throw userError(r, `could not look up @${u}`)
    return { username: r.username || u, exists: true }
  }
}
const bareName = (n) => String(n || '').trim().replace(/^@/, '').toLowerCase()
const userError = (r, what) => Object.assign(new Error(`witbitz: ${what} (${(r && (r.message || r.error)) || (r && r.status) || 'no answer'})`), { code: (r && r.error) || 'user_failed', status: r && r.status })

/** In a vault the room keys and the account's session are the VAULT's. What needs either in the page is refused by name
 *  (`vault_unsupported`) — it used to half-work: a backup that recorded nothing, "sign in first" while signed in, a crash,
 *  a room list read as empty while the vault held Spaces. spaces/test/sdkVaultSurface.test.mjs holds every public member
 *  to a decision. `keep`: the members that say something true about this page (a flag, a state to persist) and stay. */
const vaultRefusal = (what) => sdkError(`witbitz: ${what} is not available in a vault yet`, 'vault_unsupported')
function blockInVault(obj, what, keep = []) {
  if (!obj) return
  const names = new Set()
  for (let p = obj; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor' && !k.startsWith('_') && !keep.includes(k)) names.add(k)
  for (const k of names) {
    let d = null
    for (let p = obj; p && !d; p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, k)
    if (!d) continue
    if (d.get) { Object.defineProperty(obj, k, { get() { throw vaultRefusal(what) }, configurable: true }); continue }
    if (typeof d.value !== 'function') continue
    const isAsync = d.value.constructor && d.value.constructor.name === 'AsyncFunction'
    Object.defineProperty(obj, k, { value: isAsync ? () => Promise.reject(vaultRefusal(what)) : () => { throw vaultRefusal(what) }, configurable: true, writable: true })
  }
}
function refuseInVault(wb) {
  // THE ACCOUNT goes through the vault, which holds the sign-in (vault-core.js ACCOUNT_CALLS). The vault keeps what
  // must not reach the page — the session, the Siri inbox's private keys, each connection's callKey — and asks the person
  // before acting in their name.
  const conn = wb.vault._c
  // THE BACKUP, THE ACCOUNT INDEX AND THE ERASE LIST are the vault's (vault-core.js backupCall/accountCall): it records
  // every Space it holds, shows and takes the recovery code in its own screens, and keeps the index in step. The getters
  // read the vault's last VIEW of them (no link, no key, no master secret); `onChange` fires when it changes.
  wb._vaultAccount = (conn.info && conn.info.account) || { enabled: false, format: null, deviceId: '', rooms: [], devices: [], links: [], lastError: null, erasure: false }
  let accountGeneration = 0
  let memoryEmail = String(conn.info?.email || '').toLowerCase()
  wb._memoryGeneration = 0
  const view = () => wb._vaultAccount
  conn.on((ev) => {
    if (ev?.ev === 'a2aChanged') refreshVaultA2AViews(conn, ev)
    if (ev?.ev === 'siri' && ev.siri) wb._vaultSiri = { ...ev.siri, key: null }
    const expired = ev?.ev === 'signedOut' && ev.reason === 'expired'
    if (expired) wb.a2a._draftsSuspended = true
    if (ev?.ev === 'signedOut' || ev?.ev === 'accountSignedOut' || ev?.ev === 'signedIn') {
      const email = ev.ev === 'signedIn' ? String(ev.email || '').toLowerCase() : ''
      const resumed = wb.a2a._draftsSuspended && email && email === memoryEmail
      if (!email || email !== memoryEmail) {
        if (!expired) wb.a2a._dropAllDrafts()
        wb._forgetVoice(); wb._memoryGeneration++; wb._assistantMemory = null
      }
      if (!expired) {
        memoryEmail = email; wb.a2a._draftsSuspended = false
        if (resumed) for (const handle of wb._agentHandles || []) handle._a2a?._flushHeld()
      }
    }
    if (['signedOut', 'accountSignedOut', 'signedIn'].includes(ev?.ev) || (ev?.ev === 'account' && ev.view?.enabled !== view().enabled)) {
      if (ev.view?.enabled === false && !expired) wb.a2a._dropAllDrafts()
      wb._vaultGeneration = ++accountGeneration
      conn.a2aEpoch = (conn.a2aEpoch || 0) + 1
      wb._vaultSiri = { key: null, hasKey: false, endpoint: wb._vaultSiri?.endpoint }
      if (ev.ev !== 'signedOut' && ev.ev !== 'accountSignedOut' && ev.view?.enabled !== false) {
        refreshVaultA2AViews(conn, ev)
        const generation = accountGeneration
        conn.account('siri', 'shortcut').then(value => { if (generation === accountGeneration) wb._vaultSiri = value }).catch(() => {})
      }
      for (const sec of Object.values(wb.account._sections || {})) sec._seen(null, true)
    }
    if (ev?.ev === 'accountSignedOut' && typeof wb.account.onSignedOut === 'function') {
        try { wb.account.onSignedOut(ev.reason ? { reason: ev.reason } : undefined) } catch { /* app callback */ }
      }
      if (ev && ev.ev === 'accountSection' && Object.prototype.hasOwnProperty.call(wb.account._sections || {}, ev.section)) { wb.account._sections[ev.section]._seen(ev.value, true); return }
    if (!ev || ev.ev !== 'account' || !ev.view) return
    const was = wb._vaultAccount; wb._vaultAccount = ev.view
    if (typeof wb.account.onChange === 'function' && JSON.stringify([was.rooms, was.devices, was.links]) !== JSON.stringify([ev.view.rooms, ev.view.devices, ev.view.links])) { try { wb.account.onChange({ rooms: ev.view.rooms, devices: ev.view.devices }) } catch { /* the app's callback */ } }
    if (typeof wb.backup.onState === 'function' && was.enabled !== ev.view.enabled) { try { wb.backup.onState(null) } catch { /* */ } }
  })
  const getters = (obj, map) => { for (const [k, f] of Object.entries(map)) Object.defineProperty(obj, k, { get: f, configurable: true }) }
  // signOutOthers / newRecoveryCode / deleteAccount: an account on the Witbitz account service (`service === 'account'`) — the vault
  // asks the person (its own confirm, the emailed code, the new code shown in its screens); the page gets only the outcome
  forwardInVault(wb.backup, (m, a) => conn.account('backup', m, ...(m === 'remove' ? [a[0]] : m === 'migrate' && a[0]?.silent === true ? [{ silent: true }] : m === 'deleteAccount' ? [{ names: (a[0] && Array.isArray(a[0].names) ? a[0].names : []) }] : [])), ['enable', 'restore', 'migrate', 'protectRecoveryEmail', 'manageSecurityKeys', 'save', 'upgrade', 'signOutOthers', 'newRecoveryCode', 'deleteAccount', 'beginEmailMove', 'pendingEmailMove', 'finishEmailMove', 'cancelPendingEmailMove', 'emailMove', 'requestMoveTime', 'cancelEmailMove'])
  wb.backup.remove = async (room) => { await conn.account('backup', 'remove', String(room || '')); return wb.backup } // a promise here: a refusal is said, not swallowed (sweep 10-24 #10)
  wb.backup.add = () => wb.backup // the vault records every Space it holds, on its own
  wb.backup.keyFor = () => { throw vaultRefusal('a key (the vault keeps them)') }
  wb.backup.setInvite = () => { throw vaultRefusal('writing the invite key into the backup (the vault keeps both)') } // the page writes no backup (sync sweep 11-13 P7)
  getters(wb.backup, { enabled: () => view().enabled, format: () => view().format, service: () => view().service || null, gated: () => !!view().gated, state: () => null, invite: () => null, rooms: () => view().rooms.map((r) => ({ ...r })) }) // gated: as the vault says (it read false for ever — sync sweep 11-09 #24)
  forwardInVault(wb.account, (m, a) => conn.account('account', m, ...(m === 'signOutDevice' ? [a[0]] : a)), ['sync', 'start', 'stop', 'archive', 'pin', 'rename', 'forget', 'signOut', 'listDevices', 'signOutDevice', 'repairNames', 'previewEmptySpaces', 'removeEmptySpaces', 'usage'])
  // lane.link() records the link on the account (Lane#link → _noteLink): in a vault the index is the vault's (sync sweep, 10-17 #6)
  wb.account._noteLink = (a, b, cap) => { conn.account('account', 'noteLink', a, b, cap).catch(() => {}) }
  wb.account._dropLink = (a, b) => { conn.account('account', 'dropLink', a, b).catch(() => {}) }
  // THE OPTIONAL SECTIONS (wb.account.contacts / .name / .roomDefaults — sdkAccountSections.js, plan phase 5): the account's docs
  // need its master secret, which is the vault's — each call goes to the vault (ACCOUNT_CALLS account.section), which runs the
  // same section on its own SDK and sends 'accountSection' when another device changed one. They carry no key and no link.
  for (const [name, sec] of Object.entries(wb.account._sections || {})) {
    for (const m of sec._calls) sec[m] = async (...a) => {
      const generation = accountGeneration
      const v = await conn.account('account', 'section', name, m, ...a)
      if (generation !== accountGeneration) throw sdkError('the account changed during the call', 'account_changed')
      if (!(name === 'chatLocks' && (m === 'check' || m === 'match' || m === 'previewDeleteAll' || m === 'deleteAll'))) sec._seen(v)
      return v
    }
    const on = sec.on.bind(sec)
    sec.on = (ev, fn) => { on(ev, fn); if (ev === 'change' && typeof fn === 'function') sec.get().catch(() => null); return sec } // the vault watches a section once asked
    sec._remote = true
  }
  getters(wb.account, { enabled: () => view().enabled, deviceId: () => view().deviceId, rooms: () => view().rooms.map((r) => ({ ...r })), devices: () => view().devices.map((d) => ({ ...d })), links: () => view().links.map((l) => ({ ...l })), lastError: () => { const e = view().lastError; return e ? (e instanceof Error ? e : typeof e === 'object' ? Object.assign(new Error(e.message), e) : new Error(String(e))) : null } }) // an Error, as outside a vault (the vault sends its message — sync sweep, 10-16)
  forwardInVault(wb.erasure, (m, a) => conn.account('erasure', m, ...a), ['file', 'status'])
  // WHICH BUILD THE PERSON ACCEPTS (sdkBuilds.js): in a vault the VAULT seals each room's key, with its own SDK — the page's list
  // decides nothing there, so its changes are refused by name (the vault kit takes them in a later phase)
  for (const m of ['accept', 'setAutomatic', 'sync']) wb.builds[m] = () => Promise.reject(vaultRefusal('wb.builds.' + m + ' (the vault seals the keys)'))
  // …and the verdict is the vault's too: the page never meets the enclave (the vault attests it), so it answered null for ever
  // while it read as "not attested yet" (sync sweep 11-13 P7). Synchronous, as outside a vault.
  wb.builds.verdict = () => { throw vaultRefusal('wb.builds.verdict (the vault meets the enclave and seals the keys)') }
  if (wb.builds.mode === 'mine') throw sdkError("witbitz: builds: 'mine' is not available in a vault yet — the vault seals each room's key with its own SDK, so the person's list would not be consulted", 'vault_unsupported') // never silently unenforced (review 2026-11-07)
  getters(wb.erasure, { available: () => !!view().erasure })
  for (const name of ['catalog', 'discover']) Object.defineProperty(wb.connections, name, { value: wb.connections[name].bind(wb.connections), configurable: true }) // public picker data remains synchronous and local
  forwardInVault(wb.connections, (m, a) => conn.account('connections', m, ...a))
  wb.connections.recover = async id => { checkConnectionId(id); return (await wb.connections.list()).find(c => c.id === id && c.grantable) || null }
  Object.defineProperty(wb.connections, 'lock', { value: () => Promise.reject(vaultRefusal('connections.lock (the vault locks what it holds itself)')), configurable: true, writable: true }) // move 3: no key leaves a vault
  // the sign-in comes back to THIS page (sweep 10-24 #6): forwarded bare, the vault's SDK named its own origin's /mcp-callback,
  // where no page waits — the default is the page's, as outside a vault
  wb.connections.startMcp = (opts = {}) => conn.account('connections', 'startMcp', { ...(opts || {}), ...(opts && opts.redirectUri ? {} : (typeof location !== 'undefined' && location.origin ? { redirectUri: location.origin + '/mcp-callback' } : {})) })
  // detach takes Space objects (`{ spaces }`), which do not cross to the vault (a DataCloneError — sync sweep 10-19 #7): the vault
  // gets the id alone, and each Space is unlinked through its own handle, as outside a vault
  wb.connections.detach = async (id, { spaces = [] } = {}) => {
    const cid = String(id || ''), out = await conn.account('connections', 'detach', cid)
    if (out?.removed?.length) { wb.a2a._dropMoved(out.removed); refreshVaultA2AViews(conn, out) }
    let removedFrom = 0
    for (const sp of Array.isArray(spaces) ? spaces : []) { try { if (sp && sp.connections) { await sp.connections.revoke(cid); removedFrom++ } } catch { /* one Space's refusal does not undo the detach */ } }
    return { ...(out || {}), removedFrom }
  }
  forwardInVault(wb.usernames, (m, a) => conn.account('usernames', m, ...a))
  // the Shortcut KEY stays in the vault: `shortcut.key` is null here, rotateKey resolves null, and wb.vault.showSiriKey()
  // shows it in the vault's own screen
  forwardInVault(wb.siri, (m, a) => conn.account('siri', m, ...a).then((r) => { if (m === 'rotateKey') { wb._vaultSiri = r || wb._vaultSiri; return null } if (m === 'revoke') wb._vaultSiri = { key: null, hasKey: false, endpoint: wb._vaultSiri && wb._vaultSiri.endpoint }; return r }), ['status', 'sync', 'rotateKey', 'revoke'])
  wb._vaultSiri = (conn.info && conn.info.siri) || { key: null, endpoint: null }
  Object.defineProperty(wb.siri, 'shortcut', { get() { return { ...wb._vaultSiri } }, configurable: true }) // as the vault last said
  Object.defineProperty(wb.siri, 'state', { get() { return null }, configurable: true }) // the vault keeps it: its inbox private keys never come here
  wb.siri.restore = () => { throw vaultRefusal('restoring the Siri state (the vault keeps it)') }
  forwardInVault(wb.a2a, async (m, a) => {
    const result = await conn.account('a2a', m, ...a)
    if (m === 'revoke') { conn.a2aEpoch = (conn.a2aEpoch || 0) + 1; wb.a2a._dropAllDrafts() }
    if (m === 'stopJobAgent') { wb.a2a._dropMoved(result.removed); refreshVaultA2AViews(conn, result) }
    return result
  }, ['status', 'revoke', 'stopJobAgent'])
  Object.defineProperty(wb.a2a, 'state', { get() { return null }, configurable: true }) // the vault keeps it: the lanes' inbox private keys never come here
  wb.a2a.restore = () => { throw vaultRefusal('restoring the A2A state (the vault keeps it)') }
  Object.defineProperty(wb.invite, 'state', { get() { return null }, configurable: true }) // the vault keeps the account's invite key
  Object.defineProperty(wb.invite, 'status', { get() { return 'vault' }, configurable: true }) // …and publishes it: there is nothing for the page to enroll or restore (sweep 10-23 #20 — it read 'none' for ever)
  wb.invite.enroll = async () => 'vault' // the status, a string, as outside a vault and in the d.ts (sweep 10-24 #9)
  wb.invite.restore = () => { throw vaultRefusal('restoring the invite key (the vault keeps it)') }
  wb.signIn = () => Promise.reject(sdkError('witbitz: in a vault, sign in with wb.vault.signIn() — the vault keeps the session', 'vault_signs_in'))
  wb.refreshSession = wb.signIn
  wb.useSession = () => { throw sdkError('witbitz: in a vault, the vault keeps the session — wb.vault.signIn() / wb.vault.info.email', 'vault_signs_in') } // it answered and adopted nothing, as signOut did (sync sweep 11-08 #29)
  wb.signOut = () => { throw sdkError('witbitz: in a vault, sign out with wb.vault.signOut() — the vault keeps the session', 'vault_signs_in') } // it reported success and signed nothing out (sync sweep 10-19)
  // dictation and reading aloud: the short-lived speech key is minted by the VAULT with its sign-in (or with your user
  // token, wb.useUserToken) — vault-core.js `speechKey`; the page streams to the speech model itself, as outside a vault
}
/** A Space in a vault: its connections and Siri need the account's session, which is the vault's. */
function refuseSpaceInVault(sp) {
  const vc = () => sp._wb && sp._wb.vault && sp._wb.vault._c // read at each call: the vault this Space asks through now
  if (!vc()) { blockInVault(sp.connections, 'connections'); blockInVault(sp.siri, 'the Siri inbox'); return sp }
  const call = ns => (m, a) => {
    if (ns === 'connections' && m === 'revoke' && a[1]?.includeAssistant && !vc().info?.scopedConnectionRevoke)
      throw sdkError('Update the vault kit to revoke private assistant grants', 'vault_unsupported')
    return vc().roomAccount(sp.room, ns, m, ...a)
  }
  // grant by id: the callKey is the vault's (wb.connections.attach in a vault returns { id, label, host, account })
  forwardInVault(sp.connections, (m, a) => call('connections')(m, m === 'grant' ? [a[0] && typeof a[0] === 'object' ? a[0].id : a[0], a[1] && { from: a[1].from, tools: a[1].tools, auto: a[1].auto, reads: a[1].reads }] : a))
  forwardInVault(sp.siri, async (m, a) => {
    if (m !== 'collect') { const r = await call('siri')(m, a); if (m === 'enable' && r) sp._wb._vaultSiri = { key: null, hasKey: !!r.hasKey, endpoint: r.endpoint }; return r }
    const deliver = a[0] && a[0].deliver
    if (deliver !== undefined && typeof deliver !== 'function') throw sdkError('witbitz: collect({ deliver }) takes a function — deliver(text, meta)', 'invalid_argument')
    const transport = vc()
    const queue = transport.siriCollections ||= new Map()
    const collect = async () => {
      if (!deliver) return call('siri')('collect', [{}])
      const off = transport.onAsk('siriDeliver', sp.room, ({ text, meta }) => deliver(text, meta))
      try { return await call('siri')('collect', [{ deliver: true }]) } finally { off() }
    }
    const previous = queue.get(sp.room) || Promise.resolve()
    const run = previous.catch(() => {}).then(collect)
    queue.set(sp.room, run)
    try { return await run } finally { if (queue.get(sp.room) === run) queue.delete(sp.room) }
  })
  return sp
}
/** Replace each public method of `obj` with one that asks the vault: `send(method, args)`. Getters are left alone. */
function forwardInVault(obj, send, only = null) {
  for (let p = obj; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (k === 'constructor' || k.startsWith('_') || (only && !only.includes(k)) || Object.prototype.hasOwnProperty.call(obj, k)) continue
      const d = Object.getOwnPropertyDescriptor(p, k)
      if (!d || typeof d.value !== 'function') continue
      Object.defineProperty(obj, k, { value: (...a) => send(k, a), configurable: true, writable: true })
    }
  }
}

/** The vault this page runs in ({@link Witbitz.inVault}). The keys are there; this is how the page asks for what needs them. */
export class VaultSession {
  constructor(wb, conn) {
    this._wb = wb; this._c = conn; this.origin = conn.origin; this._fns = new Map(); this._live = {}
    // each room's last key state as the vault said it (once per vault window): a Space opened LATER on this page starts from it
    // (sync sweep 11-08 #27: it never heard it, and polled at full speed)
    this._keyState = new Map()
    for (const k of Array.isArray(conn.info && conn.info.keyStates) ? conn.info.keyStates : []) if (k && typeof k.room === 'string' && (k.kind === 'removed' || k.kind === 'pending')) this._keyState.set(k.room, { kind: k.kind, reason: String(k.reason || '') }) // what the vault holds now — a reloaded page hears it here, never again as an event (sync sweep 11-09)
    conn.on((d) => { if (d && d.ev === 'key' && typeof d.room === 'string') { if (d.kind === 'rekeyed') this._keyState.delete(d.room); else if (d.kind === 'removed' || d.kind === 'pending') this._keyState.set(d.room, { kind: d.kind, reason: d.reason || '' }) } })
    conn.on((ev) => this._event(ev))
  }
  /** What the vault said when the page connected — { tenant, signedIn, email, rooms, siri, account } — with the sign-in and the
   *  account kept current from the vault's events since (sync sweep 10-26 #10: it was the welcome, frozen). */
  get info() { return { ...this._c.info, ...this._live, ...(this._wb._vaultSiri ? { siri: { ...this._wb._vaultSiri } } : {}) } }
  /** The Spaces this vault holds, newest first: [{ room, title, at, lane?, tier?, lanes? }] — never a link. */
  async rooms() { return this._c.rooms() }
  /** A live {@link Space} for a room the vault holds — its key stays in the vault. */
  async openRoom(room, { resume } = {}) {
    if (typeof room !== 'string' || !room) throw sdkError('witbitz: openRoom takes a room id from wb.vault.rooms()', 'invalid_argument')
    const wb = this._wb
    // a room the vault does not hold is said here, as openLane says it — not as a Space whose every call fails (sweep 10-24 #10)
    const all = await this._c.rooms(), it = all.find((r) => r && r.room === room)
    if (!it) throw sdkError('witbitz: this vault holds no Space ' + room.slice(0, 40), 'not_in_vault')
    // a LANE's id opens it as its Space's lane — as a plain Space it skipped the lane rules (sync sweep 2026-11-02 #5)
    if (it.lane) {
      // its Space forgotten (forget / dropRoom keep the lane): said by name, about THIS room — it threw not_in_vault naming
      // the Space's id (sync sweep 2026-11-03 #4)
      if (all.some(r => r?.room === it.lane && r.lane)) throw sdkError('Conflicting private-room links must be synced before opening this lane.', 'association_changed')
      if (!all.some((r) => r && r.room === it.lane)) throw sdkError('witbitz: this private lane\'s Space is no longer in this vault, so the lane cannot be opened', 'lane_space_gone')
      const space = await this.openRoom(it.lane)
      // the Space opened here is the lane's own: lane.close() closes it too — it was left polling (sync sweep 2026-11-03 #5)
      try { const lane = await this._openLane(room, { space, resume }); lane._ownsSharedSpace = true; return lane } catch (e) { space.close(); throw e }
    }
    const sp = new Space(wb._client, { room, mk: null, link: null, viewer: wb._viewer, resume, wb, lanes: it.lanes === true })
    if (it.tier === 'enclave') wb._enc.rooms.set(room, true)
    if (it.detachedLane) sp._detachedLane = true
    return refuseSpaceInVault(sp)
  }
  /** @private wb.openLane in a vault: the lane's ROOM ID (from rooms(), where `lane` names its Space) — a link is the
   *  vault's to open. */
  async _openLane(room, { space, actions, resume, tier, mirror }) {
    const wb = this._wb
    if (!(space instanceof Space) || !space.room) throw sdkError('witbitz: openLane needs `space`, the shared Space the lane belongs to', 'invalid_argument')
    if (typeof room !== 'string' || /[:#/]/.test(room)) throw sdkError('witbitz: in a vault, openLane takes the lane\'s room id from wb.vault.rooms() — the vault opens links', 'vault_opens_links')
    const held = await this._c.rooms(), it = held.find((r) => r.room === room)
    if (!it) throw sdkError('witbitz: this vault holds no Space ' + room.slice(0, 40), 'not_in_vault')
    await assertNotKept(space)
    if (it.lane !== space.room) throw sdkError('witbitz: that room is not a lane of this Space', 'invalid_argument')
    // its Space forgotten: said by name, as openRoom says it — the lane opened and every bridged turn then failed not_in_vault (sync sweep 11-04 #9)
    if (!held.some((r) => r && r.room === space.room)) throw sdkError('witbitz: this private lane\'s Space is no longer in this vault, so the lane cannot be opened', 'lane_space_gone')
    // a lane's tier is its Space's: a different one is refused, as privateLane does — never ignored (sync sweep, 10-15)
    if (tier !== undefined && tier !== null && tierIsEnclave(tier) !== (it.tier === 'enclave')) throw tierMismatch('this lane is ' + (it.tier === 'enclave' ? 'confidential' : 'standard') + ' — its Space\'s tier')
    // a lane of the OTHER tier (the app links one): mirrored by this device, no bridge — as outside a vault (Witbitz.openLane)
    const crossTier = (it.tier === 'enclave') !== ((held.find((r) => r.room === space.room) || {}).tier === 'enclave')
    if (it.tier === 'enclave') wb._enc.rooms.set(room, true)
    return refuseSpaceInVault(new Lane(wb._client, { room, mk: null, link: null, viewer: wb._viewer, sharedRoom: space.room, sharedMk: null, actions, resume, wb, shared: space, mirror: crossTier ? (mirror || true) : mirror, crossTier }))
  }
  /** Show the Siri Shortcut's key in the VAULT's own screen (it posts words into the person's Spaces, so it never comes
   *  to this page). Rejects `no_key` until a Space has Siri enabled. */
  async showSiriKey() { return this._c.account('siri', 'showKey') }
  /** The vault's LOCK SHEET, in the vault's own pixels: the person turns the lock (a passkey at every launch) and "Also protect
   *  this device's storage" on or off there. Resolves { available, on, protect } when they close it; this page can turn neither
   *  on nor off. Rejects `vault_unsupported` unless the vault was started with `lock: true` (`info.lock` says whether it was). */
  async showLock() {
    if (typeof this._c.lockSettings !== 'function') throw sdkError('witbitz: this vault offers no lock', 'vault_unsupported')
    const r = await this._c.lockSettings()
    this._live = { ...this._live, lock: r }
    return r
  }
  /** NOTIFICATIONS on this device, in the vault's own card: the person turns them on (the browser asks for its permission
   *  there) or off. Resolves { available, on }. A tapped notification arrives as `on('notifOpen', ({ room }) => …)` — or, when
   *  it opened the vault, as `info.notifOpen`. Rejects `vault_unsupported` unless the vault was started with `push: true`. */
  async showNotifications() {
    if (typeof this._c.notifications !== 'function') throw sdkError('witbitz: this vault sends no notifications', 'vault_unsupported')
    const r = await this._c.notifications()
    this._live = { ...this._live, push: r }
    return r
  }
  /** Share a Space: the VAULT shows its share screen with the link (the link carries the key, so it never comes here). */
  async share(space, opts = {}) { if (opts.hostInviteTemplate !== undefined && !this._c.info?.hostInvites) throw sdkError('Update the vault kit to use host invites', 'vault_unsupported'); return this._c.share(space && space.room ? space.room : String(space || ''), opts) }
  /** Sign in — the vault shows its sign-in screen; resolves { email } once signed in. */
  async signIn() { return this._c.signIn() }
  async signOut() { return this._c.signOut() }
  /** { signedIn, email, keyId } — who the vault has signed in (keyId: its session key's public id, what space.isMine compares). */
  async whoami() { return this._c.whoami() }
  /** Remove a Space from this vault (its key is forgotten on this device). */
  async forget(room) { return this._c.forget(room && room.room ? room.room : String(room || '')) }
  /** 'rooms' (the list changed: { rooms }), 'joined' ({ room } — the vault opened an invite), 'signedIn' ({ email }), 'signedOut',
   *  'accountSignedOut' (this device was signed out of the account, or the account was deleted, from another device: the vault forgot
   *  the account, its sign-in and its Spaces here; `reason: 'erased'` — the account was deleted). */
  on(event, cb) { if (!this._fns.has(event)) this._fns.set(event, new Set()); this._fns.get(event).add(cb); return () => this._fns.get(event).delete(cb) }
  _event(d) {
    if (d?.ev === 'rooms' && Array.isArray(d.rooms)) {
      this._live = { ...this._live, rooms: d.rooms.map(r => ({ ...r })) }
      const held = new Set(d.rooms.map(r => r.room))
      const memory = this._wb._assistantMemory?.group
      if (memory) for (const room of memory.keys()) if (!held.has(room)) memory.delete(room)
      for (const r of d.rooms) if (r.tier === 'enclave') this._wb._enc.rooms.set(r.room, true)
      for (const lane of this._wb._openLanes || []) {
        const saved = d.rooms.find(r => r.room === lane.room)
        if (lane._sharedRoom && saved?.lane !== lane._sharedRoom) lane._detachShared()
      }
    }
    if (d && d.ev === 'signedIn') this._live = { ...this._live, signedIn: true, email: String(d.email || ''), keyId: String(d.keyId || '') }
    else if (d && (d.ev === 'signedOut' || d.ev === 'accountSignedOut')) this._live = { ...this._live, signedIn: false, email: '', keyId: '', ...(d.reason === 'expired' ? {} : { rooms: [] }) } // accountSignedOut: the vault forgot the account AND its sign-in — info said signed in, with the old email (sync sweep 11-22 #5)
    else if (d && d.ev === 'session') this._live = { ...this._live, keyId: String(d.keyId || '') } // a renewed session: its new key's public id (space.isMine)
    else if (d && d.ev === 'account' && d.view) this._live = { ...this._live, account: d.view }
    else if (d && d.ev === 'lock' && d.lock && typeof d.lock === 'object') this._live = { ...this._live, lock: { available: !!d.lock.available, on: !!d.lock.on, protect: !!d.lock.protect } } // a vault started with `lock: true`
    else if (d && d.ev === 'push' && d.push && typeof d.push === 'object') this._live = { ...this._live, push: { available: !!d.push.available, on: !!d.push.on } } // `push: true`
    const set = this._fns.get(d.ev); if (set) for (const fn of set) { try { fn(d) } catch { /* the listener's own */ } }
  }
  async _create({ agent, tools, immediateTools, clientTools, agentReplies, skills, model, data, admission, tier, key, platformTools, region, framing, dataWrites, direct, usernames, safeMedia, lanes }) {
    const enc = tierIsEnclave(tier) // the vault attests the enclave and keeps the key; the page only asks
    const split = splitKeyChoice(key) // the vault makes it through its app-half function (startVault({ appShare: true }))
    const wb = this._wb
    if (direct !== undefined) { const who = await this._c.whoami(); admission = directAdmission(direct, admission, who && who.signedIn ? { email: who.email } : null, 'wb.vault.signIn') } // the vault's signed-in member
    // THE CREATOR IS THE OWNER, as outside a vault (createSpace): the vault's signed-in member, when on the list and no owners given —
    // without it nobody could change the Space's members in place (changeMembers needs an owner or an admin)
    else if (admission && typeof admission === 'object' && Array.isArray(admission.emails) && !(Array.isArray(admission.owners) && admission.owners.length)) {
      const who = await this._c.whoami()
      if (!who || typeof who.signedIn !== 'boolean') throw sdkError('witbitz: the creating member could not be checked', 'identity_unavailable')
      const me = who && who.signedIn ? String(who.email || '').trim().toLowerCase() : ''
      if (me && admission.emails.map((e) => String(e).trim().toLowerCase()).includes(me)) admission = { ...admission, owners: [me] }
    }
    await wb._checkModel(model || (agent && agent.model))
    const gate = normAdmission(admission)
    const cfg = roomConfig({ agent, tools, immediateTools, model, data, gate, platformTools, framing, dataWrites }, { agentName: 'Assistant', persona: '' })
    applySkills(cfg, skills)
    if (Array.isArray(clientTools)) cfg.clientTools = clientTools
    if (agentReplies !== undefined) cfg.agentReplies = agentReplies
    cfg.region = region || wb._region
    if (direct !== undefined) cfg.direct = true
    if (usernames === false && gate?.admission === 'email') cfg.usernames = false
    if (safeMedia === true) cfg.safeMedia = true // as outside a vault (sync sweep 2026-10-28: it was refused here while configure turned it on)
    if (lanes === true) cfg.lanes = true
    const { room } = await this._c.create(cfg, enc || split ? { ...(enc ? { enclave: true } : {}), ...(split ? { split: true } : {}) } : undefined)
    if (enc) wb._enc.rooms.set(room, true)
    const made = refuseSpaceInVault(new Space(wb._client, { room, mk: null, link: null, viewer: wb._viewer, wb, gated: !!gate, lanes: lanes === true }))
    made.safeMedia._learn(safeMedia === true, 0) // a new room's setting is what it was made with, as outside a vault (sync sweep 2026-10-28…11-02: it read null)
    if (direct !== undefined) await made.setReplyMode('ondemand').catch(() => {}) // as outside a vault: the assistant answers when @mentioned
    return made
  }
}

/** `wb.connections` — the ACCOUNT's connections: credentials the standing Sentinel holds and spends on your behalf.
 *  Attaching seals the secret to the attested Sentinel; the page keeps only an id, a label, a host and a `callKey`.
 *  Nothing here touches a Space: grant one to a Space with `space.connections.grant(conn)`. */
function checkConnectionId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw sdkError('witbitz: invalid connection ID', 'invalid_argument')
}
class Connections {
  constructor(wb) { this._wb = wb; this._pendingMemory = new Map() }
  _pendingFor(account) {
    if (this._vaultPending) return this._vaultPending
    const protect = this._wb.protect
    const name = id => 'witbitz:conn-pending:' + encodeURIComponent(account) + ':' + id
    const memory = this._pendingMemory
    const persistent = !!protect && (!('_storage' in protect) || !!protect._storage)
    const load = id => persistent ? protect.load(name(id)) : memory.get(name(id))
    const drop = async id => { if (persistent) await protect.remove?.(name(id)); memory.delete(name(id)) }
    return {
      durable: true, load, drop,
      keep: async (id, rec) => {
        const value = { ...rec, account, at: Date.now() }
        if (persistent) {
          await protect.save(name(id), value)
          if ((await load(id))?.callKey !== rec.callKey) throw sdkError('witbitz: the connection key could not be saved', 'storage_unavailable')
        } else memory.set(name(id), value)
      },
    }
  }
  async recover(id) {
    const wb = this._wb
    wb._auth()
    checkConnectionId(id)
    const account = await wb._account(), pending = this._pendingFor(account)
    const record = await pending.load(id)
    if (!record?.callKey || record.account !== account) return null
    const listed = (await this.list()).find(c => c.id === id)
    if (!listed || account !== await wb._account()) return null
    return { ...listed, id, label: listed.label || record.label || '', host: listed.host || record.host || '', account, callKey: record.callKey }
  }
  /** The app's service/outside-agent picker data, without credentials. A builder draws its own picker. */
  catalog({ category } = {}) {
    if (category !== undefined && typeof category !== 'string') throw sdkError('witbitz: catalog category must be a string', 'invalid_argument')
    return CONNECTION_CATALOG.filter((c) => category === undefined || c.cat === category).map((c) => ({ ...c, kind: c.kind || 'mcp' }))
  }
  async spacesUsing(id) {
    const wb = this._wb, generation = wb._archiveGeneration, master = wb.backup._s?.master || null
    const byId = new Map(wb.account.rooms.map(r => [r.room, r]))
    for (const sp of wb._archiveHandles || []) {
      if (sp._archiveGeneration !== generation || sp._archiveEmail !== (wb._session?.email || '') || sp._archiveMaster !== master || byId.has(sp.room)) continue
      byId.set(sp.room, { room: sp.room, link: sp.shareLink, shared: sp._sharedRoom })
    }
    const result = await spacesUsingConnection(id, [...byId.values()], async room => {
      const link = await wb._openLink(byId.get(room).link)
      if (link.room !== room) throw sdkError('room link mismatch', 'invalid_link')
      return wb._client.getConfig(room, link.mk, { plainMark: true })
    })
    if (wb._archiveGeneration !== generation || (wb.backup._s?.master || null) !== master) throw sdkError('the account changed', 'account_changed')
    if (!wb.backup.enabled) result.incomplete = true
    return result
  }
  discover(query = '', options = {}) {
    const text = String(query).trim().toLowerCase()
    const matches = c => [c.name, c.desc].some(s => String(s || '').toLowerCase().includes(text))
    const services = this.catalog(options).filter(matches)
    const address = options.category === undefined ? typedMcpUrl(query) || null : null
    const methods = [{ id: 'mcp', name: 'Other MCP server', desc: 'Any MCP server, by its address.' }, { id: 'apiKey', name: 'API key', desc: 'A service’s own key, for its API.' }]
    const alternatives = options.category === undefined
      ? otherWaysRows({ all: methods, matches, searching: !!text, anythingElse: !!(services.length || address) }).rows.map(m => m.id)
      : []
    return { services, address, alternatives }
  }
  /** The account's display key (connDisp.js), from the backup master this client holds; null without one (then names go as before). */
  async _dispKey () {
    const st = this._wb.backup && this._wb.backup.state, m = st && st.master
    if (!m) return null
    if (!this._disp || this._disp.master !== m) this._disp = { master: m, key: dispKeyOf(m).catch(() => null) }
    return this._disp.key
  }
  /** Attach a bearer token for one host. → `{ id, label, host, callKey }` — keep it (JSON-safe) to grant it to Spaces;
   *  the secret is gone from this device the moment this returns.
   *  AN AGENT THAT TAKES JOBS (portal/docs/outside-agents.md): `webhook: true` with `host` = the agent's whole https trigger
   *  address makes a one-path, POST-only connection whose key goes as a Bearer header (a `whsec_…` secret is signed
   *  instead, without the flag); `job: { field, headers }` says where the job goes in the request body and the fixed
   *  headers every call carries. A Space granted it tells the agent, in every job, to report back with message_member. */
  async attach({ label, host, secret, rules, limits, webhook, job } = {}) {
    const wb = this._wb, auth = wb._auth()
    const account = await wb._account()
    if (job && webhook !== true && !/^whsec_/.test(String(secret || '').trim())) throw sdkError('witbitz: a job agent is a webhook — pass webhook: true and its whole https address as host', 'invalid_argument')
    const out = await attachConnection({ post: wb._sentinelPost(), pendingStore: this._pendingFor(account), auth, account, label, host, secret, rules, limits, dispKey: await this._dispKey(), pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow, tenant: wb._tenant || undefined, ...(webhook === true ? { bearerWebhook: true } : {}) })
    const j = out.webhook && job ? roomJob(job) : null
    return { ...out, account, ...(j ? { job: j } : {}) }
  }
  /** What the Sentinel holds for this account — never a secret, never a callKey. In a vault the vault answers, and marks each
   *  `grantable`: whether it holds that connection's callKey — `space.connections.grant` refuses the rest (`not_in_vault`). */
  async list() { const wb = this._wb; return listConnections({ post: wb._sentinelPost(), auth: wb._auth(), dispKey: await this._dispKey() }) } // a name sealed to the account's devices is opened here
  /** LOCK THE OLD ONES (docs/standing-sentinel.md § The two open pieces, move 3): a connection attached before 2026-11-16 that no
   *  Space has spent since is still held in the Sentinel's old form — its callKey beside its secret. Pass the callKeys your app
   *  keeps ({ id: callKey }, as `attach` returned them): each one the list marks `locked: false` is locked under its key, with no
   *  call to the service. A vault does this itself on `list`. → { locked, failed, skipped } (skipped: no key passed for it). */
  async lock(keys = {}) {
    const wb = this._wb, post = wb._sentinelPost(), auth = wb._auth()
    const list = await this.list() // the same list `list` gives (names opened with the display key)
    return lockConnections({ post, auth, list,
      attest: () => attestStandingSentinel({ post, auth, pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow }),
      proofOf: async (id, nonce, key) => (keys && typeof keys[id] === 'string' && keys[id] ? wrapProof({ callKey: keys[id], nonce, key }) : null) })
  }
  /** Detach everywhere: the Sentinel forgets it and every Space's grant for it is dead at once. Pass `spaces` (the Space handles
   *  you granted it to) and it is also dropped from each one's settings, as the app's Disconnect does — else their assistants
   *  keep offering a connection that answers 404 (sync sweep, 10-16 #9). → the Sentinel's answer + `removedFrom` (a count). */
  async detach(id, { spaces = [] } = {}) {
    const wb = this._wb, cid = String(id || '')
    const account = await wb._account()
    const removed = await wb.a2a._disconnectConnection(cid, this._bindingFor?.(cid, account))
    if (account !== await wb._account()) throw sdkError('Account changed during disconnect', 'account_changed')
    const out = await detachConnection({ post: wb._sentinelPost(), auth: wb._auth(), id: cid })
    await this._pendingFor(account).drop(cid)
    let removedFrom = 0
    for (const sp of Array.isArray(spaces) ? spaces : []) { try { if (sp && sp.connections) { await sp.connections.revoke(cid); removedFrom++ } } catch { /* one Space's refusal does not undo the detach */ } }
    return { ...(out || {}), ...(removed.length ? { removed } : {}), removedFrom }
  }

  // ── CONNECT TO A BUILDER'S OAUTH APP (https://witbitz.chat/docs/connections.md). Two calls around the consent screen. The PKCE
  // verifier lives in the enclave for the whole round trip, so the code this page ends up holding cannot be exchanged
  // by this page — only by the measured image that minted the challenge.
  /** Begin: → { authUrl, state }. Send the member to `authUrl`; your registered callback receives `?code=&state=`. */
  async startConnect ({ tenant, providerId } = {}) {
    const wb = this._wb, auth = wb._auth()
    if (!providerId) throw sdkError('witbitz: which provider? pass the id your builder gave you', 'invalid_argument')
    const r = await wb._sentinelPost()({ op: 'sentinel', sentinel: { mode: 'oauthstart', tenant: String(tenant || wb._tenant || ''), providerId: String(providerId) }, ...auth })
    if (!r || r.error || !r.authUrl) throw Object.assign(new Error(`witbitz: could not start the sign-in (${(r && (r.error || r.reason)) || 'no answer'})`), { code: (r && r.error) || 'no_answer', ...(r && r.reason ? { reason: r.reason } : {}) })
    return { authUrl: r.authUrl, state: r.state }
  }
  /** Finish with the `code` and `state` your callback received. The tokens never reach this page. → a connection you
   *  grant to Spaces exactly as an attached one: { id, label, host, callKey, account }. */
  async finishConnect ({ state, code, label, host } = {}) {
    const wb = this._wb, auth = wb._auth()
    if (!state || !code) throw sdkError('witbitz: finishConnect needs the state and code from your callback', 'invalid_argument')
    const post = wb._sentinelPost()
    const { nonce, key } = await attestStandingSentinel({ post, auth, pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow })
    const callKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    // the name sealed to the account's devices rides the finish, under the id it names (as attach / finishMcpSignIn do — sync sweep
    // 11-08: finishConnect sealed none). A Sentinel before the one that keeps it files the clear label, as before.
    const id = 'conn_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const dk = await this._dispKey()
    const disp = dk && label ? await sealDisp(dk, id, { label: String(label).trim().slice(0, 80) }).catch(() => '') : ''
    const sealed = await sealToEnclave(key, nonce, { state: String(state), code: String(code), callKey, id, ...(label ? { label: String(label) } : {}), ...(host ? { host: String(host) } : {}), ...(disp ? { disp } : {}) })
    const account = await wb._account()
    const r = await postWithPendingKey(post, { op: 'sentinel', sentinel: { mode: 'oauthfinish', sealed }, ...auth }, id, { label, host, callKey, account, at: Date.now() }, this._pendingFor(account))
    if (!r || r.error || !r.ok) throw Object.assign(new Error(`witbitz: the sign-in was not completed (${(r && (r.error || r.reason)) || 'no answer'})`), { code: (r && r.error) || 'no_answer', ...(r && r.reason ? { reason: r.reason } : {}) })
    return { id: r.id, label: String(r.label || label || ''), host: r.host, provider: 'oauth2', callKey, account: r.account || await wb._account() } // `label`: the Connection type promises one (sync sweep, 2026-10-10)
  }

  // ── MCP SERVERS (the owner, 2026-10-23: "Are the connectors exposed in the sdk?" → "Yes"): as the app's ⋯ → Connections →
  // Other MCP server (https://witbitz.chat/docs/mcp-connections.md). The server's own sign-in runs INSIDE the Sentinel (it
  // registers an app there and holds the PKCE verifier); the member consents in a window; your callback page hands back
  // `code` + `state`; the code and a fresh callKey ride sealed to the Sentinel, which exchanges and files it. Your page never
  // holds the server's token. Grant it to a Space with `space.connections.grant(conn)` like any connection.
  /** Begin: does this server want a sign-in? → `{ needsSignIn: false, host }` (then `attachMcp({ url, label })`) or
   *  `{ needsSignIn: true, authUrl, state, host }` (open `authUrl`; `redirectUri` — default `<your origin>/mcp-callback` — gets
   *  `?code=&state=`; then `finishMcp`). Opens nothing. */
  async startMcp ({ url, label, redirectUri } = {}) {
    const wb = this._wb, auth = wb._auth()
    if (!url) throw sdkError('witbitz: startMcp needs the server\'s address, like https://mcp.example.com/mcp', 'invalid_argument')
    const cb = redirectUri ? String(redirectUri) : (typeof location !== 'undefined' && location.origin ? location.origin + '/mcp-callback' : '') // outside a page (a server, a test): name your callback
    const st = await startMcpSignIn({ post: wb._sentinelPost(), auth, url, label, redirectUri: cb })
    return st.needsAuth ? { needsSignIn: true, authUrl: st.authUrl, state: st.state, host: st.host } : { needsSignIn: false, host: st.host }
  }
  /** A server with no sign-in, or one you hold a token for (`token`, sealed to the Sentinel like any secret). → a connection
   *  `{ id, label, host, callKey, account, mcp: true }`. The member's own, as a signed-in server is: never under your tenant, so
   *  its host needs no declaration (connections.js attachMcp; it was filed under the tenant and refused — docs sync, 2026-11-22). */
  async attachMcp ({ url, label, token = '' } = {}) {
    const wb = this._wb, auth = wb._auth(), account = await wb._account()
    const out = await attachMcpServer({ post: wb._sentinelPost(), pendingStore: this._pendingFor(account), auth, account, label, url, token, dispKey: await this._dispKey(), pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow })
    return { ...out, account, mcp: true }
  }
  /** Finish a server's sign-in with the `state` and `code` your callback received. → a connection, as `attachMcp`. */
  async finishMcp ({ state, code, label, host } = {}) {
    const wb = this._wb, auth = wb._auth()
    if (!state || !code) throw sdkError('witbitz: finishMcp needs the state and code from your callback', 'invalid_argument')
    const account = await wb._account()
    const out = await finishMcpSignIn({ post: wb._sentinelPost(), pendingStore: this._pendingFor(account), auth, state: String(state), code: String(code), label, host, dispKey: await this._dispKey(), pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow })
    return { ...out, account, mcp: true }
  }
  /** The tools an MCP connection offers, as the server describes them (asked through the Sentinel). → `{ tools, server, truncated }`. */
  async mcpTools (id) { const wb = this._wb; return listMcpTools({ post: wb._sentinelPost(), auth: wb._auth(), id: String(id || '') }) }
}

/** `space.connections` — what THIS Space's assistant may spend. A grant is recorded in the Space's sealed
 *  configuration (visibly — a system line lands); the assistant then gets `connection_call` for it, always proposed,
 *  never auto-run, and never sees the secret. */
class SpaceConnections {
  constructor(space) { this._space = space }
  async grants() {
    const sp = this._space
    if (sp._wb?.vault?._c) return sp._wb.vault._c.roomAccount(sp.room, 'connections', 'grants')
    const cfg = await sp._gateConfig({ fresh: true, plainMark: true })
    const wb = sp._wb
    const [account, list] = await Promise.all([wb._account().catch(() => ''), wb.connections.list().catch(() => null)])
    const known = Array.isArray(list) ? new Set(list.map(c => c.id)) : null
    return (Array.isArray(cfg.connections) ? cfg.connections : []).filter(c => typeof c?.id === 'string').map(c => ({
      id: c.id, label: String(c.label || ''), host: String(c.host || ''), status: grantStatus(c, account, known),
    }))
  }
  /** Grant a connection (the object `wb.connections.attach` returned, or `{ id, callKey, host, label, account }`). An MCP
   *  connection (`mcp: true` — what attachMcp / finishMcp return) brings its tools: `tools` (names) to choose them, else the
   *  recommended set — the app's (reads run on their own, changes ask); `auto` (names) for which run without asking. */
  async grant(conn, { from, tools, auto, reads } = {}) {
    from = this._space._who(from)
    const sp = this._space
    const c = conn && typeof conn === 'object' ? conn : {}
    if (reads !== undefined && !['auto', 'ask'].includes(reads)) throw sdkError('witbitz: reads takes auto or ask', 'invalid_argument')
    const account = String(c.account || (sp._wb ? await sp._wb._account() : '') || '').toLowerCase()
    if (!c.id || !c.callKey || !c.host || !account) throw sdkError('witbitz: grant needs { id, callKey, host, account } — the object wb.connections.attach returned', 'invalid_argument')
    // ONLY TO AN EMAIL-GATED ROOM (2026-10-02). In an open room — and a lane is open unless you gate it — the link is the
    // whole capability: whoever holds it can start a turn, and the assistant spends the connection. Gate the room (a
    // lane: privateLane({ admission: { emails: [me] } })) so every turn needs an allowed sign-in.
    const cfg = await sp._gateConfig()
    if (cfg.admission !== 'email') throw Object.assign(new Error("witbitz: a connection can be granted only to an email-gated Space — in an open one, anyone holding the link could have the assistant spend it. Gate it: createSpace / privateLane({ admission: { emails: [...] } })"), { code: 'gate_required' })
    let mcp
    if (c.mcp && !sp._wb) throw sdkError('witbitz: granting an MCP connection needs the signed-in account (open the Space through wb)', 'invalid_argument')
    if (c.mcp) { // an MCP server: its tools, as the app's "Add" does (mcpToolsSheet addWithRecommended)
      const listed = await listGrantTools(c.host, () => listMcpTools({ post: sp._wb._sentinelPost(), auth: sp._wb._auth(), id: String(c.id) }))
      const all = listed.tools.map(roomTool).filter(Boolean)
      const rec = recommendedChoice(all)
      const chosen = new Set(Array.isArray(tools) ? tools.map(String) : rec.chosen)
      const picked = all.filter((t) => chosen.has(t.name))
      if (!picked.length) throw sdkError('witbitz: none of those tools is offered by this server — mcpTools(id) lists them', 'invalid_argument')
      const names = new Set(picked.map((t) => t.name))
      mcp = { tools: picked, auto: (Array.isArray(auto) ? auto.map(String) : rec.auto).filter((n) => names.has(n)), ...(isCurated(c.host) ? {} : { own: true }), listedAt: Date.now() }
      // THE TOOL BOOK, as the app (toolBooks.js; sync sweep 2026-11-17 #3): the Space's other connections into books first, then this
      // one's tools — the config keeps names + the book's pin, so connections no longer fill its cap ("Too many tools")
      const io = { toolBook: (list) => sp._client.toolBook(sp.room, sp._mk, list), getConfig: () => sp._client.getConfig(sp.room, sp._mk), setConfig: (patch) => sp._client.setConfig(sp.room, sp._mk, patch, from) }
      await bookTheRest(io, String(c.id))
      mcp = await withBook(io, mcp)
    }
    const { mcp: _flag, ...entry } = c
    const r = await sp._client.setConfig(sp.room, sp._mk, { connections: { add: roomEntry({ ...entry, account, reads: reads === 'auto' || reads === undefined && readsAutoFor(c) ? 'auto' : undefined, ...(mcp ? { mcp } : {}) }) } }, from)
    if (!r || r.status !== 200) throw refused('recording the connection in this Space', r)
    sp._gateCfg = null
    return { granted: String(c.id), ...(mcp ? { tools: mcp.tools.map((t) => t.name), auto: mcp.auto } : {}) }
  }
  /** Drop a connection from THIS Space only; it stays attached to the account. */
  async revoke(id, { from, includeAssistant = false } = {}) {
    const parent = this._space, wb = parent._wb
    if (includeAssistant) {
      const generation = wb?._archiveGeneration
      if (!wb || parent._memoryOwner !== generation) throw sdkError('Reopen this Space in the current account', 'account_changed')
      let complete = !!wb._heldLaneRooms
      if (wb.account.enabled) {
        try { complete = !!(await wb.account.sync())?.ok } catch { complete = false }
        if (generation !== wb._archiveGeneration) throw sdkError('The account changed', 'account_changed')
      }
      const saved = new Map((wb.account.rooms || []).filter(r => !r.detachedLane && r.shared === parent.room).map(r => [r.room, r]))
      const live = new Map([...(wb._archiveHandles || []), ...(wb._openLanes || [])].filter(sp => sp._sharedRoom === parent.room &&
        !sp._stopped && !sp._detachedLane && sp._memoryOwner === parent._memoryOwner).map(sp => [sp.room, sp]))
      const ids = new Set([parent.room, ...saved.keys(), ...live.keys(), ...(wb._heldLaneRooms?.(parent.room) || [])])
      const unchecked = [], removedFrom = []
      for (const room of ids) {
        if (wb._archiveGeneration !== generation) throw sdkError('The account changed', 'account_changed')
        let sp
        try {
          sp = room === parent.room ? parent : live.get(room) || (wb._scopedRoom ? wb._scopedRoom(room) : await wb.openSpace(saved.get(room).link))
          if (sp.room !== room || wb._archiveGeneration !== generation) throw sdkError('Room or account changed', 'account_changed')
          await sp.connections.revoke(id, { from })
          removedFrom.push(room)
        } catch { unchecked.push(room) }
        finally { if (sp && sp !== parent && !live.has(room)) sp.close() }
      }
      if (unchecked.length) throw Object.assign(sdkError('Some Space grants could not be revoked', 'partial_revoke'), { unchecked, removedFrom })
      return { revoked: String(id), removedFrom, incomplete: !complete }
    }
    from = this._space._who(from)
    const sp = this._space
    const r = await sp._client.setConfig(sp.room, sp._mk, { connections: { remove: String(id || '') } }, from)
    if (!r || r.status !== 200) throw refused('dropping the connection', r) // as grant: the server's code, status and reason (sync sweep, 2026-10-10)
    sp._gateCfg = null
    return { revoked: String(id) }
  }
}

/** `wb.siri` — the account's Siri inbox: one Shortcut key for every Space, an inbox keypair per enabled Space. The
 *  STATE (`wb.siri.state`) holds the inbox private keys — without it a drop can never be opened — so persist it as
 *  you persist the session, and hand it back as `new Witbitz({ siri: state })`. */
class SiriAccount {
  constructor(wb) { this._wb = wb; this.onState = null }
  _changed() { this.onState?.(this.state) }
  /** JSON-safe state to persist. */
  get state() { return JSON.parse(JSON.stringify(this._wb._siri)) }
  /** Adopt persisted state. */
  restore(state) { this._wb._siri = siriStateOf(state); return this }
  /** The Shortcut's key and endpoint (null key until a Space enables Siri). */
  get shortcut() { return { key: this._wb._siri.pendingRotation ? null : this._wb._siri.token || null, endpoint: SIRI_ENDPOINT } }
  /** What the Sentinel holds for this account (aliases, counts) — as it reports it. */
  async status() {
    const wb = this._wb, auth = wb._auth()
    const r = await wb._sentinelPost()({ op: 'sentinel', sentinel: { mode: 'siristatus' }, ...auth })
    if (!r || r.error) throw Object.assign(new Error(`witbitz: the Sentinel could not be reached (${(r && r.error) || 'no answer'})`), { code: (r && r.error) || 'no_answer' })
    return r
  }
  /** A new Shortcut key: the old one stops working the moment the record is pushed. → the new key. */
  async sync() {
    const result = await this._change(async st => {
      if (!st.token) return NO_SIRI_CHANGE
      const remote = await this.status()
      if (remote.configured && !siriAliasesDiffer(st.rooms, remote)) return NO_SIRI_CHANGE
      return true
    })
    return { synced: result === true }
  }
  async rotateKey() { return this._change((st, rotation) => { if (!rotation) st.token = newSiriKey(); return st.token }) }
  /** Turn Siri off everywhere for this account: the Sentinel forgets the record; the local state is cleared. */
  // IN THE SAME QUEUE AS EVERY CHANGE (sync sweep 2026-11-14 P7, owner: yes): a change still being pushed when revoke() ran finished after
  // it and put Siri back at the Sentinel and here. Now revoke waits for it, and a change asked after it runs on the cleared state.
  async revoke() {
    const wb = this._wb, generation = wb._archiveGeneration, auth = wb._auth()
    const check = () => { if (generation !== wb._archiveGeneration) throw sdkError('Account changed during Siri deletion', 'account_changed') }
    const run = async () => {
      check()
      const r = await wb._sentinelPost()({ op: 'sentinel', sentinel: { mode: 'sirirevoke' }, ...auth })
      if (!r || r.error) throw Object.assign(new Error(`witbitz: the Sentinel could not be reached (${(r && r.error) || 'no answer'})`), { code: (r && r.error) || 'no_answer' })
      check()
      wb._siri = siriStateOf({ rev: Math.max(Date.now(), (wb._siri.rev || 0) + 1) })
      this._changed()
      return r
    }
    const p = (this._q || Promise.resolve()).then(run, run)
    this._q = p.catch(() => {})
    return p
  }
  // ⛔ A CHANGE IS KEPT ONLY ONCE THE SENTINEL TOOK IT (state machines pass 9, K#5): the state was changed in place and pushed
  //   after — a failed push left a Space this device had taken off Siri still open at the Sentinel (and a retry found nothing to
  //   take off), or a key this device had replaced still working there. `fn` changes a COPY; the copy is pushed; only then is it
  //   the state. One change at a time. `fn` returns NO_SIRI_CHANGE when there is nothing to do (nothing pushed).
  //   …and a restore() that landed while the push was out (a vault keep applying the account's merged Siri) is NOT
  //   overwritten (sync sweep 2026-11-13 #2: the next keep pass then stamped the other devices' Spaces `gone` everywhere): the
  //   change is made again on top of what landed and that is pushed — at most a few times, then the latest state stands.
  _change(fn) {
    const generation = this._wb._archiveGeneration
    const run = async () => {
      if (generation !== this._wb._archiveGeneration) throw sdkError('Account changed before Siri setup', 'account_changed')
      let out
      for (let i = 0; i < 4; i++) {
        const account = await this._wb._account(), base = this._wb._siri
        const next = siriStateOf(JSON.parse(JSON.stringify(base)))
        const pending = next.pendingRemovals || []
        const priorSetup = next.pendingSetup, rotation = next.pendingRotation
        delete next.pendingRotation
        delete next.pendingSetup
        if (priorSetup) {
          if (!next.token) next.token = priorSetup.token
          if (next.token === priorSetup.token) {
            for (const [id, inbox] of Object.entries(priorSetup.rooms)) if (!next.rooms[id]) next.rooms[id] = inbox
            if (!next.defaultRoom && priorSetup.defaultRoom) next.defaultRoom = priorSetup.defaultRoom
          }
        }
        delete next.pendingRemovals
        for (const room of pending) {
          delete next.rooms[room]
          if (next.defaultRoom === room) next.defaultRoom = ''
        }
        if (rotation) next.token = rotation.to
        out = await fn(next, rotation)
        if (out === NO_SIRI_CHANGE && !pending.length && !priorSetup && !rotation) return out
        if (generation !== this._wb._archiveGeneration || account !== await this._wb._account()) throw sdkError('Account changed during Siri setup', 'account_changed')
        const removed = Object.keys(base.rooms).filter(room => !next.rooms[room])
        const added = Object.entries(next.rooms).filter(([id]) => !base.rooms[id])
        const stageLocal = !this._stageInbox && (removed.length || added.length || priorSetup || next.token !== base.token) && this._wb._siri === base
        if (stageLocal) {
          if (next.token !== base.token && (base.token || !added.length)) base.pendingRotation = { from: base.token, to: next.token }
          if (removed.length) base.pendingRemovals = removed
          if (added.length) base.pendingSetup = siriStateOf({ token: next.token, rooms: Object.fromEntries(added), defaultRoom: next.defaultRoom })
          else delete base.pendingSetup
          this._changed()
        }
        const finish = await this._stageInbox?.(next)
        try { await this._push(next) } catch (e) {
          if (e.definiteRefusal || (e.status >= 400 && e.status < 500)) {
            finish?.(false)
            if (stageLocal && this._wb._siri === base) {
              if (rotation) base.pendingRotation = rotation
              else delete base.pendingRotation
              if (priorSetup) base.pendingSetup = priorSetup
              else delete base.pendingSetup
              if (pending.length) base.pendingRemovals = pending
              else delete base.pendingRemovals
              this._changed()
            }
          }
          throw e
        }
        if (generation !== this._wb._archiveGeneration || account !== await this._wb._account()) throw sdkError('Account changed during Siri setup', 'account_changed')
        finish?.(true)
        if (this._wb._siri === base) { this._wb._siri = next; this._changed(); return out === NO_SIRI_CHANGE ? true : out }
      }
      throw sdkError('witbitz: the Siri state kept changing while it was being saved — try again', 'siri_busy')
    }
    const p = (this._q || Promise.resolve()).then(run, run)
    this._q = p.catch(() => {})
    return p
  }
  /** @private send the whole record — this account's, or `st`, a changed copy (_change) — sealed to the attested Sentinel
   *  (idempotent: it REPLACES what it held). */
  async _push(st = this._wb._siri) {
    const wb = this._wb, auth = wb._auth()
    if (!st.token) st.token = newSiriKey()
    const rec = await siriRecordFor(await wb._account(), st)
    const post = wb._sentinelPost()
    const { nonce, key } = await attestStandingSentinel({ post, auth, pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow })
    const sealed = await sealToEnclave(key, nonce, rec)
    const r = await post({ op: 'sentinel', sentinel: { mode: 'sirigrant', sealed }, ...auth })
    if (!r || r.error || !r.ok) throw (r ? Object.assign(new Error(`witbitz: the Sentinel refused the Siri record (${r.error || r.reason || 'refused'})`), { code: r.error || 'refused', definiteRefusal: (r.ok === false || !!r.error) && !(r.status >= 500) && !['timeout', 'busy', 'unreachable'].includes(r.error) /* not 'sentinel_unavailable': the server says nothing was sent (sentinelRelay.mjs: no endpoint) — staged as unknown, a failed rotate hid the key and the next Siri change completed it (34304d584) */, ...(r.reason ? { reason: r.reason } : {}) }) : Object.assign(new Error('witbitz: the Sentinel did not answer'), { code: 'no_answer' }))
    return r
  }
}
const NO_SIRI_CHANGE = Symbol('no change')

/** `space.siri` — this Space's alias, and collecting what was said to it. */
class SpaceSiri {
  constructor(space) { this._space = space }
  _wb() { const wb = this._space._wb; if (!wb) throw sdkError('witbitz: this Space has no client behind it — open it through a Witbitz instance', 'no_client'); return wb }
  /** Enable Siri for this Space: the word you will say ("groceries"), optionally the default for anything said
   *  without an alias. Mints the Shortcut key on the first enable and an inbox keypair for this Space, pushes the
   *  account's record to the Sentinel. → `{ key, endpoint, alias }` — the key is what the Shortcut sends. */
  _assistantRoom() {
    const sp = this._space, wb = this._wb()
    if (wb._siriLane) return wb._siriLane(sp.room)
    if (sp._memoryOwner !== wb._archiveGeneration) throw sdkError('Reopen this Space in the current account', 'account_changed')
    const open = [...(wb._archiveHandles || [])].find(x => !x._stopped && !x._detachedLane && x._sharedRoom === sp.room && x._archiveGeneration === wb._archiveGeneration && x._archiveEmail === (wb._session?.email || '') && x._archiveMaster === (wb.backup._s?.master || null))
    if (open) return open.room
    const backupOwner = wb._siriBackupOwners?.get(wb.backup._s) || wb.backup._s?.email
    if (backupOwner && backupOwner !== wb._session?.email) return null
    return wb.account.rooms.find(r => !r.detachedLane && r.shared === sp.room)?.room
  }
  async enable({ alias, label = '', makeDefault = false, includeAssistant = false } = {}) {
    const wb = this._wb(), sp = this._space
    if (sp.temporary) throw sdkError('Temporary Spaces cannot receive Siri captures', 'temporary_room')
    const requested = normSiriAlias(alias)
    if (alias !== undefined && !requested) throw sdkError('witbitz: an alias is needed — the word you will say to Siri', 'invalid_argument')
    if (/[,:;]/.test(requested)) throw sdkError('witbitz: an alias cannot contain , : or ;', 'invalid_argument')
    return wb.siri._change(async (st) => { // kept only once the Sentinel took it (pass 9, K#5)
      const a = requested || st.rooms[sp.room]?.alias || uniqueAlias(label || sp.title || 'Space', new Set(Object.values(st.rooms).map(r => r.alias)))
      for (const [rm, r] of Object.entries(st.rooms)) if (rm !== sp.room && r.alias === a) throw sdkError(`witbitz: "${a}" already names another Space`, 'invalid_argument')
      if (!st.token) st.token = newSiriKey()
      const cur = st.rooms[sp.room]
      if (cur) st.rooms[sp.room] = { ...cur, alias: a, label: label || cur.label, at: Date.now() } // the newer copy wins a merge (sync sweep 2026-11-15 #7)
      else { const kp = await genRecipientKey(); st.rooms[sp.room] = { alias: a, label: String(label || ''), pub: { x: kp.publicJwk.x, y: kp.publicJwk.y }, priv: kp.privateJwk, at: Date.now() } }
      const lane = includeAssistant && this._assistantRoom()
      if (lane && !st.rooms[lane]) {
        const taken = new Set(Object.values(st.rooms).map(r => r.alias))
        const assistantAlias = uniqueAlias(a.slice(0, 22) + ' assistant', taken), kp = await genRecipientKey()
        st.rooms[lane] = { alias: assistantAlias, label: (label || a) + ' · assistant', pub: { x: kp.publicJwk.x, y: kp.publicJwk.y }, priv: kp.privateJwk, at: Date.now() }
      }
      if (makeDefault) st.defaultRoom = sp.room; else if (st.defaultRoom === sp.room) st.defaultRoom = ''
      return { key: st.token, endpoint: SIRI_ENDPOINT, alias: a }
    })
  }
  /** Disable Siri for this Space (other Spaces keep theirs). A push that fails rejects and keeps it on, here as at the Sentinel. */
  async disable({ includeAssistant = false } = {}) {
    const wb = this._wb(), room = this._space.room
    const targets = [room, includeAssistant && this._assistantRoom()].filter(Boolean)
    const r = await wb.siri._change(st => {
      if (!targets.some(id => st.rooms[id])) return NO_SIRI_CHANGE
      for (const id of targets) delete st.rooms[id]
      if (targets.includes(st.defaultRoom)) st.defaultRoom = ''
      return true
    })
    return { disabled: r === true }
  }
  /** Collect: pull the account's drops, open the ones for THIS Space with its inbox key, post each as you (🎙-marked),
   *  ack them. → `{ delivered, elsewhere: [{ room, label, alias }] }` — `elsewhere` names other Spaces holding drops.
   *
   *  `deliver(text, meta)` takes the drop INSTEAD of posting it — for an app that files captures into its own inbox and
   *  does not want each one to start an assistant turn. It gets the words as spoken (no 🎙: that mark is for a room) and
   *  `meta = { id, room, alias, at }`, where `alias` is the word that was actually said and `at` is when Siri took it.
   *  Want it in the room as well? Call `space.send()` from inside your `deliver` — explicit beats a second flag.
   *  ★ AT-LEAST-ONCE. A `deliver` that throws or rejects is NOT acked, so a failed write never eats a capture; the cost
   *  is that a write which succeeds and whose ack then fails comes back. Dedupe on `meta.id`. */
  async collect({ deliver } = {}) {
    const wb = this._wb(), sp = this._space
    if (deliver !== undefined && typeof deliver !== 'function') throw sdkError('witbitz: collect({ deliver }) takes a function — deliver(text, meta)', 'invalid_argument')
    return collectSiriDrops({ post: wb._sentinelPost(), auth: wb._auth(), room: sp.room, send: async (t) => { const r = await sp.send(t); if (!r || !r.ok) throw sdkError('witbitz: the Space did not take the capture', 'not_sent') }, deliver: deliver || null, s: wb._siri }) // send never throws (offline → status 0, busy → ok:false): not sent is NOT acked, it is collected next time (sync sweep, 10-17 #3)
  }
}

