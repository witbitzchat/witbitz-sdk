// spaces/public/codeUndo.js — /undo, /redo and /compact in the Code section.
//
// Measured on opencode 1.18.30 (2026-09-13), a real agent writing a file in a scratch git repo:
//   undo     POST /session/:id/revert {messageID} → the Session, revert {messageID, snapshot, diff}; the files are back as
//            they were before that turn ("two" → "one"). GET …/message still lists EVERY message — hiding is the page's.
//   redo     POST /session/:id/unrevert → files forward again, revert cleared.
//   final    a new message while undone drops the undone turns for good (and clears revert).
//   compact  POST /session/:id/summarize {providerID, modelID} → true; a user `compaction` part + an assistant summary.
//   events   session.updated carries the revert point, so an undo made elsewhere reaches this page.
// The pure rules are tested in spaces/test/codeUndo.test.mjs.

import { normRevert } from './opencodeWire.js' // the pure wire shape lives with the rest of the wire
export { normRevert }

const indexOf = (messages, revert) => (revert ? messages.findIndex((m) => m && m.info && m.info.id === revert.messageID) : -1)
const isUser = (m) => m && m.info && m.info.role === 'user'

/** The transcript as it stands: everything before the undone turn. A revert point not in the list hides nothing. */
export function visibleMessages(messages, revert) {
  const at = indexOf(messages, revert)
  return at < 0 ? messages : messages.slice(0, at)
}

/** What /undo takes back: the last of your turns still showing (its message id), or null when there is none. */
export function undoTarget(messages, revert) {
  const shown = visibleMessages(messages, revert)
  for (let i = shown.length - 1; i >= 0; i--) if (isUser(shown[i])) return shown[i].info.id
  return null
}

// The page's own commands, listed after the computer's in the "/" menu (menu-shaped like normCommands' entries). They
// win over a computer command of the same name, as OpenCode's TUI's do.
export const UNDO_COMMANDS = [
  { name: 'undo', description: 'Take back your last turn, and the changes it made to files', source: 'built-in', template: '', agent: '', model: '', needsComputer: false },
  { name: 'redo', description: 'Bring back what undo took away', source: 'built-in', template: '', agent: '', model: '', needsComputer: false },
  { name: 'compact', description: 'Summarize the conversation so far, to free the model\'s context', source: 'built-in', template: '', agent: '', model: '', needsComputer: false },
]
/** "/undo", "/redo", "/compact" (anything after the name is ignored) → its name; anything else → null. */
export function undoCommand(text) {
  const m = /^\/(\S+)(?:\s[\s\S]*)?$/.exec(String(text || '').trim())
  return m && UNDO_COMMANDS.some((c) => c.name === m[1]) ? m[1] : null
}

/** How many of your turns the undo took away (what the note says). */
export function undoneTurns(messages, revert) {
  const at = indexOf(messages, revert)
  return at < 0 ? 0 : messages.slice(at).filter(isUser).length
}
