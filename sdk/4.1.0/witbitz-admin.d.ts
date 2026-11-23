// witbitz-admin.d.ts — types for https://witbitz-spaces.pages.dev/witbitz-admin.js, the builder's SERVER-SIDE client
// (2026-10-05). It takes your tenant SECRET key: never ship it, or this module, to a page.
// Held to the code by spaces/test/sdkTypesDrift.test.mjs. Prose: https://witbitz.chat/docs/sdk-builder.md#builder-calls

export interface WitbitzAdminOptions {
  /** Your tenant's id (t_…) — the key proves it, the id names it. */
  tenant?: string
  /** Your tenant secret key (wsk_…). */
  tenantKey: string
  /** Your tenant's Ed25519 PRIVATE signing key (a JWK, or its JSON string) — `WitbitzAdmin.generateSigningKey()`. With it, every
   *  Sentinel request is signed, and once its public half is registered the Sentinel refuses an unsigned one. */
  signingKey?: { kty: 'OKP'; crv: 'Ed25519'; d: string; x: string } | string
  /** The Space endpoint; the authenticated tenant endpoint is derived from it. */
  endpoint?: string
  tenantEndpoint?: string
  fetchImpl?: typeof fetch
  sentinel?: unknown
}

/** Your app's name — what a sign-in mail from your declared origins says. 1–40 characters, never "Witbitz". */
export interface TenantApp {
  rename(name: string): Promise<{ name: string }>
  name(): Promise<string>
}
/** The page origins that act for this tenant. Declaring REPLACES the list. */
export interface Origins {
  declare(origins: string[]): Promise<{ origins: string[]; unproven: { origin: string; how: string }[] }>
  list(): Promise<string[]>
}
/** The hosts your users may attach a key for. Declaring REPLACES the list. */
export interface DeclaredHosts {
  declare(hosts: string[]): Promise<{ hosts: string[] }>
  list(): Promise<string[]>
}
/** Your own OAuth apps; the client secret is sealed to the attested enclave. */
export interface Providers {
  attach(opts: { kind?: 'google'; clientId: string; clientSecret: string; redirectUri: string; scopes: string[]; label?: string; tenant?: string }): Promise<{ id: string; kind: string; tenant: string }>
  /** A registered MCP client for an issuer that does not let apps register themselves (GitHub, Asana, Box…). */
  /** `webhookSecret`: the secret the service signs its "the person removed your app" notices with (Zoom: the app's Secret Token) —
   *  point the service at https://api.witbitz.chat/v1/connections/removed/{vendor}/{tenant} and that person's connections are deleted. */
  attachMcp(opts: { issuer: string; clientId: string; clientSecret?: string; redirectUris: string[]; label?: string; tenant?: string; webhookSecret?: string; scopes?: string | string[] }): Promise<{ id: string; kind: 'mcp'; tenant: string }>
  list(): Promise<Array<{ id: string; kind: string; label?: string; [k: string]: unknown }>>
  revoke(id: string): Promise<{ revoked: number; connections: number }>
}
export type Retain = 'none' | 'backups' | 'grace'
/** Delete or restore one of your rooms (sdk-builder.md#delete). */
export interface TenantRooms {
  delete(room: string, opts?: { retain?: Retain; graceDays?: number; after?: 'none' | 'backups' }): Promise<{ deleted: boolean; room: string; [k: string]: unknown }>
  restore(room: string): Promise<{ restored: true; room: string }>
  /** Your rooms, a page at a time; pass `next` back as `cursor`. `lastUsedAt` is recorded since 2026-10-07. */
  list(opts?: { cursor?: string; limit?: number }): Promise<{ rooms: TenantRoom[]; next: string | null }>
  /** Hold rooms no member used for `days` (30–3650) for 30 days, then delete them; `null` turns it off. */
  idleDeletion(days: number | null): Promise<{ idleRoomDays: number | null }>
}
export interface TenantRoom { room: string; createdAt: string | null; lastUsedAt: string | null; kind: string; split: boolean; gated: boolean; held: { purgeAt: string } | null }
export interface Customer { userId: string; userRef: string; capMonthlyUsd: number; createdAt?: string | number; revoked?: boolean }
/** Your app's billed customers — each with its own capped provider key. Not Witbitz accounts. */
export interface Customers {
  create(opts: { userRef: string; capMonthlyUsd?: number }): Promise<Customer>
  list(): Promise<Customer[]>
  update(userId: string, opts: { capMonthlyUsd: number }): Promise<Customer>
  revoke(userId: string): Promise<{ revoked: true; userId: string }>
  /** Delete the Spaces this person created in your app that nobody else used (https://witbitz.chat/docs/sdk-builder.md#user-erasure). */
  erase(opts: { email: string }): Promise<{ filed: boolean; rooms: number; deleted: number; shared: number; notTheirs: number; failed: number; cleared: boolean; [k: string]: unknown }>
  /** A short-lived token for this customer's page (`wb.useUserToken`). `expiresAt` is unix seconds. */
  token(userId: string, opts?: { ttlSec?: number }): Promise<{ token: string; expiresAt: number }>
}
/** What you are billed, in the provider's numbers (amounts in microdollars). */
export interface Billing {
  get(): Promise<{ tenant: string; rate: unknown; month: unknown; storage: unknown; days: unknown[]; users: unknown[]; userDays: unknown[]; at: string | number }>
  requireUserToken(on?: boolean): Promise<{ requireUserToken: boolean }>
  /** Questions a day people who are not signed in may ask in your rooms — per network and in total; null turns it off (sdk-builder.md#visitor-limits). */
  visitorLimit(limit: { perNetwork: number; total: number } | null): Promise<{ visitorLimit: { perNetwork: number; total: number } | null }>
  csv(opts?: { byUser?: boolean }): Promise<string>
  /** Your prepaid balance, or null when your app is not on prepaid billing. While `paused`, every op that spends in your rooms is refused (402 tenant_out_of_credit). */
  /** `canBuy`: whether buying credit is open to your app now (while it is in testing, only to the apps in the test) — when false, topUp is refused.
   *  Each pack's `credit`: the dollars it adds to your balance — its price (`dollars`) less the payment seller's fee. */
  balance(): Promise<{ balanceMicros: number; paused: string | null; lowWarned: boolean; earlyAccess: boolean; canBuy: boolean; packs: { pack: string; dollars: number; credit: number }[]; history: { at: number; kind: 'topup' | 'refund' | 'grant'; micros: number; orderId?: string; test?: boolean }[] } | null>
  /** A payment page for one credit pack; send the person who pays to `url`. Refusals (`err.code`): `payments_not_open` (503, buying is not open yet),
   *  `not_prepaid` (409, your app is not on prepaid billing), `not_a_tester` (403, buying is in testing and not open to your app), `checkout_unavailable`
   *  (502, the payment page could not be made — try again), `forbidden` (403, not a secret key). */
  topUp(pack: 'pack25' | 'pack100' | 'pack500', opts?: { redirectUrl?: string }): Promise<{ url: string; pack: string; dollars: number; testMode: boolean }>
}

/** What a RESTRICTED key (wrk_) may do — each opens the routes that need it, nothing else. */
export type Capability = 'customers:read' | 'customers:write' | 'customers:tokens' | 'customers:erase' | 'rooms:read' | 'rooms:write' | 'rooms:delete' | 'settings:read' | 'settings:write' | 'origins:write' | 'integrations:write' | 'billing:read' | 'wallets:grant' | 'apps:release'
export interface ApiKeyInfo { keyId: string; type: 'secret' | 'publishable' | 'restricted'; label: string; createdAt: string; revoked: boolean; display: string; scopes?: Capability[]; expiresAt?: string | null; maxCustomerCapUsd?: number | null }
/** Your API keys. Managed with your SECRET key only; a restricted key can never mint, revoke or list keys. */
export interface TenantKeys {
  list(): Promise<ApiKeyInfo[]>
  /** `key` is shown ONCE. A restricted key needs `scopes`; `expiresAt` (≤ 2 years) and `maxCustomerCapUsd` are optional. */
  create(opts: { type?: 'restricted' | 'secret' | 'publishable'; label?: string; scopes?: Capability[]; expiresAt?: string | number; maxCustomerCapUsd?: number }): Promise<{ key: string; keyId: string; type: string; scopes?: Capability[]; maxCustomerCapUsd?: number | null; expiresAt?: string | null }>
  revoke(keyId: string): Promise<{ revoked: true; keyId: string }>
}

export interface TenantSigning {
  /** File a signing key's PUBLIC half (default: this client's own). The first on the tenant key alone; a new one only signed by the current one. */
  register(publicKey?: string): Promise<{ ok: true; key: string }>
  /** Which key the Sentinel holds for this tenant — watch it: a record can be deleted from the store, never forged. */
  status(): Promise<{ registered: boolean; key: string | null; origins: string[] | null }>
  /** File your SIGNED origin list with the Sentinel (default: origins.list()); then only those pages may name your tenant there. */
  publishOrigins(origins?: string[]): Promise<{ ok: true; origins: string[] }>
}

/** RETIRED in 4.0.0 — the owner rule (rooms only your app may use): its only rule required a page SERVED as your app, which a web page
 *  cannot prove. Every call rejects with `owner_rule_retired`. Kept as a name so old code fails loudly, not with a TypeError. */
export interface TenantOwner {
  /** @deprecated retired in 4.0.0 — rejects with `owner_rule_retired` */ register(...args: unknown[]): Promise<never>
  /** @deprecated retired in 4.0.0 — rejects with `owner_rule_retired` */ rotate(...args: unknown[]): Promise<never>
  /** @deprecated retired in 4.0.0 — rejects with `owner_rule_retired` */ room(...args: unknown[]): Promise<never>
}
export declare class WitbitzAdmin {
  constructor(opts: WitbitzAdminOptions)
  /** A new Ed25519 signing key: keep `privateKey` on your server; `publicKey` (raw, base64url) is what `signing.register` files. */
  static generateSigningKey(): Promise<{ privateKey: { kty: 'OKP'; crv: 'Ed25519'; d: string; x: string }; publicKey: string }>
  /** @deprecated retired in 4.0.0 (the owner rule) — rejects with `owner_rule_retired` */
  static generateOwnerKey(): Promise<never>
  readonly signing: TenantSigning
  readonly origins: Origins
  /** Your app's name, as your users see it in a sign-in mail. */
  readonly app: TenantApp
  readonly hosts: DeclaredHosts
  readonly providers: Providers
  readonly rooms: TenantRooms
  readonly customers: Customers
  readonly billing: Billing
  readonly keys: TenantKeys
  /** @deprecated retired in 4.0.0 — every call rejects with `owner_rule_retired` */
  readonly owner: TenantOwner
  /** Is this key good, and whose is it? A refused key answers `ok: false`; a missing key throws. */
  verifyTenantKey(): Promise<{ ok: true; tenant: string } | { ok: false; reason: string; code?: string }>
  /** What logs and serialisers see: never the key. */
  toJSON(): { tenant: string | null; tenantKey: '[REDACTED]' | null; signingKey?: '[REDACTED]' }
}
export declare const DEFAULT_ENDPOINT: string
