// credits.js — WHAT A PERSON SEES IS CREDITS (the owner, 2026-10-24: "move all customer facing usage to credit terminology
// instead of dollar" → "100 credits = $1"). One unit for replies, cloud computers and whatever charges next; the price behind
// it (markup, discount, a cheaper host) can move without the number moving. Ledgers, keys, caps and a builder's billing stay
// in the providers' dollars — this converts for display only, so there is one source of truth and no rounding drift.

export const CREDITS_PER_USD = 100
export const RATE_LINE = '100 credits = $1'

/** Dollars → credits (a number, not rounded). */
export const creditsOf = (usd) => (Number(usd) || 0) * CREDITS_PER_USD
/** Micro-dollars → credits. */
export const creditsOfMicros = (micros) => (Number(micros) || 0) / 1e6 * CREDITS_PER_USD
/** Credits → dollars (what an amount typed in credits means to the API). */
export const usdOfCredits = (credits) => (Number(credits) || 0) / CREDITS_PER_USD

/** A number of credits a person can read: whole from 10 up (with separators), one decimal from 1, two below — and never a
 *  "0" for something that cost something (the smallest shown is 0.01). */
export function creditsNumber (c) {
  const v = Number(c) || 0
  if (v <= 0) return '0'
  if (v >= 10) return Math.round(v).toLocaleString('en-US')
  if (v >= 1) return String(Math.round(v * 10) / 10)
  return String(Math.max(Math.round(v * 100) / 100, 0.01))
}
/** "4 credits", "1 credit", "0.12 credits". */
export const creditsText = (c) => { const n = creditsNumber(c); return n + (n === '1' ? ' credit' : ' credits') }
/** Micro-dollars → "3.8 credits". */
export const creditsFromMicros = (micros) => creditsText(creditsOfMicros(micros))
/** Dollars → "5,000 credits". */
export const creditsFromUsd = (usd) => creditsText(creditsOf(usd))
