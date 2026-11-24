// pushCore.js — THE PUSH SUBSCRIPTION, ONE IMPLEMENTATION FOR BOTH APPS (docs/convergence-review-2026-10-17.md, step 2). The
// regular app (notifications.js) and the tenant vault (vault-loader.js — it owns push for the framed app) each had their
// own; the vault's subscribe had none of the iOS lessons the regular one learned. Leaf module: no DOM beyond what is passed.
import { nativeRegistration } from './nativePush.js' // the Android / Windows app's registration (no service worker needed)

/** A base64URL VAPID public key → the bytes pushManager.subscribe wants. */
export function vapidBytes (s) {
  const t = (String(s) + '='.repeat((4 - (String(s).length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const b = atob(t); const u = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i)
  return u
}

/** The page's service-worker registration, ACTIVE — bounded. `navigator.serviceWorker.ready` waits for ever when the
 *  registration is gone (the update fail-safe unregisters it), and every push path then hangs with no error: re-register a
 *  missing one, and give up with a readable error after `ms`. */
export async function swRegBounded ({ ms = 8000, sw = (typeof navigator !== 'undefined' ? navigator.serviceWorker : null), path = '/sw.js', sleep = (r) => setTimeout(r, 250), native = nativeRegistration } = {}) {
  if (!sw) { const nr = native(); if (nr) return nr; throw new Error('no service worker support') }
  let reg = null
  try { reg = await sw.getRegistration() } catch { /* */ }
  // inside the Windows app no service worker may register (bridge.go): its push runs through the app's bridge (nativePush.js)
  if (!reg) { const nr = native(); if (nr) return nr }
  if (!reg) { try { reg = await sw.register(path) } catch (e) { throw new Error('service worker gone and re-register failed (' + ((e && e.message) || e) + ') — close and reopen the app') } }
  const t0 = Date.now()
  while (!reg.active) { if (Date.now() - t0 > ms) throw new Error('service worker not active after ' + (ms / 1000) + 's — close and reopen the app'); await new Promise(sleep) }
  return reg
}

/** This registration's push subscription, made if there is none — the iOS lessons (2026-09): subscribe() can STALL for ever
 *  when the push service does not answer (raced against `timeoutMs`), and THROWS for a wedged registration or one minted
 *  under an older VAPID key (drop the stale subscription, try once more). Permission is the caller's: this assumes it is
 *  granted. → { sub, err } — never throws, never hangs. */
export async function subscribeRobust (reg, vapidKey, { timeoutMs = 10000 } = {}) {
  let sub = null
  try { sub = await reg.pushManager.getSubscription() } catch { /* treat as none */ }
  if (sub) return { sub, err: '' }
  const withTimeout = (pr) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after ' + (timeoutMs / 1000) + 's — push service unreachable')), timeoutMs))])
  const mk = () => withTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(vapidKey) }))
  try { return { sub: await mk(), err: '' } } catch { /* a stale or wedged subscription: drop it and try once more */ }
  try { const old = await reg.pushManager.getSubscription(); if (old) await old.unsubscribe() } catch { /* */ }
  try { return { sub: await mk(), err: '' } } catch (e) { return { sub: null, err: e && e.name ? e.name + ': ' + e.message : String(e) } }
}
