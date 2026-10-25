#!/bin/sh
log=$(mktemp)
wine /opt/toolchain/VC/Tools/MSVC/14.29.30133/bin/Hostx64/x86/lib.exe "$@" >"$log" 2>&1
status=$?
cat "$log"
rm -f "$log"
exit "$status"
