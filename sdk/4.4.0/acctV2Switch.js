// acctV2Switch.js — the device switch for account recovery v2 (acctV2Wiring.js): `space:acctv2:base` names the v2 service;
// unset, everything v2 is off. It can only point at one of the TWO services below — never at an address a link names — and
// each only on its own app:
//  - the STAGING app (preview.witbitz-spaces.pages.dev, which talks to the staging servers): ON by default; ?acctv2=off
//    switches it off for this device, ?acctv2=staging back on.
//  - the PRODUCTION regular app (witbitz-spaces.pages.dev): OFF unless a device is switched on with ?acctv2=prod — the
//    owner-only preview for release checklist 1.10 (real devices against production), never on by default; ?acctv2=off
//    switches it off again. In the hosted app the client runs in its VAULT (below), never in app.witbitz.chat's page.
//    (The release switch below has since made new accounts start on the service by default.)
export const BASE_KEY = 'space:acctv2:base'
export const STAGING_APP = 'preview.witbitz-spaces.pages.dev'
export const STAGING_SERVICE = 'https://wvevotytx5.execute-api.eu-central-1.amazonaws.com'
export const PROD_APP = 'witbitz-spaces.pages.dev'
// the API domain the production app's CSP already allows (api.witbitz.chat/v1 → the production /v1 API; the gateway strips
// the /v1, so the service sees, and the device signs, the bare /v2/account/... path)
export const PROD_SERVICE = 'https://api.witbitz.chat/v1'
// THE HOSTED APP'S VAULTS (docs/hosted-account-v2-plan.md; owner, 2026-11-15: "before deploy do the vault app with the new
// backup"): in the hosted app the VAULT holds the master, so the client runs there — never in the app page it frames
// (app.witbitz.chat stays off: no entry here). The production vault talks to the production service at the same API domain
// its CSP already allows; the staging vault (it frames the staging app) to the staging service.
export const PROD_VAULT = 'spaces.witbitz.chat'
export const STAGING_VAULT = 'vault.witbitz-spaces.pages.dev'
const SERVICE_OF = { [STAGING_APP]: STAGING_SERVICE, [PROD_APP]: PROD_SERVICE, [STAGING_VAULT]: STAGING_SERVICE, [PROD_VAULT]: PROD_SERVICE }

export function stagingSwitch(loc = globalThis.location, storage = globalThis.localStorage) {
  try {
    if (!loc || (loc.hostname !== STAGING_APP && loc.hostname !== STAGING_VAULT)) return
    const v = new URLSearchParams(loc.search).get('acctv2')
    if (v === 'staging') storage.setItem(BASE_KEY, STAGING_SERVICE)
    else if (v === 'off') storage.setItem(BASE_KEY, 'off') // remembered: the default below does not turn it back on
    // ON BY DEFAULT on the staging app: an installed iPhone app keeps storage apart from Safari, so a link cannot switch it
    else if (storage.getItem(BASE_KEY) == null) storage.setItem(BASE_KEY, STAGING_SERVICE)
  } catch { /* no storage */ }
}

/** The production preview: only `?acctv2=prod` switches a device on, `?acctv2=off` off; nothing else, no default. */
export function prodSwitch(loc = globalThis.location, storage = globalThis.localStorage) {
  try {
    if (!loc || loc.hostname !== PROD_APP) return
    const v = new URLSearchParams(loc.search).get('acctv2')
    if (v === 'prod') storage.setItem(BASE_KEY, PROD_SERVICE)
    else if (v === 'off') storage.setItem(BASE_KEY, 'off')
  } catch { /* no storage */ }
}

// THE RELEASE SWITCH FOR NEW ACCOUNTS (account recovery v2, Release 1): ON since Official v247 (owner, 2026-11-15: "Now").
// A NEW account made on the production regular app starts on the new service — the normal "Turn on backup"
// (recoverySheet.js turnOnBackup), same screens — and the normal Restore asks the new service first (acctV2Ui.restoreFromCode).
// Accounts on the old service stay there (migration is Release 3). Off again = a release with false here; accounts already
// made on the new service stay on it.
export const NEW_ACCOUNTS_ON_V2 = true
/** Where a NEW account made here starts: the new service's address, or '' (the old service, as before). The production
 *  regular app and the production vault (the hosted app's v2 client runs there — acctV2VaultWiring.js); the staging app keeps
 *  its preview card as the way in. A device switched off (?acctv2=off) stays off. */
export function newAccountService({ host, stored, releaseOn = NEW_ACCOUNTS_ON_V2 }) {
  if (host === PROD_VAULT && stored !== 'off') return releaseOn ? PROD_SERVICE : '' // the hosted app: its vault
  if (host !== PROD_APP || stored === 'off') return ''
  if (stored === PROD_SERVICE) return PROD_SERVICE
  return releaseOn ? PROD_SERVICE : ''
}

// RELEASE 3 — AN OLD ACCOUNT MOVES (protocol § 12.2; owner, 2026-11-15: "Let's just add a button in settings that lets you
// migrate if you are on the old backup"): Settings → "Move to the new account service" (acctV2UiCore.js). It is offered only
// where the SERVICE accepts moves — its own switch (ACCT_FEATURES `migration`; off = `501 feature_unavailable`), which the
// button asks first (acctV2UiCore.moveOpen) — so no release of the app is needed to open or close it. Never automatic.
/** The service an account still on the old service would move to from this app, or '': the production regular app and the
 *  production vault (the staging apps have no old service). A device switched off (?acctv2=off) stays off. */
export function moveService({ host, stored }) {
  if (stored === 'off') return ''
  return host === PROD_APP || host === PROD_VAULT ? PROD_SERVICE : ''
}

/** The service address the switch holds, or '' (off). With `host`, only that app's own service counts. */
export const baseOf = (v, host) => {
  if (!v || v === 'off') return ''
  // the local test harness (spaces/test/acctV2Ui.test.mjs): a page on a loopback host may use a service on that same host
  if (host === '127.0.0.1' || host === 'localhost') { try { return new URL(v).hostname === host ? v : '' } catch { return '' } }
  if (host !== undefined) return SERVICE_OF[host] === v ? v : ''
  return v === STAGING_SERVICE || v === PROD_SERVICE ? v : ''
}
