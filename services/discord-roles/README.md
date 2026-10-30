# Clank Discord linked roles

A standalone Node 24 service that verifies a Clank account once, connects its owner to Discord with OAuth2, and publishes **lifetime contribution credits** as Discord linked-role metadata. It does not modify the existing Clank application, run a bot gateway, change the arcade balance, or assign Discord role memberships itself. There are no npm dependencies.

## What counts

The only source is the read-only Clank SQLite `credit_ledger`: positive earnings for `identical`, `confirmed`, `skip`, `submitted`, and `review`. Bets, payouts, bailouts and other ledger reasons do not count. Spending credits does not reduce this total. The running Clank application remains responsible for booking its own ledger; this service never books awards or writes to that database.

Discord receives metadata key `credits` as a decimal string, type **2 / INTEGER_GREATER_THAN_OR_EQUAL**, with name **Credits** and description **Lifetime contribution credits on rodecomp.online**. The platform name is **rodecomp.online**.

| Hierarchy, highest first | Credits requirement | Color | Display separately |
| --- | ---: | --- | --- |
| Angeling | >= 10,000 | `#F1C40F` | Yes |
| Deviling | >= 5,000 | `#9B59B6` | Yes |
| Metaling | >= 400 | `#74B9FF` | Yes |
| Poring | >= 50 | `#FF7675` | Yes |

These are independent lower-bound requirements, **not exclusive tiers**. A person with 10,000 credits is eligible for all four. Discord users must claim eligible roles through the server’s Linked Roles menu; this service does not automatically pick their highest tier or remove their lower-tier memberships. Role hierarchy determines the displayed name color among their assigned roles, subject to any higher unrelated role.

## Credentials and public HTTPS

1. Create or select a dedicated application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Choose a real public HTTPS origin for this service. `https://roles.rodecomp.online` in the example is a **proposed hostname only**, not a claim that DNS or deployment exists. Provision DNS, a valid certificate and a reverse proxy first.
3. In the application’s **OAuth2** settings, add exactly `PUBLIC_URL/api/discord/callback` as a redirect URI. For example, if the origin is `https://roles.rodecomp.online`, use `https://roles.rodecomp.online/api/discord/callback`.
4. Set the application’s **Linked Roles Verification URL** (`role_connections_verification_url`, currently exposed in its linked-role/general settings) to `PUBLIC_URL/api/discord/link`. Visiting this URL with GET redirects to the login/account page without starting OAuth. The user then explicitly submits **Connect Discord** through its CSRF-protected POST form.
5. Copy `.env.example` to `.env`, enter `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`, set `PUBLIC_URL`, and generate the encryption key:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Put that output in `TOKEN_ENCRYPTION_KEY`. Do not commit it, paste it into tickets or use the example secret values from tests. `.env`, `.env.*` other than `.env.example`, local state databases and their SQLite sidecars are ignored. Restrict the environment file to the service administrator (for example, `chmod 600 .env` on Linux).

OAuth requests use **only `identify role_connections.write`**. The service never asks end users for a Discord bot token. Missing OAuth credentials, invalid origins, mismatched callbacks or invalid encryption keys fail startup explicitly instead of enabling a nonfunctional mode.

Native POST forms require `Referrer-Policy: same-origin` so browsers retain the same-origin `Origin` header. Do not replace it with `no-referrer`: Chromium then sends `Origin: null`, which the service correctly rejects. Cross-origin referrers remain suppressed; strict origin and CSRF checks stay enabled.

### Configuration

| Variable | Meaning |
| --- | --- |
| `PUBLIC_URL` | Required HTTPS origin, no path/query/credentials. May be changed to another provisioned hostname. |
| `DISCORD_CLIENT_ID` | Required Discord application ID. |
| `DISCORD_CLIENT_SECRET` | Required OAuth client secret. |
| `TOKEN_ENCRYPTION_KEY` | Required 32 random bytes, encoded as 64 hex characters or canonical padded base64. AES-256-GCM protects stored OAuth access and refresh tokens. |
| `DISCORD_REDIRECT_URI` | Normally omitted: derived as `PUBLIC_URL/api/discord/callback`. If supplied it must match exactly. |
| `CLANK_API_URL` | Clank HTTPS origin, default `https://rodecomp.online`; verification calls its existing `/api/me`. |
| `SOURCE_DB_PATH` | Required path to the existing Clank SQLite database, opened read-only. Compose sets `/source/td.sqlite`. |
| `STATE_DB_PATH` | Separate service SQLite file, default `./data/roles.sqlite`. Compose sets `/state/roles.sqlite`. Must not equal the source path. |
| `SYNC_INTERVAL_SECONDS` | Default 60, range 10–86400. Schedules synchronization; persisted retry/rate-limit deadlines still apply. |
| `HOST`, `PORT` | Local Node defaults `127.0.0.1:19581`; container listens on `0.0.0.0:19581`, published only to host loopback. |

Sessions last seven days. OAuth states expire after ten minutes and are consumed once, bound both to a live session and a Secure, HttpOnly, SameSite=Lax state cookie. Authentication rotates the session. All mutation routes require the exact configured `Origin` and CSRF token. Cookies always have `Secure`, so use HTTPS even for development behind a local TLS proxy; plain browser HTTP is intentionally unsupported.

Changing the hostname also requires updating the Discord callback and verification URLs and the reverse proxy. Users must sign in again on the new origin. Do not change or lose the encryption key casually: existing OAuth credentials become undecryptable and users need to reconnect. Back up the key separately from the state database.

## Separate Docker deployment

Run these commands **inside `services/discord-roles`**, not the main application’s deployment directory:

```sh
docker compose --env-file .env up -d --build
docker compose ps
docker compose logs --tail 50 roles
curl --fail http://127.0.0.1:19581/healthz
```

This Compose file has its own project name, `clank-discord-roles`, its own `state` volume and `roles` bridge network. It does not join the existing application network or mount the Docker socket. It runs as UID/GID **1000:1000**, with a read-only container root filesystem, dropped capabilities, `no-new-privileges`, bounded resources, a small `/tmp` tmpfs and the one writable state volume. The image copies only explicit runtime files; `.env` and tests are excluded from the build context. Public Clank and Discord API requests leave through its own bridge network.

The only shared resource is external volume **`rodecomp_data`**, mounted **read-only** at `/source`. This volume must already exist; the service will not create or migrate the Clank source database. Its own state volume is automatically initialized with a writable `/state` directory for the non-root user.

**Read-only is an integrity boundary, not a confidentiality boundary.** Mounting the complete `rodecomp_data` volume grants this container visibility into every file readable by UID/GID 1000, potentially including source code, account records and configuration secrets. Treat this service and its image as trusted. Review the volume’s file permissions before deployment and do not make the volume world-readable or recursively change its ownership. If your policy forbids this visibility, arrange an explicitly approved narrower read-only directory containing the live database and its WAL/SHM sidecars, then adjust only this service’s source mount/path.

The service UID needs directory traversal and read permission on `td.sqlite`, `td.sqlite-wal` and `td.sqlite-shm` when those files exist. A live WAL database may require existing readable shared-memory sidecars; mounting only `td.sqlite`, using `immutable=1`, copying a live database without SQLite backup semantics, or making the source writable is **not** a safe workaround. Have the source-volume administrator grant narrowly scoped group/ACL access consistent with the writer’s future sidecar permissions. The source writer must remain responsible for its SQLite WAL lifecycle. Readiness stays unhealthy if source reads fail.

Proxy a dedicated hostname to `127.0.0.1:19581`. A host-side Caddy example is:

```caddyfile
roles.rodecomp.online {
    reverse_proxy 127.0.0.1:19581
}
```

Use your actual configured hostname. A reverse proxy in another container cannot reach the host through its own loopback; explicitly arrange host connectivity without attaching this service to the application’s private network. Do not expose port 19581 on all host interfaces. The service does not trust forwarded headers to choose callback origins; `PUBLIC_URL` is authoritative.

Disable proxy/access logging of OAuth callback query strings, request bodies, cookies and authorization headers. Callback codes and CSRF/OAuth state values are sensitive even though the application never logs them. Docker environment values are visible to privileged Docker administrators; restrict host/Docker access accordingly.

For non-container use, provide Node **24**, create a writable parent directory for `STATE_DB_PATH`, and run:

```sh
node --env-file=.env server.mjs
```

`GET /healthz` returns 200 `{ "ready": true }` only when a source database query works, otherwise 503 without paths or error details. It is readiness for local database access, not an assertion that Discord is reachable. The background synchronizer retries transient Discord failures and respects persisted retry deadlines. Graceful termination closes the listener and SQLite connections.

## One-time Discord setup CLI

A bot user/application installation is needed for the application to appear as a verification method in the target guild; **no bot daemon or gateway connection is run**. Create the bot in the same Discord application and install it in the target guild. If using optional role provisioning, grant **Manage Roles**, not Administrator, and place the bot’s role above all four contribution roles. No privileged gateway intents are required.

Store `DISCORD_CLIENT_ID` and the bot token as `DISCORD_BOT_TOKEN` in a separate ignored `.env.setup`, restricted to the administrator. Set `DISCORD_GUILD_ID` there or pass `--guild`. The runtime Compose service does **not** receive the bot token. The CLI verifies that the token belongs to the configured application before modifying anything.

First inspect a read-only plan, then apply it deliberately:

```sh
# Register/update only the application metadata; preserve other metadata keys.
node --env-file=.env.setup setup.mjs
node --env-file=.env.setup setup.mjs --apply

# Also create/update the four named guild roles and order them.
node --env-file=.env.setup setup.mjs --roles --guild YOUR_GUILD_ID
node --env-file=.env.setup setup.mjs --roles --guild YOUR_GUILD_ID --apply
```

Replace `YOUR_GUILD_ID` with the real guild ID before running. Without `--apply`, the CLI only reads Discord and prints a plan. It uses documented Discord REST endpoints and never assigns/removes member roles. With optional roles enabled:

- New roles have zero additional permissions and are not mentionable.
- Existing, uniquely named tier roles keep their permissions, mentionability and other unrelated fields; only exact color and `hoist=true` change.
- Duplicate tier names, managed roles, roles at/above the bot, and roles held by the bot are rejected instead of guessing. Equal numeric positions are normal: Discord breaks ties by snowflake ID, with older roles above newer roles. This full ordering is used for both permission checks and tier placement.
- The four tier roles are ordered **Angeling > Deviling > Metaling > Poring** within the hierarchy slots they occupy. A newly created group already in that order needs no position update, even if all tiers and the bot report position 1. When ordering is necessary, only tier IDs are sent with their desired hierarchy ranks; unrelated role fields and their relative order are preserved, though Discord may renumber positions. The CLI does not move unrelated roles into a different relative order, raise tiers above their existing group of hierarchy slots or alter memberships.
- Metadata updates preserve other keys and refuse to exceed Discord’s five-record limit. No unrelated metadata record is deleted.

Discord setup is not transactional across API calls. On a network error or rate limit the CLI stops with a sanitized error; inspect the partial result, wait as appropriate and rerun the plan/apply sequence. Existing roles are reused by their unique exact names. Keep the bot installed for the verification integration, but do not retain its setup token in the service environment.

### Required manual Discord Links configuration

Metadata registration and ordinary role creation **do not enable the role requirements**. In the guild’s **Server Settings → Roles**, open each tier role, find its **Links / Linked Roles** requirements tab, add this application as a connection requirement, and set its **Credits** threshold to the table above. Save each role. Discord’s UI naming may vary by client/version; there is no supported role-connections API in this CLI for creating these per-guild linked-role requirements.

Confirm that the application’s verification URL is configured and its bot is installed if the application does not appear in the Links UI. Do not use undocumented Discord client endpoints or paste a personal Discord account token into this service to automate these steps.

## User flow and maintenance

1. Visit the service’s public HTTPS URL and submit a Clank API token. It is verified once against Clank’s existing `/api/me` and is **never persisted**. The source account must be active. Users can revoke that Clank token immediately afterward.
2. Click **Connect Discord**, authorize `identify role_connections.write`, and return to the service. OAuth credentials are encrypted in the service’s own state database. The account page shows current contribution credits, connection status and last synchronization time.
3. In Discord, open the server menu → **Linked Roles**, choose an eligible role and complete its claim flow. The connection must be visible/usable for linked roles in the user’s Discord Connections settings when Discord requests it. Having sufficient metadata alone does not mean the member already holds the role.
4. **Sync now** requests a synchronization pass. It respects the same durable cooldown/rate-limit deadlines as the scheduled worker; it does not bypass Discord limits. **Log out** ends the browser session, not the ongoing Discord connection.
5. **Disconnect Discord** clears published eligibility and revokes the OAuth connection. If Discord is unavailable, the account displays pending cleanup and retries rather than claiming success. If credentials are no longer usable, reconnect the same Discord account first so the service can clear its metadata. Switching to a different Discord account requires disconnecting the old one first.

Back up the service state using SQLite’s backup mechanism or while the service is stopped; preserve the encryption key securely and separately. Do not delete its database while users remain linked: that would lose the credentials needed to refresh or clear their metadata. Stop/restart only this Compose project when maintaining the integration; do not change the main Clank project.

## Tests

From this directory, run `npm test` (Node 24 built-in test runner). HTTP tests use a local test server and test doubles, and the setup tests use an injected Discord transport; they do not contact a live Discord guild or need production secrets. Core tests cover the real SQLite/encryption implementation. Live deployment still requires an operator to verify the public TLS callback, source-volume read permissions and the manual Discord role-claim flow with a real account.

## API references

- [Application role connection metadata and integer comparator types](https://docs.discord.com/developers/resources/application-role-connection-metadata)
- [Current user application role connections](https://docs.discord.com/developers/resources/user#update-current-user-application-role-connection)
- [Guild role creation, editing and positions](https://docs.discord.com/developers/resources/guild#create-guild-role)
- [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)
