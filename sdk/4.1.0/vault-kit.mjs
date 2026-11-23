#!/usr/bin/env node
// vault-kit.mjs — build a VAULT KIT you host yourself (https://witbitz.chat/docs/sdk-keys.md#vault-mode). Node 18+, no packages.
//
//   curl -O https://witbitz-spaces.pages.dev/sdk/2.1.0/vault-kit.mjs
//   node vault-kit.mjs ./vault --page https://app.acme.com/chat --vault https://vault.acme.com [--tenant t_…] [--brand Acme]
//
// It writes a folder for https://vault.acme.com: the vault keeps every room key; your app page (on its own origin) runs
// inside it and never holds one. Witbitz hosts nothing for it.
//   index.html, space/index.html   the vault page (space/ is where invite links land: …/space?room=…#mk=…) — rewritten every
//                                  run: it PINS every script of the vault by its sha384 (an import map + its own script policy)
//   vault.js                       YOURS: the configuration          ┐ written once — a re-run keeps your edits AND pins them:
//   screens.js                     YOURS: sign-in, share, didn't load ┘ edit them, then run the kit again
//   core/                          OURS: everything that touches a key — a re-run replaces ONLY this folder
//   HEADERS.md                     the headers to serve it with (nginx / Caddy / Apache)
//   README.md, kit.json            what this is; the version, and each core file's sha384
// `--from` is where the core comes from: an SDK release URL (default: the release this file was published with — KIT_RELEASE), every file checked against that release's manifest — and the manifest itself against --manifest-sha <sha384-…>
// when given (the hash the docs publish for the release); or a folder (a Witbitz checkout's spaces/public).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'

export const DEFAULTS = { endpoint: 'https://api.witbitz.chat/v1/space', loginBase: 'https://witbitz-spaces.pages.dev', from: 'https://witbitz-spaces.pages.dev/sdk/latest/', enclaveClaim: 'https://witbitz-spaces.pages.dev/enclave-claim.json', accountService: 'https://api.witbitz.chat/v1' } // enclaveClaim: the confidential tier's published measurement (and its policy text, beside it)
export const KIT_RELEASE = '4.1.0' // tools/sdk-release.mjs stamps the version here, so a downloaded copy builds from ITS release
const STAMP = '?v=' + '__' + 'SPACES_BUILD' + '__' // spelled apart, so a release of this file does not read as a placeholder
const PLACEHOLDER = /__[A-Z][A-Z0-9_]{3,}__/
const PURE_NOTE = new RegExp('@__' + 'PURE__', 'g') // spelled apart, like STAMP: esbuild's annotation in a bundle
const ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i
const originOf = (u) => { try { return new URL(u).origin } catch { return '' } }
const esc = (s) => JSON.stringify(String(s))
const sri = (s) => 'sha384-' + createHash('sha384').update(s).digest('base64')
const sha256 = (s) => 'sha256-' + createHash('sha256').update(s).digest('base64')
// Every sibling module a file names: a static or dynamic import of a ./ path, or a new URL of one (a worker, a worklet).
const SPEC = new RegExp(`(?:from\\s*|import\\s*\\(?\\s*|new URL\\(\\s*)['"]\\.\\/([\\w.-]+\\.m?js)(?:${STAMP.replace(/[?]/g, '\\?')})?['"]`, 'g')

export function parseArgs(argv) {
  const o = { out: '', page: '', vault: '', tenant: '', brand: '', accent: '', endpoint: DEFAULTS.endpoint, loginBase: DEFAULTS.loginBase, from: '', manifestSha: '', appShare: false, lock: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--app-share') { o.appShare = true; continue } // a flag: you serve your app-half function at /api/appshare on the vault's origin (split-key Spaces)
    if (a === '--lock') { o.lock = true; continue } // a flag: the vault offers its users the lock and storage protection (wb.vault.showLock())
    if (a === '--push') { o.push = true; continue } // a flag: the vault offers its users notifications (wb.vault.showNotifications()), through push-sw.js
    if (a.startsWith('--')) { const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); o[k] = argv[++i] || '' } else if (!o.out) o.out = a
  }
  const err = []
  if (!o.out) err.push('the output folder')
  if (!/^https:\/\//.test(o.page) || !originOf(o.page)) err.push('--page, your app page (https URL)')
  if (!ORIGIN.test(o.vault || '')) err.push('--vault, the vault\'s origin (https://vault.example.com, no path)')
  if (o.page && o.vault && originOf(o.page) === o.vault) err.push('--page on ANOTHER origin than --vault (that wall is the point)')
  if (o.tenant && !/^t_[0-9a-f]{32}$/.test(o.tenant)) err.push('--tenant as t_ + 32 hex')
  if (o.accent && !/^#[0-9a-f]{3,8}$/i.test(o.accent)) err.push('--accent as a hex colour')
  if (!ORIGIN.test(originOf(o.endpoint) || '')) err.push('--endpoint as an https URL')
  return { o, err }
}

/** The vault's response headers — what the host must send, since only Cloudflare reads a _headers file. They stay the SAME across
 *  kit runs: the hash that changes lives in the page's own policy (vaultPage's <meta>), which narrows this one — `'unsafe-inline'`
 *  here only lets the page's inline import map run, and the page's policy admits it by its hash alone. */
// accountService: the Witbitz account service, where the vault keeps a NEW account (core/sdkBackupV2.js) — the same API domain as
// the default endpoint, named on its own so a vault with another endpoint still reaches it
export function headersFor({ page, endpoint = DEFAULTS.endpoint, loginBase = DEFAULTS.loginBase, enclaveClaim = DEFAULTS.enclaveClaim, accountService = DEFAULTS.accountService }) {
  const csp = [
    "default-src 'self'", "script-src 'self' 'unsafe-inline'", "worker-src 'self' blob:", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    `connect-src 'self' ${[...new Set([originOf(endpoint), originOf(loginBase), originOf(enclaveClaim), originOf(accountService)])].join(' ')}`,
    `frame-src ${originOf(page)}`, "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'none'",
  ].join('; ')
  // Cross-Origin-Opener-Policy: a page that opens the vault in a window gets no handle on it (docs/hosted-app-design.md §7, as
  // Witbitz's own vault since 2026-10-25). `same-origin`, not `-allow-popups`: this vault opens no window of its own (sign-in is
  // an email code; a connection's sign-in happens in your page).
  return { 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
}

/** A source of the core's files: a folder (a checkout's spaces/public) or an SDK release URL, checked against its manifest. */
export function folderSource(dir) {
  return {
    label: dir,
    read: async (f) => {
      if (f === WORKER_SRC && !existsSync(join(dir, f))) throw new Error(`vault-kit: ${join(dir, f)} is missing — it is generated: run \`node tools/build-verified-workers.mjs ${dir}\` first`)
      return readFileSync(join(dir, f), 'utf8')
    },
  }
}
export async function releaseSource(base, { fetchImpl = (...a) => fetch(...a), pin = '' } = {}) {
  const root = String(base).replace(/\/*$/, '/')
  const mr = await fetchImpl(root + 'manifest.json')
  if (!mr.ok) throw new Error(`vault-kit: no SDK release at ${root} (manifest.json: HTTP ${mr.status})`)
  // The manifest comes from the same host as the files, so checking a file against it catches corruption, not a host
  // that was taken over. `pin` (--manifest-sha) is the stronger check: the manifest's own sha384, published in the docs
  // for each release — a manifest that is not that one is refused (security review, 2026-10-15).
  const text = await mr.text()
  const manifestSha = sri(text)
  if (pin && pin !== manifestSha) throw new Error(`vault-kit: the manifest at ${root} is not the one you pinned (${manifestSha} ≠ ${pin}) — refusing to build from it`)
  const manifest = JSON.parse(text)
  return {
    label: `${root} (SDK ${manifest.version})`, version: manifest.version, manifestSha, pinned: !!pin,
    read: async (f) => {
      const want = manifest.files && manifest.files[f]
      if (!want) throw new Error(`vault-kit: ${f} is not in SDK ${manifest.version} — this release has no vault kit; use a newer one`)
      const r = await fetchImpl(root + f)
      if (!r.ok) throw new Error(`vault-kit: ${root + f}: HTTP ${r.status}`)
      const body = await r.text()
      if (sri(body) !== want) throw new Error(`vault-kit: ${f} does not match the release's manifest — refusing to build from it`)
      return body
    },
  }
}

async function closureOf(entries, read) {
  const seen = new Map(), queue = [...entries]
  while (queue.length) {
    const f = queue.shift()
    if (seen.has(f)) continue
    const src = (await read(f)).split(STAMP).join('')
    seen.set(f, src)
    for (const m of src.matchAll(SPEC)) queue.push(m[1])
  }
  return seen
}

// THE VAULT LOADS ONLY PINNED SCRIPTS (the owner, 2026-11-14: "Do it now" — docs/vault-core-convergence-review.md § 5). Every script
// of the vault (core/, vault.js, screens.js, any module of yours in this folder) is named in an import map with its sha384, and the
// page's own policy admits no inline script but that map (by its hash). A file changed on the host
// after the kit ran — core/ or yours — is refused by the browser and the vault does not start. The KEY WORKER is no longer a file the
// browser fetches: its source is one of those pinned modules (core/l1-worker-src.js) and runs from memory (vcWorker.js), so
// `worker-src` needs `blob:`. A browser without import-map integrity runs the same files unchecked.
export const WORKER_SRC = 'l1-worker-src.js'
export const PAGE_MARK = '<!-- witbitz vault kit: pinned page -->'
function legacyPage(brand) { // what kits before the pinned page wrote once — replaced without a copy, it is ours
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${String(brand).replace(/[<&>"]/g, '')}</title>
<style>html,body{margin:0;height:100%;background:#fff}@media (prefers-color-scheme:dark){html,body{background:#111}}</style>
</head><body><script type="module" src="/vault.js"></script></body></html>
`
}
/** The page, with `integrity` ({ '/path.js': 'sha384-…' }) as its import map. → { html, policy } */
export function vaultPage(brand, integrity = {}) {
  const map = JSON.stringify({ imports: {}, integrity: Object.fromEntries(Object.entries(integrity).sort(([a], [b]) => a.localeCompare(b))) }, null, 1)
  // 'self' + the map's own hash: the import map is the page's one inline script; every file it loads is this host's, and each one the
  // map names must match its sha384 or the browser refuses it. ('strict-dynamic' with hashes does not reach a module's imports.)
  const policy = `script-src 'self' '${sha256(map)}'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'`
  const html = `<!doctype html>
${PAGE_MARK}
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${String(brand).replace(/[<&>"]/g, '')}</title>
<style>html,body{margin:0;height:100%;background:#fff}@media (prefers-color-scheme:dark){html,body{background:#111}}</style>
<script type="importmap">${map}</script>
</head><body><script type="module" src="/vault.js"></script></body></html>
`
  return { html, policy }
}
/** Every script in the vault folder a page may load (push-sw.js is a service worker — not a module, never in a map). */
function scriptsIn (root, readOut, listOut) {
  const out = {}
  for (const rel of listOut(root)) if (/\.m?js$/.test(rel) && rel !== 'push-sw.js') out['/' + rel] = sri(readOut(join(root, rel)))
  return out
}
function walk (root, rel = '') {
  const out = []
  for (const n of readdirSync(join(root, rel))) {
    if (n === 'node_modules' || n.startsWith('.')) continue
    const r = rel ? rel + '/' + n : n
    if (statSync(join(root, r)).isDirectory()) out.push(...walk(root, r)); else out.push(r)
  }
  return out
}

const sib = (f) => `'./${f}'` // written so the release tool's import scan does not take the template for an import of its own
/** push-sw.js — the vault's service worker, at its ROOT (a worker's scope is its folder): notifications only, over the shared
 *  core every Witbitz app's worker uses (core/sw-notif-core.js — the sealed preview opened with the room's notification key
 *  the vault's own key worker keeps, the tap routed to the open window). Ours, like core/: a re-run of the kit replaces it.
 *  Registered only by a vault started with `push: true`, once the person turns notifications on. */
export function pushWorker({ brand = 'this app' } = {}) {
  const b = JSON.stringify(String(brand || 'this app').slice(0, 60))
  return `// push-sw.js — this vault's notifications (vault-core.js \`push: true\`). Written by the Witbitz vault kit; a re-run replaces it.
importScripts('/core/sw-notif-core.js')
const BRAND = ${b}
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
// no read of its own: the push carries the sealed preview (opened with the room's notification key), else the generic line
self.wbxWirePush({ describe: async () => null, generic: { title: BRAND, body: 'Something new in your Spaces — open ' + BRAND + ' to see it.' }, testBody: 'You’ll get a nudge here when someone posts in your Spaces.', intakeBody: 'Your assistant has a new message — open ' + BRAND + ' to read it.' })
// a tap: the open vault is focused and told the room (it tells your page: wb.vault.on('notifOpen')); none open → the vault at ?room=…&tap=1
self.wbxWireNotifClick({ coldUrl: (room) => (room ? '/?room=' + encodeURIComponent(room) + '&tap=1' : '/'), stashTap: false })
`
}

function vaultEntry({ page, tenant, brand, accent, endpoint, loginBase, appShare, lock, push }) {
  return `// vault.js — YOUR vault's configuration. Edit freely; keep the call to startVault.
// The keys of every Space live in core/ (in a worker on this origin); your app page at PAGE never holds one.
import { startVault } from ${sib('core/vault-core.js')}
import { defaultScreens } from ${sib('screens.js')}

const PAGE = ${esc(page)}   // your app — the only origin allowed to talk to this vault

startVault({
  page: PAGE,
  ${tenant ? `tenant: ${esc(tenant)},   // your tenant (public id): the Spaces this vault creates are yours, and your users' accounts are kept on the Witbitz account service as YOUR app's` : `// tenant: 't_…',   // your tenant (public id): the Spaces this vault creates are yours, and your users' accounts are kept on the Witbitz account service as YOUR app's`}
  // accountService: false,   // keep NEW accounts on the old backup store, as before SDK 3.28; the service needs this vault's origin PROVEN on your tenant. Never turn it off once accounts are there (they could not be saved)
  endpoint: ${esc(endpoint)},
  loginBase: ${esc(loginBase)},
  ${appShare ? `appShare: true,   // you serve your app-half function at /api/appshare on this origin: split-key Spaces` : `// appShare: true,   // serve your app-half function at /api/appshare on this origin, for split-key Spaces (createSpace({ key: 'split' }))`}
  ${lock ? `lock: true,   // your users may lock this vault with a passkey and encrypt its storage (your page opens the sheet: wb.vault.showLock())` : `// lock: true,   // let your users lock this vault with a passkey and encrypt its storage (your page opens the sheet: wb.vault.showLock())`}
  ${push ? `push: true,   // your users may turn on notifications (your page asks: wb.vault.showNotifications(); the worker is push-sw.js)` : `// push: true,   // let your users turn on notifications (your page asks: wb.vault.showNotifications(); the worker is push-sw.js)`}
  brand: ${esc(brand || 'this app')},   // your name, on any screen a screens.js of yours does not have yet
  screens: defaultScreens({ brand: ${esc(brand || 'this app')}${accent ? `, accent: ${esc(accent)}` : ''} }), // or your own: see screens.js
})
`
}

function readme({ page, vault, tenant, brand, endpoint, loginBase }) {
  const h = headersFor({ page, endpoint, loginBase })
  return `# ${brand || 'Your'} vault — a Witbitz vault kit

This folder is a vault: a small site you serve on **${vault}** that keeps the keys of every Space your users use, and
shows your app (**${page}**) inside it. Your app uses the Witbitz SDK in vault mode and never holds a key — not in its
memory, not in its storage, not in a link.

    const wb = await Witbitz.inVault({ vault: '${vault}' })   // in your app page
    const space = await wb.createSpace({ agent: { name: 'Assistant' } })
    space.on('message', (m) => show(m))
    await space.send('Hello')
    await wb.vault.share(space)                               // the vault shows the invite link

## What is yours, what is ours

| | |
|---|---|
| \`vault.js\` | yours — the configuration |
| \`screens.js\` | yours — sign-in, share, "didn't load". Restyle them or write your own (same functions, same promises) |
| \`index.html\`, \`space/index.html\` | ours — rewritten every run: they pin every script here by its sha384. **After you edit \`vault.js\`, \`screens.js\` or add a module, run the kit again** — it keeps your files and pins them; a file changed without that is refused by the browser |
| \`core/\` | ours — everything that touches a key. Don't edit it; re-run the kit tool to upgrade (it replaces only core/) |
| \`push-sw.js\` | ours — the notifications' service worker, used only with \`push: true\` in vault.js; a re-run replaces it |

Options in \`vault.js\` (or build flags): \`lock: true\` (\`--lock\`) lets your users lock the vault with a passkey and encrypt
its storage — your page opens the sheet with \`wb.vault.showLock()\`; \`push: true\` (\`--push\`) lets them turn on
notifications — \`wb.vault.showNotifications()\`. Off unless you turn them on.

## Serving it

1. Put the folder at the **root** of ${vault} (any static host: nginx, Caddy, Apache, a bucket, Cloudflare Pages).
2. Send these headers on every response (HEADERS.md has them for nginx / Caddy / Apache):
${Object.entries(h).map(([k, v]) => `   - \`${k}: ${v}\``).join('\n')}
3. Your app page (${page}) must allow being framed by the vault: \`Content-Security-Policy: frame-ancestors ${vault}\`.
4. ${tenant ? `Declare BOTH origins on your tenant (${tenant}): \`await admin.origins.declare(['${vault}', '${originOf(page)}'])\`.` : 'Declare both origins on your tenant (`admin.origins.declare([...])`) once you have one, so the Spaces this vault creates are yours.'}
   The vault's worker makes the requests, so the server sees ${vault}.
   **Prove the vault's origin** too (a file \`${vault}/.well-known/witbitz-tenant.txt\` holding your tenant id, or a DNS TXT record —
   \`admin.origins.declare\` answers how): your users' accounts are kept on the Witbitz account service as your app's, and the service
   takes your tenant only from a proven origin. Until it is proven, new accounts stay on the old backup store.
5. Split-key Spaces (\`createSpace({ key: 'split' })\`): serve your app-half function at \`${vault}/api/appshare\` — copy
   the template in https://witbitz.chat/docs/sdk-keys.md#split-key — and build with \`--app-share\` (or set \`appShare: true\` in vault.js).

## What it promises — and what it does not

The keys stay in this vault's origin; your app page, its code and every package it loads cannot read them or keep
them for later, and cannot reach a Space once it is removed here. Removing a Space, signing out and joining from a link
are confirmed by the person in this vault's screens, not by your page. Your app still shows the conversation, so it
sees what it displays. And because you host this vault too, it protects keys from your app's code — not from you.

Docs: https://witbitz.chat/docs/sdk-keys.md#vault-mode
`
}

function headersDoc(o) {
  const h = headersFor(o)
  return `# Headers for the vault

Send these on EVERY response of the vault origin.

\`\`\`text
${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n')}
\`\`\`

## nginx

\`\`\`nginx
location / {
${Object.entries(h).map(([k, v]) => `  add_header ${k} "${v}" always;`).join('\n')}
  try_files $uri $uri/ /index.html;
}
\`\`\`

## Caddy

\`\`\`caddy
header {
${Object.entries(h).map(([k, v]) => `  ${k} "${v}"`).join('\n')}
}
try_files {path} {path}/ /index.html
file_server
\`\`\`

## Apache (.htaccess)

\`\`\`apache
${Object.entries(h).map(([k, v]) => `Header always set ${k} "${v}"`).join('\n')}
FallbackResource /index.html
\`\`\`
`
}

const defaultWrite = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s) }
/** Build the kit into o.out from `source` (folderSource / releaseSource). → { files, kept, from } */
export async function buildKit(o, source, { write = defaultWrite, exists = existsSync, readOut = (p) => readFileSync(p, 'utf8'), listOut = walk } = {}) {
  const opts = { endpoint: DEFAULTS.endpoint, loginBase: DEFAULTS.loginBase, ...o }
  const core = await closureOf(['vault-core.js', 'sw-notif-core.js'], source.read) // sw-notif-core: a classic script push-sw.js imports (no ES import names it); vault-core names l1-worker-src.js (the pinned key worker)
  if (!core.has(WORKER_SRC)) throw new Error(`vault-kit: the core has no ${WORKER_SRC} (the key worker's pinned source) — this release predates the pinned kit; use a newer one`)
  const hashes = {}
  for (const [f, src] of core) {
    const left = src.replace(PURE_NOTE, '').match(PLACEHOLDER) // a bundler's purity note (the key worker's bundle) is not a build placeholder
    if (left) throw new Error(`vault-kit: ${f} still carries the build placeholder ${left[0]}`)
    write(join(opts.out, 'core', f), src)
    hashes['core/' + f] = sri(src)
  }
  // YOURS: written once, never over your edits — an upgrade replaces only core/
  const kept = []
  const once = async (f, s) => { if (exists(join(opts.out, f))) kept.push(f); else write(join(opts.out, f), typeof s === 'function' ? await s() : s) }
  await once('screens.js', async () => (await source.read('vault-screens.js')).split(STAMP).join(''))
  await once('vault.js', vaultEntry(opts))
  write(join(opts.out, 'push-sw.js'), pushWorker(opts)) // OURS, like core/ (inert until a vault with `push: true` registers it)
  let upgraded = false; try { upgraded = exists(join(opts.out, 'kit.json')) && !JSON.parse(readOut(join(opts.out, 'kit.json'))).pinned } catch { /* */ } // a kit from before the pinned page: its host's headers need the one change
  // THE PAGE, LAST: it pins every script now in the folder — core/ just written, and the builder's own files as they are on disk
  const pinned = scriptsIn(opts.out, readOut, listOut)
  const { html, policy } = vaultPage(opts.brand || 'Vault', pinned)
  const replaced = []
  for (const f of ['index.html', 'space/index.html']) {
    const p = join(opts.out, f)
    if (exists(p)) { const cur = readOut(p); if (!cur.includes(PAGE_MARK) && cur !== legacyPage(opts.brand || 'Vault') && !exists(p + '.bak')) { write(p + '.bak', cur); replaced.push(f) } } // a page the builder changed: kept beside it
    write(p, html)
  }
  write(join(opts.out, 'HEADERS.md'), headersDoc(opts))
  write(join(opts.out, 'README.md'), readme(opts))
  write(join(opts.out, 'kit.json'), JSON.stringify({ kit: 1, from: source.label, ...(source.version ? { sdk: source.version } : {}), ...(source.manifestSha ? { manifest: source.manifestSha } : {}), built: new Date().toISOString(), page: opts.page, vault: opts.vault, files: hashes, pinned, policy }, null, 2) + '\n')
  return { files: core.size, kept, from: source.label, pinned: Object.keys(pinned).length, replaced, upgraded }
}

/** The command line. `localDir`: a checkout's spaces/public (tools/vault-kit.mjs passes it); else a release URL. */
export async function main(argv = process.argv.slice(2), { localDir = '' } = {}) {
  const { o, err } = parseArgs(argv)
  if (err.length) { console.error('vault-kit: need ' + err.join('; ') + '\n\n  node vault-kit.mjs <outdir> --page https://app.acme.com/chat --vault https://vault.acme.com [--tenant t_…] [--brand Acme] [--from <release URL or folder>]'); process.exitCode = 2; return }
  const from = o.from || localDir || (KIT_RELEASE !== 'dev' ? `https://witbitz-spaces.pages.dev/sdk/${KIT_RELEASE}/` : DEFAULTS.from)
  const source = /^https?:\/\//.test(from) ? await releaseSource(from, { pin: o.manifestSha }) : folderSource(from)
  const r = await buildKit(o, source)
  console.log(`vault-kit: ${o.out} — core ${r.files} files from ${r.from}${r.kept.length ? '; kept your ' + r.kept.join(', ') : ''}; ${r.pinned} scripts pinned in index.html — run the kit again after you edit one; read ${join(o.out, 'README.md')}`)
  if (r.replaced.length) console.log(`vault-kit: ${r.replaced.join(', ')} had your changes — the kit writes these pages now (they pin your scripts); yours are kept as ${r.replaced.map((f) => f + '.bak').join(', ')}`)
  if (r.upgraded) console.log("vault-kit: ⚠ this kit pins its scripts — update your host's headers from HEADERS.md once (script-src adds 'unsafe-inline', worker-src adds blob:), or the vault will not start")
  if (source.manifestSha) console.log(`vault-kit: manifest ${source.manifestSha} — ${source.pinned ? 'matches your pin' : 'compare it with the one published for SDK ' + source.version + ' (https://witbitz.chat/docs/sdk-keys.md#vault-mode), or pass --manifest-sha to require it'}`)
}
if (typeof process !== 'undefined' && process.argv && import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String((e && e.message) || e)); process.exitCode = 1 })
