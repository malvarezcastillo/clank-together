// Minimal tar reader for the compiler package: regular files and directories, with GNU long names
// and pax path headers. Entries that would land outside the target directory are refused.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Extracts a .tar.gz into `dest`; returns the number of files written. */
export async function extractTarGz(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest);
  const gunzip = fs.createReadStream(file).pipe(zlib.createGunzip());
  let buf = Buffer.alloc(0);
  let entry = null; // { name, size, left, fd, type, data }
  let longName = null;
  let paxPath = null;
  let files = 0;

  const target = (name) => {
    const clean = name.replace(/\\/g, '/').replace(/^\.\/+/, '');
    const out = path.resolve(root, clean);
    if (out !== root && !out.startsWith(root + path.sep)) throw new Error(`refusing tar entry outside the target: ${name}`);
    return out;
  };

  const headerField = (h, off, len) => h.subarray(off, off + len).toString('utf8').replace(/\0.*$/s, '');
  const octal = (h, off, len) => {
    // Sizes over 8 GB use base-256 (first byte 0x80); the package never gets there.
    if (h[off] & 0x80) throw new Error('tar entry too large');
    return Number.parseInt(headerField(h, off, len).trim() || '0', 8);
  };

  const startEntry = (h) => {
    const type = String.fromCharCode(h[156] || 48);
    const size = octal(h, 124, 12);
    const prefix = headerField(h, 345, 155);
    let name = headerField(h, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    if (longName) (name = longName), (longName = null);
    if (paxPath) (name = paxPath), (paxPath = null);
    const mode = octal(h, 100, 8);
    entry = { name, size, left: size, type, mode, data: type === 'L' || type === 'x' || type === 'g' ? [] : null, fd: null };
    if (type === '5') fs.mkdirSync(target(name), { recursive: true });
    else if (type === '0' || type === '7') {
      const out = target(name);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      entry.fd = fs.openSync(out, 'w', mode & 0o111 ? 0o755 : 0o644);
      files++;
    }
    // Links and devices are not part of the package: skipped.
  };

  const endEntry = () => {
    if (entry.fd !== null) fs.closeSync(entry.fd);
    if (entry.type === 'L') longName = Buffer.concat(entry.data).toString('utf8').replace(/\0.*$/s, '');
    if (entry.type === 'x') {
      const text = Buffer.concat(entry.data).toString('utf8');
      for (const m of text.matchAll(/^\d+ ([^=]+)=(.*)$/gm)) if (m[1] === 'path') paxPath = m[2];
    }
    entry = null;
  };

  for await (const chunk of gunzip) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let pos = 0;
    for (;;) {
      if (!entry) {
        if (buf.length - pos < 512) break;
        const h = buf.subarray(pos, pos + 512);
        pos += 512;
        if (h.every((b) => b === 0)) continue; // end-of-archive blocks
        startEntry(h);
        if (entry.size === 0) endEntry();
        continue;
      }
      const padded = Math.ceil(entry.size / 512) * 512;
      const take = Math.min(entry.left, buf.length - pos);
      if (take > 0) {
        const part = buf.subarray(pos, pos + take);
        if (entry.fd !== null) fs.writeSync(entry.fd, part);
        else if (entry.data) entry.data.push(Buffer.from(part));
        entry.left -= take;
        pos += take;
      }
      if (entry.left > 0) break;
      const pad = padded - entry.size;
      if (buf.length - pos < pad) break; // the padding comes with the next chunk
      pos += pad;
      endEntry();
    }
    buf = buf.subarray(pos);
  }
  if (entry) throw new Error('truncated tar archive');
  return files;
}
