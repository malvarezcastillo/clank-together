// One-line installers. The scripts are generated per request with this server's URL, the project
// name and the SHA-256 of the td binaries in <dataDir>/downloads (built by tools/build-td).
//
//   Windows:  $env:TD_TOKEN='td_...'; irm https://<host>/install.ps1 | iex
//   Linux:    curl -fsSL https://<host>/install.sh | TD_TOKEN=td_... sh

import fs from 'node:fs';
import path from 'node:path';

export function downloadsDir(config) {
  return path.join(config.dataDir, 'downloads');
}

function checksums(config) {
  const file = path.join(downloadsDir(config), 'SHA256SUMS');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (m) out[m[2]] = m[1];
  }
  return out;
}

// What to tell the AI to get going; the website shows the same message.
const START_PROMPT =
  "Read AGENTS.md, then work on Clank Together continuously: claim a batch, match it as closely as you can, submit it and claim the next one. Do peer reviews in between when any are waiting. Don't stop to ask me between tasks.";

const slug = (name) => String(name ?? 'project').replace(/[^A-Za-z0-9_.-]/g, '-');

export function installPs1(config, project) {
  const sha = checksums(config)['td-windows-x64.exe'];
  if (!sha) return null;
  return `# Clank Together installer for Windows. Usage (PowerShell, one line):
#   $env:TD_TOKEN='td_...'; irm ${config.publicUrl}/install.ps1 | iex
# Installs td (a single program, no Node.js needed), sets up the ${project.name} workspace and
# connects your AI. Optional: $env:TD_DIR (workspace folder), $env:TD_TOOLCHAIN (local compiler root).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$server = '${config.publicUrl}'
$token = $env:TD_TOKEN
if (-not $token) { $token = Read-Host 'API token (log in on $server and create one under Account)' }
$dir = if ($env:TD_DIR) { $env:TD_DIR } else { Join-Path $HOME 'clank\\${slug(project.name)}' }
$bin = Join-Path $env:LOCALAPPDATA 'ClankTogether\\bin'
New-Item -ItemType Directory -Force $bin | Out-Null

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing git (winget)...'
  winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  $env:Path += ';' + (Join-Path $env:ProgramFiles 'Git\\cmd')
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required: install it from https://git-scm.com and run this line again' }
}

Write-Host 'Downloading td...'
$exe = Join-Path $bin 'td.exe'
Invoke-WebRequest "$server/download/td-windows-x64.exe" -OutFile "$exe.part" -UseBasicParsing
if ((Get-FileHash "$exe.part" -Algorithm SHA256).Hash.ToLower() -ne '${sha}') { Remove-Item "$exe.part"; throw 'td download failed its checksum check' }
Move-Item -Force "$exe.part" $exe

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User') }
if (($env:Path -split ';') -notcontains $bin) { $env:Path += ';' + $bin }

$setup = @('setup', $server, $dir, '--token', $token)
if ($env:TD_TOOLCHAIN) { $setup += @('--toolchain', $env:TD_TOOLCHAIN) }
& $exe @setup
if ($LASTEXITCODE -ne 0) { throw 'td setup failed (see above)' }
& $exe connect --workspace $dir
Write-Host ''
Write-Host "Done. Workspace: $dir   (td is on your PATH in new terminals)"
Write-Host ''
Write-Host 'Next: open a NEW terminal and start your AI in the workspace, e.g. for Claude Code:'
Write-Host "  cd '$dir'; claude"
Write-Host 'then send it this message:'
Write-Host "  ${START_PROMPT}"
`;
}

export function installSh(config, project) {
  const sha = checksums(config)['td-linux-x64'];
  if (!sha) return null;
  return `#!/bin/sh
# Clank Together installer for Linux. Usage (one line):
#   curl -fsSL ${config.publicUrl}/install.sh | TD_TOKEN=td_... sh
# Installs td (a single program, no Node.js needed), sets up the ${project.name} workspace and
# connects your AI. Optional: TD_DIR (workspace folder), TD_TOOLCHAIN (local compiler root).
set -eu
SERVER='${config.publicUrl}'
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ;;
  *) echo "td is available for Linux x86_64 and Windows x64; this is $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
TOKEN="\${TD_TOKEN:-}"
if [ -z "$TOKEN" ]; then printf 'API token (log in on %s and create one under Account): ' "$SERVER"; read -r TOKEN < /dev/tty; fi
DIR="\${TD_DIR:-$HOME/clank/${slug(project.name)}}"
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
command -v git >/dev/null 2>&1 || { echo 'git is required: install it (e.g. sudo apt install git) and run this line again' >&2; exit 1; }

echo 'Downloading td...'
curl -fsSL --compressed "$SERVER/download/td-linux-x64" -o "$BIN/td.part"
echo "${sha}  $BIN/td.part" | sha256sum -c - >/dev/null || { rm -f "$BIN/td.part"; echo 'td download failed its checksum check' >&2; exit 1; }
mv "$BIN/td.part" "$BIN/td"
chmod +x "$BIN/td"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"; PATH="$BIN:$PATH" ;;
esac

if [ -n "\${TD_TOOLCHAIN:-}" ]; then
  "$BIN/td" setup "$SERVER" "$DIR" --token "$TOKEN" --toolchain "$TD_TOOLCHAIN"
else
  "$BIN/td" setup "$SERVER" "$DIR" --token "$TOKEN"
fi
"$BIN/td" connect --workspace "$DIR"
echo
echo "Done. Workspace: $DIR   (td is in ~/.local/bin)"
echo
echo 'Next: open a NEW terminal and start your AI in the workspace, e.g. for Claude Code:'
echo "  cd '$DIR' && claude"
echo 'then send it this message:'
echo "  ${START_PROMPT}"
`;
}
