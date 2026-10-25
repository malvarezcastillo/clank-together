FROM debian:13-slim AS download
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates msitools && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY download.py /build/download.py
RUN python3 download.py

FROM debian:13-slim
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends wine wine64 wine32:i386 ca-certificates coreutils && rm -rf /var/lib/apt/lists/*
COPY --from=download /build/toolchain /opt/toolchain
COPY env.sh /opt/td/env.sh
ENV WINEPREFIX=/opt/td/wineprefix WINEDEBUG=-all WINEARCH=win64 HOME=/tmp
RUN mkdir -p /opt/td/wineprefix && wineboot --init && wineserver -w && wine reg add 'HKCU\Environment' /v TEMP /t REG_SZ /d 'Z:\tmp' /f && wine reg add 'HKCU\Environment' /v TMP /t REG_SZ /d 'Z:\tmp' /f && wineserver -w && chmod -R a+rX /opt/toolchain && chmod -R a+rwX /opt/td/wineprefix
WORKDIR /job
