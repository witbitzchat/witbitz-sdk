// spaces/public/codeFolders.js — "allow this folder": ONE card for a folder outside the project, for the whole conversation.
//
// The owner, with a session refused twice reading ~/witbitz-code-pub: "It should ask for permission once for the whole new
// project like the parent directory which should be enough". OpenCode asks `external_directory` for the folder of EACH file
// it reaches (`<dirname>/*`) and for each folder a command touches, so every new subfolder asked again — and Auto answered
// only "once", judging each one. Now the card names the folder the ask belongs to (its git root, or the top folder under
// home), and allowing it adds `external_directory <folder>/* allow` to the session (the connector: tools/code-folders.mjs,
// witbitz_code/folders.py). Session rules are last-match-wins and `*` crosses "/" (measured, OpenCode 1.18.30), so
// everything inside is allowed from then on — for this conversation and the subagents it starts.
//
// Pure, shared by the page, the connector and Auto (tools/code-auto.mjs); the Python twin answers the same
// (tools/code-folders.vectors.json).
export const FOLDER_ROUTE = '/witbitz/folder'

const SYSTEM = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var']
const SECRET_PARTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.git'])
const GLOB = /[*?[\]{}]/

/** posix.normalize for absolute paths, without node:path (this module also runs in the browser). '' when not absolute. */
export function normAbs(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) return ''
  const out = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop(); else out.push(part)
  }
  return '/' + out.join('/')
}
const under = (p, root) => root === '/' ? p.startsWith('/') : p === root || p.startsWith(root + '/')

/**
 * The folder an outside path belongs to — what "allow this folder" allows. null when it must not be widened: the home
 * folder itself, "/", a system folder, a secret store, or a hidden folder right under home (~/.config, ~/.local…).
 *   dir     the directory OpenCode asked for (a pattern's `<dir>` of `<dir>/*`)
 *   home    this computer's home directory
 *   hasGit  (path) => whether `path/.git` exists — the nearest one below home (or anywhere, outside home) is the root
 */
export function folderRoot(dir, { home = '', hasGit = () => false } = {}) {
  const d = normAbs(dir)
  const h = normAbs(home) === '/' ? '' : normAbs(home) // a home of "/" is no home to go by
  if (!d || d === '/' || (h && d === h) || GLOB.test(d)) return null
  if (d.split('/').some((part) => SECRET_PARTS.has(part))) return null
  if (SYSTEM.some((s) => under(d, s))) return null
  if (h && under(h, d)) return null // an ancestor of home holds home
  const inHome = !!h && under(d, h)
  if (inHome && d.slice(h.length + 1).startsWith('.')) return null
  // the nearest git root — never home or /tmp themselves, or above them (a stray /tmp/.git must not swallow every temp folder)
  for (let p = d; p !== '/' && !(h && p === h) && p !== '/tmp'; p = p.slice(0, p.lastIndexOf('/')) || '/') {
    if (inHome && !under(p, h)) break
    let git = false
    try { git = !!hasGit(p) } catch { git = false }
    if (git) return p
  }
  if (inHome) return h + '/' + d.slice(h.length + 1).split('/')[0]
  if (under(d, '/tmp')) return d === '/tmp' ? '/tmp' : '/tmp/' + d.slice(5).split('/')[0]
  return d
}

/** The directories an external_directory ask names: its patterns' `<dir>` of `<dir>/*`. null when any is not that shape. */
export function askDirs(ask) {
  const pats = ask && Array.isArray(ask.patterns) ? ask.patterns : []
  if (!pats.length) return null
  const dirs = []
  for (const p of pats) {
    if (typeof p !== 'string' || !p.endsWith('/*')) return null
    const d = normAbs(p.slice(0, -2))
    if (!d || GLOB.test(p.slice(0, -2))) return null
    dirs.push(d)
  }
  return dirs
}

/** The folders to allow for an ask — one per distinct root, in order; null when any of its directories cannot be widened. */
export function foldersForAsk(ask, opts) {
  if (!ask || ask.permission !== 'external_directory') return null
  const dirs = askDirs(ask)
  if (!dirs) return null
  const roots = []
  for (const d of dirs) {
    const r = folderRoot(d, opts)
    if (!r) return null
    if (!roots.includes(r)) roots.push(r)
  }
  return roots
}

/** The rule that allows a folder. */
export const folderRule = (root) => ({ permission: 'external_directory', pattern: root + '/*', action: 'allow' })

/** The folders a session's rules allow outside its project: every `external_directory <abs>/*` whose LAST matching rule of
 *  that exact pattern allows (OpenCode's last-match-wins). */
export function allowedFolders(rules) {
  const last = new Map()
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || r.permission !== 'external_directory' || typeof r.pattern !== 'string' || !r.pattern.endsWith('/*')) continue
    last.set(r.pattern, r.action)
  }
  const out = []
  for (const [pattern, action] of last) {
    const d = normAbs(pattern.slice(0, -2))
    if (action === 'allow' && d && d !== '/' && !GLOB.test(pattern.slice(0, -2)) && !out.includes(d)) out.push(d)
  }
  return out
}

/** Is the absolute path inside one of the folders? */
export const insideFolders = (abs, folders) => { const a = normAbs(abs); return !!a && (Array.isArray(folders) ? folders : []).some((f) => { const r = normAbs(f); return !!r && r !== '/' && under(a, r) }) }

/** Does an external_directory ask fall entirely inside allowed folders? */
export function foldersCover(ask, folders) {
  const dirs = askDirs(ask)
  return !!dirs && dirs.every((d) => insideFolders(d, folders))
}

/** "~/witbitz-code-pub" for the card. */
export const displayPath = (p, home) => { const h = normAbs(home); return h && h !== '/' && under(p, h) ? '~' + p.slice(h.length) : p }
