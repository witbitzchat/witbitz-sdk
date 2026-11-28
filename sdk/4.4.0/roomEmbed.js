const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const types = new Set(['string', 'number', 'boolean', 'array', 'object'])
const validName = name => /^[a-zA-Z0-9_]{1,64}$/.test(name) && !Object.hasOwn(Object.prototype, name)
export function applySkills(config, skills) {
  if (skills === undefined) return
  if (!object(skills) || Object.keys(skills).length > 16 || !Object.entries(skills).every(([name, spec]) => validName(name) && object(spec) &&
    [spec.in, ...(spec.out === undefined ? [] : [spec.out])].every(schema => object(schema) && Object.keys(schema).length <= 16 &&
      Object.entries(schema).every(([key, type]) => validName(key) && types.has(type)))))
    throw Object.assign(new Error('Each skill needs a name and a typed input schema.'), { code: 'invalid_argument' })
  config.skills = Object.fromEntries(Object.entries(skills).map(([name, spec]) => [name, { in: { ...spec.in } }]))
  const protocol = skillProtocol(skills)
  if (protocol) config.persona = (config.persona || '') + '\n' + protocol
}

export function skillProtocol(skills) {
  const names = Object.keys(skills || {})
  if (!names.length) return ''
  const rows = names.map((n) => '  • ' + n + '(' + JSON.stringify((skills[n] || {}).in || {}) + ')')
  return [
    '',
    '--- YOUR MCP SKILLS (the app invokes these on you as TYPED tool calls over the bridge, NOT chat messages) ---',
    ...rows,
    'When one is invoked you are told exactly which skill and with what arguments. Handle it FULLY — use your platform',
    'tools (read_url, web_search, the map/photo tools, …) whenever they make the answer better — then reply with the',
    'finished answer for the reader. Do not just echo the raw arguments back.',
  ].join('\n')
}

export function embeddedInvite(template, link, origin) {
  if (typeof template !== 'string' || template.length > 2000 || template.split('{link}').length !== 2 || !link)
    throw Object.assign(new Error('An invite template needs a single {link} placeholder.'), { code: 'invalid_argument' })
  const base = new URL(origin)
  const url = new URL(template.replace('{link}', encodeURIComponent(link)), base.origin)
  if (!['http:', 'https:'].includes(base.protocol) || url.origin !== base.origin || url.username || url.password)
    throw Object.assign(new Error('The invite must open the embedding application.'), { code: 'invalid_argument' })
  return url.href
}

export function setLiveDoc(docs, name, text) {
  const key = String(name || 'document').slice(0, 80)
  if (typeof text === 'string' && text) docs[key] = text.slice(0, 4000)
  else delete docs[key]
}
export function formatLiveDocs(embedLiveDocs, meet = '') {
  const names = Object.keys(embedLiveDocs).filter((n) => embedLiveDocs[n])
  if (!names.length) return meet || undefined
  let body = ''
  for (const n of names) body += '[' + String(n).slice(0, 80) + ']\n' + String(embedLiveDocs[n]) + '\n\n'
  return (meet + '=== LIVE CONTEXT (the CURRENT text of what the user has open right now — e.g. a draft, a call transcript. It updates live; reason over THIS and quote it exactly. It is not a saved file.) ===\n\n' + body + '=== end live context ===').slice(0, 4000) // matches the server's 4KB context cap; large sources get windowed/summarized later
}

export function roomEmbed(space, knownLane = () => false) {
  const docs = Object.create(null), watches = new Set()
  const owner = () => space._wb?.vault ? space._wb._memoryGeneration : space._wb?._archiveGeneration
  const generation = space._memoryOwner ?? owner()
  const active = () => !space._stopped && generation === owner()
  function check() {
    if (!active()) throw Object.assign(new Error('The Space closed or the account changed.'), { code: 'closed' })
  }
  async function state(patch) {
    check()
    const r = patch === undefined ? await space._client.state(space.room, space._mk, 'embed')
      : await space._client.state(space.room, space._mk, 'embed', patch, '', 'embed')
    check()
    if (r?.status !== 200) throw Object.assign(new Error('The embedded state could not be synchronized.'), { code: r?.error || 'unavailable' })
    return r
  }
  return {
    context: () => active() ? formatLiveDocs(docs) : undefined,
    close() { for (const stop of [...watches]) stop(); for (const name of Object.keys(docs)) delete docs[name] },
    api: {
      async invite(template) {
        check()
        if (space._sharedRoom || space._detachedLane || knownLane()) throw Object.assign(new Error('A private lane cannot be shared'), { code: 'private_lane' })
        if (space._wb?.vault) return space._wb.vault.share(space, { hostInviteTemplate: template })
        return embeddedInvite(template, space.shareLink, globalThis.location?.origin)
      },
      async read() { return (await state()).state ?? null },
      async update(patch) {
        if (!object(patch)) throw Object.assign(new Error('A state update needs an object.'), { code: 'invalid_argument' })
        await state(patch)
      },
      watch(fn) {
        check()
        if (typeof fn !== 'function') throw new TypeError('A state listener is required.')
        let timer, stopped = false, version = -1
        const stop = () => { stopped = true; clearTimeout(timer); watches.delete(stop) }
        async function poll() {
          try {
            const r = await state(), v = r.v || 0
            if (!stopped && v > version) { version = v; fn(r.state ?? null) }
          } catch { /* retry when the room becomes available */ }
          if (!stopped && active()) timer = setTimeout(poll, 2500)
          else stop()
        }
        watches.add(stop); void poll()
        return stop
      },
      setLiveDocument(name, text) { check(); setLiveDoc(docs, name, text) },
    },
  }
}

export function roomInviteFlags(link) {
  try {
    const url = new URL(link, 'https://example.invalid/')
    const fragment = new URLSearchParams(url.hash.slice(1))
    const has = (key, value) => url.searchParams.getAll(key).includes(value) || fragment.getAll(key).includes(value)
    return { gated: has('gate', 'email'), lanes: has('lanes', '1') }
  } catch { return { gated: false, lanes: false } }
}
