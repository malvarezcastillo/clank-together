#!/bin/sh
# Updates the coordinator's code without taking the site down. Run as root on the server:
#   sh deploy/update.sh <unpacked-source-dir>
#
# The new release is copied and syntax-checked next to the running one; nothing changes for the
# running site until then. /opt/togetherdecomp is a symlink that switches to the new release in
# one step. Pages (src/server/web) are read through it, so page changes are live right away with
# no restart. Server code changes restart the web process (about a second) once everything is in
# place, and the worker once it has no compile running. install.sh is for first installs and
# system changes (packages, docker, caddy, firewall).
set -eu

SRC=$(cd "${1:?usage: update.sh <source-dir>}" && pwd)
BASE=/opt/togetherdecomp-releases
LINK=/opt/togetherdecomp
JOBS=/var/lib/togetherdecomp/jobs
NODE=/opt/node/bin/node
REL="$BASE/$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BASE"
# Earlier installs kept the code in a plain directory.
if [ -d "$LINK" ] && [ ! -L "$LINK" ]; then
  mv "$LINK" "$BASE/initial"
  ln -s "$BASE/initial" "$LINK"
fi
OLD=$(readlink -f "$LINK" 2>/dev/null || true)

echo "== preparing $REL"
mkdir -p "$REL"
cp -a "$SRC/src" "$SRC/template" "$SRC/ghidra_scripts" "$SRC/toolchain" "$SRC/deploy" "$SRC/package.json" "$REL/"
chown -R root:root "$REL"
chmod -R go-w,a+rX "$REL"
for f in $(find "$REL/src" -name '*.js'); do
  if ! "$NODE" --check "$f" 2>/dev/null; then
    "$NODE" --check "$f" || true
    rm -rf "$REL"
    echo "syntax error in ${f#$REL/}; the running release is unchanged" >&2
    exit 1
  fi
done

differs() { [ -z "$OLD" ] || ! diff -rq "$OLD/$1" "$REL/$1" >/dev/null 2>&1; }
code=0
for d in src/shared src/server; do
  if [ -n "$OLD" ] && diff -rq -x web "$OLD/$d" "$REL/$d" >/dev/null 2>&1; then :; else code=1; fi
done
units=0
for u in togetherdecomp.service togetherdecomp-worker.service; do
  cmp -s "$REL/deploy/$u" "/etc/systemd/system/$u" || units=1
done

echo "== switching to the new release"
ln -sfn "$REL" "$LINK.next"
mv -T "$LINK.next" "$LINK"

if [ "$units" = 1 ]; then
  install -m 0644 "$REL/deploy/togetherdecomp.service" "$REL/deploy/togetherdecomp-worker.service" /etc/systemd/system/
  systemctl daemon-reload
  code=1
fi

if [ "$code" = 0 ]; then
  differs src/server/web && echo "pages updated (live, no restart)" || echo "no server code changed"
else
  echo "== restarting the website"
  systemctl restart togetherdecomp.service
  sleep 2
  systemctl is-active --quiet togetherdecomp.service || { journalctl -u togetherdecomp -n 20 --no-pager; exit 1; }
  # A restart re-queues the worker's running verification or merge; wait (up to 15 min) for it to finish.
  echo "== restarting the worker when it is idle"
  waited=0
  while [ -n "$(ls -A "$JOBS" 2>/dev/null)" ] && [ "$waited" -lt 900 ]; do
    sleep 5
    waited=$((waited + 5))
  done
  systemctl restart togetherdecomp-worker.service
  sleep 2
  systemctl is-active --quiet togetherdecomp-worker.service || { journalctl -u togetherdecomp-worker -n 20 --no-pager; exit 1; }
fi

# Keep the last three releases for a quick rollback (ln -sfn <release> /opt/togetherdecomp).
ls -1dt "$BASE"/*/ | tail -n +4 | while read -r old; do
  [ "$(readlink -f "$old")" = "$(readlink -f "$LINK")" ] || rm -rf "$old"
done
echo "== done: $(readlink -f "$LINK")"
