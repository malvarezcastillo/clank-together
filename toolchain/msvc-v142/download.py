"""Acquire pinned v142 x64-host/x86-target packages from Microsoft's VS manifest."""
import hashlib
import io
import json
import pathlib
import re
import shutil
import subprocess
import urllib.request
import zipfile

MANIFEST = 'https://download.visualstudio.microsoft.com/download/pr/e2324e87-3765-4b14-85e5-1234d99f6254/fb642c3f891b70947e0152275e1722ffb3cca7e8700eea0f0fa0f3a7645584cc/VisualStudio.vsman'
root = pathlib.Path('toolchain')
root.mkdir(exist_ok=True)
packages = json.load(urllib.request.urlopen(MANIFEST))['packages']

def package(name):
    return next(p for p in packages if p['id'].lower() == name.lower() and p.get('language') in (None, 'en-US'))

def download(payload):
    data = urllib.request.urlopen(payload['url'].replace(' ', '%20')).read()
    if hashlib.sha256(data).hexdigest().lower() != payload['sha256'].lower():
        raise RuntimeError('Checksum mismatch: ' + payload['fileName'])
    print(payload['fileName'], len(data), flush=True)
    return data

suffixes = ['Tools.HostX64.TargetX86.base', 'Tools.HostX64.TargetX86.Res.base',
            'CRT.Headers.base', 'CRT.x86.Desktop.base', 'ATL.Headers.base', 'ATL.X86.base']
for suffix in suffixes:
    for payload in package('Microsoft.VC.14.29.16.11.' + suffix)['payloads']:
        with zipfile.ZipFile(io.BytesIO(download(payload))) as archive:
            for entry in archive.infolist():
                name = pathlib.PurePosixPath(entry.filename)
                if not entry.is_dir() and name.parts[0] == 'Contents':
                    if '..' in name.parts:
                        raise RuntimeError('Unsafe package path')
                    out = root.joinpath(*name.parts[1:])
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(archive.read(entry))

sdk = package('Win10SDK_10.0.19041')
payloads = {p['fileName'].replace('\\', '/').split('/')[-1]: p for p in sdk['payloads']}
msis = ['Windows SDK for Windows Store Apps Headers-x86_en-us.msi',
        'Windows SDK Desktop Headers x86-x86_en-us.msi',
        'Windows SDK Desktop Headers x64-x86_en-us.msi',
        'Windows SDK Desktop Libs x86-x86_en-us.msi',
        'Universal CRT Headers Libraries and Sources-x86_en-us.msi']
cache = pathlib.Path('sdk-downloads')
cache.mkdir(exist_ok=True)
for name in msis:
    data = download(payloads[name])
    msi = cache / name
    msi.write_bytes(data)
    for cab in set(re.findall(rb'[A-Za-z0-9]{32}\.cab', data)):
        cabname = cab.decode('ascii')
        dest = cache / cabname
        if not dest.exists():
            dest.write_bytes(download(payloads[cabname]))
    subprocess.run(['msiextract', '-C', str(root.resolve()), str(msi)], check=True, stdout=subprocess.DEVNULL)
(root / 'provenance.json').write_text(json.dumps({'manifest': MANIFEST, 'toolset': 'v142', 'compilerPackage': '14.29.30159', 'target': 'x86', 'sdk': '10.0.19041.0'}, indent=2))
print('Toolchain extraction complete', flush=True)
