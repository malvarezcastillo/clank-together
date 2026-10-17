# Sourced by the generated job scripts inside the sandbox. The root filesystem is read-only, so
# each container gets its own Wine prefix in tmpfs: a symlink farm of the baked one (cp -rs, ~60 KB
# instead of ~770 MB). Its directories belong to the sandbox user, which Wine requires; Wine
# replaces a link with a real file only where it writes (registry). build.sh sources this first,
# before the units run in parallel.
export WINEPREFIX=/tmp/wineprefix
export WINEDEBUG=-all
export WINEARCH=win64
export HOME=/tmp
# cl.exe writes its intermediate files to %TMP%; the prefix's profile belongs to the image's build user.
export TMP='Z:\tmp' TEMP='Z:\tmp'
if [ ! -d "$WINEPREFIX" ]; then
  cp -rs /opt/td/wineprefix "$WINEPREFIX"
  # One persistent wineserver for all parallel compiles of this container.
  wineserver -p >/dev/null 2>&1 || true
fi

TD_CL="/opt/toolchain/vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/cl.exe"
td_cl() {
  wine "$TD_CL" "$@"
}
