// witbitz-sdk.d.ts — types for https://witbitz-spaces.pages.dev/witbitz-sdk.js (written from the SDK's code, 2026-10-05).
// Held to the code by spaces/test/sdkTypesDrift.test.mjs: every public method here exists, and every public method there is here.
// Builder (server) calls: witbitz-admin.d.ts.
// Use it from TypeScript or for editor hints in plain JS:
//   // @ts-check
//   /** @typedef {import('./witbitz-sdk').Message} Message */   (after saving this file beside your code)
// Prose, examples and the rules behind each field: https://witbitz.chat/docs/sdk.md

export type Tier = 'standard' | 'enclave'
export type ReplyMode = 'auto' | 'always' | 'ondemand'
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Every error the SDK throws or emits carries a `code` (sdk.md § Error codes). */
export interface WitbitzError extends Error { code?: string; [k: string]: unknown }

export interface Media { b64?: string; bytes?: Uint8Array | ArrayBuffer; mime: string; name?: string }

// ─── Messages ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** What `space.on('message', cb)` delivers and `space.messages` holds: the room's decrypted ledger entry, with `from`
 *  copied from `name` when absent. Fields are optional because each kind carries its own. */
export interface Message {
  id: string
  ts: number
  /** text | media (has images/files) | mcp (an app→agent call) | data (a store write) | fork (the room moved). */
  kind: 'text' | 'media' | 'mcp' | 'data' | 'fork' | string
  /** The sender's display name (the `from` they posted with; the agent's name on its replies; 'system' on system lines). */
  from: string
  name: string
  text: string
  /** Set by the SERVER on the room's own AGENT output only (its replies, its data writes). Never "I sent this". */
  self?: true
  /** A system line (a config change, a connection call). */
  sys?: true
  /** The sender passed the room's email gate: `user` is their @username, `spk` their device signing key. */
  verified?: true
  user?: string
  /** The signing key the server verified this message against (a public JWK). Each device has its own: compare
   *  `m.spk.x` and `m.spk.y` with your session's `sign.pub`, never the objects with `===`. */
  spk?: { kty: string; crv: string; x: string; y: string }
  /** Carried here when the room MOVED (a move an older client made — `space.fork` is retired): the room it was first written in and the marks the server gave it
   *  there. `carriedBy` is the verified email of the member who moved the room. Both are the server's stamps. */
  carried?: Carried
  carriedBy?: string
  md?: true
  images?: Media[]
  files?: Media[]
  widgets?: unknown[]
  replyTo?: { key: string; name?: string; excerpt?: string }
  /** Where an entry came from when it was not written here: 'shared' (copied in through the mirror), 'fork', … A lane's
   *  copy of its shared room's line also has an `sh:` id — test with `isLaneCopy(m)`: a fork's or a recreated room's own
   *  history is copied in with `source: 'shared'` too, and is that room's own. */
  source?: string
  /** A lane's copy only: who wrote the original, as its Space verified them — `user` their @username (show `@` + it in place of an
   *  email `from`, as the Spaces app does), `email`, and `room` + `sid` (the Space and the writer's key row, e.g. for a photo). */
  by?: { user?: string; email?: string; room?: string; sid?: string }
  /** A lane's copy only: the original's franking record and its Space — a report of the copy names the ORIGINAL message. */
  fr?: string
  frRoom?: string
  /** Reactions on this message: emoji → the names that reacted (in a verified room, `reactKeys` maps each name to its key). */
  reactions?: Record<string, string[]>
  /** Agent replies: web sources, the turn's usage, and (confidential rooms) the signed turn certificate. */
  sources?: { url: string; title?: string }[]
  usage?: Record<string, unknown>
  cert?: Record<string, unknown>
  certDoc?: string
  /** A dictated message: the speech-to-text certificate. */
  voice?: { model?: string; cert: Record<string, unknown> }
  /** kind 'data': the row operations. */
  ops?: unknown[]
  /** A lane's crossing into the shared room. */
  via?: 'bridge'
  draft?: { by: string }
  stopped?: true
  timedOut?: true
  [k: string]: unknown
}

/** An entry's marks from the room it was first written in (`Message.carried`, a row's `_carried`). */
export interface Carried { from: string; verified?: true; user?: string; email?: string }

export interface DataEvent { ops: unknown[]; from: string; self: boolean; text: string; ts: number }
export interface PartialEvent { text: string | null; step: { phase?: 'thinking' | 'writing' | 'deciding'; tool?: string; since?: number } | null }

// ─── Proposals ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A card the agent parked for a human: an action (any tool not in `immediateTools`, e.g. data_put) or, in a lane,
 *  a message to cross into the shared room. */
export interface Proposal {
  id: string
  kind: 'action' | 'message'
  /** The tool name, e.g. 'data_put', or your lane action's name; 'cross_to_shared' for a crossing. */
  action: string
  /** The WHOLE parked action, including `type` (= action). Your lane action's `run()` receives this same object. */
  args: { type: string; [k: string]: unknown }
  text: string
  approve(opts?: DecideOptions): Promise<DecideResult>
  deny(opts?: { from?: string }): Promise<DecideResult>
}
export interface DecideOptions { from?: string; recordResult?: boolean }
/** `continued: true`: the call the server ran left its result in the room and the assistant was asked to go on from it — its reply arrives on 'message'. */
export interface DecideResult { status: number; result?: unknown; continued?: true; [k: string]: unknown }
/** 'resolved': `result` is your lane action's run() return value (propose mode), or the server's execution of a room action. */
export interface ResolvedEvent { id: string; approved: boolean; action: string; result?: unknown }

// ─── Agents and actions ───────────────────────────────────────────────────────────────────────────────────────────────
/** 'builder': the assistant is prompted with YOUR instructions and tools only — no Spaces framing (sdk-assistant.md#builder-mode). */
export type Framing = 'builder'
/** `showPrompt: true` on a send: what the model was sent, exactly. */
export interface SentPrompt { system: string; user: string; model: string; tools: { name: string; description?: string; inputSchema?: unknown }[] }
/** An app's own tool for the assistant (sdk-assistant.md#tools). The platform tools reach every room without being named;
 *  a bare name in `tools` is ignored by the server. */
export interface ToolDef { name: string; description?: string; inputSchema?: Record<string, unknown>; readOnly?: boolean; autoRun?: boolean }
export interface AgentSpec { name?: string; instructions?: string; tools?: ToolDef[]; model?: string | ModelPick }
/** A model choice — the shape the code reads and the server takes (sdk-assistant.md#model-effort): a catalog id from `wb.models()` or a wire name, and optionally its effort. */
export interface ModelPick { catalog?: string; wire?: string; params?: { reasoning_effort?: Effort } }
export interface LaneAction {
  name: string
  description?: string
  input?: Record<string, unknown>
  /** 'propose' (default): a card; on approve the SDK calls run(args) on this device and reports its return as `result`.
   *  'await': runs during the turn; the return value goes back to the agent (≤ 25 s). */
  mode?: 'propose' | 'await'
  run(args: { type: string; [k: string]: unknown }): unknown | Promise<unknown>
}
/** The email gate a room is created with (createSpace / privateLane / plan / changeMembers). `admins` and `owners` are plain email
 *  arrays — an object here was silently dropped (an earlier version of this type said `{ emails }`). */
export interface Admission {
  emails?: string[]
  domains?: string[]
  /** true: every address is readable to members; an array: just those (each must be in `emails`). Else room-salted hashes. */
  advertise?: boolean | string[]
  /** Admins and owners, by email; each must also be admitted by the gate. */
  admins?: string[]
  owners?: string[]
}
/** What `space.admission()` reads back from the room's sealed config. */
export interface AdmissionInfo {
  gated: boolean
  /** The ADVERTISED entries; `hidden` counts those stored only as a room-salted hash (check one with `space.admits`). */
  emails?: string[]
  domains?: string[]
  hidden?: number
  admins?: string[]
  owners?: string[]
  /** This room is a member's private lane (not a Space). */
  lane?: true
  /** This Space gives every member a private lane (`createSpace({ lanes: true })`, the app's option). */
  lanes?: true
}

// ─── Space ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A room's name (sdk-rooms.md#room-name): the newest rename or generated name in the room's log, else its shared title doc. */
export interface RoomTitle { title: string; manual: boolean; by: string }
export interface SpaceEvents {
  /** The room's name changed: a member renamed it (`manual`), or a name was generated. */
  title: RoomTitle
  message: Message
  data: DataEvent
  partial: PartialEvent
  proposal: Proposal
  proposals: Proposal[]
  resolved: ResolvedEvent
  /** A message you already have changed in place (a reaction, an image caption, a reply's cards); `messages` holds `message`. */
  update: { id: string; message: Message; fields: string[] }
  /** Poll errors (the loop keeps going). `code`: no_key, bad_mkseal, enclave_warming, not_found, cannot_open, unavailable, http_<n>, … — after
   *  `not_authorized` (`reason` not_on_list) or `gate_unreadable` it reads once a minute (sdk.md). */
  error: WitbitzError
  /** An older client moved the room to a new key (a fork notice): open `link` to follow. */
  moved: { room: string; link: string; from: string; at: number }
  moveRefused: { from: string; room?: string; at: number; reason: string; code?: string }
  /** The room's key changed IN PLACE (a member change or a rotation, sdk-people.md#members) and this Space took the new one: same room,
   *  `link` carries the new key (null in a vault). */
  rekeyed: { room: string; epoch: number; link?: string | null }
  /** The room was re-keyed and this account is no longer on its list: nothing written from now on reaches this Space. */
  removed: { room: string }
  /** On the room's list, but no new key this device can open: `reason` 'pending' (no invite key for this app at the change),
   *  'no_invite_key' (this device holds none — restore `wb.invite.state`), … Ask a member for the link again. */
  pending: { room: string; reason?: string }
  /** Safe media was turned on or off for everyone (`from`: who did; sdk-rooms.md#safe-media). On a private lane it fires when
   *  its Space's setting moves, with `via: 'space'` (a lane follows its Space). */
  safeMedia: { on: boolean; from: string; ts: number; via?: 'space' }
  /** A safe copy of a photo or a PDF arrived: `for` names its message (`id`) and attachment (`at`, `i`). Read it with `space.safeMedia.copy`. */
  safeCopy: { for: { id: string; at: 'images' | 'files'; i: number } }
}
export interface LaneEvents extends SpaceEvents {
  /** An outside agent's message, drafted by the lane's assistant, waiting for the member (sdk-agents.md#a2a). */
  a2a: { taskId: string; peer: { id: string; name: string }; text: string; draft: string; approve(text?: string): Promise<unknown>; askBack(text: string): Promise<unknown>; decline(): Promise<unknown> }
}
/** The tools Witbitz gives every assistant. `cross_to_shared` exists only in a private lane (it posts to the lane's
 *  shared Space, after the member approves); `connection_call` only in a room with an API-key connection. Not a closed
 *  list: the deployment may add more. */
export type PlatformTool = 'web_search' | 'fetch_url' | 'read_url' | 'read_file' | 'write_pdf' | 'write_document' | 'write_spreadsheet' | 'look_at_image' | 'show_photo' | 'show_chart' | 'show_diagram' | 'search_places' | 'show_places' | 'add_place' | 'connection_call' | 'cross_to_shared' | (string & {})
/** Which platform tools the room's assistant gets: `true` / absent = all (the default), `false` = none, a list = only
 *  those. Fewer tools = fewer tokens on every model call; your own `tools`, client actions and `data` are not affected. */
export type PlatformTools = boolean | PlatformTool[]
export interface WriteResult { ok: true; id: string; ops: unknown[] }
/** What one turn's model calls used (sdk-assistant.md#turn-usage). `costMicros` is the provider's figure in millionths of a dollar;
 *  `source` 'provider-partial' | 'none' = some calls reported no cost, and the total counts only the priced ones. */
export interface TurnUsage { tokensIn: number; tokensOut: number; tokensCached: number; costMicros: number; costUsd: number; calls: number; models: string[]; source: 'provider' | 'provider-partial' | 'none'; estimated?: true; funded?: true }
export interface SendResult { /** 0 when the request got no answer (network, enclave unreachable) — such a send MAY have been posted: read the room before resending */ status: number; /** always present: false for any refusal, busy or failure; true when posted, silent or pending */ ok: boolean; /** when !ok: 'busy', 'not_authorized' (with `reason`: not_on_list, grant_required, …), 'gate_unreadable', 'policy_invalid', 'bad_mkseal', 'enclave_warming', 'user_token_required', 'run_needs_payer', 'reply_not_stored', 'unavailable' / 'enclave_unavailable' (status 0), 'enclave_policy_unknown' (503, retryable: nothing was sent — the enclave could not be checked yet), 'answer_unsealed' (502: a sealed request's answer came back unsealed — not from the enclave), 'answer_unopenable' (its sealed answer did not open), 'store_unavailable' (503: the server could not save just now — retry), 'envelope_op_refused' / 'envelope_stale' / 'envelope_replay' / 'bad_envelope' (400: the enclave refused a sealed request; nothing ran), 'aborted' (space.turn()'s abort/timeout while held for busy — not stored), … — sdk-reference.md#errors */ error?: string; reason?: string; /** status 0: what failed */ detail?: string; pending?: true; reply?: string; silent?: true; proposed?: unknown[]; /** absent on a pending turn — read it from space.turn()'s result, or the reply message's `usage` */ usage?: TurnUsage; /** with `showPrompt: true` and a turn that finished inside the request */ prompt?: SentPrompt; [k: string]: unknown }
export interface SendOptions {
  from?: string; mode?: ReplyMode; instructions?: string; images?: Media[]; files?: Media[]
  /** The turn's cancel key (8–64 of A–Z a–z 0–9). `space.turn()` sets one so `t.abort()` can stop the turn — use that. */
  stopKey?: string
  /** Answer with `prompt`: the exact system text, user text, model and tools this turn sent (sdk-assistant.md#builder-mode). */
  showPrompt?: boolean
  /** The message this one answers — it is quoted beside it, as in the app (sdk-rooms.md#replies). */
  replyTo?: Message
  /** Tools the page offers the assistant for THIS question (sdk-assistant.md#page-tools) — the shape a Lane's actions take. */
  tools?: LaneAction[]
}
export interface Snapshot { count: number; etag: string; messages: Message[]; /** Safe media: the copies kept beside their photos (never messages) */ safeCopies?: unknown[]; rows: unknown; title?: (RoomTitle & { ts: number | null }) | null; /** a lane's outside-agent tasks waiting for a draft or the member (resume offers them again) */ a2a?: Array<{ taskId: string; peer: { id: string; name: string; reply: 'ask' | 'auto'; job?: true }; text: string; at: number; cursor: number; draft?: string }>; [k: string]: unknown }
/** What on() returns: call it to remove the listener (it returns the space). It also chains `.on()` / `.off()`. */
export interface Unsubscribe<S> { (): S; on: S extends { on: infer F } ? F : never; off: S extends { off: infer F } ? F : never }

export type TurnStatus = 'running' | 'done' | 'silent' | 'failed' | 'aborted' | 'timeout'
export interface RunResult { ok: boolean; text?: string; output?: unknown; usage?: TurnUsage; prompt?: Record<string, unknown>; error?: string; detail?: string; /** rate_limited: seconds to wait */ retryAfter?: number }
export interface TurnResult { status: Exclude<TurnStatus, 'running'>; reply: Message | null; text: string; proposed: unknown[]; usage?: TurnUsage; error?: string; /** with a failed turn: the server's sentence for the person, when it gave one (e.g. not_authorized's `not_on_list`) */ reason?: string }
/** `space.turn(text)` — one turn's answer (sdk-assistant.md#turn). */
export interface Turn {
  readonly status: TurnStatus
  /** The reply as streamed so far. */
  readonly text: string
  /** send()'s result once the server answered, else null. */
  readonly result: SendResult | null
  /** Resolves when the turn settles. Never rejects. */
  readonly finished: Promise<TurnResult>
  on(event: 'partial', cb: (e: PartialEvent) => void): () => void
  on(event: 'done', cb: (e: TurnResult) => void): () => void
  /** Stop the reply (op:'stop'); false when it had already settled. */
  abort(): Promise<boolean>
}

/** `space.connections` — what THIS Space's assistant may spend. */
export interface SpaceConnections {
  /** An MCP connection brings its tools: `tools` (names) to choose them, else the recommended set; `auto` (names) run without asking. */
  grant(conn: Connection | { id: string; callKey: string; host?: string; label?: string; account?: string; mcp?: boolean }, opts?: { from?: string; tools?: string[]; auto?: string[] }): Promise<unknown>
  revoke(id: string, opts?: { from?: string }): Promise<unknown>
}
/** `space.siri` — this Space's Siri alias and its drops. */
export interface SpaceSiri {
  enable(opts: { alias: string; label?: string; makeDefault?: boolean }): Promise<{ key: string; endpoint: string; alias: string }>
  disable(): Promise<unknown>
  /** `deliver(text, meta)` takes each drop instead of posting it. At-least-once: dedupe on `meta.id`. */
  collect(opts?: { deliver?: (text: string, meta: { id: string; room: string; alias: string; at: number }) => unknown }): Promise<{ delivered: number; more?: boolean; elsewhere: Array<{ room: string; label?: string; alias?: string }>; /** captures this device could not open — left in the inbox for a device that can (not deleted) */ unopened?: number }>
}

/** Which attachment of a message: `at` 'images' | 'files' (default: its first image, else its first file), `i` (default 0). */
export interface SafeRef { at?: 'images' | 'files'; i?: number }
/** A safe copy, VERIFIED on this device: JPEGs the tools enclave made, every byte checked against its attestation. */
export interface SafeCopy { ok: true; versions: Array<{ w: number; h: number; b64: string }>; statement: string; att: string }
/** `space.safeMedia` — SAFE MEDIA (sdk-rooms.md#safe-media): others' photos and PDFs shown only from copies an attested enclave made safe. */
export interface SpaceSafeMedia {
  /** The setting as this handle knows it; null until `refresh()`, a send with a photo, or a line that changed it. */
  readonly on: boolean | null
  /** False while this release names no accepted safe-media enclave (nothing would verify). */
  readonly available: boolean
  /** Read the room's sealed settings. */
  refresh(): Promise<boolean>
  /** Turn it on or off for everyone — the room's admins where it names some, any member otherwise; a line says who did. On a private lane: rejects with `lane_follows_space` (a lane follows its Space). */
  set(on: boolean, opts?: { from?: string }): Promise<{ changed: string[] }>
  /** The first copy of that attachment that verifies here, or `{ ok: false, why }`. Draw `versions`, never the original. */
  copy(message: Message, ref?: SafeRef): Promise<SafeCopy | { ok: false; why: string }>
  /** Does the original (`space.attachment(…).b64`) hash to the file `copy` was made from? Check before opening it. */
  isOriginal(copy: SafeCopy, b64: string): Promise<boolean>
  /** Make the copy for everyone (a signed-in session; counted to the account). send() does this by itself while the setting is on. */
  make(message: Message, ref?: SafeRef, opts?: { from?: string }): Promise<{ ok: boolean; error?: string }>
}

export interface PlanResult {
  how: 'none' | 'in_place' | 'new_room' | 'refused'
  /** kept (in place) · carried (a move carries it by default) · not_carried (a new room) */
  history: 'kept' | 'carried' | 'not_carried' | null
  /** The call that makes the change, e.g. "space.configure(…)". */
  call: string | null
  steps: string[]
  reason?: string
  /** With `how: 'refused'`: the error code the change itself would give — e.g. `not_admin`, `sign_in_required`,
   *  `governed_room`, `use_change_members`, `lane`, `lane_follows_space`, `unknown_field` (sdk-reference.md#errors). */
  code?: string
}

export declare class Space {
  readonly room: string
  readonly shareLink: string
  /** The room key (base64url). Treat it as a secret: it IS the admission. null over a keyless client. */
  readonly key: string | null
  /** True for a temporary room (createSpace({ temporary })): wiped when idle, never in the account backup. */
  readonly temporary: boolean
  /** True when the room gives every member a private assistant (createSpace({ lanes: true }), or a link that says so). */
  readonly lanes: boolean
  readonly messages: Message[]
  /** The room's name — the same on every device and in the Spaces app; null while it has none. 'title' fires when it changes. */
  readonly title: string | null
  readonly connections: SpaceConnections
  readonly siri: SpaceSiri
  /** Safe media in this Space: the setting, verified safe copies of photos and PDFs, making one. */
  readonly safeMedia: SpaceSafeMedia
  /** What logs and serialisers see: the room, never the key or the link. */
  toJSON(): { room: string; shareLink: '[REDACTED]'; messages: number; lane?: true; sharedRoom?: string | null }
  /** Resolves once the room's whole history has been read (every page of a long room); rejects only with code `cannot_open` or `closed`. */
  readonly ready: Promise<this>
  readonly data: {
    /** Each row: its fields plus `id`, `_updated`, `_by`, `_v`, and `_verified` / `_email` / `_user` when a gated member
     *  wrote it (`_carried` / `_carriedBy` when it came with a moved room — see {@link Carried}). */
    rows(collection: string): Array<Record<string, unknown> & { id: string; _updated: number; _by: string; _v: string | null; _verified?: true; _email?: string; _user?: string }>
    get(collection: string, id: string): Record<string, unknown> | null
    /** A refused write throws (`code` = the server's error); a conflicting conditional write throws `row_changed`. */
    put(collection: string, row: Record<string, unknown>, opts?: { id?: string; from?: string; ifVersion?: string | null }): Promise<WriteResult>
    delete(collection: string, id: string, opts?: { from?: string; ifVersion?: string }): Promise<WriteResult>
    batch(ops: unknown[], opts?: { from?: string }): Promise<WriteResult>
  }
  /** `{ replay: false }` on 'message': only what arrives after the room's history was read. */
  on<E extends keyof SpaceEvents>(event: E, cb: (e: SpaceEvents[E]) => void, opts?: { replay?: boolean }): Unsubscribe<this>
  /** No `cb`: every listener for the event. */
  off<E extends keyof SpaceEvents>(event: E, cb?: (e: SpaceEvents[E]) => void): this
  send(text: string, opts?: SendOptions): Promise<SendResult>
  /** An emoji on a message, or `{ off: true }` to take yours off (sdk-rooms.md#replies). No new entry, no assistant turn. */
  react(message: Message, emoji: string, opts?: { off?: boolean; from?: string }): Promise<{ ok: boolean; reactions?: Record<string, string[]>; error?: string }>
  /** send(), plus a handle on this turn's answer. `timeoutMs` (default 960 000, about 16 minutes — as long as the Spaces app waits; a turn may run 13) stops the turn when it passes; 0 = no timeout. */
  turn(text: string, opts?: SendOptions & { timeoutMs?: number }): Turn
  /** The assistant as a function (sdk-assistant.md#run): one answer, nothing written to the room. `schema`: `{ field: type }` or a
   *  JSON Schema object → `output` fits it, or `error: 'no_structured_output'`. Must finish within ~30 s (`too_slow`). */
  run(input: string, opts?: { instructions?: string; schema?: Record<string, unknown>; images?: Media[]; from?: string; showPrompt?: boolean }): Promise<RunResult>
  /** Rename the room for every member and device (they are notified). Throws `not_admin` in a room with owners or admins
   *  for anyone else, and `direct_chat` in a direct chat (it is called by the other person's name); in an email-gated room
   *  `not_authorized` with `e.reason` `not_on_list` / `unsigned`. `unavailable` when the room did not answer or failed (nothing stored — try again). `ok` false: an older server took it into the shared doc only. */
  rename(name: string, opts?: { by?: string }): Promise<{ ok: boolean; title: string }>
  setReplyMode(mode: ReplyMode): Promise<{ mode: ReplyMode }>
  replyMode(): Promise<ReplyMode>
  /** Which of the assistant's tools run on their own here, and which ask first (a card a person approves). Enforced by the server
   *  on every turn; the same setting as the Witbitz app's ⋯ → Tools. In a room with admins only an admin may set them. */
  readonly toolRules: {
    get(): Promise<{ tools: Array<{ name: string; about: string; default: 'auto' | 'ask'; now: 'auto' | 'ask'; rule?: 'auto' | 'ask' }>; rules: Record<string, 'auto' | 'ask'> }>
    /** 'auto' — runs on its own; 'ask' — asks first; null — back to the tool's default. */
    set(name: string, mode: 'auto' | 'ask' | null): Promise<{ rules: Record<string, 'auto' | 'ask'> }>
  }
  /** Poll now; the proposals waiting for a decision. */
  pending(): Promise<Proposal[]>
  approve(id: string, opts?: DecideOptions): Promise<DecideResult>
  deny(id: string, opts?: { from?: string }): Promise<DecideResult>
  /** Change the assistant or the store in place. Refuses, before sending: `create_time` (tools, immediateTools, tier, key),
   *  `use_fork` (admission — change it with changeMembers; `lane` on a lane), `unknown_field` (anything else) — sdk-reference.md#errors. */
  configure(opts: { agent?: Omit<AgentSpec, 'tools'>; data?: Record<string, unknown> | null; platformTools?: PlatformTools; framing?: Framing | null; dataWrites?: boolean | null; /** Private assistants for everyone, on or off in place (members' existing private rooms stay as their own Spaces). */ lanes?: boolean; /** Safe media on/off for everyone (sdk-rooms.md#safe-media) */ safeMedia?: boolean; from?: string }): Promise<{ changed: string[] }>
  /** What a change would require — in place or a new room — and whether the history comes along. Changes nothing.
   *  On a lane, `safeMedia` is refused with `lane_follows_space` (set it on the Space). */
  plan(change: { agent?: AgentSpec; data?: Record<string, unknown> | null; history?: 'full' | 'forward'; platformTools?: PlatformTools; framing?: Framing | null; dataWrites?: boolean | null; lanes?: boolean; safeMedia?: boolean; admission?: Admission; tier?: Tier; key?: 'split'; tools?: ToolDef[]; immediateTools?: string[] }): Promise<PlanResult>
  /** A private assistant lane for the current member (sdk-agents.md#lanes). On a Lane: rejects with `lane_of_lane` (ask from its Space). */
  privateLane(opts: { agent?: AgentSpec; actions?: LaneAction[]; tools?: ToolDef[]; immediateTools?: string[]; model?: AgentSpec['model']; data?: Record<string, unknown>; platformTools?: PlatformTools; framing?: Framing; dataWrites?: boolean; admission?: Admission; tier?: Tier; mirror?: boolean | { data?: boolean } }): Promise<Lane>
  /** Change who is in IN PLACE (sdk-people.md#members): the same room, link, history and lanes; a new key that only the people still on
   *  the list receive. `admission` is the list stated in full. Needs a signed-in owner or admin. In a vault the person confirms
   *  there and `link` is absent. Refuses `not_admin`, `sign_in_required`, `no_invite_key`, `changed_meanwhile`, `lane`, `store_unavailable` (503: not saved — retry). */
  /** `roles: true`: only owners/admins changed — the room kept its key (nobody's access changed). */
  changeMembers(admission: Admission): Promise<MemberChange & { removed: string[]; added: string[]; roles?: true }>
  /** The same members, a new key (a lost phone, a link sent to the wrong place) — sdk-people.md#members. */
  rotateKey(): Promise<MemberChange & { rotated: true }>
  /** RETIRED (3.0.0): a Space no longer moves — members change in place (`changeMembers`). Always throws `use_change_members`. */
  fork(opts?: unknown): Promise<never>
  /** A direct chat's other person, from its sealed allow-list; null when this is not a direct chat you are in (sdk-people.md#direct-chats). */
  directPeer(): Promise<{ email: string } | { username: string; handle?: string } | null>
  admission(): Promise<AdmissionInfo>
  admits(email: string): Promise<boolean>
  isAdmin(email: string): Promise<boolean>
  isOwner(email: string): Promise<boolean>
  attachment(att: Media | Record<string, unknown>): Promise<Media>
  /** The newest message carrying a file or image of this name (case-insensitive) — the assistant links files by name. Bytes: attachment(att). */
  fileNamed(name: string): { message: Message; att: Media } | null
  /** Did this signed-in session send it? (verified with this session's key; never by a typed name). In a vault: the vault's session. */
  isMine(message: Message): boolean
  /** Who wrote it, as Block knows a person (the server's stamps and the signing key; never a typed name) — null: nothing proves it (sdk-people.md#block). */
  blockIdentity(message: Message): BlockWho | null
  /** Report it to Witbitz (App Store rule 1.2; sdk-people.md#report): the message, and with `context: true` the 5 before it. Signed in, a member.
   *  Throws `invalid_argument`, `sign_in_required`; in a vault `vault_unsupported`. Refusals are answers (`not_member`, `sign_in`, `budget`). */
  report(message: Message, opts: { reason: ReportReason; note?: string; context?: boolean }): Promise<{ ok: true; id: string; /** Witbitz's own record of the message matched — the report can be acted on alone */ proven: boolean } | { ok: false; error: string; detail?: string }>
  static readonly REPORT_REASONS: readonly ReportReason[]
  /** Does this Space take only a page proved to be one named app (an attested app)? From its public policy; a failed read throws `policy_unreadable`. In a vault: `vault_unsupported`. */
  attested(): Promise<{ required: boolean; confidential: boolean }>
  sealedProof(): Promise<Record<string, unknown> | null>
  /** Confidential rooms: verify every reply's turn certificate on this device. */
  certificates(): Promise<{ verified: number; failed: Array<{ id: string; reason: string }>; unchecked: number; before: number; /** a private lane's copies of its Space's replies: not signed by the lane's enclave, so counted here and never in `failed` */ copies: number; builds: Array<{ pcr16: string; pcr17: string; audit: string; replies: number; /** the build enclave's release: rebuilt from `commit`, entry `logIndex` in Rekor (`rekor` links it); null = not in the published log; absent = the log could not be read */ source?: { commit: string; logIndex: number; rekor: string } | null }>; calls: Record<string, number>; tools: Record<string, number> }>
  snapshot(): Snapshot
  close(): void
}

/** `lane.link(other)` — two of a member's assistants that ask each other (sdk-agents.md#lane-links). */
export interface LaneLink {
  readonly a: Lane
  readonly b: Lane
  /** How many lanes a request may cross before it is answered where it is. */
  readonly cap: number
  /** The progress to persist (JSON-safe) — hand it back as `link(other, { resume })` after a reload. */
  readonly state: { cursorA: number | null; cursorB: number | null; sentA: string[]; sentB: string[] }
  /** End the link: neither assistant is offered the other any more. */
  unlink(): void
  /** Forward what is waiting now (it also runs on every new message). */
  run(): Promise<{ forwarded: number }>
}
/** `lane.a2a` — outside agents into this lane (sdk-agents.md#a2a). */
export interface LaneA2A {
  readonly cardUrl: string | null
  /** The same door over MCP (tools message_member / get_reply), with the same per-peer token. */
  readonly mcpUrl: string | null
  readonly peers: Array<{ id: string; name: string; reply: 'ask' | 'auto'; job?: true; [k: string]: unknown }>
  enable(opts: { name: string; description?: string }): Promise<{ cardUrl: string; mcpUrl: string }>
  /** `job: true` — an agent that takes jobs: it reports and its run ends, reading no reply; its reports are told to the member and a follow-up goes as a new job. */
  /** In a vault (`Witbitz.inVault`) the token is shown on the vault's own screen and never reaches the page: `token` is null and `shown` true. */
  addPeer(name: string, opts?: { reply?: 'ask' | 'auto'; job?: boolean }): Promise<{ id: string; token: string | null; shown?: boolean; cardUrl: string; mcpUrl: string }>
  setReply(peerId: string, reply: 'ask' | 'auto'): Promise<{ id: string; reply: 'ask' | 'auto' }>
  removePeer(peerId: string): Promise<{ removed: boolean }>
  disable(): Promise<{ disabled: boolean }>
  collect(): Promise<{ delivered: number; more?: boolean }> // more: it stopped 45 s after the pull — collect again (state machines pass 9, K#9)
  reply(taskId: string, text: string, opts?: { ask?: boolean; reject?: boolean }): Promise<unknown>
}

export declare class Lane extends Space {
  readonly a2a: LaneA2A
  on<E extends keyof LaneEvents>(event: E, cb: (e: LaneEvents[E]) => void, opts?: { replay?: boolean }): Unsubscribe<this>
  setActions(actions: LaneAction[]): this
  setLinks(links: Array<Space | { space: Space; label?: string }>): this
  send(text: string, opts?: SendOptions & { replace?: boolean; links?: Array<Space | { space: Space; label?: string }> }): Promise<SendResult>
  turn(text: string, opts?: SendOptions & { tools?: LaneAction[]; replace?: boolean; links?: Array<Space | { space: Space; label?: string }>; timeoutMs?: number }): Turn
  /** Synchronous: returns the link's handle. */
  link(other: Lane, opts?: { to?: string; as?: string; cap?: number; resume?: LaneLink['state'] }): LaneLink
  /** Copy the shared room's new messages into this lane now (a lane opened with `mirror`). */
  mirrorNow(): Promise<unknown>
}

// ─── The client ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** `sign`: this device's signing keypair (JWKs) — the key a verified room stamps on its messages as `spk`. */
export interface Session { email: string; idToken: string; exp: number; sign?: { pub: { kty: string; crv: string; x: string; y: string }; priv: Record<string, unknown> } }
export interface WitbitzOptions {
  endpoint?: string
  /** The origin a shareLink opens in: links read `<viewer>/space?room=<id>#mk=<key>`. */
  viewer?: string
  app?: string
  /** Your tenant's PUBLIC id (t_…). Needed to CREATE rooms from your own origin (declared with admin.origins). */
  tenant?: string
  /** Server only — prefer WitbitzAdmin (witbitz-admin.js). A page that passes one logs a warning. */
  tenantKey?: string
  tenantEndpoint?: string
  session?: Session
  userToken?: string | (() => string | Promise<string>)
  live?: boolean
  appShare?: string
  enclaveClaim?: string
  backup?: unknown
  /** Device storage protection's Storage (localStorage by default), its config key, and the passkey's site (this host by default). */
  protect?: ProtectOptions | Protect
  /** @deprecated `attest: { app }` is retired in 4.0.0 (a web page cannot prove which app it is): it throws `attest_app_retired`. */
  attest?: never
  /** The home region new rooms are made in — a code like `'us'` (docs: multi-region). Default: the default region. A private lane always takes its shared room's. */
  region?: string
  /** Which enclave build a confidential room's key may be sealed to: 'published' (default — any build Witbitz publishes) or
   *  'mine' — the person's own list of accepted builds, as the Witbitz app does (`wb.builds`). `{ mode, state }` hands back a
   *  persisted list for a page without an account. */
  builds?: 'published' | 'mine' | { mode?: 'published' | 'mine'; state?: BuildsState }
  deviceName?: string
  vaultApi?: string
  siri?: unknown
  a2a?: unknown
  a2aEndpoint?: string
  /** A persisted `wb.invite.state` (sdk-people.md#members). */
  invite?: unknown
  loginBase?: string
  /** The standing Sentinel that keeps connections' keys. `follow` (2.2.3): `'published'` (default) accepts a new build Witbitz
   *  publishes at /sentinel-claim.json; `'ask'` calls `onNewBuild(pcr0)` and accepts on `true`; `'off'` keeps the pins. Your own
   *  `pins` (a tenant running its own Sentinel) are never followed. */
  sentinel?: { pins?: string[], follow?: 'published' | 'ask' | 'off', onNewBuild?: (pcr0: string) => boolean | Promise<boolean>, claimUrl?: string, verify?: Function }
  fetchImpl?: typeof fetch
  WebSocketImpl?: unknown
  /** Advanced: a client whose ops take no room key (`keyless: true`) — the keys live where it sends the ops.
   *  {@link Witbitz.inVault} plugs one in for you. */
  client?: object
}

/** A vault's lock, as the person set it (a vault started with `lock: true`): `on` — a passkey at every launch; `protect` — its storage encrypted until unlocked. */
export interface VaultLock { available: true; on: boolean; protect: boolean }
/** A vault's notifications on this device, as the person set them (a vault started with `push: true`). */
export interface VaultPush { available: true; on: boolean }
/** A Space in the vault's list — never its link (the link carries the key). */
export interface VaultRoom { room: string; title: string; at: number; /** a private lane: the room of its Space */ lane?: string; /** a confidential Space */ tier?: 'enclave'; /** every member gets a private assistant (sdk-agents.md#lanes-for-everyone) */ lanes?: true }
/** `wb.vault` — the vault this page runs in (docs: § Vault mode). The keys are there; this page never holds one. */
export declare class VaultSession {
  /** The vault's origin. */
  readonly origin: string
  /** What the vault said when the page connected. */
  readonly info: { v: number; tenant: string; endpoint: string; signedIn: boolean; email: string; /** the vault session key's PUBLIC id (what `space.isMine` compares) — '' when signed out; an older vault sends none */ keyId?: string; rooms: VaultRoom[]; /** the Siri Shortcut: never its key */ siri: { key: null; hasKey: boolean; endpoint: string }; /** the backup and account, as `wb.backup` / `wb.account` read them */ account: { enabled: boolean; format: string; /** 'account' (the Witbitz account service) | 'legacy' | null */ service: 'account' | 'legacy' | null; /** a restore and deleting the account need the emailed code as well */ gated: boolean; deviceId: string; rooms: Array<{ room: string; kind: string; label?: string; /** a lane's Space: its room id */ shared?: string; archived?: boolean }>; devices: unknown[]; links: unknown[]; lastError: string | null; erasure: boolean }; /** only a vault started with `lock: true` says it: the lock (a passkey at every launch) and storage protection, as the person set them */ lock?: VaultLock; /** only a vault started with `push: true` says it: notifications on this device */ push?: VaultPush; /** the Space whose notification the person tapped to open the vault */ notifOpen?: string }
  /** The Spaces this vault holds, newest first. */
  rooms(): Promise<VaultRoom[]>
  /** A live Space for a room the vault holds; its key stays in the vault (`space.key` and `space.shareLink` are null). A private
   *  lane's room id (`rooms()` marks it with `lane`) gives a `Lane` of its Space — `lane_space_gone` once that Space is forgotten. */
  openRoom(room: string, opts?: { resume?: Snapshot }): Promise<Space | Lane>
  /** The vault shows its share screen with the invite link; the link never reaches this page. */
  share(space: Space | string, opts?: { title?: string }): Promise<{ shown: true }>
  /** The vault shows the Siri Shortcut's key in its own screen; the key never reaches this page. */
  showSiriKey(): Promise<{ shown: true }>
  /** The vault shows its LOCK SHEET: the person turns the lock and "Also protect this device's storage" on or off there; resolves
   *  with the outcome when they close it. Rejects `vault_unsupported` unless the vault was started with `lock: true`. */
  showLock(): Promise<VaultLock>
  /** The vault asks the person, in its own card, to turn notifications on (or off) on this device; resolves with the outcome. A
   *  tapped notification arrives as `on('notifOpen', ({ room }) => …)`. Rejects `vault_unsupported` unless the vault was started
   *  with `push: true`. */
  showNotifications(): Promise<VaultPush>
  /** The vault shows its sign-in screen; resolves once signed in. */
  signIn(opts?: { email?: string }): Promise<{ email: string }>
  /** The person confirms in the vault; rejects with code `cancelled` if they do not. */
  signOut(): Promise<{ signedIn: false }>
  whoami(): Promise<{ signedIn: boolean; email?: string; keyId?: string }>
  /** Remove a Space from this vault (its key is forgotten on this device). The person confirms in the vault; rejects
   *  with code `cancelled` if they do not. */
  forget(space: Space | string): Promise<{ forgotten: boolean }>
  on(event: 'rooms', cb: (e: { rooms: VaultRoom[] }) => void): () => void
  on(event: 'joined', cb: (e: { room: string }) => void): () => void
  on(event: 'signedIn', cb: (e: { email: string }) => void): () => void
  on(event: 'signedOut', cb: (e: object) => void): () => void
  /** This device was signed out of the account (or the account was deleted) from another device: the vault forgot the account, its
   *  sign-in and its Spaces here, and `info.signedIn` is false. `reason: 'erased'`: the account was deleted. */
  on(event: 'accountSignedOut', cb: (e: { reason?: 'erased' }) => void): () => void
  /** The vault's account view changed (the backup, the account index): what wb.backup / wb.account read. */
  on(event: 'account', cb: (e: { view: Record<string, unknown> }) => void): () => void
  /** A renewed session: its new key's public id (space.isMine). */
  on(event: 'session', cb: (e: { keyId: string }) => void): () => void
  /** The vault's lock changed (startVault({ lock: true })): whether this device can lock, whether it is on, whether stored data is sealed. */
  on(event: 'lock', cb: (e: { lock: { available: boolean, on: boolean, protect: boolean } }) => void): () => void
  /** The vault's notifications changed (startVault({ push: true })). */
  on(event: 'push', cb: (e: { push: { available: boolean, on: boolean } }) => void): () => void
  /** A notification was tapped: open this Space. */
  on(event: 'notifOpen', cb: (e: { room: string }) => void): () => void
}

/** `wb.protect` — device storage protection: what the app keeps on the device, sealed under a key a platform passkey
 *  derives (PRF or largeBlob), nowhere on disk. Off until enable(); seal/open/save/load pass values through while off. */
export interface ProtectState { on: boolean; locked: boolean; mode: 'prf' | 'largeblob' | null; auto: number }
/** Its Storage (localStorage by default), its config key, and the passkey's site (this page's host by default). */
export interface ProtectOptions { storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; storeKey?: string; rpId?: string; rpName?: string }
/** Usable before a client exists: `new Protect()` → unlock → load → `new Witbitz({ protect, session, backup })`. */
/** What `admin.customers.erase({ email })` needs from the user's devices (docs: § Erasing a user who has left). Every room
 *  the SDK creates carries a deletion commitment, every room it opens gets the account's membership mark, and the
 *  account's delete list is filed — sealed to Witbitz's attested enclave, for your tenant — automatically after a room is
 *  created or opened. Needs `new Witbitz({ tenant })`, a sign-in and `wb.backup` (the key every device of the account shares). */
export interface BuildEntry { kernel: string; payload?: string; policy?: string; at: number }
export interface BuildsState { builds: BuildEntry[]; auto?: { on: boolean; at: number } }
export interface BuildVerdict { ok: boolean; reason?: 'no_attestation' | 'no_platform_claim' | 'kernel' | 'payload' | 'policy' | 'unknown' | 'not_accepted'; live?: { kernel: string; payload?: string; policy?: string } }
/** `wb.builds` — which enclave build THIS PERSON accepts. In 'mine' mode a confidential room's key is sealed only to a build Witbitz
 *  publishes AND that is on their list: the first one is accepted on first use; with `automatic` on (the default) every published
 *  build is; off, a new one blocks their confidential rooms (`enclave_not_accepted`, `error.verdict`) until `accept(room)`. */
export interface Builds {
  readonly mode: 'published' | 'mine'
  /** JSON-safe — persist it for a page without an account; `onState` hands each change. */
  readonly state: BuildsState
  onState: ((state: BuildsState) => void) | null
  list(): BuildEntry[]
  /** Accept new Witbitz builds automatically? On unless the person turned it off. For the account (every device). */
  readonly automatic: boolean
  setAutomatic(on: boolean): Promise<boolean>
  /** Does this person accept the enclave serving `room`? null before it attested. In a vault it throws `vault_unsupported`:
   *  the vault meets the enclave and seals the keys, the page never does. */
  verdict(room: string): BuildVerdict | null
  /** Accept the build serving `room` (its region's enclave): `not_published` for a build Witbitz does not publish. */
  accept(room: string): Promise<BuildEntry[]>
  /** Read the account's list now (it is read by itself before the first seal). */
  sync(): Promise<BuildEntry[]>
}
export interface Erasure {
  /** True when this page can file: a tenant app, a live sign-in and an enabled backup. */
  readonly available: boolean
  /** File the list now (after a sign-in or a backup restore); an unchanged list is skipped unless `force`. */
  file(opts?: { force?: boolean }): Promise<{ filed: boolean; rooms?: number; skipped?: string }>
  /** Is a list filed for this account in this app, and how many rooms — never the secrets. */
  status(): Promise<{ ok?: boolean; filed: boolean; rooms?: number; updated?: number }>
  /** DELETE MY ACCOUNT, from your page — the Witbitz app's own: rooms only this person used are deleted, shared ones left; the
   *  username and directory entry, the filed list, the backup, the account index; then this client forgets the account.
   *  Needs a live sign-in and the backup. `names`: the display names they post under in your app. Rejects `vault_unsupported` in a vault.
   *  A backup with an email gate (`wb.backup.gated`) needs its emailed code FIRST, before anything is deleted: with the recovery
   *  `code` it mails one and rejects `email_code_required` (with `ticket`); call again with `{ code, ticket, emailCode }`.
   *  No `code`: `code_required`; a wrong emailed code: `email_code_wrong`. */
  deleteAccount(opts?: { onStep?: (text: string) => void; names?: string[]; code?: string; ticket?: string; emailCode?: string }): Promise<{ deleted: string[]; left: string[]; lapsing: string[]; failed: Array<{ room?: string; what?: string; why: string }>; account: { username?: boolean; directory?: boolean; backup?: boolean } }>
}
export declare class Protect {
  constructor(opts?: ProtectOptions)
  readonly state: ProtectState
  /** Can this browser hold a protection passkey (WebAuthn in a secure context)? */
  available(): boolean
  /** One passkey; everything already saved through save() is sealed in place. Refuses `backup_required` while wb.backup is
   *  off — a lost passkey loses what it sealed — unless `withoutBackup: true`. */
  enable(opts?: { label?: string; withoutBackup?: boolean }): Promise<ProtectState>
  /** A user-verified passkey assertion brings the key back. Throws `wrong_passkey` for one that opens nothing here. */
  unlock(): Promise<ProtectState>
  /** Drop the key from memory: loads refuse `locked` until unlock(). */
  lock(): ProtectState
  /** Write what save() wrote back in the clear and forget the protection (asks the passkey when locked). */
  disable(): Promise<ProtectState>
  seal<T>(value: T): Promise<T | { v: 1; s: string }>
  open<T = unknown>(stored: unknown): Promise<T>
  save(name: string, value: unknown): Promise<void>
  load<T = unknown>(name: string): Promise<T | undefined>
  remove(name: string): void
  /** Lock when the page returns after being hidden longer than this (0 = only lock() or a new launch). */
  autoLock(minutes: number): ProtectState
  on(event: 'locked' | 'unlocked' | 'change', cb: (state: ProtectState) => void): () => void
}

/** `wb.backup` — the account backup (a recovery code wraps a master secret; the record is sealed in the vault). */
export interface AccountBackup {
  readonly enabled: boolean
  /** True when enable() recorded an email: a restore, and deleting the account, then need its emailed code as well. */
  readonly gated: boolean
  /** JSON-safe state to persist (it holds the master secret), or null. */
  readonly state: unknown
  /** 'account' (the Spaces app's record format — every new backup) or 'legacy' (this SDK's original); null when not enabled. */
  readonly format: 'account' | 'legacy' | null
  /** Where the account is kept: 'account' (the Witbitz account service — a new account in a vault that names its tenant),
   *  'legacy' (the backup store every account used before), null when there is none on this client. */
  readonly service: 'account' | 'legacy' | null
  readonly rooms: Array<{ room: string; link: string; kind: 'space' | 'lane'; label?: string; shared?: string; archived?: boolean }>
  onState: ((state: unknown) => void) | null
  enable(opts?: { email?: string }): Promise<{ code: string }>
  restore(opts: { code: string; email?: string; ticket?: string; emailCode?: string }): Promise<{ rooms: AccountBackup['rooms'] }>
  save(): Promise<{ rooms: number }>
  /** Rewrite a legacy backup in the account format — same code and rooms; an older SDK can then no longer restore it. */
  upgrade(): Promise<{ format: 'account' }>
  /** Record a room in the backup (createSpace / openSpace do this for you). */
  add(spaceOrLane: Space, opts?: { label?: string }): this
  keyFor(room: string): string | null
  /** The account's invite key for this app, kept with the rooms (wb.invite hands it over; a restore gives it back). */
  readonly invite: InviteAccount['state']
  /** In a vault it throws `vault_unsupported` (the vault keeps the invite key and the backup; `invite` reads null). */
  setInvite(state: unknown): this
  /** In a vault: a promise of the same (the vault's answer, or its refusal). */
  remove(room: string): this | Promise<this>
  /** An account on the account service (`service === 'account'`), in a vault: the vault confirms and asks for an emailed code.
   *  Every other device forgets the account and its Spaces at its next check. Throws `not_on_service` otherwise. */
  signOutOthers(): Promise<{ ok: true }>
  /** A new recovery code, shown once in the vault; the old one stops working and every other device is signed out. */
  newRecoveryCode(): Promise<{ ok: true }>
  /** Delete the account and its backup on the account service; every device is signed out. In a vault this device forgets the
   *  account as a sign-out does — its Spaces, its sign-in — and the page hears `accountSignedOut` with `reason: 'erased'`. */
  deleteAccount(): Promise<{ deleted: true }>
}

/** `wb.account` — the account's live index across devices (sdk-accounts.md#account-index). */
export interface AccountIndex {
  readonly enabled: boolean
  readonly deviceId: string
  readonly rooms: AccountBackup['rooms']
  /** `sdk`: the SDK release a device last synced with (3.24.0 and later; an older device has none). */
  readonly devices: Array<{ id: string; name: string; seenAt: number; signedOut: boolean; current: boolean; sdk?: string }>
  readonly links: Array<{ a: string; b: string; cap?: number }>
  /** Called after a sync changed the index. */
  onChange: ((index: AccountIndex) => void) | null
  /** Called when another device signed THIS one out (it has dropped the account). */
  /** This device was signed out of the account by another device; `reason: 'erased'` when the account was deleted. */
  onSignedOut: ((e?: { reason?: 'erased' }) => void) | null
  /** The last background sync's error, or null. */
  lastError: Error | null
  archive(room: string, on?: boolean): this
  rename(room: string, label: string): this
  forget(room: string): this
  /** `reason: 'erased'`: the account was deleted — that device's `onSignedOut` hears `{ reason: 'erased' }`. */
  signOut(deviceId: string, opts?: { reason?: 'erased' }): this
  /** `signedOut: true` (and empty lists) when another device signed this one out. */
  sync(): Promise<{ ok: boolean; rooms: AccountBackup['rooms']; devices: AccountIndex['devices']; signedOut?: boolean }>
  start(opts?: { every?: number }): this
  stop(): this
  /** What this account's turns cost in a month (UTC, default this one), across its rooms, whoever paid — folded from the
   *  receipts every turn carries (docs: #account-usage). Amounts in micro-dollars; `costUsd` in dollars. */
  usage(opts?: { month?: string }): Promise<{ month: string; replies: number; costMicros: number; costUsd: number; in: number; out: number; byPayer: { you: number; admin: number; app: number; witbitz: number }; byDay: Record<string, number> }>
  /** Optional sections (3.24.0), kept as the Spaces app keeps them: nothing is read until you use one (sdk-accounts.md#account-sections). */
  readonly contacts: AccountContacts
  readonly name: AccountSection<string>
  readonly roomDefaults: AccountSection<RoomDefaults | null, Partial<RoomDefaults>>
  /** The people this account blocked, as the Spaces app keeps them (sdk-people.md#block). */
  readonly blocks: AccountBlocks
}

/** A person, by what proves who they are: the verified email, the @username, or the key that signed in one Space. */
export interface BlockWho { email?: string; user?: string; room?: string; sid?: string }
export type ReportReason = 'harassment' | 'threats' | 'sexual' | 'hate' | 'spam' | 'other'
/** `wb.account.blocks` — the app's Block list. Errors as AccountSection's. */
export interface AccountBlocks {
  /** The people blocked, as this device last read (null before the first read). */
  readonly value: Array<BlockWho & { name: string; at: number }> | null
  get(): Promise<Array<BlockWho & { name: string; at: number }>>
  /** Block them on every device of the account (`space.blockIdentity(message)`, plus a `name` to show). */
  block(who: BlockWho & { name?: string }): Promise<Array<BlockWho & { name: string; at: number }>>
  /** Unblock: every entry naming them by any proof goes (kept as a tombstone). */
  unblock(who: BlockWho): Promise<Array<BlockWho & { name: string; at: number }>>
  merge(list: Array<BlockWho & { name?: string; at?: number; gone?: boolean }>): Promise<Array<BlockWho & { name: string; at: number }>>
  /** Is this writer blocked (any one shared proof)? Over what was last read, or over `list` — one you keep yourself. */
  has(who: BlockWho | null, list?: Array<BlockWho & { at?: number; gone?: boolean }>): boolean
  on(ev: 'change', fn: (value: Array<BlockWho & { name: string; at: number }>) => void): this
  off(ev: 'change', fn: (value: Array<BlockWho & { name: string; at: number }>) => void): this
}

/** One optional account section. Errors: `not_enabled`, `unreadable` / `unopenable` (nothing written), `save_failed`, `invalid_argument`. */
export interface AccountSection<T, P = T> {
  /** What this device last read; null before the first read. */
  readonly value: T | null
  get(): Promise<T>
  set(value: P): Promise<T>
  /** 'change': another device changed it (seen at an account sync — the stream or the minute poll). */
  on(ev: 'change', fn: (value: T) => void): this
  off(ev: 'change', fn: (value: T) => void): this
}
/** A person ({ email and/or username }) or a saved assistant ({ kind: 'agent', id, fn }) — the Spaces app's address book row. */
export interface AccountContact { kind: 'person' | 'agent'; fn: string; email?: string; username?: string; tel?: string; handle?: string; id?: string; persona?: string; agentName?: string; model?: string; color?: string; at?: number }
export interface AccountContacts extends AccountSection<AccountContact[], Partial<AccountContact>> {
  remove(contact: Partial<AccountContact>): Promise<AccountContact[]>
  /** Fold in a list as the app does on a sync or a restore: each row by its own `at`. */
  merge(list: Array<Partial<AccountContact>>): Promise<AccountContact[]>
}
/** The New-Space defaults (the app's Settings → Default room). */
/** The account's New Space defaults, shared with the Spaces app. `verified` is kept for older apps only: today's app makes every new
 *  Space verified and ignores it. */
export interface RoomDefaults { quick?: boolean; enclave?: boolean; verified?: boolean; lanes?: boolean; temporary?: boolean; assistant?: string; model?: string }

/** What a member change in place answers. `unreachable`: members with no invite key for THIS app (they never signed in here) —
 *  send them `link`. */
export interface MemberChange { inPlace: true; epoch: number; link?: string; unreachable: string[] }

/** `wb.invite` — this account's invite key for this app (sdk-people.md#members): published at sign-in under the app's own directory scope;
 *  a member change seals a Space's new key to it. Persist `state` (a private key) and hand it back as `new Witbitz({ invite })`. */
export interface InviteAccount {
  readonly state: { boxPub: unknown; boxPriv: unknown; inbox: string; handle?: string; scope?: string; email?: string } | null
  /** 'none' | 'held' | 'enrolled' | 'held_elsewhere' (another device of this account holds the published key — restore its state) | 'failed' | 'vault' (vault mode: the vault keeps and publishes it) */
  readonly status: 'none' | 'held' | 'enrolled' | 'held_elsewhere' | 'failed' | 'vault'
  restore(state: unknown): this
  /** Publish it (signIn and refreshSession do). → the status */
  enroll(): Promise<InviteAccount['status']>
}

/** `wb.a2a` — the account's A2A record. Persist `state` (it holds the lanes' inbox private keys). */
export interface A2AAccount {
  readonly state: unknown
  readonly endpoint: string
  onState: ((state: unknown) => void) | null
  restore(state: unknown): this
  status(): Promise<unknown>
  revoke(): Promise<unknown>
}

export interface Connection { id: string; label: string; host: string; /** absent in a vault: the vault keeps it (grant by id) */ callKey?: string; account?: string; /** a webhook: its one path (docs/signed-webhooks.md) */ webhook?: string; /** an agent that takes jobs: where the job goes and the fixed headers (outside-agents.md) */ job?: { field: string; headers: Record<string, string> }; /** an MCP server (attachMcp / finishMcp): granting it brings its tools */ mcp?: boolean }
/** `wb.connections` — credentials the standing Sentinel holds and spends for the account. */
export interface Connections {
  /** `webhook: true` + `host` = the whole https trigger address: a one-path, POST-only, Bearer connection; `job` makes it an agent that takes jobs. */
  attach(opts: { label?: string; host: string; secret: string; rules?: unknown; limits?: unknown; webhook?: boolean; job?: { field?: string; headers?: Record<string, string> } }): Promise<Connection>
  /** What the Sentinel holds for the account — never a secret. In a vault each also says `grantable`: whether this vault
   *  holds its callKey (attached here, or kept from another device with the backup on); `grant` refuses the rest (`not_in_vault`). */
  list(): Promise<Array<{ id: string; label: string; host: string; grantable?: boolean; [k: string]: unknown }>>
  /** Detach everywhere. `spaces`: the Space handles you granted it to — it is dropped from each one's settings too. */
  detach(id: string, opts?: { spaces?: Space[] }): Promise<{ removedFrom: number } & Record<string, unknown>>
  /** Lock the connections the Sentinel still holds in its old form (attached before 2026-11-16, unspent since) under their
   *  callKeys — pass the keys your app keeps, as `attach` returned them. No call reaches the service. Refused in a vault: the
   *  vault locks what it holds itself when it lists. */
  lock(keys: Record<string, string>): Promise<{ locked: number; failed: number; skipped: number }>
  startConnect(opts: { tenant?: string; providerId: string }): Promise<{ authUrl: string; state: string }>
  finishConnect(opts: { state: string; code: string; label?: string; host?: string }): Promise<Connection>
  /** An MCP server: does it want a sign-in? `needsSignIn: false` → `attachMcp`; else open `authUrl` — `redirectUri` (default
   *  `<your origin>/mcp-callback`) receives `?code=&state=` → `finishMcp`. Opens nothing. */
  startMcp(opts: { url: string; label?: string; redirectUri?: string }): Promise<{ needsSignIn: false; host: string } | { needsSignIn: true; authUrl: string; state: string; host: string }>
  /** An MCP server with no sign-in, or with a token you hold (sealed to the Sentinel). */
  attachMcp(opts: { url: string; label?: string; token?: string }): Promise<Connection>
  /** Finish an MCP server's sign-in with your callback's `state` and `code`. */
  finishMcp(opts: { state: string; code: string; label?: string; host?: string }): Promise<Connection>
  /** The tools an MCP connection offers. */
  mcpTools(id: string): Promise<{ tools: Array<{ name: string; title?: string; description?: string; readOnly?: boolean; [k: string]: unknown }>; server: unknown; truncated: boolean }>
}

/** A cloud computer as `wb.computers.list()` shows it — never a secret. */
export interface ComputerInfo { id: string; name: string; cloud: true; version: number; egress: 'none' | 'trusted' | 'custom' | 'full' | string }
/** `wb.computers` — the person's cloud computers (docs: § Cloud computers). Kept sealed in this app's account; opened with the
 *  same checks as the Witbitz app's Code section; their hours charge the person's AWS key. Not available in vault mode yet
 *  (`vault_mode`). Errors carry `code`: not_enabled, sign_in_required, not_found, keys_refused, aws_limit, attestation, declined. */
export interface Computers {
  list(): Promise<ComputerInfo[]>
  /** Model keys come from the account (capped) unless `keys` brings the person's own. */
  create(opts?: { name?: string; keys?: { trustedRouter: string; tinfoil?: string; github?: string }; egress?: { mode: string; hosts?: string[] }; browsePrivate?: boolean }): Promise<ComputerInfo>
  /** Start or wake it, check it runs the published Witbitz image (a NEW published image: 'auto' accepts it, 'ask' calls
   *  `onNewImage(pcr0, role)`), hand it the person's keys sealed, connect. */
  open(id: string, opts?: { onStep?(step: 'requesting' | 'starting' | 'verifying' | 'opening' | 'connecting' | string): void; images?: 'auto' | 'ask'; onNewImage?(pcr0: string, role: 'cloud-computer' | 'sentinel'): boolean | Promise<boolean> }): Promise<Computer>
  /** Closed, its account keys cancelled, then removed from the account. */
  remove(id: string): Promise<void>
  /** This month on the person's AWS key (dollars; show credits: 100 = $1), or null before the first opening. */
  usage(): Promise<{ live: boolean; tier?: 'full' | 'free'; month?: { usd: number; capUsd: number; byKind: Record<string, number> }; resetsAt?: string; why?: string } | null>
}
/** One open cloud computer. Every call goes through its connector, which serves only the Code section's own routes. */
/** Which folder's project a computer call is about: a session's (`session`) or a folder (`dir`). The server scopes by folder. */
export interface ComputerScope { session?: string; dir?: string }

export interface Computer {
  readonly id: string
  readonly name: string
  readonly status: 'online' | 'connecting' | 'offline'
  readonly sessions: {
    list(): Promise<unknown[]>
    create(opts?: { dir?: string; title?: string }): Promise<{ id: string; [k: string]: unknown }>
    messages(sessionId: string, opts?: { limit?: number }): Promise<unknown[]>
    /** `model`: 'provider/model', e.g. 'trustedrouter/deepseek/deepseek-v4-flash'. */
    prompt(sessionId: string, text: string, opts?: { model?: string; agent?: string }): Promise<unknown>
    abort(sessionId: string): Promise<unknown>
    rename(sessionId: string, title: string): Promise<unknown>
    remove(sessionId: string): Promise<unknown>
    todo(sessionId: string): Promise<unknown>
    /** { <session id>: status } of every folder the sessions live in, or of one (`session` / `dir`). */
    status(opts?: ComputerScope): Promise<Record<string, unknown>>
  }
  readonly approvals: {
    /** Every approval waiting, in every folder the sessions live in — or in one (`session` / `dir`). */
    pending(opts?: ComputerScope): Promise<unknown[]>
    /** A 'reject' may carry a `message` for the model ("stop and ask me"); otherwise the approval's `session` is needed. */
    answer(id: string, response: 'once' | 'always' | 'reject', opts?: { session?: string; message?: string }): Promise<unknown>
  }
  /** `opts`: the folder the question is in (`session` — the event's sessionID — or `dir`); neither = the computer's default project. */
  readonly questions: { pending(opts?: ComputerScope): Promise<unknown[]>; answer(id: string, answers: string[][], opts?: ComputerScope): Promise<unknown>; dismiss(id: string, opts?: ComputerScope): Promise<unknown> }
  readonly files: {
    /** In a session's folder (`session`) or `dir`; neither = the computer's default project. */
    list(path?: string, opts?: ComputerScope): Promise<unknown>; changes(opts?: ComputerScope): Promise<unknown>; diff(opts?: ComputerScope): Promise<unknown>
    /** A file of the session's folder (at most 20 MB, nothing that looks like a secret). Rejects `not_supported` on an older connector. */
    download(sessionId: string, path: string): Promise<{ name: string; kind?: string; mime: string; size: number; mtime?: number; b64: string }>
    /** Into folder `dir` (absolute). A name already there: `onExists` 'fail' (rejects `exists`), 'replace' or 'keepBoth' ("name (2).ext"). */
    upload(sessionId: string, file: { dir: string; name: string; data: Blob | ArrayBuffer | Uint8Array | string; onExists?: 'fail' | 'replace' | 'keepBoth' }): Promise<{ ok: boolean; name: string; path: string; size: number }>
    /** A file a reply produced (`computer.outputs`), screenshots included. */
    output(sessionId: string, path: string): Promise<{ name: string; mime: string; size?: number; b64: string }>
  }
  readonly browser: {
    status(): unknown
    /** Is the agent's browser in private mode (nothing it visits is kept)? */
    readonly private: boolean
    /** Where the computer offers it (`status().canPrivate`); otherwise throws `not_supported`. The next report confirms it. */
    setPrivate(on: boolean): true
  }
  /** What a reply produced: files it wrote, the browser's screenshots, files its answer names that changed. `messages` omitted = the latest reply. */
  outputs(sessionId: string, messages?: unknown[]): Promise<Array<{ path: string; kind: 'pdf' | 'image' | 'table' | 'text' | 'file'; source: 'wrote' | 'shot' | 'named' }>>
  readonly egress: { get(): unknown }
  /** Live events (OpenCode's): a type such as 'message.part.updated', 'permission.asked', 'session.idle', or '*'. → off
   *  The computer streams per FOLDER: `{ session }` (its folder is looked up) or `{ dir }`; none = the default folder only. */
  on(type: string, fn: (event: { type: string; properties?: unknown; [k: string]: unknown }) => void, opts?: { session?: string; dir?: string }): () => void
  /** A last save, then it stops — its hours stop counting. */
  close(): Promise<boolean>
}

/** `wb.siri` — the account's Siri inbox. Persist `state` (it holds the inbox private keys). */
export interface SiriAccount {
  readonly state: unknown
  readonly shortcut: { key: string | null; endpoint: string }
  restore(state: unknown): this
  status(): Promise<unknown>
  /** In a vault: resolves `null` — the new key is shown in the vault's own screen (wb.vault.showSiriKey). */
  rotateKey(): Promise<string | null>
  revoke(): Promise<unknown>
}

/** `wb.usernames` — the signed-in member's global @username. */
export interface Usernames {
  /** → `{ username }`; whether it is listed in the directory: `mine()`. */
  claim(name: string, opts?: { publish?: boolean; name?: string }): Promise<{ username: string }>
  release(): Promise<unknown>
  mine(): Promise<{ username: string | null; published?: boolean }>
  resolve(name: string): Promise<{ username: string; exists: boolean }>
}

/** wb.speech (sdk-assistant.md#speak). `play` rejects with `no_hebrew`, `empty`, `sign_in_required`, `tts_rate_limited`, `tts_unavailable`, `http_<n>`, `audio`, `play`. */
export interface Speech {
  readonly playing: boolean
  play(text: string): Promise<void>
  stop(): void
}
export interface Dictation {
  readonly listening: boolean
  start(opts?: { onPartial?(t: string): void; onLevel?(rms: number): void }): Promise<void>
  stop(): Promise<string>
  cancel(): void
  close(): void
}

import type { Origins, DeclaredHosts, Providers, TenantRooms, Customers, Billing } from './witbitz-admin'

export declare class Witbitz {
  constructor(opts?: WitbitzOptions)
  /** VAULT MODE: this page is framed by a vault you host on another origin, which keeps every room key. Rejects
   *  `not_in_vault` when the page is not framed by that origin. Create, read and send as usual; sign-in and sharing
   *  happen in the vault (`wb.vault`). A link is opened by the vault, not by openSpace. Refuses by name a `session`
   *  (`vault_signs_in`), `attest`, and a persisted `backup` / `siri` / `a2a` / `invite` state (`vault_unsupported`): the vault keeps the account. */
  static inVault(opts: WitbitzOptions & { vault: string }): Promise<Witbitz>
  /** The vault this page runs in — set by {@link Witbitz.inVault}, else null. */
  readonly vault: VaultSession | null
  readonly session: Session | null
  readonly backup: AccountBackup
  /** Device storage protection for what the app keeps on the device (sdkProtect.js). */
  readonly protect: Protect
  readonly account: AccountIndex
  /** The tenant's erase of a user (`admin.customers.erase`) reaches the rooms this account created (sdkErase.js). */
  readonly erasure: Erasure
  /** Which enclave build this person accepts — `new Witbitz({ builds: 'mine' })`. */
  readonly builds: Builds
  readonly a2a: A2AAccount
  readonly invite: InviteAccount
  readonly connections: Connections
  /** The person's cloud computers (§ Cloud computers). */
  readonly computers: Computers
  readonly siri: SiriAccount
  readonly usernames: Usernames
  createSpace(opts: { /** @deprecated retired in 4.0.0 — `owner` rejects with `owner_rule_retired` */ owner?: never; agent?: AgentSpec; tools?: ToolDef[]; immediateTools?: string[]; model?: AgentSpec['model']; data?: Record<string, unknown>; platformTools?: PlatformTools; framing?: Framing; dataWrites?: boolean; /** a direct chat with this address (sdk-people.md#direct-chats) — instead of admission */ direct?: string; admission?: Admission; tier?: Tier; key?: 'split'; region?: string; /** a room wiped when idle: true (≈30 min), or { days } (1–7) after its last question (sdk-rooms.md#temporary) */ temporary?: true | { days: number }; /** others' photos and PDFs shown only from copies an attested enclave made safe (sdk-rooms.md#safe-media) */ safeMedia?: boolean; /** every member gets a private assistant (sdk-agents.md#lanes-for-everyone) */ lanes?: boolean }): Promise<Space>
  /** `link` is REQUIRED (a share link: `<viewer>/space?room=…#mk=…`); the current page URL is not read for you. */
  openSpace(link: string, opts?: { resume?: Snapshot; tier?: Tier }): Promise<Space>
  /** Reopen a member's lane (sdk-reference.md). In a vault `laneLink` is the lane's room id; `lane_space_gone` once its Space is forgotten. */
  /** Rejects with `lane_of_lane` when `space` is itself a lane (open the lane on its Space). */
  openLane(laneLink: string, opts: { space: Space; actions?: LaneAction[]; resume?: Snapshot; tier?: Tier; mirror?: boolean | { data?: boolean } }): Promise<Lane>
  signIn(opts: { email: string; code?: string; ticket?: string; room?: string }): Promise<{ ticket: string; email: string } | Session>
  refreshSession(): Promise<Session>
  signOut(): this
  useSession(session: Session | null): this
  useUserToken(token: string | (() => string | Promise<string>) | null): this
  models(opts?: { tier?: Tier }): Promise<Array<{ id: string; efforts?: Effort[] | null; [k: string]: unknown }>>
  dictation(): Dictation
  /** Text read aloud (sdk-assistant.md#speak) — the Spaces app's "Play aloud" player. */
  readonly speech: Speech
  /** Read `text` aloud → resolves when it has played. */
  speak(text: string): Promise<void>
  /** Feature detection: this SDK's version and features, the limits, the tiers and models this deployment serves. */
  capabilities(): Promise<{ sdk: string; endpoint: string; features: string[]; limits: Record<string, number>; tiers: { standard: true; enclave: boolean }; models: { regular: string[]; confidential: string[] } | null }>
  toJSON(): { viewer: string; tenant?: string; signedIn: boolean; tenantKey?: '[REDACTED]' }
  // ── Builder calls (server only). Deprecated here: use WitbitzAdmin (witbitz-admin.js); `users` is `customers` there.
  /** @deprecated use `new WitbitzAdmin(…).verifyTenantKey()` */
  verifyTenantKey(): Promise<{ ok: true; tenant: string } | { ok: false; reason: string; code?: string }>
  /** @deprecated use WitbitzAdmin */ readonly origins: Origins
  /** @deprecated use WitbitzAdmin */ readonly hosts: DeclaredHosts
  /** @deprecated use WitbitzAdmin */ readonly providers: Providers
  /** @deprecated use WitbitzAdmin */ readonly rooms: TenantRooms
  /** @deprecated use WitbitzAdmin's `customers` */ readonly users: Customers
  /** @deprecated use WitbitzAdmin */ readonly billing: Billing
}
export default Witbitz

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export declare const LIMITS: Readonly<Record<string, number>>
export declare const EFFORTS: readonly Effort[]
/** 'dev' on the live build; the release number in /sdk/<version>/. */
export declare const SDK_VERSION: string
/** Throws `limit_exceeded` for a list of actions offered to one turn that the server would cut or drop. */
export declare function checkActions(actions: LaneAction[]): void
/** Throws `invalid_effort` when `model` names a reasoning effort the model does not take. `catalog` = wb.models(). */
export declare function checkModelEffort(model: AgentSpec['model'], catalog?: Array<{ id: string; efforts?: Effort[] | null }>): void
/** Throws `limit_exceeded` for a `data` schema the server would cut, drop or rename. */
export declare function checkDataSchema(data: Record<string, unknown>): void
/** Is this message a lane's copy of its shared room's line (`source: 'shared'` and an `sh:` id)? The app draws exactly these as "from the room". */
export declare function isLaneCopy(m: Message | Record<string, unknown>): boolean

// AG-UI 1.0 (sdk-agents.md#ag-ui)
export declare function aguiRun(space: Space, input: { threadId?: string; runId?: string; messages?: unknown[]; context?: unknown[]; resume?: unknown }, opts?: { from?: string; mode?: ReplyMode; timeoutMs?: number; graceMs?: number; signal?: AbortSignal }): AsyncIterable<Record<string, unknown>>
export declare function aguiHistory(space: Space): unknown[]
export declare function aguiAgent(lib: { AbstractAgent: unknown; Observable: unknown }, space: Space, opts?: { threadId?: string; agentConfig?: Record<string, unknown>; [k: string]: unknown }): unknown

// RATS / EAT (sdk-keys.md#eat)
export declare const EAT_PROFILE: string
export declare function verifyEat(token: string, opts?: { expectedPCRs?: Record<string, string> | null; nonce?: string | null; root?: unknown; now?: number; maxAgeMs?: number; key?: Uint8Array | null; profile?: string }): Promise<{ ok: true; claims: Record<string, unknown>; doc: unknown; userData: unknown; pinned: boolean }>
export declare function fetchAndVerifyEat(eatUrl: string, opts?: { expectedPCRs?: Record<string, string> | null; fetchImpl?: typeof fetch; [k: string]: unknown }): Promise<{ ok: true; claims: Record<string, unknown>; doc: unknown; userData: unknown; pinned: boolean }>
