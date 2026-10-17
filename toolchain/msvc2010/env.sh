# Sourced by the generated /job/build.sh inside the sandbox.
# The root filesystem is read-only, so the baked Wine prefix is copied to tmpfs.
cp -a /opt/td/wineprefix /tmp/wineprefix
export WINEPREFIX=/tmp/wineprefix
export WINEDEBUG=-all
export INCLUDE='Z:\opt\msvc\include;Z:\opt\msvc\sdk\Include'
export HOME=/tmp

td_cl() {
  wine /opt/msvc/bin/cl.exe "$@"
}
