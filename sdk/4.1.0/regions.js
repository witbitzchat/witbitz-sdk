// regions.js — a room's home region is IN ITS ID (docs/multi-region.md). One parser for the page, the SDK and the Lambda
// (agent/spaceHandler.mjs imports this file, as it does roomName.js).
//
//   sp-k3j9x0a1b2c3        no marker: the default region — every room made before regions existed
//   sp-us-k3j9x0a1b2c3     homed in "us"            (tmp-us-… for a temporary room)
//
// Only codes in REGIONS count: sp-ci- (CI rooms), sp-rc- (/rc rooms) and the other two-letter prefixes this repo already
// uses are NOT regions, and spaces/test/regions.test.mjs refuses a table code that collides with one of them.
// Nothing is looked up — a room's region is known from its id alone, wherever the id is.

export const DEFAULT_REGION = 'eu'

/** The regions a room can be homed in. `aws` is where its storage and turns run. A code is two lower-case letters. */
export const REGIONS = Object.freeze({
  eu: Object.freeze({ aws: 'eu-central-1' }),
  us: Object.freeze({ aws: 'us-east-1' }),
})

const MARKED = /^(?:sp|tmp)-([a-z]{2})-[0-9a-z]+$/

/** The region a room is homed in: its marker when it names a region in the table, else the default. */
export function roomRegion(room) {
  const m = MARKED.exec(typeof room === 'string' ? room : '')
  return m && Object.prototype.hasOwnProperty.call(REGIONS, m[1]) ? m[1] : DEFAULT_REGION
}

/** A deployment's own region, from its /space-config (or the Lambda's env): an exact code in the table, else the default. */
export function regionCode(cfg) {
  const r = cfg && typeof cfg.region === 'string' ? cfg.region : ''
  return Object.prototype.hasOwnProperty.call(REGIONS, r) ? r : DEFAULT_REGION
}

/** True when `room` is homed somewhere other than `here`. */
export const isRemoteRoom = (room, here = DEFAULT_REGION) => roomRegion(room) !== here

/** A new room id homed in `region`. In the default region (or an unknown one) it has the old shape exactly, so a
 *  single-region deployment makes the same ids it always made. `rand` is for tests. */
export function newRoomId(region, { prefix = 'sp', rand = () => crypto.getRandomValues(new Uint8Array(8)) } = {}) {
  const tail = Array.from(rand()).map((x) => x.toString(36)).join('').slice(0, 12)
  const marked = region && region !== DEFAULT_REGION && Object.prototype.hasOwnProperty.call(REGIONS, region)
  return `${prefix}-${marked ? region + '-' : ''}${tail}`
}
