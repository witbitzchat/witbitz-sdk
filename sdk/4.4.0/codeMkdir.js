// spaces/public/codeMkdir.js — the page-side constant + helper for "New folder" in the New-session picker
// (tools/code-mkdir.mjs is the connector side; this module holds what the browser needs, so no fs leaks into the page).
// The route is connector-owned and never reaches OpenCode — the page names the home (directory) and the relative path
// under it (path) it is already browsing, plus one clean leaf (name). Pure: no DOM, no fs.
export const MKDIR_ROUTE = '/witbitz/mkdir'

/** Build the mkdir request path: `/witbitz/mkdir?path=<rel>` (withDir appends `directory=`). */
export const mkdirPath = (rel) => MKDIR_ROUTE + (rel ? '?path=' + encodeURIComponent(rel) : '')
