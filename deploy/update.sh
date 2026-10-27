#!/bin/sh
# Updates the coordinator's code without taking the site down. Run as root on the server:
#   sh deploy/update.sh <unpacked-source-dir>
# TD_KEEP_WORKER=1 leaves the worker alone (during maintenance with the worker stopped).
# TD_INSTANCE=togetherdecomp-test updates a second, separate instance (its own code under
# /opt/<instance>, data under /var/lib/<instance>, units <instance>.service and <instance>-worker).
#
# The new release is copied and syntax-checked next to the running one; nothing changes for the
# running site until then. /opt/togetherdecomp is a symlink that switches to the new release in
# one step. Pages (src/server/web) are read through it, so page changes are live right away with
# no restart. Server code changes restart the web process (about a second) once everything is in
# place, and the worker once it has no compile running. install.sh is for first installs and
# system changes (packages, docker, caddy, firewall).
set -eu

SRC=$(cd "${1:?usage: update.sh <source-dir>}" && pwd)
I="${TD_INSTANCE:-togetherdecomp}"
case "$I" in togetherdecomp|togetherdecomp-test) ;; *) echo "unknown instance $I" >&2; exit 1 ;; esac
BASE=/opt/$I-releases
LINK=/opt/$I
DATA=/var/lib/$I
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
cp -a "$SRC/src" "$SRC/template" "$SRC/ghidra_scripts" "$SRC/toolchain" "$SRC/deploy" "$SRC/package.json" "$SRC/package-lock.json" "$REL/"
(cd "$REL" && PATH="$(dirname "$NODE"):$PATH" "$(dirname "$NODE")/npm" ci --omit=dev --ignore-scripts)
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
# Units of another instance: the same files with its paths and names.
unit() { sed -e "s#/opt/togetherdecomp/#/opt/$I/#g" -e "s#/var/lib/togetherdecomp#$DATA#g" -e "s#^Description=Clank Together#Description=Clank Together ($I)#" "$REL/deploy/$1"; }
units=0
for u in web worker; do
  src=togetherdecomp.service; [ "$u" = worker ] && src=togetherdecomp-worker.service
  dst=$I.service; [ "$u" = worker ] && dst=$I-worker.service
  unit "$src" > "$REL/deploy/.$dst"
  cmp -s "$REL/deploy/.$dst" "/etc/systemd/system/$dst" || units=1
done

echo "== switching to the new release"
ln -sfn "$REL" "$LINK.next"
mv -T "$LINK.next" "$LINK"

if [ "$units" = 1 ]; then
  install -m 0644 "$REL/deploy/.$I.service" /etc/systemd/system/$I.service
  install -m 0644 "$REL/deploy/.$I-worker.service" /etc/systemd/system/$I-worker.service
  systemctl daemon-reload
  code=1
fi

if [ "$code" = 0 ]; then
  differs src/server/web && echo "pages updated (live, no restart)" || echo "no server code changed"
else
  echo "== restarting the website"
  systemctl restart $I.service
  sleep 2
  systemctl is-active --quiet $I.service || { journalctl -u $I -n 20 --no-pager; exit 1; }
  # The worker finishes its running verification, merge or check before it stops (no work is
  # redone), then starts on the new release. That can take minutes, so don't wait for it here.
  if [ -n "${TD_KEEP_WORKER:-}" ]; then
    # Maintenance (e.g. a rebuild with the worker stopped): leave it; it runs the new code when started.
    echo "== worker left as it is (TD_KEEP_WORKER)"
  else
    echo "== the worker restarts once its running work is done"
    systemctl restart --no-block $I-worker.service
  fi
fi

# Keep the last three releases for a quick rollback (ln -sfn <release> /opt/togetherdecomp), and
# every release a running process was started from (it loads files from it later, e.g. workers).
inuse=$(cat $DATA/release-*.txt 2>/dev/null)
ls -1dt "$BASE"/*/ | tail -n +4 | while read -r old; do
  old=$(readlink -f "$old")
  [ "$old" = "$(readlink -f "$LINK")" ] && continue
  echo "$inuse" | grep -qxF "$old" && continue
  rm -rf "$old"
done
echo "== done: $(readlink -f "$LINK")"
