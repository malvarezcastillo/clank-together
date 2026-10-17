# VS2010 SP1 x64 compiler (cl 16.00.40219.01 for x64) under 64-bit Wine, for compiling untrusted
# submissions of wowdecomp15890. Build context: this directory plus toolchain.tar from pack.sh.
#
#   sh pack.sh "<re/toolchain>" .        (on the machine that has the toolchain)
#   docker build -t togetherdecomp/msvc2010-x64:1 .
#
# The image is for the coordinator only: the Microsoft files in it are not redistributable.

FROM debian:13-slim

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends wine wine64 libwine ca-certificates coreutils \
 && rm -rf /var/lib/apt/lists/*

# ${TC} of config/compile.json is Z:\opt\toolchain.
ADD toolchain.tar /opt/toolchain/
RUN cp "/opt/toolchain/vs2010sp1/vc_stdamd64/Win/System64/msvcr100.dll" \
       "/opt/toolchain/vs2010sp1/vc_stdamd64/Program Files(64)/Microsoft Visual Studio 10.0/VC/bin/amd64/" \
 && chmod -R a+rX /opt/toolchain
COPY env.sh /opt/td/env.sh

RUN mkdir -p /opt/td/wineprefix && chmod 777 /opt/td/wineprefix
ENV WINEPREFIX=/opt/td/wineprefix WINEDEBUG=-all WINEARCH=win64 HOME=/tmp
# Create the prefix at build time; each run copies it to tmpfs (the root filesystem is read-only).
# cl.exe writes intermediate files to %TEMP%; point it at the container's tmpfs instead of the
# build user's profile (the registry value wins over the Unix environment).
RUN wineboot --init && wineserver -w \
 && wine reg add 'HKCU\Environment' /v TEMP /t REG_SZ /d 'Z:\tmp' /f \
 && wine reg add 'HKCU\Environment' /v TMP /t REG_SZ /d 'Z:\tmp' /f \
 && wineserver -w && chmod -R a+rwX /opt/td/wineprefix

WORKDIR /job
