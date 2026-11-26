import { exportSpace, recreateSpace } from './spaceExport.js'
import { makeBundle, sealSpaceMeta, keysFileText } from './offlineBundle.js'

// Downloads stay in the document doing the export. A vault never returns the
// contents or a recovery key to its embedding page.
export function saveExport(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export async function saveOfflineReader() {
  const response = await fetch(new URL('./decrypt.html', import.meta.url))
  if (!response.ok) throw new Error('The offline reader could not be downloaded.')
  saveExport('witbitz-offline-decryptor.html', await response.text(), 'text/html;charset=utf-8')
}

export async function saveRoomExport(sp, tier, current = () => true, title = sp.title) {
  const reader = Object.fromEntries(['poll', 'getConfig', 'blob', 'state'].map((op) => [
    op, (room, ...args) => sp._client[op](room, sp._mk, ...args),
  ]))
  const bundle = await exportSpace(sp.room, reader, { title })
  if (!current()) throw new Error('account_changed')
  bundle.tier = tier
  saveExport('witbitz-space-' + sp.room + '.json', JSON.stringify(bundle), 'application/json')
  return { count: bundle.count }
}

export async function recreateExport(wb, bundle, { tier = bundle?.tier || (bundle?.device?.confidential === false ? 'standard' : 'enclave') } = {}) {
  const email = wb.vault ? (await wb.vault.whoami())?.email : wb.session?.email
  if (!email) throw Object.assign(new Error('Sign in to recreate a Space for yourself.'), { code: 'sign_in_required' })
  let space
  const result = await recreateSpace(bundle, {
    createSpace: async (cfg) => {
      space = await wb.createSpace({
        agent: { name: cfg.agentName, instructions: cfg.persona }, model: cfg.model, tools: cfg.tools,
        clientTools: cfg.clientTools, agentReplies: cfg.agentReplies,
        immediateTools: cfg.immediateTools, data: cfg.dataSchema, platformTools: cfg.platformTools,
        framing: cfg.framing, dataWrites: cfg.dataWrites, admission: { emails: [email], admins: [email] }, tier,
      })
      return { room: space.room, mk: space._mk, keyless: !!wb.vault }
    },
    mirror: (_room, _mk, entries) => space._client.mirror(space.room, space._mk, entries),
  })
  let titleWarning
  if (bundle.title) { try { await space.rename(bundle.title) } catch { titleWarning = 'The room was copied, but its title could not be saved.' } }
  return { space, carried: result.carried, total: result.total, ...(titleWarning ? { titleWarning } : {}) }
}

export async function saveAccountArchive(rooms, resolveRoom, recoveryKeys, current) {
  const spaces = [], keys = [], unavailable = []
  for (const r of rooms) {
    if (!current()) throw new Error('account_changed')
    try {
      const { key, ledger, count } = await resolveRoom(r, recoveryKeys)
      if (!key || (!recoveryKeys && !ledger)) throw new Error('room_unavailable')
      if (recoveryKeys) keys.push({ room: r.room, title: r.label || r.title || '', key })
      else spaces.push({ meta: await sealSpaceMeta(key, { room: r.room, title: r.label || r.title || '', count }), ledger })
    } catch { unavailable.push(r.room) }
  }
  if (!current()) throw new Error('account_changed')
  const saved = recoveryKeys ? keys.length : spaces.length
  if (!saved) throw Object.assign(new Error('No rooms could be exported.'), { code: 'archive_empty', unavailable })
  if (recoveryKeys) saveExport('witbitz-room-keys.txt', keysFileText(keys), 'text/plain')
  else saveExport('witbitz-spaces.json', JSON.stringify(makeBundle(spaces)), 'application/json')
  return { saved, unavailable }
}
