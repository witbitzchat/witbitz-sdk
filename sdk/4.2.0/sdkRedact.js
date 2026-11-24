// sdkRedact.js — keep a room's key out of a builder's logs (https://witbitz.chat/docs/sdk-roadmap.md, item 1, measured 2026-10-05).
//
// A Space's link and key ARE the admission: whoever holds them is a member. `console.log(space)` printed both (`_mk`,
// `shareLink` were plain enumerable properties), and an error reporter that walks objects (`Sentry.setContext('space',
// space)`) would have sent them to a third party. Two layers, so either habit is covered:
//   1. hide()  — the credential-bearing properties become NON-ENUMERABLE: still readable and writable by name (the SDK's
//      own code and `space.shareLink` / `space.key` are unchanged), invisible to Object.keys, for…in, spread, JSON and
//      every walker that follows enumerable keys.
//   2. redacted() — `toJSON()` and Node's `inspect.custom` print a short summary with `[REDACTED]` in place of each secret.
// Browsers' consoles show non-enumerable properties greyed out when an object is EXPANDED by hand; that is the developer
// opening the object on their own screen, not a log leaving it.

export const REDACTED = '[REDACTED]'
export const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/** Make `names` on `obj` non-enumerable, keeping their values and writability. Missing names are created undefined. */
export function hide(obj, names) {
  for (const n of names) {
    const d = Object.getOwnPropertyDescriptor(obj, n)
    Object.defineProperty(obj, n, { value: d ? d.value : undefined, writable: true, configurable: true, enumerable: false })
  }
  return obj
}

/** Install toJSON + inspect.custom on a class prototype. `summary(self)` returns the plain object to show. */
export function redacted(proto, summary) {
  Object.defineProperty(proto, 'toJSON', { value: function toJSON() { return summary(this) }, writable: true, configurable: true })
  Object.defineProperty(proto, INSPECT, {
    value: function inspect(depth, options, nodeInspect) {
      const s = summary(this)
      const name = (this && this.constructor && this.constructor.name) || 'Object'
      return typeof nodeInspect === 'function' ? `${name} ${nodeInspect(s, options)}` : { [name]: s }
    },
    writable: true, configurable: true,
  })
}
