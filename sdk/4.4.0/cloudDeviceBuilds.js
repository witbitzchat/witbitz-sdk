// cloudDeviceBuilds.js — what the phone hands the cloud device of the turn-enclave builds the account accepted (docs/cloud-device.md
// § 4.9; cloudDeviceSheet.js). Pure: the device keeps the union, so the phone sends only what the device lacks — a build it does not
// hold, or a newer "accept new builds automatically" choice. A list not yet known on this phone (`ours` null) is never sent.
const buildKey = (e) => [e.kernel, e.payload || '', e.policy || ''].join('|')
export function deviceLacksBuilds (theirs, ours) {
  if (!ours) return false
  const have = new Set(((theirs && theirs.builds) || []).map(buildKey))
  if ((ours.builds || []).some((e) => !have.has(buildKey(e)))) return true
  const a = ours.auto, b = theirs && theirs.auto
  return !!a && (!b || a.at > b.at)
}
