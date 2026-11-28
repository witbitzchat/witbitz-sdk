// vcWorker.js — construct the key-holding Worker from source we already trust, with no runtime fetch.
//
// THE GAP. `new Worker(url)` accepts no `integrity`, and import maps are per-realm so the document's map never
// reaches a worker. `worker-src 'self'` is therefore the only workable policy — and `'self'` lets a compromised
// origin serve a swapped `l1-worker.js` straight into the realm that holds mk. Worse, a worker fetched by URL takes
// its CSP from its OWN response headers, so the document's connect-src does not restrain where it sends what it
// reads. Every other script on the page is pinned by hash; this one was not.
//
// THE FIX, AND WHY IT IS SHAPED LIKE THIS. The source arrives as a MODULE (`l1-worker-src.js`, generated at deploy
// by tools/build-verified-workers.mjs) that exports it as a string. So it is pinned exactly like every other
// module — an SRI entry, an import-map integrity key, and a hash in the enforced policy — and there is nothing to
// fetch, nothing to verify here, and no failure branch.
//
// ⚠ THE PREVIOUS ATTEMPT FETCHED AND HASHED THE BUNDLE AT RUNTIME, AND IT TOOK EVERY ROOM DOWN ON iOS. Worker
// creation sat behind a network round trip, inside a 5s liveness watchdog (vault-loader.js) that terminates and
// recreates a worker it believes is dead: on a slow link — or on iOS, where foregrounding fires that check
// mid-fetch — the watchdog killed a worker that did not exist yet, recreated it, and started another fetch. It
// never lived long enough to load keys. See design doc §14.5.
//
// So the property that matters here is not cryptographic, it is temporal: **this must stay SYNCHRONOUS.** Nothing
// in it may await. Keep it that way — a network round trip in front of worker creation is a change to somebody
// else's timeout, whether or not you were thinking about it.
// The deploy replaces the build placeholder everywhere in the tree, this file too — so the needle is built in two halves.
const UNSTAMPED = '__SPACES' + '_BUILD__'
export function makeVerifiedWorker (src, fallbackUrl, opts) {
  // No source compiled in: ONLY an unbuilt tree (dev, the tests) may load the worker by URL. A DEPLOYED build always bundles it
  // (deploy.sh / build-vault.sh run tools/build-verified-workers.mjs); one without it is broken or tampered with, and a URL worker
  // there is exactly the unpinned load this file exists to close — refused, as the builders' vault refuses (sync sweep 2026-11-14 P8).
  if (typeof src !== 'string' || src.length < 1000) {
    if (!String(fallbackUrl || '').includes(UNSTAMPED)) throw new Error('the key worker\'s pinned source is missing from this build — refusing to load it by URL')
    return new Worker(fallbackUrl, opts)
  }
  return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), opts)
}
