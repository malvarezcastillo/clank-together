#!/usr/bin/python3
"""Invoke MSVC under Wine, translating POSIX inputs and isolating service pipes."""
import os
import subprocess
import sys
import tempfile
args = []
for arg in sys.argv[1:]:
    if arg.startswith('/') and os.path.isfile(arg):
        arg = 'Z:' + arg.replace('/', '\\')
    args.append(arg)
with tempfile.TemporaryFile() as output:
    result = subprocess.run(['wine', '/opt/toolchain/VC/Tools/MSVC/14.29.30133/bin/Hostx64/x86/cl.exe', *args], stdout=output, stderr=subprocess.STDOUT)
    output.seek(0)
    sys.stdout.buffer.write(output.read())
sys.exit(result.returncode)
