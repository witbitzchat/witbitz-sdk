// workerClient.js — the Spaces app's room worker, as an SDK client (docs/sdk-convergence.md, phase 1).
//
// The SDK's Space calls `client.op(room, mk, …)`. The app confines mk to a worker (l1.js → l1-worker.js; in the tenant app
// the worker is hoisted into the vault), whose facade takes the SAME ops and arguments minus mk — the worker inserts its
// own. So the adapter only drops the mk argument, and says it is `keyless`: a Space over it never holds the key, and
// refuses what would need it in the page (see witbitz-sdk.js, KEYLESS).
//
//   const space = new Space(workerClient(l1), { room, mk: null, poll: false })
export const WORKER_OPS = ['poll', 'pollSealed', 'turn', 'state', 'data', 'title', 'decide', 'pending', 'subscribe', 'unsubscribe',
  'mirror', 'toolResult', 'getConfig', 'setConfig', 'blob', 'toolBook', 'react', 'safeCopy', 'mark', 'leave', 'carry', 'purge', 'mailPurge', 'intakeReg', 'intakePush', 'intake', 'intakeAck']

export function workerClient (l1) {
  const c = { keyless: true }
  for (const op of WORKER_OPS) if (typeof l1[op] === 'function') c[op] = (room, _mk, ...rest) => l1[op](room, ...rest)
  return c
}
