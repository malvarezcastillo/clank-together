#!/bin/sh
set -eu
. /opt/td/env.sh
TC=/opt/toolchain/VC/Tools/MSVC/14.29.30133
SDK='/opt/toolchain/Program Files/Windows Kits/10/Include/10.0.19041.0'
export INCLUDE="Z:\\opt\\toolchain\\VC\\Tools\\MSVC\\14.29.30133\\include;Z:\\opt\\toolchain\\VC\\Tools\\MSVC\\14.29.30133\\atlmfc\\include;$(printf '%s' "$SDK" | sed 's|/|\\|g' | sed 's/^/Z:/')\\ucrt;$(printf '%s' "$SDK" | sed 's|/|\\|g' | sed 's/^/Z:/')\\shared;$(printf '%s' "$SDK" | sed 's|/|\\|g' | sed 's/^/Z:/')\\um"
cmake -S /data/repo -B /tmp/rodecomp-cmake -G Ninja -DCMAKE_TOOLCHAIN_FILE=/opt/td/cmake-toolchain.cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
python3 /tools/export-compile.py /tmp/rodecomp-cmake/compile_commands.json /data/repo/compile.json --source /data/repo --compiler "$TC/bin/Hostx64/x86/cl.exe" --include "$INCLUDE"
