"""Bidirectional fast-forward-only sync between GitHub and Forgejo, driven by webhooks.

Any signed push event triggers a full reconcile of branches and tags:
- a ref missing on one side is created there;
- a branch behind on one side is fast-forwarded;
- a diverged branch or a tag pointing at different commits is logged and left alone.
Nothing is ever force-pushed or deleted.
"""
import hashlib
import hmac
import os
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRETS = "/secrets"
WORK = "/work/repo.git"
GITHUB_URL = os.environ["SYNC_GITHUB_URL"]
FORGEJO_URL = os.environ["SYNC_FORGEJO_URL"]
REMOTES = ("github", "forgejo")


def secret(name):
    with open(os.path.join(SECRETS, name), encoding="utf-8") as f:
        return f.read().strip()


WEBHOOK_SECRET = secret("webhook_secret.txt").encode()
FORGEJO_TOKEN = secret("forgejo_token.txt")


def log(msg):
    print(msg, flush=True)


def git(*args, check=True):
    r = subprocess.run(["git", "-C", WORK, *args], capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r


def setup():
    # Bind-mounted Windows files are world-readable; ssh refuses such keys.
    key = "/root/.ssh/id_ed25519"
    os.makedirs("/root/.ssh", exist_ok=True)
    shutil.copyfile(os.path.join(SECRETS, "rodecomp_sync"), key)
    os.chmod(key, 0o600)

    # Forgejo accepts an access token as the HTTP username.
    forgejo_url = FORGEJO_URL.replace("://", f"://{FORGEJO_TOKEN}@", 1)

    if not os.path.isdir(WORK):
        subprocess.run(["git", "init", "--bare", "-q", WORK], check=True)
    for name, url in (("github", GITHUB_URL), ("forgejo", forgejo_url)):
        if git("remote", "get-url", name, check=False).returncode:
            git("remote", "add", name, url)
        else:
            git("remote", "set-url", name, url)
        # Each remote's branches and tags live in their own namespace so they can be compared.
        git("config", "--replace-all", f"remote.{name}.fetch", f"+refs/heads/*:refs/sync/{name}/heads/*")
        git("config", "--add", f"remote.{name}.fetch", f"+refs/tags/*:refs/sync/{name}/tags/*")
        git("config", f"remote.{name}.tagOpt", "--no-tags")


def refs(remote, kind):
    prefix = f"refs/sync/{remote}/{kind}/"
    out = git("for-each-ref", "--format=%(refname) %(objectname)", prefix).stdout
    return {line.split()[0][len(prefix):]: line.split()[1] for line in out.splitlines()}


def is_ancestor(a, b):
    return git("merge-base", "--is-ancestor", a, b, check=False).returncode == 0


def push(remote, sha, ref):
    git("push", "--porcelain", remote, f"{sha}:{ref}")
    log(f"pushed {ref} {sha[:10]} -> {remote}")


def reconcile():
    for remote in REMOTES:
        git("fetch", "--prune", "-q", remote)

    gh, fj = refs("github", "heads"), refs("forgejo", "heads")
    for branch in sorted(gh.keys() | fj.keys()):
        a, b, ref = gh.get(branch), fj.get(branch), f"refs/heads/{branch}"
        if a == b:
            continue
        if b is None:
            push("forgejo", a, ref)
        elif a is None:
            push("github", b, ref)
        elif is_ancestor(b, a):
            push("forgejo", a, ref)
        elif is_ancestor(a, b):
            push("github", b, ref)
        else:
            log(f"DIVERGED {branch}: github={a[:10]} forgejo={b[:10]}, skipped")

    gh, fj = refs("github", "tags"), refs("forgejo", "tags")
    for tag in sorted(gh.keys() | fj.keys()):
        a, b, ref = gh.get(tag), fj.get(tag), f"refs/tags/{tag}"
        if a == b:
            continue
        if b is None:
            push("forgejo", a, ref)
        elif a is None:
            push("github", b, ref)
        else:
            log(f"TAG CONFLICT {tag}: github={a[:10]} forgejo={b[:10]}, skipped")


# Events arriving during a run coalesce into one follow-up run.
_lock = threading.Lock()
_pending = threading.Event()


def worker():
    while True:
        _pending.wait()
        with _lock:
            _pending.clear()
            try:
                reconcile()
            except Exception as e:  # keep serving; next event retries
                log(f"sync failed: {e}")


def valid_signature(headers, body):
    expected = hmac.new(WEBHOOK_SECRET, body, hashlib.sha256).hexdigest()
    github = headers.get("X-Hub-Signature-256", "").removeprefix("sha256=")
    forgejo = headers.get("X-Forgejo-Signature") or headers.get("X-Gitea-Signature") or ""
    return any(sig and hmac.compare_digest(sig, expected) for sig in (github, forgejo))


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if not valid_signature(self.headers, body):
            self.send_response(401)
            self.end_headers()
            return
        event = self.headers.get("X-GitHub-Event") or self.headers.get("X-Forgejo-Event") or "?"
        source = "github" if "X-GitHub-Event" in self.headers else "forgejo"
        log(f"event {event} from {source}")
        if event in ("push", "create"):
            _pending.set()
        self.send_response(202)
        self.end_headers()

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    setup()
    threading.Thread(target=worker, daemon=True).start()
    _pending.set()  # reconcile once at startup to catch pushes missed while down
    log("listening on :9000")
    ThreadingHTTPServer(("0.0.0.0", 9000), Handler).serve_forever()
