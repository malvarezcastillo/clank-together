#!/bin/sh
# Installs Forgejo as the git dashboard at https://<host>/git/ and makes the
# coordinator push every merge to it. Run as root from the unpacked source dir:
#   sh deploy/forgejo/install-forgejo.sh <host> <admin-password-file>
# The password file holds the Forgejo admin password (one line); it is not printed.
set -eu

HOST="${1:?usage: install-forgejo.sh <host> <admin-password-file>}"
PWFILE="${2:?usage: install-forgejo.sh <host> <admin-password-file>}"
VERSION=15.0.10
# Forgejo release signing key ("Forgejo Releases <release@forgejo.org>").
SIGNING_KEY=EB114F5E6C0DC2BCDD183550A4B61A2DC5923710
ORG=${FJ_ORG:-clank}
REPO=${FJ_REPO:-game-decomp}
BOT=clank-bot
# "admin" is a reserved name in Forgejo.
ADMIN_USER=clank-admin
SRC=$(cd "$(dirname "$0")/../.." && pwd)
FJ="runuser -u git -- /usr/local/bin/forgejo --config /etc/forgejo/app.ini --work-path /var/lib/forgejo"
API=http://127.0.0.1:3000/api/v1
TD_DATA=/var/lib/togetherdecomp

echo "== forgejo $VERSION"
apt-get install -y -q gnupg curl git >/dev/null
if ! /usr/local/bin/forgejo --version 2>/dev/null | grep -q "version $VERSION[+ ]"; then
  tmp=$(mktemp -d)
  base="https://codeberg.org/forgejo/forgejo/releases/download/v$VERSION/forgejo-$VERSION-linux-amd64"
  curl -fsSL "$base" -o "$tmp/forgejo"
  curl -fsSL "$base.sha256" -o "$tmp/forgejo.sha256"
  curl -fsSL "$base.asc" -o "$tmp/forgejo.asc"
  (cd "$tmp" && echo "$(cut -d' ' -f1 forgejo.sha256)  forgejo" | sha256sum -c -)
  export GNUPGHOME="$tmp/gnupg"; mkdir -m 700 "$GNUPGHOME"
  curl -fsSL "https://keys.openpgp.org/vks/v1/by-fingerprint/$SIGNING_KEY" | gpg --batch --quiet --import
  # Releases are signed by a subkey; VALIDSIG ends with the primary key's fingerprint.
  gpg --batch --status-fd 1 --verify "$tmp/forgejo.asc" "$tmp/forgejo" 2>/dev/null | grep -Eq "^\[GNUPG:\] VALIDSIG [0-9A-F]{40} .* $SIGNING_KEY\$" \
    || { echo "signature check FAILED"; exit 1; }
  echo "signature ok"
  install -m 0755 "$tmp/forgejo" /usr/local/bin/forgejo
  rm -rf "$tmp"; unset GNUPGHOME
fi

echo "== user, dirs, config"
id git >/dev/null 2>&1 || adduser --system --group --home /var/lib/forgejo --shell /bin/bash --disabled-password git >/dev/null
mkdir -p /var/lib/forgejo/data /var/lib/forgejo/repositories /var/lib/forgejo/custom /etc/forgejo
chown -R git:git /var/lib/forgejo && chmod 750 /var/lib/forgejo
if [ ! -f /etc/forgejo/app.ini ]; then
  sk=$(/usr/local/bin/forgejo generate secret SECRET_KEY)
  it=$(/usr/local/bin/forgejo generate secret INTERNAL_TOKEN)
  js=$(/usr/local/bin/forgejo generate secret JWT_SECRET)
  sed -e "s|@HOST@|$HOST|g" -e "s|@SECRET_KEY@|$sk|" -e "s|@INTERNAL_TOKEN@|$it|" -e "s|@JWT_SECRET@|$js|" \
    "$SRC/deploy/forgejo/app.ini.template" > /etc/forgejo/app.ini
fi
chown root:git /etc/forgejo /etc/forgejo/app.ini && chmod 750 /etc/forgejo && chmod 640 /etc/forgejo/app.ini

install -m 0644 "$SRC/deploy/forgejo/forgejo.service" /etc/systemd/system/forgejo.service
systemctl daemon-reload
systemctl enable --now forgejo.service
for i in $(seq 1 30); do curl -fs "$API/version" >/dev/null && break; sleep 1; done
curl -fs "$API/version" >/dev/null || { journalctl -u forgejo -n 30 --no-pager; exit 1; }

echo "== accounts"
ADMIN_PW=$(cat "$PWFILE")
if ! $FJ admin user list --admin | awk '{print $2}' | grep -qx "$ADMIN_USER"; then
  $FJ admin user create --admin --username "$ADMIN_USER" --email "admin@$HOST" --password "$ADMIN_PW" --must-change-password=false >/dev/null
fi
if ! $FJ admin user list | awk '{print $2}' | grep -qx "$BOT"; then
  $FJ admin user create --username "$BOT" --email "bot@$HOST" --random-password --must-change-password=false >/dev/null
fi
AUTH="$ADMIN_USER:$ADMIN_PW"
api() { curl -fsS -u "$AUTH" -H 'content-type: application/json' "$@"; }

echo "== organisation and repository"
api "$API/orgs/$ORG" >/dev/null 2>&1 || api -X POST "$API/orgs" -d "{\"username\":\"$ORG\",\"full_name\":\"Clank Together\",\"visibility\":\"public\",\"description\":\"Matching decompilations, built by people and their agents\"}" >/dev/null
if ! api "$API/repos/$ORG/$REPO" >/dev/null 2>&1; then
  api -X POST "$API/orgs/$ORG/repos" -d "{\"name\":\"$REPO\",\"description\":\"Matching decompilation (written through the Clank Together coordinator)\",\"private\":false,\"default_branch\":\"main\"}" >/dev/null
fi
api -X PATCH "$API/repos/$ORG/$REPO" -d '{"has_pull_requests":false,"has_actions":false,"has_packages":false,"has_releases":false,"has_projects":false,"website":"https://'"$HOST"'/"}' >/dev/null
api -X PUT "$API/repos/$ORG/$REPO/collaborators/$BOT" -d '{"permission":"write"}' >/dev/null

echo "== push main and protect it"
# The bot token lives only in the coordinator repo's .git/config (data dir is 0700).
TDGIT="runuser -u togetherdecomp -- git -C $TD_DATA/repo"
if ! $TDGIT remote get-url forgejo >/dev/null 2>&1; then
  TOKEN=$($FJ admin user generate-access-token --username "$BOT" --token-name "coordinator-$(date +%s)" --scopes write:repository --raw)
  $TDGIT remote add forgejo "http://$BOT:$TOKEN@127.0.0.1:3000/$ORG/$REPO.git"
  unset TOKEN
fi
$TDGIT push -q forgejo HEAD:refs/heads/main
api -X DELETE "$API/repos/$ORG/$REPO/branch_protections/main" >/dev/null 2>&1 || true
api -X POST "$API/repos/$ORG/$REPO/branch_protections" -d "{\"rule_name\":\"main\",\"enable_push\":true,\"enable_push_whitelist\":true,\"push_whitelist_usernames\":[\"$BOT\"],\"block_on_rejected_reviews\":false}" >/dev/null

echo "== coordinator settings"
runuser -u togetherdecomp -- /opt/node/bin/node -e '
const fs = require("fs"); const [file, host, org, repo] = process.argv.slice(1);
const c = JSON.parse(fs.readFileSync(file, "utf8"));
c.pushRemote = "forgejo";
c.gitCloneUrl = `https://${host}/git/${org}/${repo}.git`;
c.gitWebUrl = `https://${host}/git/${org}/${repo}`;
fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
' "$TD_DATA/server.json" "$HOST" "$ORG" "$REPO"
systemctl restart togetherdecomp
echo "== done: https://$HOST/git/$ORG/$REPO"
