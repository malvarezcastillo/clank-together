#!/bin/sh
# Deploys the committed HEAD to the coordinator without taking the site down (deploy/update.sh).
#   tools/deploy.sh [--td]
# --td also publishes the td binaries from dist/ (node tools/build-td/build.mjs) for download and
# self-update. TD_HOST names the ssh host (default: td-server).
set -eu

HOST="${TD_HOST:-td-server}"
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain -- src deploy template ghidra_scripts toolchain)" ] || echo "note: uncommitted changes are not deployed; this deploys HEAD ($(git rev-parse --short HEAD))"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git archive --format=tar.gz -o "$tmp/release.tar.gz" HEAD
scp -q "$tmp/release.tar.gz" "$HOST:/tmp/clank-release.tar.gz"

if [ "${1:-}" = "--td" ]; then
  scp -q dist/td-windows-x64.exe dist/td-linux-x64 dist/SHA256SUMS "$HOST:/tmp/"
fi

ssh "$HOST" "set -e
  d=\$(mktemp -d)
  tar -xzf /tmp/clank-release.tar.gz -C \"\$d\"
  rm -f /tmp/clank-release.tar.gz
  if [ '${1:-}' = '--td' ]; then
    D=/var/lib/togetherdecomp/downloads
    for f in td-windows-x64.exe td-linux-x64 SHA256SUMS; do
      install -o togetherdecomp -g togetherdecomp -m 0644 /tmp/\$f \$D/\$f.new && mv \$D/\$f.new \$D/\$f && rm -f /tmp/\$f
    done
    chmod 0755 \$D/td-linux-x64
    echo 'td binaries published'
  fi
  sh \"\$d/deploy/update.sh\" \"\$d\"
  rm -rf \"\$d\""
