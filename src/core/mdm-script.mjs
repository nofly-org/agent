import { parseEvery } from './schedule-plan.mjs';

export const MDM_OSES = ['macos', 'linux', 'windows'];
export const PACKAGE_NAME = '@shomra/agent';

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psQuote = (s) => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;

function bashScript({ os, key, url, hours, guard }) {
  const jamf = os === 'macos';
  const keyLine = key
    ? `SHOMRA_API_KEY="\${SHOMRA_API_KEY:-}"\n[ -n "$SHOMRA_API_KEY" ] || SHOMRA_API_KEY=${shQuote(key)}`
    : `SHOMRA_API_KEY="\${SHOMRA_API_KEY:-${jamf ? '${4:-}' : ''}}"`;
  const urlLine = url
    ? `SHOMRA_URL="\${SHOMRA_URL:-}"\n[ -n "$SHOMRA_URL" ] || SHOMRA_URL=${shQuote(url)}`
    : `SHOMRA_URL="\${SHOMRA_URL:-${jamf ? '${5:-}' : ''}}"`;
  return `#!/bin/bash
# Shomra endpoint agent - MDM bootstrap (${os}). Run as root.${jamf ? '\n# Jamf: pass the API key as parameter 4 and the URL as parameter 5, or set SHOMRA_API_KEY / SHOMRA_URL.' : ''}
set -euo pipefail

${keyLine}
${urlLine}
if [ -z "$SHOMRA_API_KEY" ]; then echo "SHOMRA_API_KEY is not set - supply it from your MDM's secret variables" >&2; exit 1; fi
if [ -z "$SHOMRA_URL" ]; then echo "SHOMRA_URL is not set" >&2; exit 1; fi
if [ "$(id -u)" -ne 0 ]; then echo "run this as root" >&2; exit 1; fi
export SHOMRA_API_KEY SHOMRA_URL

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\${PATH:-}"

resolve() {
  local f="$1" d n=0
  while [ -L "$f" ] && [ "$n" -lt 40 ]; do
    d="$(cd "$(dirname "$f")" && pwd -P)" || return 1
    f="$(readlink "$f")"
    case "$f" in /*) ;; *) f="$d/$f" ;; esac
    n=$((n + 1))
  done
  d="$(cd "$(dirname "$f")" && pwd -P)" || return 1
  printf '%s/%s\n' "$d" "$(basename "$f")"
}

root_chain() {
  local p="$1" uid mode
  while :; do
    if [ "$(uname -s)" = Darwin ]; then uid="$(stat -f %u "$p")" && mode="$(stat -f %Lp "$p")" || return 1
    else uid="$(stat -c %u "$p")" && mode="$(stat -c %a "$p")" || return 1; fi
    [ "$uid" = 0 ] || return 1
    if [ ! -L "$p" ] && (( 8#$mode & 8#022 )) && ! { [ -d "$p" ] && (( 8#$mode & 8#1000 )); }; then return 1; fi
    [ "$p" = / ] && return 0
    p="$(dirname "$p")"
  done
}

root_owned() {
  local real
  real="$(resolve "$1")" || return 1
  root_chain "$1" && root_chain "$real"
}

NODE=""
FIRST=""
for candidate in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node "$(command -v node || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  [ -n "$FIRST" ] || FIRST="$candidate"
  if root_owned "$candidate"; then NODE="$candidate"; break; fi
done
if [ -z "$FIRST" ]; then echo "Node.js 18+ is required - deploy it first" >&2; exit 1; fi
if [ -z "$NODE" ]; then
  if [ "\${SHOMRA_ALLOW_USER_NODE:-}" = 1 ]; then
    NODE="$FIRST"
    echo "using $NODE, which a normal user can change - accepted with SHOMRA_ALLOW_USER_NODE=1" >&2
  else
    echo "No root-owned Node.js was found (first found: $FIRST). The schedule${guard ? ' and the managed firewall run' : ' runs'} as root, so a Node a normal user can change would run that user's code as root." >&2
    echo "Install Node with the official installer or your OS packages, or set SHOMRA_ALLOW_USER_NODE=1 to accept the risk." >&2
    exit 1
  fi
fi
export SHOMRA_ALLOW_USER_NODE="\${SHOMRA_ALLOW_USER_NODE:-}"
NPM="$(dirname "$NODE")/npm"
if [ ! -x "$NPM" ]; then echo "npm was not found next to $NODE - install npm for that Node first" >&2; exit 1; fi
PREFIX=/usr/local/shomra
ENTRY="$PREFIX/lib/node_modules/${PACKAGE_NAME}/shomra.mjs"

if [ ! -f "$ENTRY" ]; then
  umask 022
  "$NPM" install --global --prefix "$PREFIX" ${PACKAGE_NAME}
fi

"$NODE" "$ENTRY" init --machine --url "$SHOMRA_URL"
status=0
"$NODE" "$ENTRY" schedule install --all-users --every ${hours}h || { echo "the report schedule could not be installed - see the output above" >&2; status=1; }
${guard ? '"$NODE" "$ENTRY" install-hook --managed || { echo "the managed runtime firewall could not be installed for every agent - see the output above" >&2; status=1; }\n' : ''}"$NODE" "$ENTRY" report --all-users || echo "first report finished with findings or errors - see the Shomra dashboard"
exit "$status"
`;
}

function powershellScript({ key, url, hours, guard }) {
  return `# Shomra endpoint agent - MDM bootstrap (Windows). Run as SYSTEM or an elevated Administrator.
$ErrorActionPreference = 'Stop'

$ApiKey = $env:SHOMRA_API_KEY
${key ? `if (-not $ApiKey) { $ApiKey = ${psQuote(key)} }\n` : ''}$Url = $env:SHOMRA_URL
${url ? `if (-not $Url) { $Url = ${psQuote(url)} }\n` : ''}if (-not $ApiKey) { Write-Error "SHOMRA_API_KEY is not set - supply it from your MDM's secret variables"; exit 1 }
if (-not $Url) { Write-Error 'SHOMRA_URL is not set'; exit 1 }
$env:SHOMRA_API_KEY = $ApiKey
$env:SHOMRA_URL = $Url

$Node = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $Node) {
  $Candidate = Join-Path $env:ProgramFiles 'nodejs\\node.exe'
  if (Test-Path $Candidate) { $Node = $Candidate }
}
if (-not $Node) { Write-Error 'Node.js 18+ is required - deploy it first'; exit 1 }
$Npm = Join-Path (Split-Path $Node) 'npm.cmd'
$Prefix = Join-Path $env:ProgramFiles 'Shomra'
$Entry = Join-Path $Prefix 'node_modules\\${PACKAGE_NAME.replace('/', '\\')}\\shomra.mjs'

if (-not (Test-Path $Entry)) {
  & $Npm install --global --prefix $Prefix ${PACKAGE_NAME}
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $Node $Entry init --machine --url $Url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$Status = 0
& $Node $Entry schedule install --all-users --every ${hours}h
if ($LASTEXITCODE -ne 0) { Write-Output 'the report schedule could not be installed - see the output above'; $Status = 1 }
${guard ? "& $Node $Entry install-hook --managed\nif ($LASTEXITCODE -ne 0) { Write-Output 'the managed runtime firewall could not be installed for every agent - see the output above'; $Status = 1 }\n" : ''}& $Node $Entry report --all-users
if ($LASTEXITCODE -ne 0) { Write-Output 'first report finished with findings or errors - see the Shomra dashboard' }
exit $Status
`;
}

export function mdmScript({ os, key = null, url = null, every = undefined, guard = false } = {}) {
  const target = String(os ?? '').toLowerCase();
  if (!MDM_OSES.includes(target)) throw new Error(`--os must be one of ${MDM_OSES.join(', ')}`);
  const hours = parseEvery(every);
  const args = { os: target, key: key && key !== true ? String(key) : null, url: url && url !== true ? String(url).replace(/\/$/, '') : null, hours, guard: !!guard };
  return target === 'windows' ? powershellScript(args) : bashScript(args);
}
