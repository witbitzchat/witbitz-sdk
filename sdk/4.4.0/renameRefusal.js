// renameRefusal.js — WHY a rename was refused, in the room's own words: one table for the ⋯ menu, the drawer and the SDK
// (sync sweep, 2026-10-11 — every refusal said "admins", also to a signed-out, removed or unlisted member of a room with
// none). `refused` / `reason` are the title op's answer (roomName.sendRename: { refused: error, reason }).
export function renameRefusalText ({ refused, reason } = {}) {
  if (refused === 'direct_chat') return 'A direct chat isn’t renamed — each side sees the other person’s name.'
  if (refused === 'not_admin') return 'Only this Space’s admins can rename it.'
  if (refused === 'not_authorized') return reason === 'not_on_list' ? 'Your sign-in isn’t on this Space’s list.' : 'Sign in to rename this Space.'
  return 'Couldn’t rename this Space.'
}
