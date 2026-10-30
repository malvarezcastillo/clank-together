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

/** The SHA-256 of every published td binary (download name -> hash). */
export function publishedBuilds(config) {
  return checksums(config);
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
  "Read AGENTS.md and CODING_RULES.md and follow them strictly, then work on Clank Together continuously. Once you've finished a batch, start a new one without interruption.";
const PROMPT_LINES = START_PROMPT.match(/.{1,76}(?:\s|$)/g).map((line) => line.trim());

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
$log = Join-Path ([IO.Path]::GetTempPath()) ('rodecomp-install-' + [guid]::NewGuid().ToString('N') + '.log')
$useColor = -not $env:NO_COLOR -and -not [Console]::IsOutputRedirected
function Show-Line($text, $color = 'Cyan') {
  if ($useColor) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}
function Run-Step($label, [string[]]$commandArgs, $program = $exe) {
  Show-Line "  $label ..."
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = (& $program @commandArgs 2>&1 | Out-String); $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $savedPreference }
  if ($token) { $output = $output.Replace($token, '[REDACTED]') }
  Add-Content -LiteralPath $log -Value $output -Encoding UTF8
  if ($code -ne 0) {
    Show-Line "  ✗ $label FAILED" Red
    Write-Host $output
    return $false
  }
  Show-Line "  ✅ $label OK" Green
  return $true
}
Show-Line ''
Show-Line '  ============================================================================' DarkGray
Show-Line '   R O D E C O M P' Yellow
Show-Line '   Ragnarok Online reconstruction  /  Contributor setup' White
Show-Line '  ============================================================================' DarkGray
Show-Line ''

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Git (MinGit, no administrator rights required)...'
  $gitDir = Join-Path $env:LOCALAPPDATA 'ClankTogether\\MinGit'
  $gitBin = Join-Path $gitDir 'cmd'
  $gitArchive = Join-Path ([IO.Path]::GetTempPath()) ('clank-mingit-' + [guid]::NewGuid().ToString('N') + '.zip')
  try {
    Invoke-WebRequest 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/MinGit-2.56.0.4-64-bit.zip' -OutFile $gitArchive -UseBasicParsing
    if ((Get-FileHash $gitArchive -Algorithm SHA256).Hash.ToLower() -ne 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877') { throw 'Git download failed its checksum check' }
    Expand-Archive -LiteralPath $gitArchive -DestinationPath $gitDir -Force
    & (Join-Path $gitBin 'git.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'Downloaded Git could not run' }
    $gitUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $gitUserPath) { $gitUserPath = '' }
    if (($gitUserPath -split ';') -notcontains $gitBin) { [Environment]::SetEnvironmentVariable('Path', ($gitUserPath.TrimEnd(';') + ';' + $gitBin), 'User') }
    if (($env:Path -split ';') -notcontains $gitBin) { $env:Path += ';' + $gitBin }
  } finally {
    if (Test-Path -LiteralPath $gitArchive) { Remove-Item -LiteralPath $gitArchive }
  }
}

Show-Line '  [1/4] Download client ...'
$exe = Join-Path $bin 'td.exe'
Invoke-WebRequest "$server/download/td-windows-x64.exe" -OutFile "$exe.part" -UseBasicParsing
if ((Get-FileHash "$exe.part" -Algorithm SHA256).Hash.ToLower() -ne '${sha}') { Remove-Item "$exe.part"; throw 'td download failed its checksum check' }
Move-Item -Force "$exe.part" $exe
Show-Line '  ✅ [1/4] Client downloaded and verified' Green

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User') }
if (($env:Path -split ';') -notcontains $bin) { $env:Path += ';' + $bin }

$setup = @('setup', $server, $dir, '--token', $token)
if ($env:TD_TOOLCHAIN) { $setup += @('--toolchain', $env:TD_TOOLCHAIN) }
if (-not (Run-Step '[2/4] Set up workspace' $setup)) { throw "Setup failed. Files preserved. Rerun the installer after correcting the error. Log: $log" }
$compilerReady = $true
if (-not $env:TD_TOOLCHAIN) {
  Push-Location $dir
  try { $compilerReady = Run-Step '[3/4] Install compiler' @('toolchain', 'install') }
  finally { Pop-Location }
} else { Show-Line '  ✅ [3/4] Using supplied compiler' Green }
$connectReady = Run-Step '[4/4] Configure AI connection' @('connect', '--workspace', $dir)
$codexPresent = [bool](Get-Command codex -ErrorAction SilentlyContinue)
$codexReady = $false
if ($codexPresent) {
  $codexReady = Run-Step 'Register Codex MCP' @('mcp', 'add', 'clank-together', '--', $exe, 'mcp', '--workspace', $dir) 'codex'
  if (-not $codexReady) { $connectReady = $false }
}
Show-Line ''
if ($compilerReady -and $connectReady) { Show-Line '  ✅ INSTALLATION COMPLETE' Green }
else { Show-Line '  ⚠ INSTALLATION INCOMPLETE — workspace and target preserved' Yellow }
Write-Host "  Workspace  $dir"
Write-Host "  Server     $server"
Write-Host "  Log        $log"
if (-not $compilerReady) { Show-Line '  Retry inside your workspace: td toolchain install' Yellow }
if (-not $connectReady) { Show-Line '  Retry: td connect --workspace <your workspace>' Yellow }
Show-Line ''
Show-Line ''
Show-Line '  NEXT: PUT YOUR AI TO WORK' Yellow
Show-Line '  ============================================================================' DarkGray
Show-Line ''
Show-Line '  1. CONNECT YOUR AI' Yellow
Show-Line ''
Show-Line '     CLAUDE CODE' White
Write-Host '     Install Claude Code if needed:'
Show-Line '       https://code.claude.com/docs/en/quickstart' Cyan
Write-Host '     Register this workspace if clank-together is not already configured:'
Show-Line ('       claude mcp add --scope user clank-together -- "' + $exe + '" mcp --workspace "' + $dir + '"') Cyan
Write-Host '     Open a new terminal (restart any existing AI session), then run:'
Show-Line "       cd '$dir'; claude" Cyan
Write-Host '     Type /mcp and confirm clank-together is connected.'
Show-Line ''
Show-Line '     CODEX' White
Write-Host '     Install Codex CLI if needed:'
Show-Line '       https://learn.chatgpt.com/docs/codex/cli#getting-started' Cyan
if ($codexReady) { Show-Line '     MCP registered automatically for this workspace.' Green }
Write-Host '     Register this workspace if clank-together is not already configured:'
Show-Line ('       codex mcp add clank-together -- "' + $exe + '" mcp --workspace "' + $dir + '"') Cyan
Write-Host '     Open a new terminal (restart any existing AI session), then run:'
Show-Line "       cd '$dir'; codex" Cyan
Write-Host '     Type /mcp and confirm clank-together is connected.'
Show-Line ''
Show-Line '     OTHER AI CLIENTS' White
Write-Host '     Ask your AI: "Install the clank-together MCP server using the configuration'
Write-Host '     below. Keep its workspace path exactly as shown and preserve my other MCP'
Write-Host '     servers. Tell me if you need permission or a restart to finish setup."'
Write-Host '     If your AI cannot edit its settings, add this configuration manually.'
Show-Line ''
$jsonExe = ConvertTo-Json -InputObject $exe -Compress
$jsonDir = ConvertTo-Json -InputObject $dir -Compress
Write-Host '     {'
Write-Host '       "mcpServers": {'
Write-Host '         "clank-together": {'
Write-Host ('           "command": ' + $jsonExe + ',')
Write-Host ('           "args": ["mcp", "--workspace", ' + $jsonDir + ']')
Write-Host '         }'
Write-Host '       }'
Write-Host '     }'
Show-Line ''
Show-Line '  --------------------------------------------------------------------------' DarkGray
Show-Line ''
Show-Line '  2. SEND THIS TO YOUR AI' Yellow
Show-Line ''
Write-Host '     Paste this message into your AI:'
Show-Line ''
${PROMPT_LINES.map((line) => `Write-Host '     ${line.replaceAll("'", "''")}'`).join('\n')}
Show-Line ''
Write-Host '     Leave your AI running. To stop, stop the AI session.'
Show-Line ''
Show-Line '  ============================================================================' DarkGray
Write-Host "  Guide: $server/#/guide"
Show-Line ''
if (-not $compilerReady -or -not $connectReady) { throw "Installation incomplete. See $log" }
`;
}

export function installSh(config, project) {
  const sums = checksums(config);
  const sha = sums['td-linux-x64'];
  if (!sha) return null;
  const shaArm = sums['td-linux-arm64'] ?? '';
  return `#!/bin/sh
# Clank Together installer for Linux. Usage (one line):
#   curl -fsSL ${config.publicUrl}/install.sh | TD_TOKEN=td_... sh
# Installs td (a single program, no Node.js needed), sets up the ${project.name} workspace and
# connects your AI. Optional: TD_DIR (workspace folder), TD_TOOLCHAIN (local compiler root).
set -eu
SERVER='${config.publicUrl}'
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET=td-linux-x64 SHA='${sha}' ;;
  Linux-aarch64|Linux-arm64) ASSET=td-linux-arm64 SHA='${shaArm}' ;;
  *) ASSET= SHA= ;;
esac
[ -n "$SHA" ] || { echo "td is not available for $(uname -s) $(uname -m)" >&2; exit 1; }
TOKEN="\${TD_TOKEN:-}"
if [ -z "$TOKEN" ]; then printf 'API token (log in on %s and create one under Account): ' "$SERVER"; read -r TOKEN < /dev/tty; fi
DIR="\${TD_DIR:-$HOME/clank/${slug(project.name)}}"
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
umask 077
LOG=$(mktemp "\${TMPDIR:-/tmp}/rodecomp-install.XXXXXX")
STEP_LOG=$(mktemp "\${TMPDIR:-/tmp}/rodecomp-step.XXXXXX")
trap 'rm -f "$STEP_LOG"' EXIT
CYAN='' GREEN='' YELLOW='' RED='' RESET=''
if [ -t 1 ] && [ -z "\${NO_COLOR:-}" ]; then
  CYAN=$(printf '\\033[36m'); GREEN=$(printf '\\033[32m'); YELLOW=$(printf '\\033[33m'); RED=$(printf '\\033[31m'); RESET=$(printf '\\033[0m')
fi
line() { printf '%s%s%s\\n' "$1" "$2" "$RESET"; }
step() {
  label=$1; shift
  line "$CYAN" "  $label ..."
  code=0; "$@" >"$STEP_LOG" 2>&1 || code=$?
  # td tokens use URL-safe characters; do not write the credential into the log.
  sed "s/$TOKEN/[REDACTED]/g" "$STEP_LOG" >> "$LOG"
  if [ "$code" -ne 0 ]; then
    line "$RED" "  ✗ $label FAILED"
    sed "s/$TOKEN/[REDACTED]/g" "$STEP_LOG"
    return "$code"
  fi
  line "$GREEN" "  ✅ $label OK"
}
line "$CYAN" '+--------------------------------------------------+'
line "$CYAN" '|                   R O D E C O M P                |'
line "$CYAN" '|      Ragnarok Online reconstruction project      |'
line "$CYAN" '+--------------------------------------------------+'
command -v git >/dev/null 2>&1 || { echo 'git is required: install it (e.g. sudo apt install git) and run this line again' >&2; exit 1; }

line "$CYAN" '  [1/4] Download client ...'
curl -fsSL --compressed "$SERVER/download/$ASSET" -o "$BIN/td.part"
echo "$SHA  $BIN/td.part" | sha256sum -c - >/dev/null || { rm -f "$BIN/td.part"; echo 'td download failed its checksum check' >&2; exit 1; }
mv "$BIN/td.part" "$BIN/td"
chmod +x "$BIN/td"
line "$GREEN" '  ✅ [1/4] Client downloaded and verified'
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"; PATH="$BIN:$PATH" ;;
esac

compiler_ready=1; connect_ready=1
if [ -n "\${TD_TOOLCHAIN:-}" ]; then
  step '[2/4] Set up workspace' "$BIN/td" setup "$SERVER" "$DIR" --token "$TOKEN" --toolchain "$TD_TOOLCHAIN" || { echo "Setup failed. Files preserved. Log: $LOG"; exit 1; }
  line "$GREEN" '  ✅ [3/4] Using supplied compiler'
else
  step '[2/4] Set up workspace' "$BIN/td" setup "$SERVER" "$DIR" --token "$TOKEN" || { echo "Setup failed. Files preserved. Log: $LOG"; exit 1; }
  (cd "$DIR" && step '[3/4] Install compiler' "$BIN/td" toolchain install) || compiler_ready=0
fi
step '[4/4] Configure AI connection' "$BIN/td" connect --workspace "$DIR" || connect_ready=0
CONNECT_LOG=$(mktemp "\${TMPDIR:-/tmp}/rodecomp-connect.XXXXXX")
cp "$STEP_LOG" "$CONNECT_LOG"
trap 'rm -f "$STEP_LOG" "$CONNECT_LOG"' EXIT
codex_ready=0
if command -v codex >/dev/null 2>&1; then
  if step 'Register Codex MCP' codex mcp add clank-together -- "$BIN/td" mcp --workspace "$DIR"; then codex_ready=1; else connect_ready=0; fi
fi
echo
if [ "$compiler_ready$connect_ready" = 11 ]; then
  line "$GREEN" '  ✅ INSTALLATION COMPLETE'
else
  line "$YELLOW" '  ⚠ INSTALLATION INCOMPLETE — workspace and target preserved'
fi
printf '  Workspace  %s\\n  Server     %s\\n  Log        %s\\n' "$DIR" "$SERVER" "$LOG"
if [ "$compiler_ready" = 0 ]; then
  if [ "$ASSET" = td-linux-arm64 ]; then line "$YELLOW" '  Retry inside your workspace: td toolchain install (ARM64 needs x86 wine via box64, or an x86-64 container)'
  else line "$YELLOW" '  Retry inside your workspace: td toolchain install (Linux requires wine)'; fi
fi
if [ "$connect_ready" = 0 ]; then line "$YELLOW" '  Retry inside your workspace: td connect'; fi
echo
line "$YELLOW" '  NEXT: PUT YOUR AI TO WORK'
line "$CYAN" '  ============================================================================'
echo
line "$YELLOW" '  1. CONNECT YOUR AI'
echo
echo '     CLAUDE CODE'
echo '     Install Claude Code if needed:'
line "$CYAN" '       https://code.claude.com/docs/en/quickstart'
echo '     Register this workspace if clank-together is not already configured:'
printf '       claude mcp add --scope user clank-together -- "%s" mcp --workspace "%s"\\n' "$BIN/td" "$DIR"
echo '     Open a new terminal (restart any existing AI session), then run:'
printf '       cd "%s" && claude\\n' "$DIR"
echo '     Type /mcp and confirm clank-together is connected.'
echo
echo '     CODEX'
echo '     Install Codex CLI if needed:'
line "$CYAN" '       https://learn.chatgpt.com/docs/codex/cli#getting-started'
if [ "$codex_ready" = 1 ]; then line "$GREEN" '     MCP registered automatically for this workspace.'; fi
echo '     Register this workspace if clank-together is not already configured:'
printf '       codex mcp add clank-together -- "%s" mcp --workspace "%s"\\n' "$BIN/td" "$DIR"
echo '     Open a new terminal (restart any existing AI session), then run:'
printf '       cd "%s" && codex\\n' "$DIR"
echo '     Type /mcp and confirm clank-together is connected.'
echo
echo '     OTHER AI CLIENTS'
echo '     Ask your AI: "Install the clank-together MCP server using the configuration'
echo '     below. Keep its workspace path exactly as shown and preserve my other MCP'
echo '     servers. Tell me if you need permission or a restart to finish setup."'
echo '     If your AI cannot edit its settings, add this configuration manually.'
echo
sed -n '/^{/,/^}/p' "$CONNECT_LOG" | sed 's/^/     /'
echo
line "$CYAN" '  --------------------------------------------------------------------------'
echo
line "$YELLOW" '  2. SEND THIS TO YOUR AI'
echo
echo '     Paste this message into your AI:'
echo
cat <<'RODECOMP_PROMPT'
${PROMPT_LINES.map((line) => '     ' + line).join('\n')}
RODECOMP_PROMPT
echo
echo '     Leave your AI running. To stop, stop the AI session.'
echo
line "$CYAN" '  ============================================================================'
printf '  Guide: %s/#/guide\\n' "$SERVER"
echo
[ "$compiler_ready$connect_ready" = 11 ] || exit 1
`;
}
