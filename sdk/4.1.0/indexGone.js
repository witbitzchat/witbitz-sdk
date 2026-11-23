// indexGone.js — ONE RULE for "this account was deleted while the device was offline" (the app: devices.js indexGoneVerdict; the SDK:
// sdkAccount.js — sync sweep 2026-11-18 #11: the SDK read any non-200 as "unreadable" for ever). The account's index answers 410
// once Delete my account deleted it (only that deletes an account index). Believed only when seen twice at least a minute apart —
// one odd answer never wipes a device — and a good read clears the note. Pure: the caller keeps `first`.
export const INDEX_GONE_AFTER_MS = 60_000
/** → { first, erased }: `first` is what to keep (0 = clear it); `erased` = sign this device out as erased now. */
export function indexGoneStep (first, status, now = Date.now()) {
  if (status !== 410) return { first: status === 200 ? 0 : (Number(first) || 0), erased: false }
  const f = Number(first) || 0
  if (!f) return { first: now, erased: false }
  return { first: f, erased: now - f >= INDEX_GONE_AFTER_MS }
}
