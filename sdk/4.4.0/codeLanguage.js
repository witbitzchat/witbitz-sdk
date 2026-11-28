// spaces/public/codeLanguage.js — the language the person writes in, so the coding agent narrates in it.
//
// The owner: "when deepseek is in a hebew project it thinks in english". Measured (2026-09-14, DeepSeek V4 Flash through
// OpenCode, a Hebrew request): no reasoning comes back — the English was the NARRATION between steps ("I'll analyze the
// case file…"), because everything around the model is English (OpenCode's prompt, the tools, this page's PROGRESS rule).
// An English "answer in the person's language" line changed nothing; a line written IN HEBREW, first in the turn's
// `system`, made the narration Hebrew and kept the answers right at the same token cost (spaces/test/codeLanguage.test.mjs).
// Only Hebrew is measured; another language gets no line until it is.

export const HEBREW_LINE = 'שפה: האדם כותב בעברית. כתוב בעברית כל טקסט שאתה מציג — גם את עדכוני ההתקדמות הקצרים לפני פעולה ובין שלבים, וגם את התשובה. שמות קבצים, פקודות וקוד נשארים כפי שהם.'

// …and beside the question itself. In a long session (the owner's: ≈677k tokens, mostly English narration) the line alone
// was not enough — the answer opened with an English paragraph. A synthetic part right after the person's words was.
export const HEBREW_NUDGE = '(ענה בעברית בלבד — גם עדכוני ההתקדמות, ההסברים וכל משפט אחר שאתה כותב. שמות קבצים, פקודות וקוד נשארים כפי שהם.)'

const HEBREW = /[א-ת]/g
const LATIN = /[A-Za-z]/g

/** 'he' | 'other' | '' (too few letters to say). Code, links and path-like words are left out of the count. */
export function languageOf(text) {
  const words = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .split(/\s+/)
    .filter((w) => !/[/\\._]/.test(w.replace(/^[א-ת]-/, '')) || !/[A-Za-z]/.test(w))
    .join(' ')
  const he = (words.match(HEBREW) || []).length
  const latin = (words.match(LATIN) || []).length
  if (he + latin < 3) return ''
  return he / (he + latin) >= 0.3 ? 'he' : 'other'
}

/** The line for the person's messages, newest first: the first one that says anything decides. */
export function languageLine(texts) {
  for (const t of texts || []) {
    const lang = languageOf(t)
    if (lang === 'he') return HEBREW_LINE
    if (lang) return ''
  }
  return ''
}

/** The turn's instructions with the language line FIRST — where it was measured to work. */
export function withLanguage(system, texts) {
  const line = languageLine(texts)
  return line ? `${line}\n\n${system}` : system
}

/** The reminder that rides beside the person's words on a Hebrew turn — a synthetic part (the model reads it, the
 *  transcript does not show it) — or null. */
export function languageNudge(texts) {
  return languageLine(texts) === HEBREW_LINE ? { type: 'text', text: HEBREW_NUDGE, synthetic: true } : null
}
