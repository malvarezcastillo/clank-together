export WINEPREFIX=/tmp/wineprefix
export WINEDEBUG=-all
export WINEARCH=win64
export HOME=/tmp
export TMP='Z:\tmp' TEMP='Z:\tmp'
if [ ! -d "$WINEPREFIX" ]; then
  cp -rs /opt/td/wineprefix "$WINEPREFIX"
  wineserver -p >/dev/null 2>&1 || true
fi
TD_CL='/opt/toolchain/VC/Tools/MSVC/14.29.30133/bin/Hostx64/x86/cl.exe'
td_cl() {
  wine "$TD_CL" "$@"
}
