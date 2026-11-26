// Account-scoped room defaults. Pure merge rule shared by live encrypted sync, backup and tenant restore.
export const ROOM_DEFAULTS_KEY = 'space:default-room'
export const ROOM_DEFAULTS_DOC = 'room-defaults'
const BOOLS = ['quick','enclave','verified','lanes','temporary']
const STRINGS = ['assistant','model']
const FIELDS = [...BOOLS,...STRINGS]
let memory = null, notify = () => {}
export const setRoomDefaultsSync = fn => { notify = typeof fn === 'function' ? fn : () => {} }
export function cleanRoomDefaults(value) {
  if (!value || typeof value !== 'object' || value.v !== 1) return null
  const out = { v:1, mods:{} }
  for (const key of FIELDS) {
    if (BOOLS.includes(key) ? typeof value[key] !== 'boolean' : typeof value[key] !== 'string' || value[key].length > 200) continue
    out[key] = value[key]
    const at = value.mods?.[key]
    out.mods[key] = Number.isSafeInteger(at) && at >= 0 ? at : 0
  }
  return FIELDS.some(key => key in out) ? out : null
}
/** Per-option last-edit wins; equal clocks use a deterministic value order. An absent field never resets one. */
export function mergeRoomDefaults(a,b) {
  a=cleanRoomDefaults(a);b=cleanRoomDefaults(b)
  if(!a)return b;if(!b)return a
  const out={v:1,mods:{}}
  for(const key of FIELDS){
    const winner=!(key in a)?b:!(key in b)?a:a.mods[key]>b.mods[key]?a:a.mods[key]<b.mods[key]?b:JSON.stringify(a[key])>=JSON.stringify(b[key])?a:b
    if(key in winner){out[key]=winner[key];out.mods[key]=winner.mods[key]}
  }
  // Temporary rooms cannot create durable private assistants. The later of these two edits determines the combination.
  if(out.temporary && out.lanes){if(out.mods.temporary>=out.mods.lanes)out.lanes=false;else out.temporary=false}
  return out
}
export function readRoomDefaults(store=globalThis.localStorage) {
  if(memory && store===globalThis.localStorage)return memory
  try {
    const value=cleanRoomDefaults(JSON.parse(store.getItem(ROOM_DEFAULTS_KEY)||'null'))
    if(value)return value
    if(store.getItem('space:simple-setup')==='1')return cleanRoomDefaults({v:1,quick:true,enclave:true,verified:true,lanes:true,temporary:false,assistant:'',model:''})
  }catch{}
  return null
}
function arrived(){if(typeof dispatchEvent==='function')dispatchEvent(new Event('wb-room-defaults'))}
export function writeRoomDefaults(patch,baseline={},store=globalThis.localStorage,now=Date.now()) {
  const old=readRoomDefaults(store), next=cleanRoomDefaults({v:1,...baseline,...old,...patch})
  if(!next)return null
  next.mods={...(old?.mods||{})}
  const at=Math.max(now,...Object.values(next.mods).map(n=>n+1))
  for(const key of FIELDS)if(key in patch && key in next)next.mods[key]=at
  if(patch.temporary===true){next.lanes=false;next.mods.lanes=at}
  if(patch.lanes===true){next.temporary=false;next.mods.temporary=at}
  const value=cleanRoomDefaults(next)
  try{store.setItem(ROOM_DEFAULTS_KEY,JSON.stringify(value));store.removeItem('space:simple-setup');store.removeItem('space:simple-setup:previous-theme');memory=null}catch{if(store===globalThis.localStorage)memory=value}
  if(store===globalThis.localStorage){arrived();notify()}
  return value
}
export function adoptRoomDefaults(remote,store=globalThis.localStorage) {
  const local=readRoomDefaults(store),merged=mergeRoomDefaults(local,remote)
  if(!merged || JSON.stringify(local)===JSON.stringify(merged))return false
  try{store.setItem(ROOM_DEFAULTS_KEY,JSON.stringify(merged));memory=null}catch{return false}
  if(store===globalThis.localStorage)arrived()
  return true
}

/** A dedicated sealed account doc; failed/unknown reads never authorize a replacement write. */
export async function syncRoomDefaultsDocument({read,write=null,store=globalThis.localStorage}) {
  let response;try{response=await read()}catch{return {status:0}}
  if(!response || ![200,404].includes(response.status))return {status:0}
  const raw=response.state,remote=cleanRoomDefaults(raw)
  const empty=raw==null || (typeof raw==='object' && !Array.isArray(raw) && !Object.keys(raw).length)
  if(!remote && !empty)return {status:0}
  const merged=mergeRoomDefaults(readRoomDefaults(store),remote)
  if(!merged)return {status:200}
  adoptRoomDefaults(merged,store)
  if(write && JSON.stringify(merged)!==JSON.stringify(remote)){try{return await write(merged)}catch{return {status:0}}}
  return {status:200}
}
