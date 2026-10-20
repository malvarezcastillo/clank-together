import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractTarGz } from '../src/shared/tar.js';

function header(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h[156] = type.charCodeAt(0);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

test('extracts files, GNU long names and pax paths; refuses paths outside the target', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-'));
  const long = 'toolchain/vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/1033/clui.dll';
  const pax = Buffer.from(`${`path=toolchain/pax/name.h`.length + 4} path=toolchain/pax/name.h\n`);
  const parts = [
    header('toolchain/', 0, '5'),
    header('toolchain/a.txt', 5), pad(Buffer.from('hello')),
    header('././@LongLink', long.length + 1, 'L'), pad(Buffer.from(long + '\0')), header(long.slice(0, 99), 3), pad(Buffer.from('dll')),
    header('PaxHeader', pax.length, 'x'), pad(pax), header('short', 2), pad(Buffer.from('ok')),
    Buffer.alloc(1024),
  ];
  const file = path.join(dir, 'a.tar.gz');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts)));
  assert.equal(await extractTarGz(file, path.join(dir, 'out')), 3);
  assert.equal(fs.readFileSync(path.join(dir, 'out/toolchain/a.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(dir, 'out', long), 'utf8'), 'dll');
  assert.equal(fs.readFileSync(path.join(dir, 'out/toolchain/pax/name.h'), 'utf8'), 'ok');

  const evil = path.join(dir, 'evil.tar.gz');
  fs.writeFileSync(evil, zlib.gzipSync(Buffer.concat([header('../escape.txt', 1), pad(Buffer.from('x')), Buffer.alloc(1024)])));
  await assert.rejects(extractTarGz(evil, path.join(dir, 'out2')), /outside the target/);
  fs.rmSync(dir, { recursive: true, force: true });
});
