// HTTP client for the coordinator API.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class Api {
  constructor(server, token) {
    this.server = server.replace(/\/+$/, '');
    this.token = token;
  }

  async request(method, path, body) {
    const res = await fetch(this.server + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      const e = new Error(`${res.status} ${data.error ?? res.statusText}`);
      e.status = res.status;
      e.details = data.details;
      throw e;
    }
    return data;
  }

  get(p) {
    return this.request('GET', p);
  }
  post(p, body = {}) {
    return this.request('POST', p, body);
  }

  /** Downloads to `dest` and verifies the SHA-256; the file is removed on mismatch. */
  async download(url, dest, sha256) {
    // The token is sent only to our own server (a project may limit downloads to contributors).
    const own = this.token && this.server && url.startsWith(this.server + '/');
    const res = await fetch(url, own ? { headers: { authorization: `Bearer ${this.token}` } } : undefined);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
    const hash = crypto.createHash('sha256');
    const tmp = dest + '.part';
    const body = Readable.fromWeb(res.body);
    body.on('data', (c) => hash.update(c));
    await pipeline(body, fs.createWriteStream(tmp));
    const got = hash.digest('hex');
    if (sha256 && got !== sha256.toLowerCase()) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`hash mismatch for ${url}: expected ${sha256}, got ${got}`);
    }
    fs.renameSync(tmp, dest);
    return got;
  }
}
