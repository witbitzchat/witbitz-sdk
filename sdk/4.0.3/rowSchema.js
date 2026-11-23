// rowSchema.js — a store collection's ROW SCHEMA: a small, deterministic JSON Schema subset (portal/docs/sdk-store.md#schemas).
//
// One module, two callers, one verdict: the server (agent/dataTools.mjs — a member's write is refused, the assistant's
// data_put is not proposed) and the SDK (checkDataSchema refuses a schema the server could not enforce). No dependency:
// it is in the confidential tier's measured code, and every keyword below is a few lines anyone can read.
//
// Supported: type (object|string|number|integer|boolean|array|null, or a list of them), properties, required,
// additionalProperties (true|false), enum, const, minLength, maxLength, minimum, maximum, exclusiveMinimum,
// exclusiveMaximum, items, minItems, maxItems, format (date | date-time | email | uri), and the annotations description,
// title, default, examples (kept for the assistant, never checked).
// Refused: anything else, including `pattern` — a regular expression from a room's config run against every row on our
// servers is a denial-of-service waiting to happen. A keyword we cannot check is REFUSED at declaration, never ignored:
// a schema that silently skips a rule reads exactly like one that holds it.

export const MAX_SCHEMA_BYTES = 8_000
export const MAX_SCHEMA_DEPTH = 6
const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null'])
const CHECKED = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'items', 'minItems', 'maxItems', 'format'])
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples', '$comment'])
const FORMATS = new Set(['date', 'date-time', 'email', 'uri'])
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isCount = (v) => Number.isInteger(v) && v >= 0

/** Why this schema cannot be enforced, or null when it can. The top level must describe an object (a row). */
export function schemaProblem(schema) {
  let bytes
  try { bytes = new TextEncoder().encode(JSON.stringify(schema)).length } catch { return 'it is not JSON' }
  if (bytes > MAX_SCHEMA_BYTES) return `it is ${bytes} bytes; the limit is ${MAX_SCHEMA_BYTES}`
  if (!isObj(schema)) return 'it must be an object'
  if (schema.type !== undefined && schema.type !== 'object') return 'a row schema describes an object: type must be "object"'
  return walk(schema, '', 0)
}

function walk(s, at, depth) {
  const where = at || 'the row'
  if (!isObj(s)) return `${where}: a schema must be an object`
  if (depth > MAX_SCHEMA_DEPTH) return `${where}: nested deeper than ${MAX_SCHEMA_DEPTH}`
  for (const k of Object.keys(s)) if (!CHECKED.has(k) && !ANNOTATIONS.has(k)) return `${where}: "${k}" is not supported${k === 'pattern' ? ' (regular expressions are not run on the server)' : ''}`
  if (s.type !== undefined) { const ts = Array.isArray(s.type) ? s.type : [s.type]; if (!ts.length || ts.some((t) => !TYPES.has(t))) return `${where}: type must be one of ${[...TYPES].join(', ')}` }
  if (s.properties !== undefined) {
    if (!isObj(s.properties)) return `${where}: properties must be an object`
    for (const [k, v] of Object.entries(s.properties)) { const p = walk(v, `${at ? at + '.' : ''}${k}`, depth + 1); if (p) return p }
  }
  if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((x) => typeof x === 'string'))) return `${where}: required must be a list of field names`
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') return `${where}: additionalProperties must be true or false`
  if (s.enum !== undefined && !(Array.isArray(s.enum) && s.enum.length)) return `${where}: enum must be a non-empty list`
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (s[k] !== undefined && !isCount(s[k])) return `${where}: ${k} must be a whole number`
  for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (s[k] !== undefined && !isNum(s[k])) return `${where}: ${k} must be a number`
  if (s.format !== undefined && !FORMATS.has(s.format)) return `${where}: format must be one of ${[...FORMATS].join(', ')}`
  if (s.items !== undefined) { const p = walk(s.items, `${at || 'row'}[]`, depth + 1); if (p) return p }
  return null
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v === 'number' ? 'number' : typeof v)
const matchesType = (v, t) => { const k = typeOf(v); return k === t || (t === 'number' && k === 'integer') }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const okFormat = {
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')),
  'date-time': (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)),
  email: (v) => /^[^\s@]{1,200}@[^\s@]{1,253}\.[^\s@]{2,63}$/.test(v),
  uri: (v) => { try { return !!new URL(v).protocol } catch { return false } },
}

/** The FIRST way `row` breaks `schema` — `{ path, message }` — or null when it fits. Deterministic: properties are checked
 *  in the schema's own order, so the same row always gets the same answer. Assumes schemaProblem(schema) === null. */
export function rowProblem(schema, row) { return check(schema, row, '') }

function check(s, v, at) {
  const where = at || 'the row'
  const fail = (message) => ({ path: at || '', message: `${where} ${message}` })
  if (s.type !== undefined) { const ts = Array.isArray(s.type) ? s.type : [s.type]; if (!ts.some((t) => matchesType(v, t))) return fail(`must be ${ts.join(' or ')}, not ${typeOf(v)}`) }
  if (s.const !== undefined && !same(v, s.const)) return fail(`must be ${JSON.stringify(s.const)}`)
  if (s.enum !== undefined && !s.enum.some((e) => same(e, v))) return fail(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`)
  if (typeof v === 'string') {
    if (s.minLength !== undefined && [...v].length < s.minLength) return fail(`must be at least ${s.minLength} characters`)
    if (s.maxLength !== undefined && [...v].length > s.maxLength) return fail(`must be at most ${s.maxLength} characters`)
    if (s.format !== undefined && !okFormat[s.format](v)) return fail(`must be a valid ${s.format}`)
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) return fail(`must be ≥ ${s.minimum}`)
    if (s.maximum !== undefined && v > s.maximum) return fail(`must be ≤ ${s.maximum}`)
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) return fail(`must be > ${s.exclusiveMinimum}`)
    if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) return fail(`must be < ${s.exclusiveMaximum}`)
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) return fail(`must have at least ${s.minItems} items`)
    if (s.maxItems !== undefined && v.length > s.maxItems) return fail(`must have at most ${s.maxItems} items`)
    if (s.items !== undefined) for (let i = 0; i < v.length; i++) { const p = check(s.items, v[i], `${at || 'row'}[${i}]`); if (p) return p }
  }
  if (isObj(v)) {
    for (const k of (s.required || [])) if (v[k] === undefined) return { path: at ? `${at}.${k}` : k, message: `${at ? at + '.' : ''}${k} is required` }
    const props = s.properties || {}
    for (const [k, sub] of Object.entries(props)) if (v[k] !== undefined) { const p = check(sub, v[k], at ? `${at}.${k}` : k); if (p) return p }
    if (s.additionalProperties === false) { const extra = Object.keys(v).find((k) => !(k in props)); if (extra !== undefined) return { path: at ? `${at}.${extra}` : extra, message: `${at ? at + '.' : ''}${extra} is not a field of this collection` } }
  }
  return null
}

/** A short, readable line per field for the assistant's tool description: "title (string, required)". */
export function describeFields(schema) {
  const props = isObj(schema && schema.properties) ? schema.properties : {}
  const req = new Set(Array.isArray(schema && schema.required) ? schema.required : [])
  return Object.entries(props).map(([k, s]) => {
    const bits = []
    if (s && s.type) bits.push(Array.isArray(s.type) ? s.type.join('|') : s.type)
    if (s && Array.isArray(s.enum)) bits.push('one of ' + s.enum.map((e) => JSON.stringify(e)).join('/'))
    if (s && s.format) bits.push(s.format)
    if (req.has(k)) bits.push('required')
    if (s && typeof s.description === 'string') bits.push(s.description.slice(0, 120))
    return `${k}${bits.length ? ' (' + bits.join(', ') + ')' : ''}`
  }).join(', ')
}
