/**
 * A small pool of worker threads for image encoding.
 *
 * Decoding and re-encoding a poster is 100-200ms of pure-JS CPU (see
 * imageEncoder.js). Done on the request thread, fifty cold posters from one
 * freshly opened grid queue up behind each other on the event loop - the
 * grid fills in one poster at a time, and every other request the server is
 * handling waits in the same line. In workers they run in parallel on the
 * box's other cores and the event loop stays free.
 *
 * Sized at cores-minus-one, capped at three: enough parallelism to clear a
 * grid quickly without starving the main thread or the database. Every
 * failure path degrades to encoding in-process, which is exactly what ran
 * before this existed - a box where workers cannot start is slower, never
 * broken.
 */
const os = require('os')
const path = require('path')
const { encode: encodeInProcess } = require('./imageEncoder')

let Worker = null
try { ({ Worker } = require('node:worker_threads')) } catch { /* in-process only */ }

const POOL_SIZE = Math.max(1, Math.min(3, ((os.cpus && os.cpus().length) || 2) - 1))
const JOB_TIMEOUT_MS = 20000

class EncodePool {
  constructor() {
    this.workers = []
    this.idle = []
    this.queue = []
    this.jobs = new Map()
    this.nextId = 1
    this.started = false
    this.broken = !Worker
  }

  start() {
    if (this.started) return
    this.started = true
    if (this.broken) {
      console.log('[ImageCache] encode pool: in-process (worker threads unavailable)')
      return
    }
    const script = path.join(__dirname, 'imageWorker.js')
    for (let i = 0; i < POOL_SIZE; i++) {
      try {
        const w = new Worker(script)
        w.on('message', (m) => this.onMessage(w, m))
        w.on('error', (e) => this.onFailure(w, e))
        w.on('exit', (code) => { if (code !== 0) this.onFailure(w, new Error(`worker exited ${code}`)) })
        // A worker must never keep the process alive on its own.
        if (typeof w.unref === 'function') w.unref()
        this.workers.push(w)
        this.idle.push(w)
      } catch (e) {
        console.warn('[ImageCache] encode worker failed to start:', e?.message)
        break
      }
    }
    if (this.workers.length === 0) this.broken = true
    console.log(`[ImageCache] encode pool: ${this.broken ? 'in-process (workers unavailable)' : `${this.workers.length} worker(s)`}`)
  }

  // Resolves { buf, format } - the format actually produced, which is the
  // caller's to trust over the one it asked for (see imageEncoder.encode).
  async encode(buf, opts) {
    this.start()
    if (this.broken) return encodeInProcess(buf, opts)
    try {
      return await this.dispatch(buf, opts)
    } catch (e) {
      // A worker dying or timing out is an infrastructure failure, not a
      // verdict on the image - do the work here instead. A genuine decode
      // error comes back as a plain error and propagates.
      if (e && e.workerFailure) return encodeInProcess(buf, opts)
      throw e
    }
  }

  dispatch(buf, opts) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        const job = this.jobs.get(id)
        if (!job) return
        this.jobs.delete(id)
        const err = new Error('encode timeout'); err.workerFailure = true
        reject(err)
      }, JOB_TIMEOUT_MS)
      this.jobs.set(id, { resolve, reject, timer, buf, opts, worker: null })
      this.queue.push(id)
      this.pump()
    })
  }

  pump() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const id = this.queue.shift()
      const job = this.jobs.get(id)
      if (!job) continue
      const worker = this.idle.pop()
      job.worker = worker
      worker.postMessage({ id, buf: job.buf, w: job.opts.w, format: job.opts.format })
    }
  }

  onMessage(worker, m) {
    if (!this.idle.includes(worker)) this.idle.push(worker)
    const job = m && this.jobs.get(m.id)
    if (job) {
      this.jobs.delete(m.id)
      clearTimeout(job.timer)
      if (m.error) job.reject(new Error(m.error))
      else job.resolve({ buf: Buffer.from(m.out), format: m.format || job.opts.format })
    }
    this.pump()
  }

  onFailure(worker, e) {
    this.workers = this.workers.filter((w) => w !== worker)
    this.idle = this.idle.filter((w) => w !== worker)
    for (const [id, job] of this.jobs) {
      if (job.worker === worker) {
        this.jobs.delete(id)
        clearTimeout(job.timer)
        const err = new Error(`encode worker failed: ${e?.message || e}`); err.workerFailure = true
        job.reject(err)
      }
    }
    if (this.workers.length === 0) {
      this.broken = true
      console.warn('[ImageCache] all encode workers gone - encoding in-process from here')
      // Anything still queued runs here rather than waiting for nobody.
      for (const id of this.queue.splice(0)) {
        const job = this.jobs.get(id)
        if (!job) continue
        this.jobs.delete(id)
        clearTimeout(job.timer)
        encodeInProcess(job.buf, job.opts).then(job.resolve, job.reject)
      }
    } else {
      this.pump()
    }
  }
}

module.exports = new EncodePool()
