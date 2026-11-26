import { SCHEDULES_DOC, ALWAYSON_DOC, alwaysOnNow, jobsOf, withJob, withoutJob, withPaused, summaryOf } from './schedulesDoc.js'

const fail = (code, message, status) => Object.assign(new Error('witbitz: ' + message), { code, ...(status ? { status } : {}) })

/** The same sealed schedule document edited by the app and executed by the cloud device. */
export class SpaceSchedules {
  constructor(space) { this._sp = space }
  async _read(name) {
    const s = this._sp, r = await s._client.state(s.room, s._mk, name)
    if (!r || r.status !== 200 || !Number.isInteger(r.v)) throw fail((r && r.error) || 'unreadable', 'the schedule document could not be read', r && r.status)
    return r
  }
  async list() { const s = this._sp; if (s._wb?.vault) return s._wb.vault._c.roomAccount(s.room, 'schedules', 'list'); return jobsOf(await this._read(SCHEDULES_DOC)) }
  async _edit(fn, needsDevice = false) {
    const s = this._sp
    if (needsDevice && !alwaysOnNow(await this._read(ALWAYSON_DOC))) throw fail('not_always_on', 'this Space needs an active cloud device for schedules')
    for (let i = 0; i < 5; i++) {
      const cur = await this._read(SCHEDULES_DOC), jobs = fn(jobsOf(cur))
      const r = await s._client.state(s.room, s._mk, SCHEDULES_DOC, { jobs }, summaryOf(jobs), s._who(), cur.v)
      if (r && r.status === 409) continue
      if (!r || r.status !== 200) throw fail((r && r.error) || 'save_failed', 'the schedules could not be saved', r && r.status)
      s._kick()
      if (s._wb && s._wb.cloudDevice) s._wb.cloudDevice._ask('sched', { room: s.room }).catch(() => {})
      return jobs
    }
    throw fail('version_conflict', 'the schedules kept changing; try again', 409)
  }
  async add({ when, text } = {}) {
    const s = this._sp; if (s._wb?.vault) return s._wb.vault._c.roomAccount(s.room, 'schedules', 'add', { when, text })
    let id
    const jobs = await this._edit((jobs) => { const next = withJob(jobs, { when, text, by: this._sp._who() }); id = next.at(-1).id; return next }, true)
    return jobs.find((j) => j.id === id)
  }
  async remove(id) { const s = this._sp; if (s._wb?.vault) return s._wb.vault._c.roomAccount(s.room, 'schedules', 'remove', id); return this._edit((jobs) => withoutJob(jobs, id)) }
  async pause(id, paused = true) {
    const s = this._sp; if (s._wb?.vault) return s._wb.vault._c.roomAccount(s.room, 'schedules', 'pause', id, !!paused)
    return this._edit((jobs) => { if (!jobs.some((j) => j.id === id)) throw fail('not_found', 'that schedule does not exist'); return withPaused(jobs, id, !!paused) }, !paused)
  }
}
