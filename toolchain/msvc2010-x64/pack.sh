#!/bin/sh
# Packs the parts of re/toolchain that compile wowdecomp15890 (VS2010 SP1 x64 compiler, its CRT
# headers, Windows SDK 7.1 headers, DirectX SDK headers, compat overlays) into toolchain.tar,
# keeping their layout so the ${TC}\... paths of config/compile.json resolve inside the image.
#
#   sh pack.sh "<path to re/toolchain>" <out dir>
#
# The Microsoft files are not redistributable: the tarball is for your own build server only.
set -eu
TC="${1:?usage: pack.sh <re/toolchain dir> <out dir>}"
OUT="${2:?usage: pack.sh <re/toolchain dir> <out dir>}"
mkdir -p "$OUT"
cd "$TC"
# --force-local: "C:/..." is a path, not a remote host (Git Bash on Windows).
# --owner/--group: Docker with userns-remap cannot map the packing machine's user IDs.
tar --force-local --owner=0 --group=0 --numeric-owner -cf "$OUT/toolchain.tar" \
  "vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/cl.exe" \
  "vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/c1.dll" \
  "vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/c1xx.dll" \
  "vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/c2.dll" \
  "vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/mspdb100.dll" \
  "vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/msobj100.dll" \
  "vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/mspdbcore.dll" \
  "vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/mspdbsrv.exe" \
  "vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/1033/clui.dll" \
  "vs2010sp1/vc_stdamd64/Win/System64/msvcr100.dll" \
  "vs2010sp1/vc_stdx86/Program Files/Microsoft Visual Studio 10.0/VC/include" \
  "vs2010sp1/sdk71/Program Files/Microsoft SDKs/Windows/v7.1/Include" \
  vs2010sp1/compat \
  vs2008/compat \
  dxsdk/DXSDK/Include
sha256sum "vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/cl.exe" | cut -d' ' -f1 > "$OUT/cl.sha256"
echo "wrote $OUT/toolchain.tar (cl.exe sha256 $(cat "$OUT/cl.sha256"))"
