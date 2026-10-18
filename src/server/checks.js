// Remote checks (td check for contributors without a local toolchain) run in the worker process.
// The web process queues them in the database and waits for the result, so it never compiles
// anything itself and either process can restart without the other.

import { now } from './db.js';
import { summarizeCheck } from '../shared/check.js';

const POLL_MS = 1000;
const KEEP_MS = 24 * 3600_000;

export class CheckQueue {
  constructor({ store, repo, verifier, config, log = console }) {
    Object.assign(this, { store, repo, verifier, config, log });
    this.running = 0;
  }

  /** Web side: queues a check of already merged files and waits for its result. */
  async run(userId, files) {
    const id = Number(this.store.run(`INSERT INTO check_jobs (user_id, files_json, state, created_at) VALUES (?, ?, 'queued', ?)`, userId, JSON.stringify(files), now()).lastInsertRowid);
    // A queued check waits for the ones ahead of it, then builds; give up well after both.
    const deadline = Date.now() + 3 * (this.config.buildTimeoutMs ?? 300_000) + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const job = this.store.get('SELECT state, result_json FROM check_jobs WHERE id = ?', id);
      if (job.state === 'done') return JSON.parse(job.result_json);
      if (job.state === 'failed') throw new Error(JSON.parse(job.result_json).error);
    }
    this.store.run(`UPDATE check_jobs SET state = 'abandoned' WHERE id = ? AND state = 'queued'`, id);
    throw new Error('the check did not finish in time; the server may be busy, try again later');
  }

  /** Worker side. */
  start() {
    this.store.run(`UPDATE check_jobs SET state = 'queued' WHERE state = 'running'`);
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
  }

  pump() {
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
      const { check, rec } = await this.verifier.check(files, `check-${job.user_id}-${job.id}`);
      result = { gate: 'ok', head: this.repo.head(), ...summarizeCheck(check, rec, new Set(Object.keys(files))) };
    } catch (e) {
      state = 'failed';
      result = { error: e.message };
      this.log.error(`remote check ${job.id} failed: ${e.message}`);
    }
    this.store.run('UPDATE check_jobs SET state = ?, result_json = ?, finished_at = ? WHERE id = ?', state, JSON.stringify(result), now(), job.id);
  }
}
