// witbitz-admin.js — the BUILDER's SDK: what your server does with your tenant SECRET key (wsk_…).
// https://witbitz.chat/docs/sdk-roadmap.md, item 5 (2026-10-05). These ops used to live only on the page client (`wb.origins`,
// `wb.users`, …), so the code that takes a secret key shipped in every page bundle and nothing but a doc comment said
// "server only". They live here now; the page client's old names delegate here and keep working.
//
//   import { WitbitzAdmin } from 'https://witbitz-spaces.pages.dev/witbitz-admin.js'   // on YOUR server
//   const admin = new WitbitzAdmin({ tenant: 'acme', tenantKey: process.env.WITBITZ_TENANT_KEY })
//   await admin.verifyTenantKey()            // → { ok: true, tenant }
//   await admin.origins.declare(['https://app.acme.com'])
//   const c = await admin.customers.create({ userRef: 'acct_42' })   // a customer YOU bill — not a Witbitz account
//
// `customers` is the new name of `wb.users`: your app's billed users, each with its own capped provider key.
import { attestStandingSentinel, STANDING_SENTINEL_PCR0 } from './connections.js'
import { sealTo as sealToEnclave } from './sealShare.js'
import { hide, redacted, REDACTED } from './sdkRedact.js'
// Every error a builder can switch on carries a `code`, as the SDK's do (sync sweep, 10-13): no_tenant_key, invalid_argument,
// the server's own refusal (refused when it names none), plus the HTTP ones above (unauthorized, bad_response, …).
const adminError = (code, message) => Object.assign(new Error(message), { code: String(code || 'refused') })


export const DEFAULT_ENDPOINT = 'https://api.witbitz.chat/v1/space'

// RETIRED in 4.0.0 — YOUR APP'S OWNER KEY, rooms only your app may use (B8). The rule it signed required a page SERVED as your app: a
// web page vouching for itself, which anyone can copy (the owner, 2026-11-22: "We dont need any emulation rooms"). Every call says so
// by name; no app ever registered a key (checked 2026-11-22), so no room depended on it.
const ownerRetired = () => adminError('owner_rule_retired', 'witbitz: the owner rule (rooms only your app may use) is retired — a web page cannot prove which app it is (sdk-changes.md, 4.0.0)')
class TenantOwner {
  constructor (admin) { this._a = admin }
  async register () { throw ownerRetired() }
  async rotate () { throw ownerRetired() }
  async room () { throw ownerRetired() }
}

export class WitbitzAdmin {
  /** RETIRED in 4.0.0 (the owner rule, above). */
  static async generateOwnerKey () { throw ownerRetired() }
  /** @param {object} opts { tenant, tenantKey, signingKey?, endpoint?, tenantEndpoint?, fetchImpl?, sentinel? } — `signingKey`: your
   *  tenant's Ed25519 PRIVATE key (a JWK, or its JSON string; WitbitzAdmin.generateSigningKey()), kept on your server. */
  constructor({ tenant = '', tenantKey = '', signingKey = null, endpoint = DEFAULT_ENDPOINT, tenantEndpoint, fetchImpl, sentinel } = {}) {
    this._endpoint = endpoint
    this._tenant = tenant || ''
    this._tenantKey = tenantKey || ''
    this._signingKey = signingKey ? (typeof signingKey === 'string' ? JSON.parse(signingKey) : signingKey) : null
    this._tenantEndpointOverride = tenantEndpoint ? String(tenantEndpoint) : ''
    this._fetch = typeof fetchImpl === 'function' ? fetchImpl : ((...a) => fetch(...a))
    this.owner = new TenantOwner(this) // RETIRED in 4.0.0: each call answers owner_rule_retired
    // A NEW WITBITZ SENTINEL BUILD IS FOLLOWED, as in the SDK (witbitz-sdk.js; sync sweep 10-19 #5): `follow` 'published' (the
    // default) takes a build Witbitz publishes at /sentinel-claim.json, 'off' keeps the pins. Your own `pins` are never followed.
    const ownPins = !!(sentinel && Array.isArray(sentinel.pins)), off = !!(sentinel && sentinel.follow === 'off')
    this._sentinel = { pins: ownPins ? sentinel.pins : STANDING_SENTINEL_PCR0, ...(sentinel && typeof sentinel.verify === 'function' ? { verify: sentinel.verify } : {}),
      follow: ownPins || off ? null : { auto: () => true, ask: async () => false, claimUrl: String((sentinel && sentinel.claimUrl) || 'https://witbitz-spaces.pages.dev/sentinel-claim.json'), fetch: (u, o) => this._fetch(u, o) } }
    /** The page origins that act for this tenant. */
    this.origins = new TenantOrigins(this)
    /** Your app's name — what a sign-in mail from your pages says ("Your Keepwarden code"). */
    this.app = new TenantApp(this)
    /** The hosts your users may attach a key for. */
    this.hosts = new DeclaredHosts(this)
    /** Your own OAuth apps. */
    this.providers = new Providers(this)
    /** Delete / restore your rooms. */
    this.rooms = new TenantRooms(this)
    /** Your tenant's signing key: register its public half once; from then on every tenant request is signed by it. */
    this.signing = new TenantSigning(this)
    /** Your app's billed customers (per-user billing) — not Witbitz accounts. */
    this.customers = new TenantCustomers(this)
    /** What you are billed. */
    this.billing = new TenantBilling(this)
    /** Your API keys — including RESTRICTED keys that carry only the capabilities you choose. */
    this.keys = new TenantKeys(this)
    hide(this, ['_tenantKey', '_signingKey', '_fetch'])
  }

  /** The BUILDER's transport: the same endpoint with a tenant SECRET key, which the /v1 authorizer resolves to a
   *  tenant before this reaches any handler. Server-side only. */
  /**
   * ⛔ A BUILDER CALL MUST NOT GO TO THE SPACE ENDPOINT (2026-09-27, found by a builder whose key was fine all along).
   * `/v1/space` is deliberately KEYLESS — a Space authenticates by its own key-commitment — so no authorizer runs there
   * and an `authorization: Bearer wsk_…` header is never examined. Every builder op therefore answered 403
   * `tenant_required`, identically for a real key and a forged one, and the whole builder half was unreachable in
   * production while the refusal read like a bad secret. Builder ops belong on the AUTHENTICATED twin, where the
   * gateway checks the key and hands the handler a tenant it cannot have been told.
   */
  _tenantEndpoint() {
    if (this._tenantEndpointOverride) return this._tenantEndpointOverride
    // Derive rather than hardcode: a staging or self-hosted deployment answers the Space at its own path, and its
    // tenant twin sits beside it. Only the last segment moves, so a query or a port is untouched.
    return this._endpoint.replace(/\/space(?=$|[?#])/, '/tenant-space')
  }

  /** A /v1/tenant REST route beside the tenant twin (`/v1/tenant-space` → `/v1/tenant` + path), called with the tenant
   *  key. Unlike the twin these answer the /v1 envelope — `{ data }` or `{ error: { code, message } }` — and a refusal
   *  is thrown with the server's own words, since they name exactly what was wrong. */
  async _tenantRest(method, path, body, { envelope = true, root = '/tenant', text = false } = {}) {
    const key = this._tenantKey
    if (!key) throw adminError('no_tenant_key', 'witbitz: this needs a tenant secret key (wsk_), or a restricted key (wrk_) with the capability — new WitbitzAdmin({ tenant, tenantKey }) ON YOUR SERVER, never in a page')
    const url = this._tenantEndpoint().replace(/\/tenant-space(?=$|[?#])/, root + path)
    const r = await this._fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${key}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (text && r && r.ok !== false) return r.text()
    let j = null; try { j = await r.json() } catch { j = null }
    if (r && r.ok === false) {
      // The /v1 envelope says { error: { code, message } }; the room-purge route says { error, message } — read both.
      const err = j && j.error ? (typeof j.error === 'object' ? j.error : { code: String(j.error), message: j.message || String(j.error) }) : null
      const auth = !err && (r.status === 401 || r.status === 403)
      const e = new Error(auth
        ? `witbitz: the tenant key was not accepted at ${url} (HTTP ${r.status}) — check the key with verifyTenantKey()`
        : `witbitz: ${url} refused: ${(err && err.message) || 'HTTP ' + r.status}`)
      e.code = auth ? 'tenant_key_rejected' : ((err && err.code) || 'http_' + r.status)
      e.status = r.status
      throw e
    }
    if (!j || typeof j !== 'object' || (envelope && !j.data)) { const e = new Error(`witbitz: ${url} did not answer with data`); e.code = 'bad_response'; throw e }
    return envelope ? j.data : j
  }

  _tenantPost() {
    const key = this._tenantKey
    if (!key) throw adminError('no_tenant_key', 'witbitz: this needs a tenant secret key — new WitbitzAdmin({ tenant, tenantKey }) ON YOUR SERVER, never in a page')
    const url = this._tenantEndpoint()
    return async (body) => {
      // SIGNED (docs/standing-sentinel.md § Step 1e): with a signing key, a Sentinel request carries its own signature, which
      // the Sentinel checks itself — so no one between your server and the enclave (the Witbitz Lambda included) can act as
      // your tenant. `whoami` is answered by the door, not the Sentinel, and is never signed.
      if (this._signingKey && body && body.op === 'sentinel' && body.sentinel && body.sentinel.mode !== 'whoami') body = await this._signed(body)
      const r = await this._fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) })
      // ⛔ CHECK THE STATUS BEFORE THE BODY (2026-09-27). The /v1 gateway refuses an unknown key with a 403 whose body
      // is {"message":"Forbidden"} — which PARSES, so returning it verbatim handed callers an object with neither
      // `error` nor the field they wanted. `attestStandingSentinel` then said "the Sentinel could not be reached (no
      // attestation)", and a builder went hunting for a fault in our enclave that did not exist. The enclave was never
      // asked; their key was refused one hop earlier, and the status code said so all along.
      // It THROWS rather than returning an error object, deliberately: every caller wraps a returned error in its own
      // sentence ("could not list hosts…", "the Sentinel could not be reached…"), and those sentences all blame the
      // wrong thing when the truth is that the gateway refused the key one hop before any of them. A throw carries the
      // real cause past all of that. `verifyTenantKey` is the one caller that WANTS a no rather than an exception, and
      // it catches.
      if (r && r.ok === false) {
        const auth = r.status === 401 || r.status === 403
        // The server's own reason, when it gave one (2026-10-10: a builder's erase saw "HTTP 503" and nothing else). A 503
        // with no Witbitz body is API Gateway's 30 s cap: the work may still have finished — say so.
        let reason = null
        if (!auth) { try { const b = await r.json(); reason = b && (b.error || b.message) ? b : null } catch { reason = null } }
        const said = reason && reason.error ? `: ${reason.error}${reason.reason ? ' — ' + reason.reason : ''}` : ''
        const timedOut = (r.status === 503 || r.status === 504) && !(reason && reason.error)
        const e = new Error(auth
          ? `witbitz: the tenant key was not accepted at ${url} (HTTP ${r.status}). The enclave was never reached — check the key with verifyTenantKey()`
          : timedOut
            ? `witbitz: ${url} answered HTTP ${r.status} — the request ran past the gateway's 30 s limit; it may still have finished. Call again: the operation is safe to repeat`
            : `witbitz: ${url} answered HTTP ${r.status}${said}`)
        e.code = auth ? 'tenant_key_rejected' : timedOut ? 'gateway_timeout' : (reason && reason.error) || 'http_' + r.status
        e.status = r.status
        if (reason) e.body = reason
        throw e
      }
      try { return await r.json() } catch { const e = new Error(`witbitz: ${url} did not answer with JSON`); e.code = 'bad_response'; throw e }
    }
  }

  /** Is this tenant key good, and whose is it? → `{ ok: true, tenant }` or `{ ok: false, reason }`.
   *
   *  It exists because there was no way to ask (a builder, 2026-09-27: *"I am not 100% sure the secret I saved was the
   *  right one, but currently I can't even check that"*). Reaching the answer at all is the proof: the gateway refuses a
   *  key it does not recognise before this ever runs. Costs nothing — no enclave round trip, and it works on a
   *  deployment with no standing Sentinel, which is exactly when someone is setting one up. */
  /** The tenant's own signature over one request: Ed25519 over "witbitz-tenant-op v1\n<tenant>\n<ts>\n<nonce>\n<hex sha256(req)>", where
   *  <tenant> is the name the gateway knows this tenant key by (asked once, `whoami`) and <req> the exact JSON sent. */
  async _signed(body) {
    if (!this._signedTenant) { const v = await this.verifyTenantKey(); if (!v.ok) throw adminError('tenant_key_rejected', 'witbitz: could not sign — ' + v.reason); this._signedTenant = v.tenant }
    const req = JSON.stringify(body.sentinel), ts = String(Date.now())
    const nonce = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))
    const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(req)))
    const msg = `witbitz-tenant-op v1\n${this._signedTenant}\n${ts}\n${nonce}\n${Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')}`
    const key = await globalThis.crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: this._signingKey.d, x: this._signingKey.x }, { name: 'Ed25519' }, false, ['sign'])
    const sig = new Uint8Array(await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(msg)))
    return { ...body, sentinel: JSON.parse(req), tsig: { ts, nonce, sig: b64u(sig), req } }
  }

  /** A new tenant signing key: `{ privateKey }` (a JWK — keep it on your server, as you keep the tenant key) and `{ publicKey }`
   *  (raw Ed25519, base64url — what `admin.signing.register()` files). */
  static async generateSigningKey() {
    const k = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', k.privateKey)
    return { privateKey: { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x }, publicKey: jwk.x }
  }

  async verifyTenantKey() {
    // ★ Two different things, and only one of them is an answer. NO KEY CONFIGURED is a programming error — the caller
    // forgot `new Witbitz({ tenantKey })` — so building the poster stays OUTSIDE the catch and still throws. A key the
    // gateway REFUSES is exactly the question this method exists to ask, so that one comes back as a plain no.
    const post = this._tenantPost()
    let r
    try { r = await post({ op: 'sentinel', sentinel: { mode: 'whoami' } }) }
    catch (e) { return { ok: false, reason: String((e && e.message) || e), code: (e && e.code) || '' } }
    if (r && r.ok && r.tenant) return { ok: true, tenant: String(r.tenant) }
    const reason = (r && (r.reason || r.message || r.error)) || 'no answer'
    return { ok: false, reason: String(reason) }
  }

}

redacted(WitbitzAdmin.prototype, (a) => ({ tenant: a._tenant || null, tenantKey: a._tenantKey ? REDACTED : null, ...(a._signingKey ? { signingKey: REDACTED } : {}) }))

const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** `admin.signing` — your tenant's signing key (docs/standing-sentinel.md § Step 1e). The FIRST key is registered on your tenant
 *  key alone; once one is registered, every request of this tenant must be signed by it, and a new key is registered only by a
 *  request signed with the current one (so a stolen tenant key alone can neither act nor swap the signing key). */
class TenantSigning {
  constructor(admin) { this._a = admin; hide(this, ['_a']) }
  /** Which signing key the Sentinel holds for this tenant: `{ registered, key }`. Watch it — removing the record from the store is
   *  the one change someone with access to the Sentinel's storage could make (it cannot be forged, only deleted). */
  async status() {
    const r = await this._a._tenantPost()({ op: 'sentinel', sentinel: { mode: 'tenantkeyget' } })
    if (!r || r.error) throw adminError('refused', 'witbitz: the signing key could not be read' + (r && r.error ? ': ' + r.error : ''))
    return { registered: !!r.key, key: r.key || null, origins: Array.isArray(r.origins) ? r.origins : null }
  }
  /** File your SIGNED list of origins with the Sentinel (default: the list you declared — origins.list()). Once filed, a page
   *  that names your tenant there must be one of these; Witbitz's own app may name you only if you list one of its origins.
   *  Needs a registered signing key. Replaces the list held. */
  async publishOrigins(origins) {
    const list = Array.isArray(origins) ? origins.map(String) : await this._a.origins.list()
    if (!this._a._signingKey) throw adminError('no_signing_key', 'witbitz: publishOrigins signs the list — new WitbitzAdmin({ …, signingKey })')
    const r = await this._a._tenantPost()({ op: 'sentinel', sentinel: { mode: 'tenantorigins', origins: list } })
    if (!r || !r.ok) throw adminError((r && r.error && String(r.error).split(':')[0]) || 'refused', 'witbitz: the origin list was not filed' + (r && r.error ? ': ' + r.error : ''))
    return { ok: true, origins: r.origins || list }
  }
  /** File the public half of `publicKey` (default: this client's own signing key). Signed by this client's key when it has one. */
  async register(publicKey) {
    const key = String(publicKey || (this._a._signingKey && this._a._signingKey.x) || '')
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw adminError('invalid_argument', 'witbitz: signing.register needs a raw Ed25519 public key (base64url) — or a client made with { signingKey }')
    const r = await this._a._tenantPost()({ op: 'sentinel', sentinel: { mode: 'tenantkey', key } })
    if (!r || !r.ok) throw adminError((r && r.error && String(r.error).split(':')[0]) || 'refused', 'witbitz: the signing key was not registered' + (r && r.error ? ': ' + r.error : ''))
    return { ok: true, key }
  }
}

/** `wb.providers` — a BUILDER's own OAuth apps (https://witbitz.chat/docs/connections.md). Their users consent to THEM, so this
 *  platform never requests a sensitive or restricted scope on anyone's behalf. **Server-side only**: it needs your
 *  tenant SECRET key, and a page that holds one has given it away. */
class Providers {
  constructor (wb) { this._wb = wb }
  /** Attach your OAuth app once. The client secret is sealed to the attested enclave and is gone from your process
   *  when this returns. `kind` is one the enclave knows ('google'); the consent URL and every host come from there,
   *  not from you, so no provider can point your users at an unmeasured screen. → { id, kind } */
  async attach ({ kind = 'google', clientId, clientSecret, redirectUri, scopes, label, tenant } = {}) {
    const wb = this._wb
    const t = String(tenant || wb._tenant || '')
    if (!t) throw adminError('invalid_argument', 'witbitz: which tenant? pass new WitbitzAdmin({ tenant, tenantKey }) — the key proves it, the id names it')
    if (!clientId || !clientSecret) throw adminError('invalid_argument', 'witbitz: a provider needs your OAuth clientId and clientSecret')
    if (!/^https:\/\//.test(String(redirectUri || ''))) throw adminError('invalid_argument', 'witbitz: redirectUri must be the https callback you registered with the provider')
    if (!Array.isArray(scopes) || !scopes.length) throw adminError('invalid_argument', 'witbitz: name at least one scope your users will be asked for')
    const post = wb._tenantPost()
    const { nonce, key } = await attestStandingSentinel({ post, auth: {}, pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow })
    const id = 'prov_' + randomId(12)
    const sealed = await sealToEnclave(key, nonce, { id, tenant: t, kind, clientId, clientSecret: String(clientSecret), redirectUri, scopes: scopes.map(String), label: String(label || '') })
    const r = await post({ op: 'sentinel', sentinel: { mode: 'provgrant', sealed } })
    if (!r || r.error || !r.ok) throw adminError((r && r.error) || 'refused', `witbitz: the provider was refused (${(r && (r.error || r.reason)) || 'no answer'})`)
    return { id, kind, tenant: t }
  }
  /** A REGISTERED MCP CLIENT: for an MCP server whose sign-in does not let apps register themselves (GitHub, Asana, Box…),
   *  the OAuth app you registered with that sign-in's `issuer` (as its metadata names it, e.g. https://github.com/login/oauth),
   *  and the exact https callback addresses you registered (your page's `/mcp-callback`). Today only the Spaces app signs
   *  in to MCP servers, with the apps filed under its own tenant; one filed under yours is kept for when the SDK does
   *  (connections.md). The secret (if the issuer gave one) is sealed to the attested enclave. `scopes`: the scopes your app was
   *  approved for (a string or an array) — a sign-in with it asks for exactly those, not the server's whole list (Google's
   *  Calendar server lists twelve). → { id, kind: 'mcp' } */
  async attachMcp ({ issuer, clientId, clientSecret = '', redirectUris, label, tenant, webhookSecret = '', scopes = '' } = {}) {
    const wb = this._wb
    const t = String(tenant || wb._tenant || '')
    if (!t) throw adminError('invalid_argument', 'witbitz: which tenant? pass new WitbitzAdmin({ tenant, tenantKey }) — the key proves it, the id names it')
    if (!/^https:\/\//.test(String(issuer || ''))) throw adminError('invalid_argument', 'witbitz: issuer must be the https sign-in issuer, like https://github.com/login/oauth')
    if (!clientId) throw adminError('invalid_argument', 'witbitz: a registered MCP client needs the clientId the issuer gave you')
    if (!Array.isArray(redirectUris) || !redirectUris.length || !redirectUris.every((u) => /^https:\/\//.test(String(u)))) throw adminError('invalid_argument', 'witbitz: redirectUris — the https callback addresses you registered with the issuer')
    const scopeList = (Array.isArray(scopes) ? scopes.map(String) : String(scopes || '').split(/\s+/)).filter(Boolean)
    if (scopeList.length > 30 || !scopeList.every((x) => /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(x))) throw adminError('invalid_argument', 'witbitz: scopes — the scope names your app was approved for')
    if (webhookSecret && String(webhookSecret).length < 8) throw adminError('invalid_argument', 'witbitz: webhookSecret — the secret the service signs its notices with (Zoom: the app\'s Secret Token)')
    const post = wb._tenantPost()
    const { nonce, key } = await attestStandingSentinel({ post, auth: {}, pins: wb._sentinel.pins, verify: wb._sentinel.verify, follow: wb._sentinel.follow })
    const id = 'prov_' + randomId(12)
    // webhookSecret: the service's "the person removed your app" notices are checked with it, inside the Sentinel (sealed like the client secret)
    const sealed = await sealToEnclave(key, nonce, { id, tenant: t, kind: 'mcp', issuer: String(issuer), clientId: String(clientId), clientSecret: String(clientSecret || ''), redirectUris: redirectUris.map(String), label: String(label || ''), ...(webhookSecret ? { webhookSecret: String(webhookSecret) } : {}), ...(scopeList.length ? { scopes: scopeList.join(' ') } : {}) })
    const r = await post({ op: 'sentinel', sentinel: { mode: 'provgrant', sealed } })
    if (!r || r.error || !r.ok) throw adminError((r && r.error) || 'refused', `witbitz: the MCP client was refused (${(r && (r.error || r.reason)) || 'no answer'})`)
    return { id, kind: 'mcp', tenant: t }
  }
  /** Your tenant's providers — never a client secret. */
  async list () {
    const r = await this._wb._tenantPost()({ op: 'sentinel', sentinel: { mode: 'provlist' } })
    if (!r || r.error) throw adminError((r && r.error) || 'refused', `witbitz: could not list providers (${(r && r.error) || 'no answer'})`)
    return Array.isArray(r.providers) ? r.providers : []
  }
  /** Remove an OAuth app. Every connection your users made under it dies at once. → { revoked, connections } */
  async revoke (id) {
    const r = await this._wb._tenantPost()({ op: 'sentinel', sentinel: { mode: 'provrevoke', id: String(id || '') } })
    if (!r || r.error) throw adminError((r && r.error) || 'refused', `witbitz: could not revoke (${(r && r.error) || 'no answer'})`)
    return { revoked: Number(r.revoked) || 0, connections: Number(r.connections) || 0 }
  }
}

const randomId = (n) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** `wb.rooms` — what a tenant does to its rooms from its server. **Server-side only**: it needs your tenant key. */
class TenantRooms {
  constructor (wb) { this._wb = wb }
  /** Delete ONE room. Afterwards it answers 410 to everyone, at once, whichever retention you choose:
   *    retain: 'none'     (default) every stored version of everything is deleted now — sealed messages, files, the
   *                       confidential tier's copies. Irreversible.
   *    retain: 'backups'  the current copies are deleted now; old versions expire within 35 days (recoverable only by
   *                       Witbitz operators, by hand, until then).
   *    retain: 'grace'    nothing is deleted yet; `rooms.restore(room)` undoes it for `graceDays` (1–90, default 30),
   *                       then it is purged as `after` says ('none' default, or 'backups').
   *  Only for a room no one else uses — a shared room belongs to its other members too, and the server cannot tell
   *  (membership is sealed), so that is yours to decide.
   *  → none/backups: { deleted:true, room, retain, versions, bytes, turnWasRunning, backupsUntil? }
   *  → grace:        { deleted:false, held:true, room, purgeAt, after }
   *  When `turnWasRunning`, a reply being written may land a moment later: call delete again after a few minutes.
   *  Throws if anything could not be removed (code 'partial') — never a half-done delete reported as done. */
  async delete (room, { retain, graceDays, after } = {}) {
    if (typeof room !== 'string' || !/^(?:sp|tmp)-[0-9a-z-]{1,48}$/.test(room)) throw adminError('invalid_argument', 'witbitz: rooms.delete takes a room id, e.g. "sp-…"')
    const body = { confirm: room, ...(retain ? { retain } : {}), ...(graceDays !== undefined ? { graceDays } : {}), ...(after ? { after } : {}) }
    const r = await this._wb._tenantRest('DELETE', '/rooms/' + encodeURIComponent(room), body, { envelope: false })
    if (r.held) return { deleted: false, held: true, room: r.room, purgeAt: Number(r.purgeAt) || 0, after: r.after || 'none' }
    if (!r.deleted) { const e = new Error(`witbitz: room ${room} was only partly deleted — call delete again`); e.code = 'partial'; e.result = r; throw e }
    return { deleted: true, room: r.room, retain: r.retain || 'none', versions: Number(r.versions) || 0, bytes: Number(r.bytes) || 0, turnWasRunning: !!r.turnWasRunning, ...(r.backupsUntil ? { backupsUntil: Number(r.backupsUntil) } : {}) }
  }
  /** Your rooms, a page at a time: `{ rooms: [{ room, createdAt, lastUsedAt, kind, split, gated, held }], next }`.
   *  `createdAt` / `lastUsedAt` are ISO times or null (`lastUsedAt` is when a member last opened, wrote or prompted in it;
   *  recorded since 2026-10-07). `held` is `{ purgeAt }` for a room pending deletion. Pass `next` back as `cursor`. */
  async list ({ cursor, limit } = {}) {
    const q = new URLSearchParams({ list: '1', ...(cursor ? { cursor } : {}), ...(limit ? { limit: String(limit) } : {}) })
    const r = await this._wb._tenantRest('GET', '?' + q.toString(), null, { envelope: false, root: '/tenant/rooms' })
    return { rooms: Array.isArray(r.rooms) ? r.rooms : [], next: r.next || null }
  }
  /** THE IDLE RULE: rooms no member used for `days` (30–3650) are held for 30 days — gone at once, restorable with
   *  `rooms.restore(room)` — then deleted, by a daily run. `null` turns it off. A room with no recorded use counts from
   *  2026-10-07. At most 100 of your rooms are held per day. → { idleRoomDays } */
  async idleDeletion (days) {
    if (days !== null && !(Number.isInteger(days) && days >= 30 && days <= 3650)) throw adminError('invalid_argument', 'witbitz: rooms.idleDeletion(days) — a whole number of days from 30 to 3650, or null to turn it off')
    const d = await this._wb._tenantRest('PUT', '/webhooks', { idleRoomDays: days })
    return { idleRoomDays: d && d.tenant ? d.tenant.idle_room_days ?? null : days }
  }
  /** Undo a `retain: 'grace'` delete before its window ends. → { restored:true, room }. A room deleted with 'none' or
   *  'backups', or whose window has ended, cannot come back (code 'purged' / 'grace_ended'). */
  async restore (room) {
    if (typeof room !== 'string' || !/^(?:sp|tmp)-[0-9a-z-]{1,48}$/.test(room)) throw adminError('invalid_argument', 'witbitz: rooms.restore takes a room id, e.g. "sp-…"')
    const r = await this._wb._tenantRest('POST', '/rooms/' + encodeURIComponent(room) + '/restore', {}, { envelope: false })
    return { restored: !!r.restored, room: r.room }
  }
}

const USER_ID = /^u_[a-z0-9]{24}$/
const userIdOf = (id, what) => { if (typeof id !== 'string' || !USER_ID.test(id)) throw adminError('invalid_argument', `witbitz: ${what} takes a user id, e.g. "u_…" (from users.create)`); return id }

/** `wb.users` — PER-USER BILLING (https://witbitz.chat/docs/sdk-builder.md#user-billing). Each user you create gets its OWN provider key with a
 *  strict monthly cap, so what a user costs is what the provider reports for that key. Your server mints a short-lived
 *  token for the signed-in user and hands it to their page (`wb.useUserToken`). **Server-side only**: needs your tenant key. */
/** `admin.keys` — mint, list and revoke your tenant API keys (with your SECRET key; no other key can). A RESTRICTED key
 *  (wrk_) carries only the capabilities you choose, an optional expiry and an optional ceiling on the customer caps it may
 *  set — give your account server `customers:write` + `customers:tokens` instead of the key that can delete everything.
 *  Capabilities: customers:read · customers:write · customers:tokens · customers:erase · rooms:read · rooms:write ·
 *  rooms:delete · settings:read · settings:write · origins:write · integrations:write · billing:read · wallets:grant ·
 *  apps:release (the builder release API's release routes).
 *  Never grantable: managing keys, deleting the tenant, deleting every room. */
class TenantKeys {
  constructor (wb) { this._wb = wb }
  /** → [{ keyId, type, label, createdAt, revoked, display, scopes?, expiresAt?, maxCustomerCapUsd? }] — never a key */
  async list () { return await this._wb._tenantRest('GET', '/keys') }
  /** → { key, keyId, type, scopes?, maxCustomerCapUsd?, expiresAt? } — `key` is shown ONCE: store it now.
   *  @param {object} opts { type: 'restricted' | 'secret' | 'publishable', label?, scopes?, expiresAt?, maxCustomerCapUsd? } */
  async create ({ type = 'restricted', label, scopes, expiresAt, maxCustomerCapUsd } = {}) {
    const d = await this._wb._tenantRest('POST', '/keys', { type, ...(label ? { label } : {}), ...(scopes ? { scopes } : {}), ...(expiresAt != null ? { expiresAt } : {}), ...(maxCustomerCapUsd != null ? { maxCustomerCapUsd } : {}) })
    return { key: d.key, keyId: d.key_id, type: d.type, ...(d.type === 'restricted' ? { scopes: d.scopes || [], maxCustomerCapUsd: d.max_customer_cap_usd ?? null, expiresAt: d.expires_at ?? null } : {}) }
  }
  /** Revoke a key — refused from then on. → { revoked: true, keyId } */
  async revoke (keyId) {
    if (!/^k_[0-9A-Za-z]{1,40}$/.test(String(keyId || ''))) throw adminError('invalid_argument', 'witbitz: keys.revoke(keyId) — the keyId from keys.list()')
    await this._wb._tenantRest('DELETE', '/keys/' + encodeURIComponent(keyId), null, { envelope: false, text: true })
    return { revoked: true, keyId }
  }
}

class TenantCustomers {
  constructor (wb) { this._wb = wb }
  /** `userRef` — YOUR label for the user (1–120 chars; shown to you in billing, never to the provider). `capMonthlyUsd`
   *  — a hard monthly stop (default 25). → { userId, userRef, capMonthlyUsd, createdAt, revoked } */
  async create ({ userRef, capMonthlyUsd } = {}) {
    const d = await this._wb._tenantRest('POST', '/users', { userRef, ...(capMonthlyUsd !== undefined ? { capMonthlyUsd } : {}) })
    return d.user
  }
  /** Every user you created, oldest first — nothing secret. */
  async list () { return await this._wb._tenantRest('GET', '/users') }
  /** Change a user's monthly cap — a plan upgrade or a cancellation. The provider's limit moves first; the user, their key
   *  and their history stay the same. A revoked user cannot be changed. → the user, as `create` returns it. */
  async update (userId, { capMonthlyUsd } = {}) {
    const d = await this._wb._tenantRest('PATCH', '/users/' + userIdOf(userId, 'users.update'), { capMonthlyUsd })
    return d.user
  }
  /** Revoke: the user's provider key is deleted and their tokens stop working. Spend up to now is still billed. */
  async revoke (userId) { await this._wb._tenantRest('DELETE', '/users/' + userIdOf(userId, 'users.revoke'), null, { envelope: false, text: true }); return { revoked: true, userId } }
  /** ERASE A USER WHO IS GONE (https://witbitz.chat/docs/sdk-builder.md#user-erasure): the Spaces this person created in YOUR app that nobody else used are
   *  deleted — every message, file and stored version. Shared Spaces stay (what they wrote is part of the others'
   *  conversation); Spaces they only joined are not theirs to delete. Works from the list the person's own devices filed,
   *  sealed, with Witbitz's attested enclave for your app; you never see it. Run it again after a partial result
   *  (`failed` > 0 or `incomplete`) — nothing is lost. Pair it with `revoke(userId)` for their billing.
   *  → { filed, rooms, deleted, shared, notTheirs, failed, cleared } */
  async erase ({ email } = {}) {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw adminError('invalid_argument', 'witbitz: users.erase takes { email } — the address the person signed in to your app with')
    const r = await this._wb._tenantPost()({ op: 'sentinel', sentinel: { mode: 'eraseuser', email: email.trim() } })
    if (!r || r.error || r.ok === false) throw adminError((r && r.error) || 'refused', `witbitz: the erase was refused (${(r && (r.error || r.reason)) || 'no answer'})`)
    return r
  }
  /** A token for this user's page, valid `ttlSec` (60–3600, default 900). → { token, expiresAt } (unix seconds).
   *  Mint it when the user signs in and again before `expiresAt`; never store it server-side longer than that. */
  async token (userId, { ttlSec } = {}) { return await this._wb._tenantRest('POST', '/users/' + userIdOf(userId, 'users.token') + '/token', ttlSec !== undefined ? { ttlSec } : {}) }
}

/** `wb.billing` — what you are billed, in the provider's numbers: this month (your key live + your users' keys through
 *  yesterday), would-have-cost (markup), charged (discount), storage, by day, and per user. The same data as the tenant
 *  portal. **Server-side only**: needs your tenant key. */
class TenantBilling {
  constructor (wb) { this._wb = wb }
  /** → { tenant, rate, month, storage, days, users, userDays, at } — amounts in microdollars (1e-6 USD). */
  async get () { return await this._wb._tenantRest('GET', '', null, { root: '/billing', envelope: false }) }
  /** REQUIRE A USER TOKEN on every op that spends (a turn, a title, an approval, an import) in your rooms. With it on, such
   *  an op that arrives WITHOUT a user token is refused (`user_token_required`) instead of billed to you — so your
   *  per-user caps cannot be bypassed by a page that simply sends none. Reads never need one. Takes effect within about a
   *  minute. → { requireUserToken } as stored. */
  async requireUserToken (on = true) {
    if (typeof on !== 'boolean') throw adminError('invalid_argument', 'witbitz: billing.requireUserToken takes true or false')
    const d = await this._wb._tenantRest('PUT', '/webhooks', { requireUserToken: on })
    return { requireUserToken: !!(d && d.tenant && d.tenant.require_user_token) }
  }
  /** LIMIT VISITORS (docs/visitor-limits.md): how many questions a day (UTC) people who are NOT signed in — no user token —
   *  may ask in your rooms: at most `perNetwork` from one network, at most `total` from all of them. Over either, the
   *  question is refused before anything is spent (`429 visitor_limit`, with `scope` and a sentence to show). `null` turns
   *  it off (every question bills to you, as without it). A question with a user token is its user's, under their own cap.
   *  Takes effect within about a minute. → { visitorLimit } as stored. */
  async visitorLimit (limit) {
    const ok = limit === null || (limit && typeof limit === 'object' && !Array.isArray(limit) && Object.keys(limit).every((k) => k === 'perNetwork' || k === 'total') &&
      Number.isInteger(limit.perNetwork) && Number.isInteger(limit.total) && limit.perNetwork >= 1 && limit.perNetwork <= limit.total && limit.total <= 10_000_000)
    if (!ok) throw adminError('invalid_argument', 'witbitz: billing.visitorLimit takes { perNetwork, total } — whole numbers of questions a day, 1 ≤ perNetwork ≤ total ≤ 10000000 — or null to turn it off')
    const d = await this._wb._tenantRest('PUT', '/webhooks', { visitorLimit: limit === null ? null : { perNetwork: limit.perNetwork, total: limit.total } })
    const vl = d && d.tenant ? d.tenant.visitor_limit : null
    return { visitorLimit: vl && typeof vl === 'object' ? { perNetwork: vl.perNetwork, total: vl.total } : null }
  }
  /** The same as CSV text: one line per day, or with `{ byUser: true }` one line per user per day. */
  async csv ({ byUser = false } = {}) { return await this._wb._tenantRest('GET', '?format=csv' + (byUser ? '&by=user' : ''), null, { root: '/billing', text: true }) }
  /** YOUR PREPAID BALANCE (docs/tenant-prepaid.md), or null when your app is not on prepaid billing.
   *  → { balanceMicros, paused: null | 'out_of_credit', lowWarned, earlyAccess, canBuy, packs: [{ pack, dollars, credit }], history: [{ at, kind, micros, orderId? }] }
   *  (`canBuy`: buying credit is open to your app now — while it is in testing, only to the apps in the test).
   *  While `paused`, every op that spends in your rooms is refused (`402 tenant_out_of_credit`) until you add credit. */
  async balance () { const v = await this.get(); return (v && v.prepaid) || null }
  /** ADD CREDIT: a payment page for one pack — 'pack25' | 'pack100' | 'pack500' — bound to your app. Open its `url` in a browser
   *  (Lemon Squeezy takes the payment and the tax); the credit lands within a minute of paying, and lifts a pause at once.
   *  `redirectUrl` (https): where the payer returns. Needs your SECRET key. → { url, pack, dollars, testMode }
   *  Refused with `payments_not_open` (buying is not open yet), `not_prepaid` (your app is not on prepaid billing), `not_a_tester`
   *  (buying is in testing, not open to your app), `checkout_unavailable` (the payment page could not be made — try again). */
  async topUp (pack, { redirectUrl } = {}) {
    if (!['pack25', 'pack100', 'pack500'].includes(pack)) throw adminError('invalid_argument', "witbitz: billing.topUp takes 'pack25', 'pack100' or 'pack500'")
    if (redirectUrl != null && !/^https:\/\/\S{1,300}$/.test(String(redirectUrl))) throw adminError('invalid_argument', 'witbitz: billing.topUp redirectUrl must be an https address')
    return await this._wb._tenantRest('POST', '/billing/checkout', { pack, ...(redirectUrl ? { redirectUrl } : {}) })
  }
}

/** `admin.app` — YOUR APP'S NAME, as your users see it: a sign-in code mailed from one of your declared AND PROVEN origins comes
 *  from "<name> via Witbitz" with the subject "Your <name> code". 1–40 characters (letters, digits, spaces and
 *  . & ' + -), never "Witbitz". A rename reaches the mail within about 15 minutes. **Server-side only.** */
class TenantApp {
  constructor (wb) { this._wb = wb }
  /** → { name } as stored. Refused with the reason when the name breaks the rule. */
  async rename (name) {
    if (typeof name !== 'string' || !name.trim()) throw adminError('invalid_argument', "witbitz: app.rename takes your app's name, e.g. 'Keepwarden'")
    const d = await this._wb._tenantRest('PUT', '/webhooks', { name })
    return { name: (d && d.tenant && d.tenant.name) || '' }
  }
  /** The name your app is registered with now. */
  async name () {
    const d = await this._wb._tenantRest('GET', '')
    return (d && typeof d.name === 'string') ? d.name : ''
  }
}

/** `wb.origins` — the PAGE origins that act for this tenant: a room created from one of them belongs to the tenant, and
 *  the tenant's rooms may be read and embedded from them. Compared by exact string against the browser's Origin header,
 *  so the server stores the exact form ("https://host" or "https://host:port") and refuses anything else by name.
 *  Takes effect within about a minute. **Server-side only**: it needs your tenant key. */
class TenantOrigins {
  constructor (wb) { this._wb = wb }
  /** Declare the whole list. Declaring REPLACES what you had — keep the origins you still use.
   *  → { origins, unproven } — origins as stored (lower-cased, trailing slash removed, de-duplicated); unproven = the ones
   *  whose host does not yet say it is yours, each with how to prove it ({ origin, how }). An unproven origin works; only
   *  a proven one puts your app's name in a sign-in mail. Declare again once the file or record is in place. */
  async declare (origins) {
    if (!Array.isArray(origins)) throw adminError('invalid_argument', 'witbitz: origins.declare takes an array, e.g. ["https://app.example.com"]')
    const d = await this._wb._tenantRest('PUT', '/webhooks', { origins: origins.map(String) })
    const out = { origins: Array.isArray(d.tenant && d.tenant.origins) ? d.tenant.origins : [], unproven: Array.isArray(d.origins_unproven) ? d.origins_unproven : [] }
    // With a signing key, the Sentinel gets the same list SIGNED (signing.publishOrigins): from then on only these pages may
    // name your tenant there — connect through your OAuth apps, file a user's erase list for you.
    if (this._wb._signingKey) out.signed = (await this._wb.signing.publishOrigins(out.origins)).origins
    return out
  }
  /** The origins this tenant declares now. */
  async list () {
    const d = await this._wb._tenantRest('GET', '')
    return Array.isArray(d.origins) ? d.origins : []
  }
}

/** `wb.hosts` — the hosts THIS tenant's users may attach a key for (https://witbitz.chat/docs/connections.md). A host nobody vouches
 *  for is refused when a member attaches it, not an hour later on the first call, and the enclave's firewall opens a
 *  host only while a live connection under this tenant needs it. **Server-side only**: it needs your tenant key. */
class DeclaredHosts {
  constructor (wb) { this._wb = wb }
  /** Declare the whole list. Declaring REPLACES what you had, so removing a host is declaring without it.
   *  → { hosts } as the enclave normalised them (lower-cased, scheme and path stripped, de-duplicated). */
  async declare (hosts) {
    if (!Array.isArray(hosts)) throw adminError('invalid_argument', 'witbitz: declare takes an array of bare domains, e.g. ["api.todoist.com"]')
    const r = await this._wb._tenantPost()({ op: 'sentinel', sentinel: { mode: 'hostdeclare', hosts: hosts.map(String) } })
    if (!r || r.error || !r.ok) throw adminError((r && r.error) || 'refused', `witbitz: the hosts were refused (${(r && (r.error || r.reason)) || 'no answer'})`)
    return { hosts: Array.isArray(r.hosts) ? r.hosts : [] }
  }
  /** What this tenant currently vouches for. */
  async list () {
    const r = await this._wb._tenantPost()({ op: 'sentinel', sentinel: { mode: 'hostlist' } })
    if (!r || r.error) throw adminError((r && r.error) || 'refused', `witbitz: could not list hosts (${(r && r.error) || 'no answer'})`)
    return Array.isArray(r.hosts) ? r.hosts : []
  }
}

/** Back-compat for the page client: `wb.users` keeps its old class name in stack traces. */
export { TenantCustomers as TenantUsers }
