// Live updates for the website over a WebSocket (/api/live): the feed, progress, changes to the
// map and the viewer's own credit balance, pushed as they happen instead of polled by every tab.
//
// The worker writes to the database from another process, so the web process watches it: every
// two seconds it reads the events that are new (a primary-key range), and when work moved it
// recomputes the progress and map (shared caches) and sends only what changed. A minimal
// RFC 6455 server: text frames out; pings, pongs and close in. Nothing a client sends changes
// anything; it only listens.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CLIENTS = 1000;
const MAX_PER_IP = 8;

export class Live {
  constructor({ store, credits, feed, progress, map, pipeline, userFromCookie, allowedOrigins, clientIp, log = console }) {
    Object.assign(this, { store, credits, feed, progress, map, pipeline, userFromCookie, allowedOrigins, clientIp, log });
    this.clients = new Set();
    this.lastEvent = store.get('SELECT COALESCE(MAX(id), 0) AS n FROM events').n;
    this.lastMap = null;
    this.lastProgress = null;
    this.lastPipeline = null;
  }

  attach(server) {
    server.on('upgrade', (req, socket) => {
      try {
        this.accept(req, socket);
      } catch {
        socket.destroy();
      }
    });
    this.timer = setInterval(() => this.tick().catch(() => {}), 2000);
    this.pinger = setInterval(() => this.ping(), 30_000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.pinger);
    for (const c of this.clients) c.socket.destroy();
  }

  accept(req, socket) {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    const refuse = (code, why) => {
      socket.end(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (url.pathname !== '/api/live' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) return refuse(400, 'Bad Request');
    // Only our own pages (a cross-site page must not ride the session cookie).
    const origin = req.headers.origin;
    if (origin && !this.allowedOrigins.includes(origin)) return refuse(403, 'Forbidden');
    const ip = this.clientIp(req);
    if (this.clients.size >= MAX_CLIENTS || [...this.clients].filter((c) => c.ip === ip).length >= MAX_PER_IP) return refuse(503, 'Busy');
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    const user = this.userFromCookie(req);
    const client = { socket, ip, user, alive: true, balance: null, buf: Buffer.alloc(0) };
    this.clients.add(client);
    socket.on('data', (d) => this.read(client, d));
    socket.on('error', () => this.drop(client));
    socket.on('close', () => this.drop(client));
    // A fresh client gets the current picture once.
    this.send(client, { type: 'hello', user: user?.name ?? null, lastEvent: this.lastEvent });
    if (user) this.sendBalance(client, true);
  }

  drop(client) {
    this.clients.delete(client);
    client.socket.destroy();
  }

  // Incoming frames: only control frames matter. Clients must mask; frames are small.
  read(client, data) {
    client.buf = Buffer.concat([client.buf, data]);
    if (client.buf.length > 4096) return this.drop(client);
    while (client.buf.length >= 2) {
      const b = client.buf;
      const op = b[0] & 0x0f;
      const masked = b[1] & 0x80;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) return this.drop(client);
      if (!masked) return this.drop(client);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      client.buf = b.subarray(off + 4 + len);
      client.alive = true;
      if (op === 0x8) return this.drop(client); // close
      if (op === 0x9) this.frame(client, 0xa, payload); // ping -> pong
    }
  }

  frame(client, op, payload) {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), bigLen(len)]);
    if (client.socket.writableLength > 4 * 1024 * 1024) return this.drop(client); // a client that does not read
    client.socket.write(Buffer.concat([head, payload]));
  }

  send(client, msg) {
    this.frame(client, 0x1, Buffer.from(JSON.stringify(msg)));
  }

  broadcast(msg) {
    if (!this.clients.size) return;
    const payload = Buffer.from(JSON.stringify(msg));
    for (const c of this.clients) this.frame(c, 0x1, payload);
  }

  ping() {
    for (const c of this.clients) {
      if (!c.alive) {
        this.drop(c);
        continue;
      }
      c.alive = false;
      this.frame(c, 0x9, Buffer.alloc(0));
    }
  }

  sendBalance(client, force = false) {
    const balance = this.credits.balance(client.user.id);
    if (!force && balance === client.balance) return;
    client.balance = balance;
    this.send(client, { type: 'credits', balance });
  }

  async tick() {
    if (!this.clients.size) {
      this.lastEvent = this.store.get('SELECT COALESCE(MAX(id), 0) AS n FROM events').n;
      return;
    }
    const items = this.feed(this.lastEvent);
    const newest = this.store.get('SELECT COALESCE(MAX(id), 0) AS n FROM events').n;
    const moved = newest > this.lastEvent;
    this.lastEvent = newest;
    if (items.length) this.broadcast({ type: 'feed', items: items.slice().reverse() });
    if (moved) {
      const p = this.progress();
      const ps = JSON.stringify(p);
      if (ps !== this.lastProgress) {
        this.lastProgress = ps;
        this.broadcast({ type: 'progress', data: p });
      }
      const m = this.map();
      if (this.lastMap && this.lastMap.length === m.states.length) {
        const changes = [];
        for (let i = 0; i < m.states.length; i++) if (m.states[i] !== this.lastMap[i]) changes.push([i, m.states[i]]);
        if (changes.length && changes.length < 5000) this.broadcast({ type: 'map', changes });
        else if (changes.length) this.broadcast({ type: 'map-reload' });
      }
      this.lastMap = m.states;
    }
    // Builds advance without events (one unit at a time), so the pipeline is compared every tick.
    if (this.pipeline) {
      const pl = JSON.stringify(this.pipeline());
      if (pl !== this.lastPipeline) {
        this.lastPipeline = pl;
        this.broadcast({ type: 'pipeline', data: JSON.parse(pl) });
      }
    }
    // Balances move with merges, reviews and games; each viewer only sees their own.
    for (const c of this.clients) if (c.user) this.sendBalance(c);
  }
}

function bigLen(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}
