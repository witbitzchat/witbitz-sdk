// spaces/public/codeCommands.js — OpenCode's "/" commands and skills in the Code section.
//
// ★ NEVER POST /session/:id/command. Measured on opencode 1.18.30 (2026-09-13): that route substitutes the typed arguments
//   into the template and THEN runs every !`…` in the result through a shell — with no permission prompt, even in a session
//   whose rules deny bash (a probe `touch`ed a file that way, both for a command and for a skill). So a command's arguments
//   are a shell, and the relay must not carry them. An ordinary message with the same text runs nothing.
//
//   Instead the page reads the list (GET /command — name, description, source, template, agent, model), fills the
//   template in itself with OpenCode's OWN substitution rules (the regexes below are copied from its source), and sends an
//   ordinary message: what you typed ("/review main") as the visible part, the expansion as a `synthetic` part — measured:
//   the model reads it, the stored message keeps the flag, and the transcript hides it. A template that itself contains
//   !`…` needs the computer: it is listed, marked, and refused here.
//   Not reproduced from OpenCode's route: its @file expansion inside a template, and running `subtask` commands as a
//   sub-agent. The agent reads files itself, and the turn runs in the open session.

const SHELL_RE = /!`([^`]+)`/            // OpenCode: /!`([^`]+)`/g
const ARG_RE = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi // OpenCode's argument splitter
const QUOTE_RE = /^["']|["']$/g
const POS_RE = /\$(\d+)/g

const str = (v) => (v == null ? '' : String(v))

/** GET /command → the entries that can be offered, sorted by name. `needsComputer` = the template runs a shell. */
export function normCommands(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c === 'object' && str(c.name).trim() && typeof c.template === 'string')
    .map((c) => ({
      name: str(c.name).trim(),
      description: str(c.description),
      source: ['command', 'skill', 'mcp'].includes(c.source) ? c.source : 'command',
      template: c.template,
      agent: str(c.agent),
      model: str(c.model),
      needsComputer: SHELL_RE.test(c.template),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** OpenCode's substitution, minus the shell: $1…$n positional (the highest takes the rest), $ARGUMENTS verbatim, and
 *  with no placeholder at all the arguments are appended after a blank line. */
export function expandTemplate(template, args) {
  const a = str(args)
  const words = (a.match(ARG_RE) || []).map((w) => w.replace(QUOTE_RE, ''))
  const placeholders = template.match(POS_RE) || []
  let last = 0
  for (const p of placeholders) last = Math.max(last, Number(p.slice(1)))
  let out = template.replace(POS_RE, (_, n) => {
    const i = Number(n) - 1
    if (i < 0 || i >= words.length) return ''
    return Number(n) === last ? words.slice(i).join(' ') : words[i]
  })
  const hasAll = template.includes('$ARGUMENTS')
  out = out.split('$ARGUMENTS').join(a)
  if (!placeholders.length && !hasAll && a.trim()) out = `${out}\n\n${a}`
  return out.trim()
}

/** "/name args" at the very start of the message → {name, args}; anything else is a normal message. */
export function parseSlash(text) {
  const m = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(str(text))
  return m ? { name: m[1], args: str(m[2]).trim() } : null
}

/** The turn a "/…" message becomes, or null when it is not a known command (then it is sent as typed). */
export function commandTurn(text, commands) {
  const s = parseSlash(str(text).trim())
  if (!s || !Array.isArray(commands)) return null
  const cmd = commands.find((c) => c.name === s.name)
  if (!cmd) return null
  return {
    name: cmd.name, source: cmd.source, agent: cmd.agent, model: cmd.model,
    visible: `/${cmd.name}${s.args ? ' ' + s.args : ''}`,
    expanded: expandTemplate(cmd.template, s.args),
    blocked: cmd.needsComputer,
  }
}

/** Names starting with the query first, then names or descriptions containing it. */
export function filterCommands(commands, query) {
  const q = str(query).toLowerCase()
  const list = Array.isArray(commands) ? commands : []
  if (!q) return list.slice()
  const starts = list.filter((c) => c.name.toLowerCase().startsWith(q))
  const rest = list.filter((c) => !starts.includes(c) && (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)))
  return [...starts, ...rest]
}

/**
 * The menu over the composer. It opens while the message is a lone "/word" being typed, filters as you type, and picks
 * with a tap, Enter or Tab (↑↓ to move, Escape to close). Options fire on mousedown so the keyboard stays up.
 * @param input      the composer <textarea>
 * @param anchor     the element the menu sits above (the composer pill)
 * @param commands   () => { list } | { loading: true } | { error: 'why' } — asked on every open; may start a load
 * @param onChange   () => void — after a pick rewrites the input (autosize, direction)
 */
export function slashMenu({ input, anchor, commands, onChange = () => {} }) {
  let menu = null, items = [], index = 0
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
  const query = () => {
    const caret = input.selectionStart == null ? input.value.length : input.selectionStart
    const m = /^\/(\S*)$/.exec(input.value.slice(0, caret))
    return m && !/\S/.test(input.value.slice(caret, caret + 1)) ? m[1] : null
  }
  const close = () => { if (menu) { menu.remove(); menu = null } }
  const pick = (c) => {
    const rest = input.value.replace(/^\/\S*\s?/, '')
    input.value = `/${c.name} ${rest}`
    const end = c.name.length + 2
    try { input.setSelectionRange(end, end) } catch { /* not focused */ }
    close()
    onChange()
  }
  const render = () => {
    const q = query()
    if (q == null) return close()
    const state = commands() || {}
    if (!menu) {
      menu = el('div', 'slash-menu')
      menu.setAttribute('role', 'listbox')
      menu.addEventListener('mousedown', (e) => e.preventDefault()) // never take focus from the composer
      document.body.appendChild(menu)
    }
    menu.textContent = ''
    items = state.list ? filterCommands(state.list, q) : []
    if (index >= items.length) index = 0
    if (state.error) menu.append(el('div', 'slash-note', state.error))
    else if (state.loading) menu.append(el('div', 'slash-note', 'Loading commands…'))
    else if (!items.length) menu.append(el('div', 'slash-note', q ? `No command or skill matches "${q}"` : 'No commands or skills on this computer'))
    items.forEach((c, i) => {
      const row = el('button', 'slash-opt')
      row.type = 'button'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === index))
      const top = el('span', 'slash-top')
      top.append(el('span', 'slash-name', '/' + c.name), el('span', 'slash-src', c.source))
      row.append(top)
      if (c.description) row.append(el('span', 'slash-desc', c.description))
      if (c.needsComputer) row.append(el('span', 'slash-warn', 'Runs commands on your computer — start it there, not from here'))
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(c) })
      menu.append(row)
    })
    const r = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(8, r.left)}px`
    menu.style.width = `${Math.min(r.width, window.innerWidth - 16)}px`
    menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`
    const sel = menu.querySelector('[aria-selected="true"]')
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' })
  }
  input.addEventListener('input', () => { index = 0; render() })
  input.addEventListener('click', render)
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close() }, 150))
  // Capture, so a pick with Enter/Tab never reaches the composer's own keys (a newline, or send on ⌘/Ctrl-Enter).
  input.addEventListener('keydown', (e) => {
    if (!menu) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return }
    if (!items.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopImmediatePropagation()
      index = (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
      render()
    } else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
      e.preventDefault(); e.stopImmediatePropagation()
      pick(items[index])
    }
  }, true)
  return { refresh: render, close, isOpen: () => !!menu }
}
