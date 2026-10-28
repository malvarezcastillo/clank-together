// Remote checks (td check for contributors without a local toolchain) run in the worker process.
// The web process queues them in the database and waits for the result, so it never compiles
// anything itself and either process can restart without the other.

import crypto from 'node:crypto';
import { now } from './db.js';
import { summarizeCheck } from '../shared/check.js';

const POLL_MS = 1000;
const KEEP_MS = 24 * 3600_000;
// The worker records that it is alive; without it, checks are refused at once instead of waiting.
const HEARTBEAT_KEY = 'worker_seen';
const HEARTBEAT_MS = 5000;
const WORKER_GONE_MS = 30_000;

export class WorkerUnavailable extends Error {}

export class CheckQueue {
  constructor({ store, repo, verifier, config, log = console }) {
    Object.assign(this, { store, repo, verifier, config, log });
    this.running = 0;
    this.waiters = new Map(); // web side: job id -> requests waiting for it
    this.detached = new Set(); // web side: checks started without waiting (kept until fetched)
  }

  workerAlive() {
    return now() - Number(this.store.getMeta(HEARTBEAT_KEY) ?? 0) < WORKER_GONE_MS;
  }

  /**
   * Web side: queues a check of already merged files and waits for its result. A retry of the same
   * files joins the job already on its way; a job nobody waits for any more is dropped.
   * @param {AbortSignal} [signal]  aborted when the client disconnects
   */
  /**
   * Queues a check (or joins the same one already on its way) and returns its id without waiting:
   * the agent works on while it compiles and fetches the result with `result()`.
   */
  enqueue(userId, files, { detached = false } = {}) {
    if (!this.workerAlive()) throw new WorkerUnavailable('the compile service is paused for maintenance; try again in a few minutes');
    const filesJson = JSON.stringify(files);
    const hash = crypto.createHash('sha256').update(filesJson).digest('hex');
    const existing = this.store.get(`SELECT id FROM check_jobs WHERE user_id = ? AND files_hash = ? AND state IN ('queued', 'running') ORDER BY id DESC LIMIT 1`, userId, hash);
    const id = existing?.id ?? Number(this.store.run(`INSERT INTO check_jobs (user_id, files_json, files_hash, state, created_at) VALUES (?, ?, ?, 'queued', ?)`, userId, filesJson, hash, now()).lastInsertRowid);
    // A check nobody waits on is dropped when its last waiter leaves; one started without waiting
    // keeps an extra waiter until its result is fetched or a day passes.
    if (detached) this.detached.add(id);
    return id;
  }

  /** The state of a check of this user; with the result once done. */
  result(userId, id) {
    const job = this.store.get('SELECT id, user_id, state, result_json, created_at, finished_at FROM check_jobs WHERE id = ?', id);
    if (!job || job.user_id !== userId) return null;
    const ahead = job.state === 'queued' ? this.store.get(`SELECT COUNT(*) AS n FROM check_jobs WHERE state IN ('queued', 'running') AND id < ?`, id).n : 0;
    if (job.state === 'done') this.detached.delete(id);
    return {
      checkId: job.id,
      state: job.state,
      ...(job.state === 'queued' && { ahead }),
      ...(job.state === 'done' && { result: JSON.parse(job.result_json) }),
      ...(job.state === 'failed' && { error: JSON.parse(job.result_json).error }),
    };
  }

  async run(userId, files, { signal } = {}) {
    const id = this.enqueue(userId, files);
    this.waiters.set(id, (this.waiters.get(id) ?? 0) + 1);
    try {
      // A queued check waits for the ones ahead of it, then builds; give up well after both.
      const deadline = Date.now() + 3 * (this.config.buildTimeoutMs ?? 300_000) + 60_000;
      while (Date.now() < deadline && !signal?.aborted) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const job = this.store.get('SELECT state, result_json FROM check_jobs WHERE id = ?', id);
        if (job.state === 'done') return JSON.parse(job.result_json);
        if (job.state === 'failed') throw new Error(JSON.parse(job.result_json).error);
        if (job.state === 'queued' && !this.workerAlive()) throw new WorkerUnavailable('the compile service is paused for maintenance; try again in a few minutes');
      }
      throw new Error(signal?.aborted ? 'the client went away' : 'the check did not finish in time; the server may be busy, try again later');
    } finally {
      const left = this.waiters.get(id) - 1;
      if (left > 0) this.waiters.set(id, left);
      else {
        this.waiters.delete(id);
        if (!this.detached.has(id)) this.store.run(`UPDATE check_jobs SET state = 'abandoned' WHERE id = ? AND state = 'queued'`, id);
      }
    }
  }

  /** Worker side. */
  start() {
    this.stopped = false;
    this.store.run(`UPDATE check_jobs SET state = 'queued' WHERE state = 'running'`);
    this.store.setMeta(HEARTBEAT_KEY, now());
    this.heartbeat = setInterval(() => {
      try {
        this.store.setMeta(HEARTBEAT_KEY, now());
      } catch (e) {
        this.log.error(`worker heartbeat: ${e.message}`);
      }
    }, HEARTBEAT_MS);
    this.timer = setInterval(() => {
      try {
        this.pump();
      } catch (e) {
        this.log.error(`check pump: ${e.message}`);
      }
    }, POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.stopped = true;
  }

  pump() {
    if (this.stopped || this.verifier.repositoryBlocked) return;
    const max = this.config.remoteCheckConcurrency ?? 2;
    while (this.running < max) {
      const job = this.store.tx(() => {
        const row = this.store.get(`SELECT * FROM check_jobs WHERE state = 'queued' ORDER BY id LIMIT 1`);
        if (row) this.store.run(`UPDATE check_jobs SET state = 'running' WHERE id = ?`, row.id);
        return row;
      });
      if (!job) break;
      this.running++;
      this.execute(job).finally(() => this.running--);
    }
    this.store.run(`DELETE FROM check_jobs WHERE created_at < ? AND state != 'running'`, now() - KEEP_MS);
  }

  async execute(job) {
    const files = JSON.parse(job.files_json);
    let state = 'done';
    let result;
    try {
      const { check, rec, changedHeaders } = await this.verifier.check(files, `check-${job.user_id}-${job.id}`, { dependents: false });
      result = { gate: 'ok', head: this.repo.head(), ...summarizeCheck(check, rec, new Set(Object.keys(files))) };
      if (changedHeaders?.length) result.note = 'Header changes: this check compiled only your own files. The submission is also checked against every file that includes the changed headers.';
    } catch (e) {
      state = 'failed';
      result = { error: e.message };
      this.log.error(`remote check ${job.id} failed: ${e.message}`);
    }
    this.store.run('UPDATE check_jobs SET state = ?, result_json = ?, finished_at = ? WHERE id = ?', state, JSON.stringify(result), now(), job.id);
  }
}
