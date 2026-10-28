import fs from 'node:fs';
import path from 'node:path';

// The Ghidra release the server builds its project with. A project saved by a newer Ghidra cannot
// be opened by an older one, so clients that download it need the same release.
export const GHIDRA_RELEASE = {
  version: '12.2',
  url: 'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.2_build/ghidra_12.2_PUBLIC_20261016.zip',
  sha256: '2c2cd776db3c1f6a097ba418922378ac3649cadd5e844a6f5f088ae628a7be67',
  dir: 'ghidra_12.2_PUBLIC',
  jdk: '25',
};

/** The application.version of the Ghidra installed at `home`, or null. */
export function ghidraVersionAt(home) {
  if (!home) return null;
  try {
    const props = fs.readFileSync(path.join(home, 'Ghidra', 'application.properties'), 'utf8');
    return props.match(/^application\.version=(.+)$/m)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

/** True when Ghidra version `a` is at least `b` (dotted numeric versions). */
export function ghidraAtLeast(a, b) {
  const key = (v) => String(v ?? '0').split('.').map((x) => Number.parseInt(x, 10) || 0).concat([0, 0, 0]).slice(0, 3).reduce((n, x) => n * 1000 + x, 0);
  return key(a) >= key(b);
}
