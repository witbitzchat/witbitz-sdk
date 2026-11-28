// Room activity and changes to who a private room is linked to have distinct clocks.
export function associationTime(record, now = Date.now()) {
  return Math.max(now, (Number(record?.associationAt || record?.at) || 0) + 1)
}
// Normalize legacy records before cursor or key maintenance can move their activity time.
export function reconcilePrivateRooms(pipes) {
  const byRoom = new Map()
  for (const pipe of Object.values(pipes)) {
    if (pipe?.kind === 'lane-lane') { pipe.associationAt ||= Number(pipe.at) || 1; continue }
    if (pipe?.kind !== 'private-lane') continue
    pipe.associationAt ||= Number(pipe.at) || 1
    const room = pipe.lane?.room
    if (!room || pipe.removed) continue
    if (!byRoom.has(room)) byRoom.set(room, [])
    byRoom.get(room).push(pipe)
  }
  const conflicting = new Set()
  for (const parents of byRoom.values()) {
    for (const pipe of parents) {
      const upstream = byRoom.get(pipe.shared?.room)
      if (!upstream) continue
      conflicting.add(pipe)
      for (const other of upstream) conflicting.add(other)
    }
  }
  for (const parents of byRoom.values()) {
    if (parents.length < 2 && !conflicting.has(parents[0])) continue
    const decision = Math.max(...parents.map(p => p.associationAt))
    for (const pipe of parents) {
      pipe.removed = true
      pipe.associationAt = decision
      pipe.cursor = 0
    }
  }
  return pipes
}

export function preferredAssociation(left, right) {
  if (!left || !right) return left || right
  const explicit = record => Number(record.associationAt) || (record.kind === 'private-lane' || record.kind === 'lane-lane' || record.detachedLane || record.removed ? Number(record.at) || 0 : 0)
  const a = explicit(left), b = explicit(right)
  if (a !== b) return a > b ? left : right
  if (left.detachedLane || left.removed) return left
  if (right.detachedLane || right.removed) return right
  const activity = Number(right.at || 0) - Number(left.at || 0)
  if (activity) return activity > 0 ? right : left
  const destination = record => record.lane?.room || (typeof record.shared === 'string' ? record.shared : '') || ''
  return destination(right) > destination(left) ? right : left
}

/** A private room cannot itself parent another private room. Suspend both edges of any merged chain. */
export function reconcileAccountLanes(rooms) {
  const parents = new Map(rooms.filter(r => r.shared && !r.detachedLane).map(r => [r.room, r]))
  const suspend = new Map()
  for (const child of parents.values()) {
    const parent = parents.get(child.shared)
    if (!parent) continue
    const at = Math.max(Number(child.associationAt || child.at) || 1, Number(parent.associationAt || parent.at) || 1)
    for (const r of [parent, child]) suspend.set(r.room, Math.max(at, suspend.get(r.room) || 0))
  }
  return rooms.map(r => {
    if (!suspend.has(r.room)) return r
    const detached = { ...r, kind: 'space', detachedLane: true, associationAt: suspend.get(r.room) }
    delete detached.shared
    delete detached.laneOrigin
    return detached
  })
}
