// spaces/public/sdkA2A.js — OUTSIDE AGENTS INTO A MEMBER'S PRIVATE LANE, over A2A (https://witbitz.chat/docs/sdk-agents.md#a2a): the device's half.
// The Sentinel (infra/cloud-computer/sentinel/a2a.mjs) is the door: TLS ends inside the enclave, a peer's words are sealed
// to the lane's INBOX public key and kept until a device collects them. This module is everything the device does:
//   • wb.a2a        — the ACCOUNT's record (which lanes take A2A, each peer's token HASH and reply rule, the lanes'
//                     inbox public keys), sealed to the attested Sentinel and pushed whole; its state is the app's to
//                     persist (it holds the lanes' inbox PRIVATE keys), exactly like wb.siri.
//   • lane.a2a      — this lane: enable / addPeer (the token is shown ONCE, only its hash leaves) / setReply / removePeer
//                     / disable, and collect(): open each waiting message with the lane's inbox key and post it into the
//                     lane, where the lane's assistant drafts an answer. The member approves it (reply 'ask', the
//                     default) or it goes back on its own (reply 'auto') — the owner's D2: configurable per peer.
// A peer's text is someone else's words: it lands as a message the assistant READS, with a one-turn instruction to treat
// it as information and not as instructions; nothing crosses to the shared room except through the usual proposals.
import { attestStandingSentinel } from './connections.js'
import { rosterParticipants, isSoloVerified } from './rosterCount.js'
import { isKeptSpace, assertNotKept } from './sdkCloudDevice.js'

export async function assertAgentTarget(space) {
  if (space._sharedRoom) return
  const session = space._wb && space._wb._session, generation = space._wb?._archiveGeneration
  const cfg = await space._client.getConfig(space.room, space._mk, { plainMark: true })
  if (!session || !session.email || !cfg || cfg.admission !== 'email' || !cfg.allow) throw fail('solo_verified_required', 'outside agents need a private lane or a solo verified Space')
  if (!(await isSoloVerified(cfg, space.room, session.email))) throw fail('solo_verified_required', 'outside agents need a verified Space with only you in it')
  const book = await space._client.state(space.room, space._mk, 'roster')
  if (!book || book.status !== 200 || await rosterParticipants(cfg, space.room, { seen: book.seen || book.state?.seen }) !== 1) throw fail('solo_verified_required', 'outside agents need a solo verified Space')
  if (space._wb._archiveGeneration !== generation || space._wb._session?.email !== session?.email) throw fail('account_changed', 'the account changed while checking the Space')
}
import { readAllPages } from './ledgerView.js'
import { sealTo as sealToEnclave } from './sealShare.js'
// The rules — the record, letting a peer in, the Sentinel calls, opening a collected message — are a2aCore.js, which the
// Spaces app's a2aLane.js shares. This module is the SDK's classes and storage around them.
import { A2A_COLLECT_WINDOW_MS, finishedTask, A2A_ENDPOINT, a2aTokenHash, cardUrlOf, mcpUrlOf, normA2A, mergeA2ARecords, peersOf, applyRemovals, removalIntents, pruneGoneIn, enableLaneIn, addPeerIn, setPeerReplyIn, removePeerIn, disableLaneIn, clearLanesIn, recordFor, sentinelCalls, openItem, a2aMessage, a2aInstructions, isJobPeer } from './a2aCore.js'
import { isLaneCopy } from './roomName.js' // a lane's copy of its shared room's line is never a draft
import { A2A_PENDING_DOC, A2A_PEERS_DOC, peersFromDoc, pendingFromDoc, withoutShared } from './a2aShared.js'
/** The Sentinel's answer for a task that already has its reply (infra/cloud-computer/sentinel/a2a.mjs). */
export { finishedTask } // a2aCore.js — one test for the app and the SDK
export { A2A_ENDPOINT, a2aTokenHash }
/** Persisted state → its checked form (a2aCore.normA2A — the app's rules: room, handle and key shapes, ≤ 32 lanes and peers). */
export const a2aStateOf = normA2A
const fail = (code, msg, details = {}) => Object.assign(new Error('witbitz: ' + msg), { code, ...details })
/** The pending tasks as a snapshot carries them (JSON-safe, bounded): a lane's snapshot() / resume (sync sweep 10-24 #17). */
export const pendingOf = (xs) => (Array.isArray(xs) ? xs : []).filter((p) => p && typeof p.taskId === 'string' && p.taskId && p.peer && typeof p.peer === 'object').slice(-50)
  .map((p) => ({ taskId: p.taskId, n: Number(p.n) || 0, peer: { id: String(p.peer.id || ''), name: String(p.peer.name || '').slice(0, 80), reply: p.peer.reply === 'auto' ? 'auto' : 'ask', ...(p.peer.job ? { job: true } : {}) },
    text: String(p.text || '').slice(0, 4000), at: Number(p.at) || 0, cursor: Math.max(0, Number(p.cursor) || 0), ...(typeof p.draft === 'string' ? { draft: p.draft } : {}) }))

/** `wb.a2a` — the account's A2A record. */
export class A2AAccount {
  /** @param wb the Witbitz client; `deps` lets a test replace the Sentinel path ({ post, auth, attest, seal }). */
  constructor(wb, { endpoint = A2A_ENDPOINT, state = null, deps = null } = {}) {
    this._wb = wb; this._endpoint = String(endpoint).replace(/\/+$/, ''); this.restore(state); this._deps = deps
    /** Called with the new state whenever it changes — persist it (it holds the lanes' inbox private keys). */
    this.onState = null
  }
  get state() { return JSON.parse(JSON.stringify({ ...this._s, ...(this._removals.length ? { pendingRemovals: this._removals } : {}) })) }
  restore(state) {
    this._s = a2aStateOf(state)
    this._removals = Array.isArray(state?.pendingRemovals) ? state.pendingRemovals.filter(x => Array.isArray(x) && x.length === 3 && x.every(v => typeof v === 'string') && this._s.lanes[x[0]]?.handle === x[1]).map(x => [...x]) : []
    return this
  }
  get endpoint() { const c = this._wb && this._wb._client; return c && c.vault ? A2A_ENDPOINT : this._endpoint } // in a vault the vault's door answers (it is built with the default; sync sweep backlog P7) — never the page's own setting
  _d() {
    const wb = this._wb
    if (this._deps) return this._deps
    return { post: wb._sentinelPost(), auth: wb._auth(), attest: (o) => attestStandingSentinel({ ...o, pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow }), seal: sealToEnclave }
  }
  async _account() { const s = this._wb._session; if (!s || !s.email) throw fail('sign_in_required', 'A2A belongs to an account — sign in first (' + (this._wb && this._wb.vault ? 'wb.vault.signIn' : 'wb.signIn') + ')'); return this._wb._account() } // the app-scoped account on a builder's page (accountScope.js)
  _dropMoved(removed = []) {
    for (const lane of this._wb._agentHandles || []) for (const item of removed) {
      if (item.source !== lane.room) continue
      lane._a2a?._dropDrafts(item.id)
      if (lane._a2aResume) lane._a2aResume = lane._a2aResume.filter(task => task.peer?.id !== item.id)
    }
  }
  async _disconnectConnection(id, binding) {
    const removed = []
    await this._change(record => {
      for (const [source, lane] of Object.entries(record.lanes)) {
        for (const peer of [...lane.peers]) {
          const bound = binding?.peerId === peer.id && binding?.peerRoom === source
          if (!isJobPeer(peer) || (peer.connectionId ? peer.connectionId !== id : !bound)) continue
          removePeerIn(record, source, peer.id)
          removed.push({ source, id: peer.id })
        }
      }
      return removed.length || NO_CHANGE
    })
    this._dropMoved(removed)
    return removed
  }
  async stopJobAgent(name) {
    if (typeof name !== 'string' || !name.trim()) throw fail('invalid_argument', 'Choose a named job agent')
    const removed = []
    await this._change(s => {
      for (const [source, lane] of Object.entries(s.lanes)) for (const peer of [...lane.peers]) {
        if (peer.name === name.trim() && isJobPeer(peer)) { removePeerIn(s, source, peer.id); removed.push({ source, id: peer.id }) }
      }
      return removed.length || NO_CHANGE
    })
    this._dropMoved(removed)
    return { removed }
  }
  _dropAllDrafts() {
    for (const lane of this._wb._agentHandles || []) { lane._a2aResume = null; lane._a2aReceipts = []; lane._a2a?._posted.clear(); lane._a2a?._dropDrafts() }
  }
  _resetAccount() {
    this._dropAllDrafts()
    clearTimeout(this._pruneRetry)
    this._pruneRetry = null
    this._s = a2aStateOf(null); this._removals = []
  }
  _pruneForgotten() {
    const wb = this._wb, generation = wb._archiveGeneration, state = wb.backup?._s
    if (!wb._session || !state || this._pruneRun) return
    const rooms = new Map((state.rooms || []).map(r => [r.room, Number(r.at) || 0]))
    const gone = new Set((state.tomb || []).filter(t => !rooms.has(t.room) || Number(t.at) >= rooms.get(t.room)).map(t => t.room))
    if (!Object.keys(this._s.lanes).some(room => gone.has(room))) return
    this._pruneRun = this._change(next => pruneGoneIn(next, room => gone.has(room)) || NO_CHANGE).then(() => {
      clearTimeout(this._pruneRetry)
    }, () => {
      if (generation !== wb._archiveGeneration || wb.backup?._s !== state) return
      clearTimeout(this._pruneRetry)
      this._pruneRetry = setTimeout(() => this._pruneForgotten(), 30000)
      this._pruneRetry.unref?.()
    }).finally(() => { this._pruneRun = null })
  }
  _changed() { if (typeof this.onState === 'function') { try { this.onState(this.state) } catch { /* the app's callback */ } } }
  _calls() {
    const { post, auth, attest, seal } = this._d()
    return sentinelCalls({ post, auth, attest, seal, err: (kind, m, reply) => fail(kind === 'refused' ? 'sentinel_refused' : 'sentinel_unreachable', m, { definiteRefusal: kind === 'refused' && !!reply && (reply.ok === false || !!reply.error) && !(reply.status >= 500) && !['sentinel_unavailable', 'unreachable', 'timeout', 'busy'].includes(reply.error) }) })
  }
  _sealed(mode, obj) { return this._calls().sealed(mode, obj) }
  _plain(mode, extra = {}) { return this._calls().plain(mode, extra) }
  /** Send the whole record (it REPLACES what the Sentinel held) — this account's, or `s`, a changed copy (_change). */
  async _push(s = this._s, expectedGeneration = this._wb._archiveGeneration) {
    const account = await this._account()
    if (this._wb._archiveGeneration !== expectedGeneration) throw fail('account_changed', 'the account changed while sharing its agent record')
    const candidate = this._removals.length ? structuredClone(s) : s
    if (this._removals.length) applyRemovals(candidate, this._removals)
    const r = await this._sealed('a2agrant', { ...recordFor(candidate, account), preserveIntake: true })
    if (s === this._s) this._changed()
    return r
  }
  // ⛔ A CHANGE IS KEPT ONLY ONCE THE SENTINEL TOOK IT (state machines pass 9, K#5): the record was changed in place and pushed
  //   after — a push that failed left this device believing an agent removed (or a lane closed) while the Sentinel still let it
  //   in, and a retry found nothing to remove and pushed nothing: the token stayed valid. `disable` had already dropped the lane's
  //   inbox private key while its door stayed open. Now `fn` changes a COPY, the copy is pushed, and only then is it the state.
  //   One change at a time (each starts from the last one's result: two at once lost one). A restore() that landed while the
  //   push was out (a vault applying the account's kept copy) is merged with the change, not overwritten (a2aCore.js rules).
  //   `fn` returns NO_CHANGE when there is nothing to do (nothing pushed).
  _change(fn) {
    const generation = this._wb._archiveGeneration, email = this._wb._session?.email
    const changed = () => generation !== this._wb._archiveGeneration || email !== this._wb._session?.email
    const run = async () => {
      if (changed()) throw fail('account_changed', 'the account changed before the agent update')
      const base = this._s, next = JSON.parse(JSON.stringify(base))
      const previous = this._removals.slice()
      const out = await fn(next)
      if (out === NO_CHANGE && !previous.length) return out
      applyRemovals(next, previous)
      const existing = new Set(previous.map(x => JSON.stringify(x)))
      const added = this._stageInbox ? [] : removalIntents(base, next).filter(x => !existing.has(JSON.stringify(x)))
      if (changed()) throw fail('account_changed', 'the account changed during the agent update')
      if (added.length) { this._removals.push(...added); this._changed() }
      const finish = await this._stageInbox?.(next)
      try { await this._push(next, generation) } catch (e) { if (!changed() && (e.definiteRefusal || (e.status >= 400 && e.status < 500))) { finish?.(false); if (added.length) { this._removals = previous; this._changed() } } throw e }
      if (changed()) throw fail('account_changed', 'the account changed during the agent update')
      finish?.(true)
      this._removals = []
      this._s = this._s === base ? a2aStateOf(next) : mergeA2ARecords(next, this._s)
      this._changed()
      return out
    }
    const p = (this._q || Promise.resolve()).then(run, run)
    this._q = p.catch(() => {})
    return p
  }
  /** What the Sentinel holds for this account (lanes, peers by name, open tasks). */
  status() { return this._plain('a2astatus') }
  /** Turn A2A off everywhere for this account: every lane's card and every token stop working. Each inbox is marked switched
   *  off, so no other device's copy of the account's record switches one back on (pass 9, K#3). */
  async revoke() { const generation = this._wb._archiveGeneration; const r = await this._plain('a2arevoke'); if (this._wb._archiveGeneration !== generation) throw fail('account_changed', 'the account changed during revocation'); this._s = a2aStateOf(clearLanesIn(this._s)); this._removals = []; this._dropAllDrafts(); this._changed(); return r }
}
const deliveryKey = (taskId, n, at) => JSON.stringify([taskId, Number(n) || 1, Number(at) || 0])
const NO_CHANGE = Symbol('no change')

/** `lane.a2a` — this lane's door for outside agents. */
export class LaneA2A {
  constructor(lane) {
    this._lane = lane
    // [{ taskId, peer, text, at, cursor, draft? }] — waiting for the assistant's draft, or for the member, oldest first. It rides
    // the lane's snapshot(): a message is acked as it is posted, so a reload that lost these left the agent's task "working"
    // for ever (sync sweep 10-24 #17). Resumed: watched again, and a draft that already came is offered again.
    this._pending = pendingOf(lane._a2aResume)
    this._posted = new Set([...(lane._a2aReceipts || []), ...this._pending.map((p) => deliveryKey(p.taskId, p.n, p.at))]) // posted in this lane already (an ack that failed must not repost it)
    this._ambiguous = new Map()
    this._sendingDrafts = new Set()
    this._seenDrafts = new WeakSet()
    this._sub = null
    this._held = [] // drafts for the member while nobody listens for 'a2a' — given to the first listener (Lane.on; sync sweep 10-26 #8)
    if (this._pending.length) {
      this._listen()
      Promise.resolve().then(() => { for (const t of this._pending.slice()) if (t.draft !== undefined) this._offer(t) })
    }
  }
  _acct() { const wb = this._lane._wb; if (!wb || !wb.a2a) throw fail('no_client', 'this lane has no Witbitz client behind it — open it through a Witbitz instance'); return wb.a2a }
  _cfg() { return this._acct()._s.lanes[this._lane.room] || null }
  /** The lane's public Agent Card URL (null until enabled) — hand it, with a token, to the agents you choose. */
  get cardUrl() { const c = this._cfg(); return c ? cardUrlOf(this._acct()._endpoint, c.handle) : null }
  /** The lane's MCP address (null until enabled) — the same door for an agent that speaks MCP instead of A2A (Claude Code,
   *  Grok, Cursor…): tools message_member / get_reply, the SAME per-peer token (portal/docs/outside-agents.md). */
  get mcpUrl() { const c = this._cfg(); return c ? mcpUrlOf(this._acct()._endpoint, c.handle) : null }
  /** The peers that may reach this lane: [{ id, name, reply }] — never a token. */
  get peers() { return peersOf(this._acct()._s, this._lane.room) }
  /** Let outside agents reach this lane. `name`/`description` are what its public card says. → { cardUrl } */
  async enable({ name = '', description = '' } = {}) {
    const a = this._acct(), room = this._lane.room
    await assertAgentTarget(this._lane)
    await a._change((s) => enableLaneIn(s, room, { name, description })) // kept only once the Sentinel took it (pass 9, K#5)
    return { cardUrl: this.cardUrl, mcpUrl: this.mcpUrl }
  }
  /** Issue a token to one outside agent. `reply`: 'ask' (default — you approve every answer) or 'auto' (the lane's
   *  assistant answers it on its own). `job: true`: an agent that TAKES JOBS — it reports and its run ends, reading no reply,
   *  so its messages are told to the member and a follow-up is a new job (docs/sdk-agents.md). → { id, token, cardUrl } — the
   *  token is shown ONCE; only its hash is kept. */
  async addPeer(name, { reply = 'ask', job = false, reconnect = false, previousPeerId, connectionId } = {}) {
    if (reply === 'auto') await assertNotKept(this._lane)
    await assertAgentTarget(this._lane)
    const a = this._acct()
    const moved = [], room = this._lane.room
    const { id, token } = await a._change(async s => {
      if (previousPeerId && !s.lanes[room]?.peers.some(peer => peer.id === previousPeerId)) throw fail('not_found', 'The previous peer is not on this lane.')
      if (reconnect || previousPeerId) {
        for (const [source, lane] of Object.entries(s.lanes)) for (const peer of [...lane.peers]) {
          if ((reconnect && peer.name === String(name).trim()) || (source === room && previousPeerId && peer.id === previousPeerId)) { removePeerIn(s, source, peer.id); moved.push({ source, id: peer.id }) }
        }
        if (!s.lanes[room]) await enableLaneIn(s, room, { name: 'Private assistant' })
      }
      return addPeerIn(s, room, name, { reply, job: job === true, connectionId }, (code, m) => fail(code, code === 'not_enabled' ? 'enable A2A on this lane first (lane.a2a.enable())' : m))
    })
    a._dropMoved(moved)
    for (const previous of moved) {
      const old = previous.source === room ? this._lane : [...(this._lane._wb._agentHandles || []), ...(this._lane._wb._archiveHandles || [])].find(sp => sp.room === previous.source)
      if (old?._a2a) { old._a2a._dropDrafts(previous.id); await old._a2a._syncRoomPeer(previous.id).catch(() => {}) }
    }
    try { await this._syncRoomPeer(id) } catch (error) {
      if (reconnect || previousPeerId) return { id, token, ...(moved.length ? { moved } : {}), cardUrl: this.cardUrl, mcpUrl: this.mcpUrl, roomListPending: true }
      await a._change((s) => removePeerIn(s, this._lane.room, id) || NO_CHANGE)
      throw error
    }
    return { id, token, ...(moved.length ? { moved } : {}), cardUrl: this.cardUrl, mcpUrl: this.mcpUrl }
  }
  /** Change whether this peer's answers wait for you ('ask') or go on their own ('auto'). */
  async setReply(peerId, reply) {
    await assertNotKept(this._lane)
    const a = this._acct()
    const r = await a._change((s) => setPeerReplyIn(s, this._lane.room, peerId, reply, fail))
    await this._syncRoomPeer(peerId)
    return { id: peerId, reply: r }
  }
  /** Revoke one agent's token; its unanswered messages are dropped. */
  async removePeer(peerId) {
    const a = this._acct(); if (!this._cfg()) return { removed: false }
    const r = await a._change((s) => removePeerIn(s, this._lane.room, peerId) || NO_CHANGE) // a failed push rejects and keeps the agent: a retry pushes (K#5)
    this._dropDrafts(peerId)
    await this._syncRoomPeer(peerId)
    return { removed: r === true }
  }
  async _syncRoomPeer(id) {
    const sp = this._lane
    if (sp._sharedRoom) return
    const session = sp._wb._session, generation = sp._wb._archiveGeneration
    await assertAgentTarget(sp)
    for (let i = 0; i < 5; i++) {
      const doc = await sp._client.state(sp.room, sp._mk, A2A_PEERS_DOC)
      if (sp._wb._archiveGeneration !== generation || sp._wb._session?.email !== session?.email) throw fail('account_changed', 'the account changed while saving the peer')
      if (!doc || doc.status !== 200) throw fail('unreadable', 'the room peer list could not be read')
      const peers = peersFromDoc(doc).filter((p) => p.id !== id)
      const peer = this.peers.find((p) => p.id === id)
      if (peer) peers.push(peer)
      const r = await sp._client.state(sp.room, sp._mk, A2A_PEERS_DOC, { peers }, `${peers.length} outside agents may write here`, 'you', doc.v || 0)
      if (r?.status === 200) return
      if (r?.status !== 409) throw fail('save_failed', 'the room peer list could not be saved')
    }
    throw fail('version_conflict', 'the room peer list kept changing')
  }
  /** Close this lane to outside agents: its card and every token stop working. */
  async disable() { const a = this._acct(); const r = await a._change((s) => disableLaneIn(s, this._lane.room) || NO_CHANGE); this._dropDrafts(); return { disabled: r === true } }

  async _sharedDrafts() {
    const space = this._lane, session = space._wb._session, generation = space._wb._archiveGeneration
    if (space._sharedRoom) throw fail('solo_verified_required', 'shared drafts belong to a solo verified Space')
    await assertAgentTarget(space)
    const doc = await space._client.state(space.room, space._mk, A2A_PENDING_DOC)
    if (space._wb._archiveGeneration !== generation || space._wb._session?.email !== session?.email) throw fail('account_changed', 'the account changed while reading shared drafts')
    if (doc?.status !== 200 || !Number.isInteger(doc.v)) throw fail('unreadable', 'shared drafts could not be read')
    return { items: pendingFromDoc(doc), version: doc.v }
  }
  /** Replies drafted on another device, including the cloud device. */
  async sharedDrafts() { return (await this._sharedDrafts()).items }
  async reviewDraft(draft, text, options = {}) {
    const space = this._lane, session = space._wb._session, generation = space._wb._archiveGeneration
    const matches = (p) => p.taskId === draft?.taskId && p.at === draft.at && p.peerId === draft.peerId && p.draft === draft.draft && p.text === draft.text
    let doc = await this._sharedDrafts()
    const current = doc.items.find(matches)
    if (!current) throw fail('draft_changed', 'refresh the shared drafts before reviewing this reply')
    const result = await this.reply(current.taskId, options.reject ? '' : (text ?? current.draft), options)
    for (let attempt = 0; attempt < 5; attempt++) {
      if (space._wb._archiveGeneration !== generation || space._wb._session?.email !== session?.email) throw fail('account_changed', 'the account changed during draft review')
      if (!doc.items.some(matches)) return result
      const items = withoutShared(doc.items, current.taskId)
      const saved = await space._client.state(space.room, space._mk, A2A_PENDING_DOC, { items }, `${items.length} outside-agent replies wait for review`, 'you', doc.version)
      if (saved?.status === 200) return result
      if (saved?.status !== 409) throw fail('save_failed', 'the reply was sent but its shared draft could not be cleared')
      doc = await this._sharedDrafts()
    }
    throw fail('version_conflict', 'the reply was sent but shared drafts kept changing')
  }

  /** Collect: open every waiting message for this lane and post it into the lane; its assistant drafts an answer. For an
   *  'ask' peer the draft arrives as an `a2a` event on the lane — { taskId, peer, text, draft, approve(text?), askBack(text),
   *  decline() }; for an 'auto' peer it is sent back on its own. → { delivered }. At-least-once: a message posted but not
   *  acked comes back, so `taskId` + its order is the dedupe key. */
  _dropDrafts(peerId) {
    const keep = t => peerId && t.peer.id !== peerId
    this._pending = this._pending.filter(keep)
    this._held = this._held.filter(keep)
  }
  async _sendOnce(key, msg, opts) {
    const lane = this._lane
    if (this._ambiguous.has(key)) {
      const { offset: cursor } = this._ambiguous.get(key)
      const result = await readAllPages(since => lane._client.poll(lane.room, lane._mk, undefined, since || cursor))
      if (result.incomplete) return false
      if (result.entries.some(e => e.text === msg.text && (e.from || e.name) === msg.from)) { this._ambiguous.delete(key); return true }
      this._ambiguous.delete(key)
    }
    const cursor = { offset: lane._count || 0, draft: lane.messages?.length || 0 }
    let sent
    try { sent = await lane.send(msg.text, opts) } catch (err) { this._ambiguous.set(key, cursor); throw err }
    if (sent?.ok === true && !sent.pending) return true
    if (sent?.status === 0 || sent?.pending) this._ambiguous.set(key, cursor)
    return false
  }
  collect() {
    for (const t of this._pending) if (t.peer.reply === 'auto' && t.draft !== undefined) this._offer(t)
    if (!this._collecting) this._collecting = this._collectInbox().finally(() => { this._collecting = null })
    return this._collecting
  }
  async _collectInbox() {
    // The cloud device takes intake drops. Only fallback boxes sealed to this inbox are returned by a2apull.
    if (await isKeptSpace(this._lane) && !this._lane._wb?.a2a?._s?.lanes?.[this._lane.room]) return { delivered: 0 }
    await assertAgentTarget(this._lane)
    const a = this._acct(), c = this._cfg(), lane = this._lane
    if (!c) return { delivered: 0 }
    const t0 = Date.now()
    const r = await a._plain('a2apull', { handle: c.handle })
    const items = Array.isArray(r.items) ? r.items : []
    this._listen()
    let delivered = 0, more = false
    for (const it of items) {
      if (Date.now() - t0 > A2A_COLLECT_WINDOW_MS) { more = true; break } // its lease runs out before it is posted and acked: the next collect (pass 9, K#9)
      const opened = await openItem(c, it); if (!opened) continue // not for this lane's key: leave it for a device that can
      const { m, peer } = opened
      const msg = a2aMessage(peer, m.text)
      // POSTED ONCE, ACKED ONLY WHEN IT LANDED (sync sweep 2026-11-23 #3 + its unclear P1): lane.send never throws — busy, refused or
      // closed resolve ok:false — and acking that lost the message; an ack that threw reposted it at the next collect
      const key = deliveryKey(it.taskId, it.n, m.at)
      const cursor = this._ambiguous.get(key)?.draft ?? (lane.messages || []).length
      if (!this._posted.has(key)) {
        const sent = await this._sendOnce(key, msg, {
          from: msg.from, mode: 'always',
          instructions: a2aInstructions(peer),
          _peerPost: true, // the agent's name is not the member's (sweep 10-24 #13)
        })
        if (!sent) continue // not in the lane: left un-acked, the next collect delivers it
        this._posted.add(key); if (this._posted.size > 512) this._posted.delete(this._posted.values().next().value)
        if (!isJobPeer(peer)) this._registerDraft({ taskId: m.taskId, peer, text: m.text, at: m.at, n: it.n, cursor }) // a job agent reads no answer: nothing to draft (sweep 10-25 #5)
      }
      await a._plain('a2aack', { items: [{ taskId: it.taskId, n: it.n }] })
      delivered++
    }
    return { delivered, ...(more ? { more } : {}) }
  }
  /** Answer a task yourself (or after editing a draft). `ask: true` asks the peer something back; `reject: true` declines. */
  async reply(taskId, text, { ask = false, reject = false } = {}) {
    const a = this._acct()
    let r
    try { r = await a._sealed('a2areply', { account: await a._account(), taskId: String(taskId), text: String(text || ''), ask: !!ask, reject: !!reject }) } catch (e) {
      // a task already answered (a resumed 'auto' task taken mid-send was re-sent on every resume, an error each time —
      // sync sweep backlog): it is done, not failed — dropped, never offered again
      if (!finishedTask(e)) throw e
      r = { state: 'completed' }
    }
    this._pending = this._pending.filter((p) => p.taskId !== taskId)
    return { state: r.state }
  }

  // The lane's assistant answers after each posted message: the first agent message after a pending task's cursor is
  // its draft (oldest task first). 'auto' → sent; 'ask' → an `a2a` event for the member.
  _registerDraft(task) {
    this._pending.push(task)
    const messages = this._lane.messages || []
    for (let i = task.cursor; i < messages.length && task.draft === undefined; i++) this._matchDraft(messages[i], i)
  }
  _matchDraft(m, idx) {
      if (!m || m.self !== true || isLaneCopy(m)) return // the lane's assistant, never the shared room's mirrored in (sweep 10-24 #16)
      if (!String(m.text || '').trim()) return // an empty line is no draft, as in the app (a2aLane.js) — an 'auto' peer was sent '' (sweep 10-26 #9)
      if (this._seenDrafts.has(m)) return
      const t = this._pending.find((p) => p.draft === undefined && idx >= p.cursor)
      if (!t) return
      this._seenDrafts.add(m)
      t.draft = String(m.text || '')
      this._offer(t)
  }
  _listen() {
    if (this._lane._wb) (this._lane._wb._agentHandles ||= new Set()).add(this._lane)
    if (this._sub) return
    this._sub = (m) => this._matchDraft(m, (this._lane.messages || []).lastIndexOf(m))
    this._lane.on('message', this._sub)
  }
  /** The drafts held while nobody listened, to the listener that came (Lane.on). */
  _flushHeld() { const h = this._held.splice(0); for (const t of h) if (this._pending.includes(t)) this._offer(t) }
  /** A task's draft: 'auto' → sent; 'ask' → an `a2a` event for the member. */
  _offer(t) {
    if (this._lane._wb?.a2a?._draftsSuspended) { if (!this._held.includes(t)) this._held.push(t); return }
    if (t.peer.reply === 'auto' && this.peers.some(peer => peer.id === t.peer.id && peer.reply === 'auto')) {
      if (this._sendingDrafts.has(t.taskId)) return
      this._sendingDrafts.add(t.taskId)
      this.reply(t.taskId, t.draft, { autoPeerId: t.peer.id }).then(result => {
        if (result?.held && this._pending.includes(t)) { t.peer.reply = 'ask'; this._offer(t) }
      }).catch(e => this._lane._emit('error', e)).finally(() => this._sendingDrafts.delete(t.taskId))
      return
    }
    if (!((this._lane._subs && this._lane._subs.a2a) || []).length) { if (!this._held.includes(t)) this._held.push(t); return } // nobody listens yet: kept for the first
    this._lane._emit('a2a', {
      taskId: t.taskId, peer: { id: t.peer.id, name: t.peer.name }, text: t.text, draft: t.draft,
      approve: (text) => this.reply(t.taskId, text === undefined ? t.draft : text),
      askBack: (text) => this.reply(t.taskId, text, { ask: true }),
      decline: () => this.reply(t.taskId, '', { reject: true }),
    })
  }
}

/** `lane.a2a` IN A VAULT (docs/sdk-vault-mode.md § The account). The vault keeps the A2A state — the lanes' inbox private
 *  keys, per account — and makes the Sentinel calls: enable, peers, the pull (it opens each message) and the ack. This
 *  page does what it does outside a vault: posts each opened message into the lane BEFORE the vault acks it, and runs the
 *  draft flow (the `a2a` event, approve / askBack / decline). `conn` is the vault connection (sdkVault.js). */
function readVaultA2AView(conn, room) {
  const slot = { epoch: conn.a2aEpoch, view: null }
  conn.a2aViews.set(room, slot)
  const discard = () => { if (conn.a2aViews.get(room) === slot) conn.a2aViews.delete(room) }
  conn.roomAccount(room, 'a2a', 'view').then(r => {
    if (!r || !('view' in r)) return discard()
    if (conn.a2aViews.get(room) === slot) slot.view = r.view
  }, discard)
}

export function refreshVaultA2AViews(conn, event) {
  if (conn.lastA2AChange === event) return
  conn.lastA2AChange = event
  conn.a2aEpoch = (conn.a2aEpoch || 0) + 1
  for (const room of conn.a2aViews?.keys() || []) readVaultA2AView(conn, room)
}

export class VaultLaneA2A extends LaneA2A {
  constructor(lane, conn) {
    super(lane)
    this._conn = conn
    conn.a2aViews ||= new Map()
    if (!conn.a2aViews.has(lane.room) || conn.a2aViews.get(lane.room).epoch !== conn.a2aEpoch) readVaultA2AView(conn, lane.room)
  }
  get _view() {
    const slot = this._conn.a2aViews.get(this._lane.room)
    return slot?.epoch === this._conn.a2aEpoch ? slot?.view : null
  }
  async _call(m, ...a) {
    const epoch = this._conn.a2aEpoch
    const r = await this._conn.roomAccount(this._lane.room, 'a2a', m, ...a)
    if (epoch === this._conn.a2aEpoch && r && 'view' in r) this._conn.a2aViews.set(this._lane.room, { epoch, view: r.view })
    return r ? r.result : r
  }
  get cardUrl() { const v = this._view; return v?.handle ? cardUrlOf(v.endpoint, v.handle) : null }
  get mcpUrl() { const v = this._view; return v?.handle ? mcpUrlOf(v.endpoint, v.handle) : null }
  get peers() { return (this._view?.peers || []).map(p => ({ ...p })) }
  async enable({ name = '', description = '' } = {}) {
    await this._call('enable', { name, description }); return { cardUrl: this.cardUrl, mcpUrl: this.mcpUrl }
  }
  // in a vault the token is shown on the VAULT's screen and never reaches this page (sync sweep 2026-11-14 #3): `token` is null, `shown` true
  async addPeer(name, { reply = 'ask', job = false, reconnect = false, previousPeerId, connectionId } = {}) { const r = await this._call('addPeer', name, { reply, job: job === true, ...(connectionId !== undefined ? { connectionId } : {}), ...(reconnect ? { reconnect: true } : {}), ...(previousPeerId ? { previousPeerId } : {}) }); const { cardUrl, mcpUrl } = this; this._acct()._dropMoved(r.moved); if (r.moved?.length) refreshVaultA2AViews(this._conn, r); return { id: r.id, token: r.token || null, shown: !!r.shown, ...(r.roomListPending ? { roomListPending: true } : {}), cardUrl, mcpUrl } }
  async setReply(peerId, reply) { return this._call('setReply', peerId, reply) }
  async removePeer(peerId) { const result = await this._call('removePeer', peerId); this._dropDrafts(peerId); return result }
  async disable() { const result = await this._call('disable'); this._dropDrafts(); return result }
  sharedDrafts() { return this._call('sharedDrafts') }
  reviewDraft(draft, text, options = {}) { return this._call('reviewDraft', draft, text, options) }
  async _collectInbox() {
    const lane = this._lane
    const t0 = Date.now()
    const items = await this._call('pull')
    if (!Array.isArray(items)) return { delivered: 0 }
    this._listen()
    let delivered = 0, more = false
    for (const { taskId, n, m, peer } of items) {
      if (Date.now() - t0 > A2A_COLLECT_WINDOW_MS) { more = true; break } // as above: the vault's pull leased them (pass 9, K#9)
      const msg = a2aMessage(peer, m.text)
      const key = deliveryKey(taskId, n, m.at)
      const cursor = this._ambiguous.get(key)?.draft ?? (lane.messages || []).length
      if (!this._posted.has(key)) { // as above (sync sweep 2026-11-23 #3): acked only once it landed, posted once
        const sent = await this._sendOnce(key, msg, { from: msg.from, mode: 'always', instructions: a2aInstructions(peer), _peerPost: true })
        if (!sent) continue
        this._posted.add(key); if (this._posted.size > 512) this._posted.delete(this._posted.values().next().value)
        if (!isJobPeer(peer)) this._registerDraft({ taskId: m.taskId, peer, text: m.text, at: m.at, n, cursor }) // a job agent reads no answer: nothing to draft (sweep 10-25 #5)
      }
      await this._call('ack', { taskId, n })
      delivered++
    }
    return { delivered, ...(more ? { more } : {}) }
  }
  async reply(taskId, text, { ask = false, reject = false, autoPeerId } = {}) {
    let r
    try { r = await this._call('reply', String(taskId), String(text || ''), { ask: !!ask, reject: !!reject, ...(autoPeerId ? { autoPeerId } : {}) }) } catch (e) { if (!finishedTask(e)) throw e; r = { state: 'completed' } } // already answered: done (see above)
    if (r?.held) return r
    this._pending = this._pending.filter((p) => p.taskId !== taskId)
    return { state: r && r.state }
  }
}
