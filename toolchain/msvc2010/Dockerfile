# MSVC 2010 (cl.exe 16.00) under Wine, used to compile untrusted submissions.
#
# The Microsoft compiler is NOT redistributable, so it is not in this repo.
# Before building, copy these from a licensed Visual Studio 2010 install
# into ./msvc (next to this Dockerfile):
#
#   msvc/bin/      cl.exe c1.dll c1xx.dll c2.dll mspdb100.dll msobj100.dll
#                  mspdbcore.dll mspdbsrv.exe msvcr100.dll msvcp100.dll 1033/clui.dll
#   msvc/include/  VC\include
#   msvc/sdk/      Windows SDK 7.0A Include (only if the code includes windows.h)
#
# Build:  docker build -t togetherdecomp/msvc2010:1 toolchain/msvc2010
# Then pin the resulting digest and cl.exe hash in the repo's toolchain.lock.json.

FROM debian:12-slim

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends wine wine32:i386 ca-certificates coreutils \
 && rm -rf /var/lib/apt/lists/*

COPY msvc/ /opt/msvc/
COPY env.sh /opt/td/env.sh

RUN useradd -u 1000 -m builder \
 && mkdir -p /opt/td/wineprefix \
 && chown builder /opt/td/wineprefix

USER builder
ENV WINEPREFIX=/opt/td/wineprefix WINEDEBUG=-all WINEARCH=win32
# Create the prefix at build time; each run copies it to tmpfs because the
# container root filesystem is read-only.
RUN wineboot --init && wineserver -w

WORKDIR /job
