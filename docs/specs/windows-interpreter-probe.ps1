# Windows: what does the managed environment's launcher actually spawn?
#
# The failure this answers:
#
#     error: uv trampoline failed to spawn Python child process
#     Caused by: permission denied (os error 5)
#
# A uv-created venv on Windows does not contain a Python. `Scripts\python.exe`
# is a TRAMPOLINE that spawns the real interpreter somewhere else, and inside an
# AppContainer nothing is reachable unless its ACL names the container's SID. We
# grant the path `pyvenv.cfg` calls `home`. If the trampoline spawns something
# else - a different version directory, or a second trampoline under
# `~\.local\bin` - then we granted the wrong thing and the spawn is denied.
#
# This script only READS. It changes no ACL, installs nothing, and needs no
# elevation. Run it in a normal PowerShell window (NOT inside the agent, which
# is sandboxed and would measure the sandbox instead of the machine).
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File windows-interpreter-probe.ps1
#
# Paste the whole output.

$ErrorActionPreference = "Continue"

function Section($name) {
  Write-Host ""
  Write-Host "=== $name ===" -ForegroundColor Cyan
}

function Show-Owner($p) {
  if (-not (Test-Path -LiteralPath $p)) { Write-Host "  $p  <missing>"; return }
  try {
    $acl = Get-Acl -LiteralPath $p
    # Ownership is the whole question for grantability: icacls can only change
    # an ACL the caller owns, so a SYSTEM- or Administrators-owned path can
    # never be opened to an AppContainer without elevation.
    Write-Host "  $p"
    Write-Host "      owner: $($acl.Owner)"
    $pkg = $acl.Access | Where-Object { $_.IdentityReference -like "*APPLICATION PACKAGES*" }
    if ($pkg) { foreach ($a in $pkg) { Write-Host "      $($a.IdentityReference) : $($a.FileSystemRights)" } }
    else { Write-Host "      (no APPLICATION PACKAGES ACE - expected; ours is granted per run and revoked after)" }
  } catch {
    Write-Host "  $p  <acl read failed: $($_.Exception.Message)>"
  }
}

Section "openscience"
$exe = Join-Path $env:APPDATA "npm\node_modules\@synsci\openscience-windows-x64\bin\openscience.exe"
if (Test-Path -LiteralPath $exe) {
  Write-Host "  $exe"
  Write-Host "      version: $(& $exe --version 2>&1)"
  Write-Host "      sha256 : $((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.Substring(0,16).ToLower())"
} else {
  Write-Host "  not found at $exe"
}

Section "environments on this machine"
$envRoot = Join-Path $env:USERPROFILE ".cache\openscience\envs"
if (-not (Test-Path -LiteralPath $envRoot)) {
  Write-Host "  none at $envRoot"
} else {
  Get-ChildItem -LiteralPath $envRoot -Directory | ForEach-Object {
    Get-ChildItem -LiteralPath $_.FullName -Directory | ForEach-Object { Write-Host "  $($_.FullName)" }
  }
}

# Every environment, not just the first: the wildcard in the earlier one-liner
# would have hidden a second project quietly disagreeing with the first.
$venvs = @()
if (Test-Path -LiteralPath $envRoot) {
  $venvs = Get-ChildItem -LiteralPath $envRoot -Directory -Recurse -Depth 1 |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "pyvenv.cfg") }
}

foreach ($v in $venvs) {
  Section "environment: $($v.FullName)"

  Write-Host "  -- pyvenv.cfg (what we currently grant) --"
  Get-Content -LiteralPath (Join-Path $v.FullName "pyvenv.cfg") | ForEach-Object { Write-Host "  $_" }

  $py = Join-Path $v.FullName "Scripts\python.exe"
  Write-Host ""
  Write-Host "  -- Scripts\ --"
  if (Test-Path -LiteralPath (Join-Path $v.FullName "Scripts")) {
    Get-ChildItem -LiteralPath (Join-Path $v.FullName "Scripts") -File |
      ForEach-Object { Write-Host ("  {0,-28} {1,10} bytes" -f $_.Name, $_.Length) }
  } else { Write-Host "  <no Scripts directory>" }

  Write-Host ""
  Write-Host "  -- what the launcher resolves to (THE question) --"
  if (Test-Path -LiteralPath $py) {
    # sys._base_executable is literally the binary the launcher exec'd, so it
    # names the hop that is being denied inside the container. sys.base_prefix
    # is the tree the standard library is read from. Both must be reachable.
    $code = "import sys; print('  executable      :', sys.executable); print('  _base_executable:', getattr(sys, '_base_executable', None)); print('  base_prefix     :', sys.base_prefix); print('  version         :', sys.version.split()[0])"
    & $py -c $code 2>&1 | ForEach-Object { Write-Host $_ }
  } else {
    Write-Host "  <no Scripts\python.exe>"
  }
}

Section "uv"
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) { Write-Host "  uv not on PATH" }
else {
  Write-Host "  binary : $uv"
  Write-Host "  version: $(& $uv --version 2>&1)"
  Write-Host "  python dir (the managed install root we filter on):"
  & $uv python dir 2>&1 | ForEach-Object { Write-Host "    $_" }
  Write-Host "  installed, as JSON (paths under HOME come back RELATIVE - that is the parsing trap):"
  & $uv python list --only-installed --output-format json 2>&1 | ForEach-Object { Write-Host "    $_" }
}

Section "can each candidate base be granted?"
# The product's rule: a path is grantable only if the user owns it, because
# icacls cannot change an ACL you do not own. Anything owned by SYSTEM or
# Administrators is out of reach without elevation, which is out of scope.
$candidates = @(
  (Join-Path $env:APPDATA "uv\python"),
  (Join-Path $env:USERPROFILE ".local\bin"),
  (Join-Path $env:USERPROFILE ".local\bin\python3.12.exe"),
  "C:\Python312",
  "C:\ProgramData\chocolatey\bin"
)
if (Test-Path -LiteralPath (Join-Path $env:APPDATA "uv\python")) {
  $candidates += (Get-ChildItem -LiteralPath (Join-Path $env:APPDATA "uv\python") -Directory | ForEach-Object { $_.FullName })
}
foreach ($c in ($candidates | Select-Object -Unique)) { Show-Owner $c }

Section "the ~\.local\bin shim, if it is one"
$shim = Join-Path $env:USERPROFILE ".local\bin\python3.12.exe"
if (Test-Path -LiteralPath $shim) {
  Write-Host "  size: $((Get-Item -LiteralPath $shim).Length) bytes  (a uv trampoline is tens of KB; a real CPython is not)"
  & $shim -c "import sys; print('  it resolves to  :', getattr(sys, '_base_executable', None))" 2>&1 | ForEach-Object { Write-Host $_ }
} else {
  Write-Host "  absent"
}

Write-Host ""
Write-Host "=== done ===" -ForegroundColor Cyan
