// spaces/public/codeModes.js — the Code composer's ACCEPT EDITS mode, as OpenCode permission rules.
//
// The owner, beside Claude Code's modes: "What about an equivalent of accept edits" — and chose "secrets still ask".
// Unlike Auto (decided by the connector), Accept edits is decided by OpenCode ITSELF: the page appends rules to the
// session (PATCH /session/:id {permission}), so it holds with every phone closed and on any connector.
//
// Measured on opencode 1.18.30 (the evaluator and matcher below are copied from its bundle, and a real turn confirmed it):
//   • evaluate = rules.flat().findLast(match permission && match pattern) ?? ask — the LAST matching rule wins
//   • PATCH /session/:id {permission} APPENDS to the session's rules; it never replaces them
//   • the edit/write/apply_patch tools ask as `edit`, with the path RELATIVE to the worktree ("src/a.ts", ".env")
//   • a wildcard `*` crosses "/", the match is anchored and case-sensitive
// So switching appends: Accept edits = allow every edit, then ask again for protected files; Manual = one "ask" rule.
// Edits outside the project still ask first through `external_directory`, which these rules never touch.

/** OpenCode 1.18 Wildcard.match. */
export function wildcardMatch(str, pattern) {
  const s = String(str).replaceAll('\\', '/')
  let re = String(pattern).replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  if (re.endsWith(' .*')) re = re.slice(0, -3) + '( .*)?'
  return new RegExp('^' + re + '$', 's').test(s)
}

/** OpenCode 1.18 Permission.evaluate over one ruleset → 'allow' | 'ask' | 'deny'. */
export function evaluateRules(permission, pattern, rules) {
  const hit = (Array.isArray(rules) ? rules : []).findLast((r) => r && wildcardMatch(permission, r.permission) && wildcardMatch(pattern, r.pattern))
  return hit ? hit.action : 'ask'
}

// Protected files — the same families tools/code-auto.mjs keeps out of Auto's fast allow. Each name is matched at the
// project root AND under any folder ("*/" — a wildcard crosses "/"). OpenCode's match is case-sensitive, so the common
// spellings are listed.
const DIRS = ['.git', '.ssh', '.aws', '.gnupg', '.kube', '.docker']
const NAMES = ['.env', '.env.*', '.npmrc', '.netrc', '.pypirc', ...['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'].flatMap((k) => [k, k + '.pub'])]
const KEY_EXTS = ['pem', 'key', 'p12', 'pfx', 'jks', 'keystore'].flatMap((e) => [e, e.toUpperCase()])
const WORDS = ['secret', 'Secret', 'SECRET', 'credential', 'Credential', 'CREDENTIAL']
const SAFE_ENV = ['.env.example', '.env.sample', '.env.template', '.env.dist']

const rule = (pattern, action) => ({ permission: 'edit', pattern, action })
const atAnyDepth = (p) => [p, '*/' + p]

/** Appended to switch a session to Accept edits. */
export function acceptEditsRules() {
  return [
    rule('*', 'allow'),
    ...NAMES.flatMap(atAnyDepth).map((p) => rule(p, 'ask')),
    ...SAFE_ENV.flatMap(atAnyDepth).map((p) => rule(p, 'allow')), // a template is not a secret — but only here: the
    ...DIRS.flatMap((d) => atAnyDepth(d + '/*')).map((p) => rule(p, 'ask')), // asks after it still win (.git/…, secrets/…)
    ...KEY_EXTS.map((e) => rule('*.' + e, 'ask')),
    ...WORDS.map((w) => rule('*' + w + '*', 'ask')),
  ]
}

/** Appended to go back: the last matching rule wins, so one rule undoes all of the above. */
export const askEditsRules = () => [rule('*', 'ask')]

/** Whether a session's rules let an ordinary edit through without asking — how the chip knows the mode. */
export const acceptsEdits = (rules) => evaluateRules('edit', 'src/index.ts', rules) === 'allow'
