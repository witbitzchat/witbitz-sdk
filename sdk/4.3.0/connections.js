// connections.js — the page's half of the STANDING Sentinel (docs/standing-sentinel.md §3): attach an API key to your
// account so a Space can use it without ever holding it.
//
//   attach:  attest the Sentinel (through op:'sentinel', a pipe) → seal { account, id, host, secret, callKey… } to its
//            share key over the attest nonce → credgrant → put { account, id, callKey, label, host } into this room's
//            sealed config (setConfig; `connections` is one of the fields that may change in place). The SECRET goes
//            only into the seal. The callKey goes into the seal AND the room: it is what lets THIS room spend it.
//   list:    what the Sentinel holds for the signed-in account — never a secret, never a callKey.
//   detach:  credrevoke (the Sentinel deletes the record and stops every room at once) + drop it from this room.
//   use/unuse: add or drop an existing connection in THIS room (record only; the Sentinel is not involved).
//
// The page never talks to the Sentinel's front directly (self-signed, off the CSP): the Lambda forwards, and learns
// nothing from a sealed grant. The account is the VERIFIED sign-in's email — the Lambda sets it from the token, and
// the Sentinel refuses a sealed grant whose account is not that one — so `account` here must be the signed-in email.
import { CATALOG } from './connCatalog.js'
import { verifyAttestation } from './nitroVerify.js'
import { sentinelPcrOfRelease } from './sentinelRelease.js' // a Sentinel build not pinned here, checked by its build-enclave release record
import { sealTo } from './sealShare.js'
import { adoptPendingKeys } from './connPending.js' // a key whose grant answer was lost (N#7): the rule both keepers use
import { sealDisp, withDisplay } from './connDisp.js' // step 2: a connection's name sealed to the person's devices (docs/standing-sentinel.md)

/** The standing Sentinel's image, a rollover set of PCR0s (docs/standing-sentinel.md; infra/enclave/sentinel-host/README.md
 *  for the repin). Empty would mean attach REFUSES: the page will not seal an API key to an enclave it cannot name.
 *  Pin it here and in the Lambda's SENTINEL_HOP_PCRS together. */
export const STANDING_SENTINEL_PCR0 = ['1903ce28fc5a75efe2e57a451d667f1ce8b4b6e11872fb2b81d9e62d8cd994ed80fcfa99807f289af5f281aa4e4cc010', '267a82525bbdc8f17ed32792f887dad9b06629350da41c0357ad0a6d67a3b2a8aba0a93e1d3ee9ae56bdd07948eeff98'] // st56 and st55 during the rollout

const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const b64u = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const CONNECTION_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/

export class ConnectionError extends Error { constructor(m, code = '') { super(m); this.code = code } }

/**
 * Attest the standing Sentinel: a fresh nonce, its `attest` op through the Lambda, the Nitro document verified against
 * the pinned root + STANDING_SENTINEL_PCR0 + the nonce, the role in user_data, and its P-384 share key imported.
 * @param {{ post: (body:object)=>Promise<object>, auth: object, pins?: string[], verify?: Function }} o
 * @returns {{ nonce: Uint8Array, key: CryptoKey }}
 */
// A NEW PUBLISHED SENTINEL BUILD IS FOLLOWED, NOT REFUSED (the owner, 2026-10-15: an app open across a Sentinel repin said
// "PCR0 mismatch" — "we have a flag for that. It should follow the published releases" → "and if that flag is not set ask
// the user"). The pins above are this build's; Witbitz publishes the current set at /sentinel-claim.json (held equal to them
// by test, network-only in both workers, like /enclave-claim.json). On a mismatch the app reads it: a build named there is
// accepted at once when "Accept new Witbitz builds automatically" is on, and the person is ASKED when it is off. The shell
// wires the flag and the question (setSentinelFollow); with none wired (the SDK, a test) nothing changes.
const ACCEPTED_KEY = 'space:sentinelAccepted'
let _follow = null
export const setSentinelFollow = (f) => { _follow = f && typeof f.auto === 'function' && typeof f.ask === 'function' ? f : null }
const acceptedPcrs = () => { try { const a = JSON.parse(localStorage.getItem(ACCEPTED_KEY) || '[]'); return Array.isArray(a) ? a.filter((x) => /^[0-9a-f]{96}$/.test(x)) : [] } catch { return [] } }
const rememberPcr = (p) => { try { const a = acceptedPcrs(); if (!a.includes(p)) localStorage.setItem(ACCEPTED_KEY, JSON.stringify([...a, p].slice(-4))) } catch { /* */ } }
/** The standing Sentinel builds this device trusts now, newest first, at most two: a build it accepted by its published claim or its
 *  verified release record (rememberPcr), then this app's pins. A cloud computer's grant names these (codeCloud.js `standing`). */
export const trustedSentinelPins = () => [...new Set([...acceptedPcrs().reverse(), ...STANDING_SENTINEL_PCR0])].slice(0, 2)
export async function publishedSentinelPins(fetchImpl = (u, o) => fetch(u, o), url = '/sentinel-claim.json') {
  try { const r = await fetchImpl(url, { cache: 'no-store' }); if (!r.ok) return []; const c = await r.json(); return Array.isArray(c && c.pcr0) ? c.pcr0.filter((x) => /^[0-9a-f]{96}$/.test(x)) : [] } catch { return [] }
}
/** Verify against this build's pins (and builds the person already accepted); on a mismatch, a PUBLISHED newer build by the flag or the person's yes. */
// `follow` per call (the SDK: each instance its own, and the claim read from Witbitz's site, not the builder's — sync sweep
// 10-16 #4: no SDK release could follow a Sentinel repin, so each lost connections when its pins were narrowed away).
async function verifyFollowing(verify, docBytes, { nonce, pins, follow, release = null, links = null }) {
  const f = follow || _follow
  const following = f && pins === STANDING_SENTINEL_PCR0
  // ★ THE PINS, THEN EACH ACCEPTED BUILD ON ITS OWN (the owner, 2026-10-21, Claude Code's card: "PCR0 pins 3 values; at most
  //   2"): adding the builds this device once accepted to the pins made a set of 3 under a rollover, which the verifier
  //   refuses before it compares — every device that ever followed a Sentinel build lost its connections.
  const tryPins = (set) => verify(docBytes, { nonce, maxAgeMs: 120_000, expectedPCRs: { 0: set } })
  const known = following ? [...new Set([...pins, ...acceptedPcrs()])] : pins
  try { return await tryPins(pins) } catch (first) {
    if (!following || !/PCR0/i.test(String((first && first.message) || first))) throw first
    for (const p of known.filter((x) => !pins.includes(x))) { try { return await tryPins([p]) } catch { /* not this one */ } }
    // ITS RELEASE RECORD (docs/standing-sentinel.md § Following verified releases): the build enclave's signed verdict for the running
    // build came with the attestation — a build that verifies there is followed like a published one (the flag, or the person's yes)
    if (release) {
      let p = null; try { p = await sentinelPcrOfRelease(release, { links }) } catch { p = null } // + the build-enclave links beside it (docs/trust-root.md)
      if (p && !known.includes(p)) {
        let doc = null; try { doc = await tryPins([p]) } catch { doc = null }
        if (doc) {
          if (f.auto() || await f.ask(p)) { rememberPcr(p); return doc }
          throw new ConnectionError('you did not accept the new Witbitz Sentinel build, so nothing was sent to it', 'declined')
        }
      }
    }
    for (const p of (await publishedSentinelPins(f.fetch || undefined, f.claimUrl || undefined)).filter((x) => !known.includes(x))) {
      let doc = null; try { doc = await verify(docBytes, { nonce, maxAgeMs: 120_000, expectedPCRs: { 0: [p] } }) } catch { continue }
      if (f.auto() || await f.ask(p)) { rememberPcr(p); return doc }
      throw new ConnectionError('you did not accept the new Witbitz Sentinel build, so nothing was sent to it', 'declined')
    }
    throw first
  }
}
export async function attestStandingSentinel({ post, auth = {}, pins = STANDING_SENTINEL_PCR0, verify = verifyAttestation, follow = null }) {
  if (!Array.isArray(pins) || !pins.length) throw new ConnectionError('the standing Sentinel is not pinned in this build — nothing can be attached yet', 'unpinned')
  const nonce = crypto.getRandomValues(new Uint8Array(32))
  const r = await post({ op: 'sentinel', sentinel: { mode: 'attest', nonce: b64(nonce) }, ...auth })
  if (!r || r.error || typeof r.doc !== 'string') throw new ConnectionError(`the Sentinel could not be reached (${(r && r.error) || 'no attestation'})`, (r && r.error) || 'unreachable')
  let doc
  try { doc = await verifyFollowing(verify, unb64(r.doc), { nonce, pins, follow, release: r.release && typeof r.release === 'object' ? r.release : null, links: Array.isArray(r.links) ? r.links : null }) }
  catch (e) { if (e instanceof ConnectionError) throw e; throw new ConnectionError(`the Sentinel is not running the published Witbitz image, so nothing was sent to it (${String((e && e.message) || e).split('\n')[0]})`, 'attestation') }
  let said = null
  try { said = JSON.parse(new TextDecoder().decode(doc.userData || new Uint8Array(0))) } catch { /* below */ }
  if (!said || said.role !== 'sentinel') throw new ConnectionError('the attestation does not name a Sentinel, so nothing was sent to it', 'attestation')
  const key = await crypto.subtle.importKey('spki', doc.publicKey, { name: 'ECDH', namedCurve: 'P-384' }, false, [])
  return { nonce, key, spki: new Uint8Array(doc.publicKey) } // spki: the same key's bytes, for a minter that seals elsewhere (the hosted app's vault)
}

/** The entry a ROOM keeps (its sealed config): enough to name and spend the connection, never the secret. */
export const roomEntry = (c) => ({ account: c.account, id: c.id, callKey: c.callKey, label: c.label || '', host: c.host, ...(c.mcp ? { mcp: c.mcp } : {}), ...(c.webhook ? { webhook: c.webhook } : {}), ...(c.webhook && c.job ? { job: c.job } : {}), ...(c.reads === 'auto' && !c.mcp ? { reads: 'auto' } : {}) }) // reads: a GET through it runs without asking (connectionEntry.js keeps it; agent/connectionTools.mjs readsRunAlone)

/**
 * Attach: seal to the Sentinel, grant, then record in this room through `record(patch, by)` — the shell passes
 * `(patch, by) => l1.setConfig(room, patch, by)`; the patch is DECLARATIVE ({ add: entry }) because it crosses the L1
 * façade by structured clone, and spaceClient.setConfig applies it to the room's current list under its own key.
 * @returns {{ id: string, label: string, host: string, callKey: string }}
 */
export async function attachConnection({ post, auth = {}, record, by, account, label, host, secret, rules, limits, pins, verify, follow, tenant, bearerWebhook, dispKey } = {}) { // dispKey: connDisp.js — the name also goes sealed to the person's devices (step 2)
  const acct = String(account || '').trim().toLowerCase()
  if (!/^[^\s@]{1,200}@[^\s@]{1,63}$/.test(acct)) throw new ConnectionError('sign in with your email first — a connection belongs to an account', 'account')
  const s = String(secret || '')
  if (!s.trim() || s.length > 4000 || /[\r\n]/.test(s)) throw new ConnectionError('paste the API key or token, on one line', 'secret')
  // A SIGNED WEBHOOK (docs/signed-webhooks.md): a whsec_ secret means the receiver wants each request SIGNED, not the
  // secret in a header (Grok Bot's routines). The member pastes the webhook's whole address; it becomes the host and the
  // ONE path this connection may call, and the Sentinel signs every approved request.
  // A BEARER WEBHOOK (Grok Bot's desktop routines): the same one-path, POST-only shape, the key sent as a Bearer header.
  const signed = /^whsec_/.test(s.trim()) || bearerWebhook === true
  let path = ''
  if (signed) {
    let u = null; try { u = new URL(/^https?:\/\//i.test(String(host || '').trim()) ? String(host).trim() : 'https://' + String(host || '').trim()) } catch { u = null }
    if (!u || u.protocol !== 'https:' || !u.pathname || u.pathname === '/' || u.search || u.port) throw new ConnectionError('for a webhook, paste its whole https address (with its path) as the host', 'host')
    path = u.pathname
  }
  const h = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
  if (!CONNECTION_HOST.test(h)) throw new ConnectionError('the host must be a bare domain name, like api.example.com', 'host')
  const lbl = String(label || '').trim().slice(0, 80) || h
  const att = await attestStandingSentinel({ post, auth, pins, verify, follow })
  const id = 'conn_' + b64u(crypto.getRandomValues(new Uint8Array(12)))
  // The TENANT this was attached under, when there is one: its declaration is what vouches for the host, and the
  // Sentinel refuses an attach for a host it has not declared (docs/oauth-providers.md). Absent → the pre-tenant
  // behaviour, unchanged.
  const disp = dispKey ? await sealDisp(dispKey, id, { label: lbl }).catch(() => '') : '' // opaque to the Sentinel; '' → as before
  const grant = signed
    ? { id, account: acct, provider: 'bearer', host: h, secret: s.trim(), label: lbl, ...(disp ? { disp } : {}), sign: /^whsec_/.test(s.trim()) ? 'standard-webhooks' : 'bearer', rules: { paths: [path] }, own: true, ...(limits ? { limits } : {}) } // a SIGNED WEBHOOK is the member's own, never under a tenant: the tenant vouches for API hosts, and a webhook's host is wherever the member's routine lives (the app's rule, now here for every caller — the SDK filed it under its tenant and the Sentinel refused the host; sync sweep, 2026-10-10)
    : { id, account: acct, provider: 'bearer', host: h, secret: s.trim(), label: lbl, ...(disp ? { disp } : {}), ...(tenant ? { tenant: String(tenant) } : {}), ...(rules ? { rules } : {}), ...(limits ? { limits } : {}) }
  const sk = await sealWithCallKey(att, grant, id, { label: lbl, host: h, account: acct })
  const g = await postGrant(post, { op: 'sentinel', sentinel: { mode: 'credgrant', sealed: sk.sealed }, ...auth }, id, { label: lbl, host: h, account: acct, at: Date.now() }, sk)
  if (!g || g.error || !g.ok) throw new ConnectionError(`the Sentinel refused the connection (${(g && g.error) || 'no answer'})`, (g && g.error) || 'refused')
  // ⛔ THE CONNECTION IS RETURNED EVEN WHEN THE SPACE COULD NOT RECORD IT (2026-11-08, docs/state-machines.md I16 / C#11): this threw
  //   after the Sentinel had taken the grant — the callKey was dropped with the error, the Sentinel kept a connection no device
  //   could use, and "attach it again" made a second one. Now the caller keeps it (the account has it) and says the Space did not
  //   take it: it is added to the Space from the account's connections, the same connection.
  let roomError = ''
  if (typeof record === 'function') {
    let r = null; try { r = await record({ connections: { add: roomEntry({ ...grant, callKey: sk.callKey, ...(signed ? { webhook: path } : {}) }) } }, by) } catch { r = null } // held: no callKey here — the vault fills it by id
    if (!r || r.status !== 200) roomError = String((r && r.error) || (r && r.status) || 'no answer')
  }
  return { id, label: lbl, host: h, callKey: sk.callKey, ...(sk.held ? { held: 1 } : {}), ...(signed ? { webhook: path } : {}), ...(roomError ? { roomError } : {}) } // the callKey is the page's own material: the caller keeps it for other Spaces (held: the vault's — the caller keeps a stub)
}

// ⛔ A KEY WHOSE ANSWER WAS LOST (state machines pass 9, N#7). The callKey is made here and sealed into the grant / the sign-in's
//   finish; the Sentinel files the connection and this device keeps the key only when the ANSWER arrives. An answer lost on
//   the way left a connection the account lists that no device holds a key for — unusable, and the one-per-service rule then
//   stopped a second sign-in. The key is kept as PENDING before the request leaves (the page's store — connectionsSheet.js),
//   dropped on a definite answer (the caller keeps a granted one), and adopted when the account's list shows it.
let _pendingStore = { keep () {}, drop () {} }
export const setPendingKeyStore = (s) => { _pendingStore = { keep () {}, drop () {}, ...(s || {}) } }
export async function postWithPendingKey (post, body, id, rec) {
  const store = _pendingStore
  try { await store.keep(id, rec) } catch (e) { if (store.durable) throw e }
  const r = await post(body) // a throw (no answer) leaves it pending
  if (r && (r.error || (r.ok && !store.durable))) { try { await store.drop(id) } catch { /* */ } }
  return r
}
export { adoptPendingKeys } // connPending.js — the rule, shared with the hosted app's vault (vaultConnKeys.js)

// ── WHO MINTS THE CALLKEY. Here, by default. In the HOSTED app the VAULT does (the owner, 2026-11-14: "Close the gaps" — §7.5 of
//   docs/vault-core-convergence-review.md left the attach minting it in the frame): the page attests the Sentinel as always and
//   hands the vault the attested key's bytes, the nonce and the grant WITHOUT a callKey; the vault mints one, keeps it PENDING
//   (its own `space:connPending`), puts it in, seals the whole to that key and answers only the sealed bundle. The page posts it;
//   on a definite answer it SETTLES (filed → the vault holds the key with the account's others; refused → the vault drops it),
//   and keeps a stub. So the callKey is never in this page — not in memory, not in storage. A minter that does not answer, or
//   refuses (an older vault, a protected device still locked): minted here, as before. Never worse.
let _minter = null
export const setCallKeyMinter = (m) => { _minter = m && typeof m.seal === 'function' ? m : null }
/** `payload` + a fresh callKey, sealed to the attested Sentinel → { sealed, callKey ('' when the vault holds it), held, settle } */
async function sealWithCallKey (att, payload, id, rec) {
  if (_minter && att.spki) {
    let v = null; try { v = await _minter.seal({ spki: att.spki, nonce: att.nonce, payload, id, rec }) } catch { v = null }
    if (v && v.sealed) return { sealed: v.sealed, callKey: '', held: true, settle: v.settle }
  }
  const callKey = b64(crypto.getRandomValues(new Uint8Array(32)))
  return { sealed: await sealTo(att.key, att.nonce, { ...payload, callKey }), callKey, held: false, settle: null }
}
/** Post a grant; while its answer is out the key is PENDING — in this page's store (rec = null: none), or the vault's, which a
 *  definite answer settles: `filed` = it was filed (r.ok), `final(r)` = what the Sentinel filed it as ({ id, label, account }). */
async function postGrant (post, body, id, rec, sk, filed = (r) => !!(r && r.ok && !r.error), final = () => ({})) {
  if (!sk.held) return rec ? postWithPendingKey(post, body, id, { ...rec, callKey: sk.callKey }) : post(body)
  const r = await post(body) // a throw (no answer): the vault keeps it pending, adopted when the account lists it
  if (r && (r.ok || r.error)) { let ok = false; try { ok = !!(await sk.settle(filed(r), filed(r) ? final(r) : {})) } catch { ok = false } if (filed(r) && !ok) throw new ConnectionError('the connection was made, but your vault did not keep its key — open Connections again to finish', 'vault') }
  return r
}

/** The signed-in account's connections, as the Sentinel lists them (no secret, no callKey). */
export async function listConnections({ post, auth = {}, dispKey }) { // dispKey: each sealed name is opened (connDisp.withDisplay)
  const r = await post({ op: 'sentinel', sentinel: { mode: 'credlist' }, ...auth })
  if (!r || r.error) throw new ConnectionError(`could not list connections (${(r && r.error) || 'no answer'})`, (r && r.error) || 'unreachable')
  return withDisplay(Array.isArray(r.connections) ? r.connections : [], dispKey || null)
}

/** Detach everywhere (the Sentinel forgets it; every room's callKey for it is dead), and drop it from this room. */
export async function detachConnection({ post, auth = {}, record, by, id }) {
  const r = await post({ op: 'sentinel', sentinel: { mode: 'credrevoke', id }, ...auth })
  if (!r || r.error) throw new ConnectionError(`could not detach (${(r && r.error) || 'no answer'})`, (r && r.error) || 'unreachable')
  if (typeof record === 'function') await record({ connections: { remove: id } }, by)
  return { revoked: Number(r.revoked) || 0 }
}
/** Drop a connection from THIS room only (it stays attached to the account and usable elsewhere). */
export const unuseConnection = ({ record, by, id }) => record({ connections: { remove: id } }, by)

// ── MCP SERVERS AS CONNECTIONS (docs/mcp-connections.md) ─────────────────────────────────────────────────────────────
// A remote MCP server is attached like a key, at one endpoint (https://host/path). Either a token the member pastes, or
// the server's OWN sign-in: the Sentinel discovers it, registers Witbitz as an app there and hands back a consent URL;
// the member's browser consents; /mcp-callback hands the code back here; the code and the room's callKey ride SEALED to
// the Sentinel, which exchanges it inside. The page never holds the server's token.
//
// Servers Witbitz lists (the owner's (c), 2026-10-10): a quick pick, and their cards read as the service. Any other
// server is the member's OWN — allowed, and said so on every card.
// The catalog Connections offers (connCatalog.js — each address passed the Sentinel's sign-in steps). Labels/urls only here.
export const MCP_CURATED = CATALOG.filter((c) => c.url).map((c) => ({ label: c.name, url: c.url })) // sign-in services only: an agent's webhook (kind 'webhook') has its own form
/** "https://mcp.linear.app/mcp" (or a bare host) → { host, path }, or throws a ConnectionError. */
export function parseMcpUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) throw new ConnectionError('paste the MCP server’s address, like https://mcp.example.com/mcp', 'url')
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  let u
  try { u = new URL(s) } catch { throw new ConnectionError('that is not an address, like https://mcp.example.com/mcp', 'url') }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash) throw new ConnectionError('the address must be https, with no port or query', 'url')
  const host = u.hostname.toLowerCase()
  if (!CONNECTION_HOST.test(host)) throw new ConnectionError('the address must be on a domain name, like mcp.example.com', 'url')
  // THE ROOT IS A PATH TOO (2026-11-16: Vercel attached with "the MCP server refused to start a session (404)"): Vercel, Stripe,
  // Calendly, Gusto and HTML/CSS to Image serve MCP at "/" and answer /mcp with 404. A root address keeps "/" when the catalog lists
  // it so, or when it is typed with its trailing slash; only a BARE host ("mcp.example.com") guesses the common /mcp.
  let path = u.pathname || '/'
  if (path === '/') {
    const cur = CATALOG.find((c) => { try { return c.url && new URL(c.url).hostname === host } catch { return false } })
    const typedRoot = /^https:\/\/[^/]+\/$/i.test(s)
    path = cur ? new URL(cur.url).pathname : typedRoot ? '/' : '/mcp'
  }
  return { host, path }
}
export const isCurated = (host) => MCP_CURATED.some((c) => { try { return new URL(c.url).hostname === host } catch { return false } })
/** What to CALL a connection on screen: the label a member gave it — unless it is empty or just the host (a phone that
 *  finished the sign-in without the name stored the host as the label: "api.githubcopilot.com · api.githubcopilot.com"),
 *  then the server's known name (GitHub), then the host. Never changes the stored label or the tools' names. */
export function connectionName (c) {
  const host = String((c && c.host) || '').toLowerCase(), label = String((c && c.label) || '').trim()
  if (label && label.toLowerCase() !== host) return label
  const known = MCP_CURATED.find((k) => { try { return new URL(k.url).hostname === host } catch { return false } })
  return known ? known.label : (host || String((c && c.id) || ''))
}

/** Attach an MCP server with a token (or none, for an open server). Same seal as attachConnection.
 *  ALWAYS THE MEMBER'S OWN (`own: true`), NEVER UNDER A TENANT — for every caller, as a signed webhook is (attachConnection) and as
 *  the Sentinel files every MCP sign-in (custody.mjs mcpOauthFinish): the owner's (c), docs/mcp-connections.md — its host is
 *  reachable while this connection lives, and a tenant's declared hosts vouch only for plain keys. (The SDK passed its tenant
 *  here, and the Sentinel refused every MCP host the builder had not declared — DeepWiki included; docs sync, 2026-11-22.)
 *  "Your own server" on a room's card is another mark: a server not in the catalog (connectionEntry.js, isCurated). */
export async function attachMcp({ post, auth = {}, account, label, url, token = '', pins, verify, follow, dispKey, sealGrant = sealWithCallKey } = {}) {
  const acct = String(account || '').trim().toLowerCase()
  if (!/^[^\s@]{1,200}@[^\s@]{1,63}$/.test(acct)) throw new ConnectionError('sign in with your email first — a connection belongs to an account', 'account')
  const { host, path } = parseMcpUrl(url)
  const t = String(token || '').trim()
  if (t.length > 4000 || /[\r\n]/.test(t)) throw new ConnectionError('paste the token on one line', 'secret')
  const lbl = String(label || '').trim().slice(0, 80) || connectionName({ host }) // empty → the server's known name (GitHub), else the host
  const att = await attestStandingSentinel({ post, auth, pins, verify, follow })
  const id = 'conn_' + b64u(crypto.getRandomValues(new Uint8Array(12)))
  const disp = dispKey ? await sealDisp(dispKey, id, { label: lbl }).catch(() => '') : ''
  const grant = { id, account: acct, provider: 'bearer', host, secret: t, label: lbl, ...(disp ? { disp } : {}), mcp: { path }, own: true }
  const sk = await sealGrant(att, grant, id, { label: lbl, host, account: acct })
  const g = await postGrant(post, { op: 'sentinel', sentinel: { mode: 'credgrant', sealed: sk.sealed }, ...auth }, id, { label: lbl, host, account: acct, at: Date.now() }, sk)
  if (!g || g.error || !g.ok) throw new ConnectionError(`the Sentinel refused the connection (${(g && g.error) || 'no answer'})`, (g && g.error) || 'refused')
  return { id, label: lbl, host, callKey: sk.callKey, ...(sk.held ? { held: 1 } : {}) }
}

/** Does this server want a sign-in? → { needsAuth:false } or { needsAuth:true, state, authUrl }. Opens nothing. */
export async function startMcpSignIn({ post, auth = {}, url, label, redirectUri = location.origin + '/mcp-callback' }) {
  const { host, path } = parseMcpUrl(url)
  const r = await post({ op: 'sentinel', sentinel: { mode: 'mcpoauthstart', host, path, redirectUri, label: String(label || '').slice(0, 80) }, ...auth })
  if (!r || r.error || !r.ok) throw new ConnectionError(`${host}: ${(r && r.error) || 'no answer from the Sentinel'}`, 'signin')
  return r.needsAuth ? { needsAuth: true, state: r.state, authUrl: r.authUrl, host } : { needsAuth: false, host }
}

// THE WAY BACK FROM A WINDOW THAT SHARES NOTHING WITH THIS PAGE (the owner, 2026-11-18, the hosted app on an iPhone: Todoist signed
// in, the app waited for ever). An installed app on iOS opens the sign-in in an in-app browser: no storage, no BroadcastChannel in
// common, so /mcp-callback's two hand-backs never arrive. The window is opened on /mcp-callback FIRST, with the server's sign-in,
// a one-time key and an id in the fragment (never sent anywhere); it keeps the key in its own sessionStorage, goes on to the
// server, and on its way back seals { state, code } under that key and leaves it at the auth broker under the id
// (auth-broker/functions/api/handoff/drop.js — a ciphertext it cannot open, read once, to this origin only). `null` = an
// address the callback would refuse (not https, or it does not come back to this page's /mcp-callback) — open it as before.
// The broker: the app passes its own (connectionsSheet.js, stamped at deploy); no placeholder here — the SDK ships this file.
export const AUTH_BROKER_DEFAULT = 'https://auth.witbitz.chat'
export function nativeMcpOpener(url, bridge = globalThis.WitbitzAttest) {
  if (!bridge) return null
  try {
    const { host } = parseMcpUrl(url)
    // ⚑ 11·K#6: these two hand the sign-in back through the BROKER's drop (the browser deposits it, then wakes the app), so a page the OS
    //   recreated meanwhile can still collect it — `byBroker` lets the sheet keep the recoverable record for them (androidConsent.js)
    if (host === 'mcp.linear.app' && bridge.openLinearConsent) return Object.assign(handoff => bridge.openLinearConsent(handoff + '&returnApp=android'), { byBroker: true })
    if (BROKER_CALLBACK_HOSTS.test(host)) return bridge.openCalendarConsent ? Object.assign(handoff => bridge.openCalendarConsent(handoff + '&returnApp=android'), { byBroker: true }) : null
    if ((bridge.openRecoverableConnector || bridge.openConnectorConsent) && bridge.takeConnectorResult) return Object.assign(handoff => {
      const handle = bridge.openRecoverableConnector ? bridge.openRecoverableConnector(handoff) : bridge.openConnectorConsent(handoff)
      if (!handle || handle === 'browser') return !!handle
      return () => {
        const result = bridge.takeConnectorResult(handle)
        return result ? JSON.parse(result) : null
      }
    }, { recoverable: !!bridge.openRecoverableConnector })
  } catch { /* the connection form reports an invalid URL */ }
  return null
}
function returnTrip (u, page, origin, forApp = '') {
  const key = crypto.getRandomValues(new Uint8Array(32)), sid = b64u(crypto.getRandomValues(new Uint8Array(24)))
  return { openUrl: origin + page + '#' + new URLSearchParams({ go: u.toString(), k: b64u(key), d: sid, ...(forApp ? { o: forApp } : {}) }), drop: { sid, key } }
}
// GOOGLE'S MCP SERVERS SIGN IN THROUGH THE BROKER'S CALLBACK (2026-11-23, Google Calendar): Google verifies an app only with redirect
// addresses on domains its developer owns, and the regular app lives on pages.dev — so Witbitz's Google client registers
// <broker>/mcp-callback, the page served there leaves the sealed result FOR this app (auth-broker handoff/drop.js `for`), and the app
// takes it as before. Every other server comes back to the app's own /mcp-callback.
export const BROKER_CALLBACK_HOSTS = /\.googleapis\.com$/
export function mcpRedirectFor (host, { origin = location.origin, broker = AUTH_BROKER_DEFAULT, bridge = globalThis.WitbitzAttest } = {}) {
  const server = String(host || '').toLowerCase()
  const useBroker = BROKER_CALLBACK_HOSTS.test(server) || (server === 'mcp.linear.app' && bridge?.openLinearConsent)
  return (useBroker ? String(broker).replace(/\/$/, '') : origin) + '/mcp-callback'
}
export function mcpReturnTrip (authUrl, { origin = location.origin, broker = AUTH_BROKER_DEFAULT } = {}) {
  let u; try { u = new URL(String(authUrl)) } catch { return null }
  if (u.protocol !== 'https:' || !/^[A-Za-z0-9_-]{16,64}$/.test(u.searchParams.get('state') || '')) return null
  const back = u.searchParams.get('redirect_uri'), b = String(broker).replace(/\/$/, '')
  if (back === origin + '/mcp-callback') return returnTrip(u, '/mcp-callback', origin)
  if (back === b + '/mcp-callback' && b !== origin) return returnTrip(u, '/mcp-callback', b, origin) // the broker's page, for this app
  return null
}
/** The same way back for the GitHub App's install (github-callback.html): GitHub's own install page only, with a state. */
export function gitHubReturnTrip (installUrl, { origin = location.origin } = {}) {
  let u; try { u = new URL(String(installUrl)) } catch { return null }
  if (u.origin !== 'https://github.com' || !/^\/apps\/[^/]+\/installations\/new$/.test(u.pathname) || !/^[A-Za-z0-9_-]{8,80}$/.test(u.searchParams.get('state') || '')) return null
  return returnTrip(u, '/github-callback', origin)
}
const unb64u = (s) => unb64(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(s).length % 4)) % 4))
async function takeDrop (drop, { broker = AUTH_BROKER_DEFAULT, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(broker + '/api/handoff/drop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid: drop.sid, take: true }) }).then((x) => x.json()).catch(() => null)
  // a broker that will never hand this app anything (not admitted there): say so now, not after the ten-minute wait
  if (r && r.ok === false && r.reason === 'origin_not_allowed') throw new ConnectionError('this app cannot collect sign-ins from the auth broker (its address is not admitted there)', 'signin')
  if (!r || !r.ok || typeof r.blob !== 'string') return null
  return openDrop(drop, r.blob)
}
async function openDrop (drop, blob) {
  const box = unb64u(blob)
  const k = await crypto.subtle.importKey('raw', drop.key, 'AES-GCM', false, ['decrypt'])
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.subarray(0, 12), additionalData: new TextEncoder().encode(drop.sid) }, k, box.subarray(12))))
}

/** The code /mcp-callback hands back for `state`: a BroadcastChannel message, the localStorage note it leaves, or — with `drop`
 *  (mcpReturnTrip) — what it sealed at the auth broker. */
// signal: an AbortSignal — the wait ends at once with a ConnectionError of kind 'cancel' (the owner, 2026-11-19: a service that
// shows its OWN error page never comes back, and the Connect button stayed grey for the whole ten minutes)
const DISMISS_GRACE_MS = 12_000 // 11·K#2: how long a dismissed Auth Tab's grant is looked for at the broker
export function awaitMcpCallback(state, { timeoutMs = 10 * 60_000, drop = null, broker, fetchImpl, dropEveryMs = 1500, readNative = null, checkDropOnDismiss = false, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let done = false, bc = null, iv = 0, to = 0, dv = 0, asking = null
    const onAbort = () => { if (!done) { done = true; stop(); reject(new ConnectionError('the sign-in was started again', 'cancel')) } }
    const stop = () => { clearInterval(iv); clearInterval(dv); clearTimeout(to); try { bc && bc.close() } catch { /* */ }; try { typeof document !== 'undefined' && document.removeEventListener('visibilitychange', onVis) } catch { /* */ }; try { signal && signal.removeEventListener('abort', onAbort) } catch { /* */ } }
    if (signal) { if (signal.aborted) { onAbort(); return } signal.addEventListener('abort', onAbort) }
    const finish = (m) => {
      if (done || !m || m.state !== state) return
      done = true; stop()
      try { localStorage.removeItem('space:mcpcb:' + state) } catch { /* */ }
      if (m.error) reject(new ConnectionError(`the sign-in did not finish (${String(m.error).slice(0, 80)})`, 'signin')); else resolve(String(m.code || ''))
    }
    const askDrop = () => {
      if (done || !drop) return
      if (!asking) asking = takeDrop(drop, { broker, fetchImpl }).then(finish).catch(e => {
        if (e instanceof ConnectionError && !done) { done = true; stop(); reject(e) }
      }).finally(() => { asking = null })
      return asking
    }
    const readTab = () => {
      if (!readNative || done) return
      const reply = readNative()
      // Some browsers dismiss the tab when its verified link foregrounds the app.
      // The callback deposited its grant before navigating to that link.
      // ⚑ 11·K#2: the drop is asked for a few seconds, not once — one miss (a dropped fetch, the deposit not visible yet) reported a
      //   consent that had succeeded as cancelled, and the recovery record went with it
      if (reply?.error && checkDropOnDismiss && drop) void (async () => {
        const until = Date.now() + DISMISS_GRACE_MS
        for (;;) {
          if (asking) await asking
          if (!done) await askDrop()
          if (done || Date.now() >= until) break
          await new Promise((r) => setTimeout(r, Math.min(dropEveryMs, 1500)))
        }
        finish(reply)
      })()
      else finish(reply)
    }
    const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') { readTab(); askDrop() } } // back from the sign-in: ask at once
    try { bc = new BroadcastChannel('wb-mcp-signin'); bc.onmessage = (e) => finish(e.data) } catch { bc = null }
    iv = setInterval(() => { readTab(); try { const v = localStorage.getItem('space:mcpcb:' + state); if (v) finish(JSON.parse(v)) } catch { /* */ } }, 700)
    if (drop) dv = setInterval(askDrop, dropEveryMs)
    if (drop || readNative) { try { typeof document !== 'undefined' && document.addEventListener('visibilitychange', onVis) } catch { /* */ } }
    to = setTimeout(() => { if (!done) { done = true; stop(); reject(new ConnectionError('the sign-in took too long — start again', 'signin')) } }, timeoutMs)
    readTab()
  })
}

// The iPhone sheet stays open until the broker hands back the code, or the person dismisses it.
// A second attempt owns its own sheet: finishing the first must never dismiss the replacement.
let activeConsent = null
export async function connectorConsent (state, { trip, authUrl, win, broker, signal, nativeOAuth, manualLink, sheet = globalThis.WitbitzSignIn }, waitForCode = awaitMcpCallback) {
  if (signal?.aborted) throw new ConnectionError('the sign-in was started again', 'cancel')
  const url = trip ? trip.openUrl : authUrl
  const options = { drop: trip?.drop, broker, signal }
  if (!trip && sheet?.open) throw new ConnectionError('The sign-in return address could not be prepared. Tap Connect to try again.', 'signin')
  if (!trip || !sheet?.open || !sheet?.close) {
    if (nativeOAuth) {
      if (!trip) throw new ConnectionError('The sign-in could not be prepared. Tap Connect to try again.', 'signin')
      let launched = false
      try {
        const result = nativeOAuth(url)
        launched = result !== false
        if (typeof result === 'function') { options.readNative = result; options.checkDropOnDismiss = !!nativeOAuth.recoverable }
      } catch { /* the displayed link can still open the same trip */ }
      if (!launched && !manualLink?.isConnected) throw new ConnectionError('The sign-in browser could not open. Tap Connect to try again.', 'signin')
    }
    else if (win) win.location.href = url
    else if (!window.open(url, '_blank')) throw new ConnectionError('the sign-in window was blocked — allow pop-ups for this app and try again', 'signin')
    return waitForCode(state, options)
  }
  activeConsent?.abort()
  const controller = new AbortController()
  activeConsent = controller
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort)
  try {
    const nativeDrop = typeof sheet.openConnector === 'function'
    const result = Promise.resolve(nativeDrop ? sheet.openConnector(url) : sheet.open(url)).then(async reply => {
      if (controller.signal.aborted) throw new ConnectionError('the sign-in was started again', 'cancel')
      if (nativeDrop && reply?.blob) {
        const message = await openDrop(trip.drop, reply.blob)
        if (message.state !== state || (!message.code && !message.error)) throw new ConnectionError('Unexpected sign-in response. Tap Connect to try again.', 'signin')
        if (message.error) throw new ConnectionError('The provider declined the sign-in.', 'signin')
        return String(message.code)
      }
      throw new ConnectionError('Sign-in was cancelled. Tap Connect to try again.', 'dismissed')
    })
    // Only one reader may take the sealed envelope. The web listener still handles abort and timeout.
    return await Promise.race([result, waitForCode(state, { ...options, drop: nativeDrop ? null : options.drop, signal: controller.signal })])
  } finally {
    signal?.removeEventListener('abort', abort)
    controller.abort()
    if (activeConsent === controller) {
      activeConsent = null
      try { await sheet.close() } catch { /* the sheet may already have closed */ }
    }
  }
}

/** Finish: seal { state, code, callKey, id, label } to the Sentinel, which exchanges the code and files the connection. */
export async function finishMcpSignIn({ post, auth = {}, state, code, label, host, pins, verify, follow, dispKey }) {
  const att = await attestStandingSentinel({ post, auth, pins, verify, follow })
  const id = 'conn_' + b64u(crypto.getRandomValues(new Uint8Array(12)))
  const lbl = String(label || '').trim().slice(0, 80) || connectionName({ host }) // empty → the server's known name (GitHub), else the host
  // `disp` rides the sealed finish too: the Sentinel that files it from here (st28 does not yet — its mcpOauthFinish takes the
  // clear label only) keeps it as it does a grant's; until then this record shows the Sentinel's label
  const disp = dispKey ? await sealDisp(dispKey, id, { label: lbl }).catch(() => '') : ''
  const sk = await sealWithCallKey(att, { state, code, id, label: lbl, ...(disp ? { disp } : {}) }, id, { label: lbl, host })
  const r = await postGrant(post, { op: 'sentinel', sentinel: { mode: 'mcpoauthfinish', sealed: sk.sealed }, ...auth }, id, { label: lbl, host, at: Date.now() }, sk)
  if (!r || r.error || !r.ok) throw new ConnectionError(`${host}: ${(r && r.error) || 'the sign-in did not finish'}`, 'signin')
  return { id, label: lbl, host, callKey: sk.callKey, ...(sk.held ? { held: 1 } : {}) }
}

// ── A SERVICE'S OWN API THROUGH WITBITZ'S OAUTH APP (2026-11-23, Google Calendar: Google's regular Calendar API, not its preview MCP
// server). The Sentinel's provider sign-in (custody.mjs oauthStart / oauthFinish): it mints the PKCE verifier, asks Google for offline
// access, exchanges the code and keeps the refresh token — so the connection renews itself; nothing about it lives in this page.
// `tenant`/`provider`: the Witbitz app filed with the Sentinel (connCatalog.js). The consent comes back through the same pages as an
// MCP sign-in (mcpReturnTrip: the broker's /mcp-callback for Google, which Witbitz's Google client registers).
export async function startOauthSignIn({ post, auth = {}, tenant, provider }) {
  const r = await post({ op: 'sentinel', sentinel: { mode: 'oauthstart', tenant: String(tenant || ''), providerId: String(provider || '') }, ...auth })
  if (!r || r.error || !r.ok || !r.authUrl) throw new ConnectionError(`the sign-in could not start (${(r && (r.error || r.reason)) || 'no answer from the Sentinel'})`, 'signin')
  return { state: r.state, authUrl: r.authUrl }
}
/** Finish: the code and a fresh callKey ride sealed to the Sentinel, which exchanges the code (its secret, its verifier) and files it. */
export async function finishOauthSignIn({ post, auth = {}, state, code, label, host, pins, verify, follow, dispKey }) {
  const att = await attestStandingSentinel({ post, auth, pins, verify, follow })
  const id = 'conn_' + b64u(crypto.getRandomValues(new Uint8Array(12)))
  const lbl = String(label || '').trim().slice(0, 80) || String(host || '')
  const disp = dispKey ? await sealDisp(dispKey, id, { label: lbl }).catch(() => '') : ''
  const sk = await sealWithCallKey(att, { state, code, id, label: lbl, host: String(host || ''), ...(disp ? { disp } : {}) }, id, { label: lbl, host })
  const r = await postGrant(post, { op: 'sentinel', sentinel: { mode: 'oauthfinish', sealed: sk.sealed }, ...auth }, id, { label: lbl, host, at: Date.now() }, sk)
  if (!r || r.error || !r.ok) throw new ConnectionError(`${lbl}: ${(r && r.error) || 'the sign-in did not finish'}`, 'signin')
  return { id: r.id || id, label: lbl, host: r.host || host, callKey: sk.callKey, provider: 'oauth2', ...(sk.held ? { held: 1 } : {}) }
}

// ── THE WITBITZ GITHUB APP (docs/cloud-computer-connections.md, Part B) ────────────────────────────────────────────────
// GitHub's own install page: the person picks which repositories, GitHub sends them back to /github-callback with the
// install id AND a sign-in code (the app asks for that during install). The code is what proves the install is theirs —
// sealed to the Sentinel with a fresh callKey, exchanged and checked there; an install id alone proves nothing.
/** The app's slug (for the install page) → { slug, owner } or throws. */
export async function gitHubAppInfo({ post, auth = {} }) {
  const r = await post({ op: 'sentinel', sentinel: { mode: 'ghappinfo' }, ...auth })
  if (!r || r.error || !r.ok || !r.slug) throw new ConnectionError(r && r.status === 404 ? 'the Witbitz GitHub app is not set up yet' : `could not reach the Witbitz GitHub app (${(r && r.error) || 'no answer'})`, 'ghapp')
  return { slug: String(r.slug), owner: String(r.owner || '') }
}
export const gitHubInstallUrl = (slug, state) => `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`
/** What /github-callback hands back for `state`: { installationId, code }, a BroadcastChannel message or its localStorage note. */
export function awaitGitHubInstall(state, { timeoutMs = 15 * 60_000, drop = null, broker, fetchImpl, dropEveryMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false, bc = null, iv = 0, to = 0, dv = 0, asking = false
    const stop = () => { clearInterval(iv); clearInterval(dv); clearTimeout(to); try { bc && bc.close() } catch { /* */ }; try { typeof document !== 'undefined' && document.removeEventListener('visibilitychange', onVis) } catch { /* */ } }
    const finish = (m) => {
      if (done || !m || (m.state && m.state !== state)) return
      done = true; stop()
      try { localStorage.removeItem('space:ghcb:' + state); localStorage.removeItem('space:ghcb:last') } catch { /* */ }
      if (m.error || !m.installationId) reject(new ConnectionError(`GitHub did not finish the install (${String(m.error || 'no installation').slice(0, 80)})`, 'ghapp'))
      else resolve({ installationId: Number(m.installationId), code: String(m.code || '') })
    }
    // the hosted app's frame shares nothing with GitHub's window (as an MCP sign-in, mcpReturnTrip): what it sealed at the broker
    const askDrop = async () => { if (done || asking || !drop) return; asking = true; try { finish(await takeDrop(drop, { ...(broker ? { broker } : {}), ...(fetchImpl ? { fetchImpl } : {}) })) } catch { /* not there yet */ } finally { asking = false } }
    const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') askDrop() }
    try { bc = new BroadcastChannel('wb-github-install'); bc.onmessage = (e) => finish(e.data) } catch { bc = null }
    // GitHub carries `state` back only on some paths; with one install in flight, the note without a state is this one's.
    iv = setInterval(() => { try { const v = localStorage.getItem('space:ghcb:' + state) || localStorage.getItem('space:ghcb:last'); if (v) finish(JSON.parse(v)) } catch { /* */ } }, 700)
    if (drop) dv = setInterval(askDrop, dropEveryMs)
    if (drop) { try { typeof document !== 'undefined' && document.addEventListener('visibilitychange', onVis) } catch { /* */ } }
    to = setTimeout(() => { if (!done) { done = true; stop(); reject(new ConnectionError('the GitHub install took too long — start again', 'ghapp')) } }, timeoutMs)
  })
}
/** Finish: seal { code, installationId, callKey, id } to the Sentinel, which checks the install is this person's and files it. */
export async function finishGitHubInstall({ post, auth = {}, code, installationId, pins, verify, follow }) {
  const att = await attestStandingSentinel({ post, auth, pins, verify, follow })
  const id = 'conn_' + b64u(crypto.getRandomValues(new Uint8Array(12)))
  const sk = await sealWithCallKey(att, { code: String(code || ''), installationId: Number(installationId), id }, id, { label: 'GitHub', host: 'api.github.com' })
  // no pending key in the page here (as before: the Sentinel may file it under its own id); a vault's is settled under the filed one
  const body = { op: 'sentinel', sentinel: { mode: 'ghappfinish', sealed: sk.sealed }, ...auth }
  const r = sk.held ? await postGrant(post, body, id, null, sk, undefined, (x) => ({ id: String(x.id || id), label: `GitHub · ${x.login || 'app'}`, account: String(x.account || '') })) : await post(body)
  if (!r || r.error || !r.ok) throw new ConnectionError(`GitHub: ${(r && r.error) || 'the install could not be connected'}`, 'ghapp')
  return { id: String(r.id || id), callKey: sk.callKey, ...(sk.held ? { held: 1 } : {}), account: String(r.account || ''), login: String(r.login || ''), installationId: Number(r.installationId || installationId), label: `GitHub · ${r.login || 'app'}` }
}

/** The server's tools, as the Sentinel lists them for the account that owns the connection. */
export async function listMcpTools({ post, auth = {}, id }) {
  const r = await post({ op: 'sentinel', sentinel: { mode: 'mcplist', id }, ...auth })
  if (!r || r.error || !r.ok) throw new ConnectionError(`could not read the server’s tools (${(r && r.error) || 'no answer'})`, 'list')
  return { tools: Array.isArray(r.tools) ? r.tools : [], server: r.server || null, truncated: !!r.truncated }
}

/** What changed between the tools a room chose and what the server lists now — shown before anything is adopted. */
export function mcpToolDiff(kept, now) {
  const k = new Map((kept || []).map((t) => [t.name, t])), n = new Map((now || []).map((t) => [t.name, t]))
  const added = [...n.keys()].filter((x) => !k.has(x))
  const removed = [...k.keys()].filter((x) => !n.has(x))
  const changed = [...k.keys()].filter((x) => n.has(x) && (k.get(x).description !== n.get(x).description || JSON.stringify(k.get(x).inputSchema) !== JSON.stringify(n.get(x).inputSchema)))
  return { added, removed, changed, same: !added.length && !removed.length && !changed.length }
}
