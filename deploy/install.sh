#!/bin/sh
# Installs or updates the Clank Together coordinator on Debian 13. Run as root
# from the unpacked source directory: sh deploy/install.sh <public-hostname>
set -eu

HOST="${1:?usage: install.sh <public-hostname>}"
NODE_VERSION=v22.21.0
GHIDRA_VERSION=11.2.1
GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_11.2.1_build/ghidra_11.2.1_PUBLIC_20241105.zip
GHIDRA_SHA256=ce4db5117da0fbaf8f33863fec4f40902f754f06b68945a59fb1c0f9b1bc461c
SRC=$(cd "$(dirname "$0")/.." && pwd)
APP=/opt/togetherdecomp
DATA=/var/lib/togetherdecomp

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# binutils: objdump disassembles original functions for /api/original before a Ghidra export exists.
apt-get install -y -q git curl ca-certificates nftables caddy docker.io xz-utils binutils >/dev/null

echo "== node $NODE_VERSION"
if [ "$(/opt/node/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " node-$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sed 's/node-.*/node.tar.xz/' | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/node.tar.xz" -C /opt/node --strip-components=1
  rm -rf "$tmp"
fi

echo "== ghidra $GHIDRA_VERSION (server-side project and pseudocode)"
# The JDK, not just the runtime: Ghidra compiles its .java scripts.
apt-get install -y -q openjdk-21-jdk-headless unzip >/dev/null
GHIDRA_HOME="/opt/ghidra/ghidra_${GHIDRA_VERSION}_PUBLIC"
if [ ! -x "$GHIDRA_HOME/support/analyzeHeadless" ]; then
  tmp=$(mktemp -d)
  curl -fsSL "$GHIDRA_URL" -o "$tmp/ghidra.zip"
  echo "$GHIDRA_SHA256  $tmp/ghidra.zip" | sha256sum -c - >/dev/null
  mkdir -p /opt/ghidra
  unzip -q -o "$tmp/ghidra.zip" -d /opt/ghidra
  rm -rf "$tmp"
fi

echo "== docker sandbox settings"
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "userns-remap": "default",
  "no-new-privileges": true,
  "icc": false,
  "live-restore": true,
  "log-driver": "local"
}
EOF
systemctl restart docker

echo "== service user and code"
id togetherdecomp >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin togetherdecomp
usermod -aG docker togetherdecomp
rm -rf "$APP.new" && mkdir -p "$APP.new"
cp -a "$SRC/src" "$SRC/template" "$SRC/ghidra_scripts" "$SRC/toolchain" "$SRC/package.json" "$APP.new/"
chown -R root:root "$APP.new" && chmod -R go-w "$APP.new"
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"; mv "$APP.new" "$APP"

mkdir -p "$DATA" && chown togetherdecomp:togetherdecomp "$DATA" && chmod 700 "$DATA"
NODE="/opt/node/bin/node --disable-warning=ExperimentalWarning"
if [ ! -f "$DATA/server.json" ]; then
  runuser -u togetherdecomp -- $NODE "$APP/src/server/cli.js" init --data "$DATA"
fi
# Production settings, keeping anything else already configured.
UIDGID="$(id -u togetherdecomp):$(id -g togetherdecomp)"
runuser -u togetherdecomp -- env GHIDRA_HOME="$GHIDRA_HOME" $NODE -e '
const fs = require("fs"); const [file, host, user] = process.argv.slice(1);
const c = JSON.parse(fs.readFileSync(file, "utf8"));
c.listen = { host: "127.0.0.1", port: 8080 };
c.publicUrl = "https://" + host;
c.trustProxy = true;
c.allowUnsandboxedRunners = false;
c.ghidraHome = process.env.GHIDRA_HOME || c.ghidraHome || null;
for (const r of Object.values(c.runners || {})) if (r.type === "docker") r.user = user;
fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
' "$DATA/server.json" "$HOST" "$UIDGID"

echo "== systemd"
install -m 0644 "$SRC/deploy/togetherdecomp.service" /etc/systemd/system/togetherdecomp.service
install -m 0644 "$SRC/deploy/nftables-td.nft" /etc/nftables-td.nft
cat > /etc/systemd/system/td-firewall.service <<'EOF'
[Unit]
Description=Clank Together host firewall
After=network-pre.target docker.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/nftables-td.nft
ExecStop=/usr/sbin/nft delete table inet td_filter

[Install]
WantedBy=multi-user.target
EOF
sed "s/saty.dev/$HOST/" "$SRC/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

systemctl daemon-reload
systemctl enable --now td-firewall.service
systemctl restart td-firewall.service
systemctl enable togetherdecomp.service caddy.service
systemctl restart togetherdecomp.service caddy.service
sleep 2
systemctl --no-pager --lines=5 status togetherdecomp.service | head -12
echo "== done: https://$HOST"
