# One rented box, one terminal. Copies the miner up, runs setup once, then keeps
# a reverse tunnel + worker alive in a single SSH session (restarts on drop).
#
#   .\hashcats-miner\deploy\box.ps1 -SshHost <ssh-host> -Port <ssh-port> -Token <t> [-Name box1] [-SkipSetup]
#
# The box only ever receives hashcats-miner.tgz (no .env, no private keys).
param(
  [Parameter(Mandatory = $true)][string]$SshHost,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Name = "",
  [string]$User = "root",
  [int]$CoordPort = 8787,
  [switch]$SkipSetup
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)
$tgz = Join-Path $root "hashcats-miner.tgz"
if ($Name -eq "") { $Name = "$SshHost-$Port" }
$target = "$User@$SshHost"
$sshOpts = @("-p", "$Port", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3")
# Non-root logins (e.g. ubuntu on VM providers) need sudo for apt and the ICD file.
$sudo = if ($User -eq "root") { "" } else { "sudo " }

if (-not $SkipSetup) {
  if (-not (Test-Path $tgz)) { throw "missing $tgz (build it with deploy/pack.ps1)" }
  Write-Host "[$Name] copying hashcats-miner.tgz"
  & scp -P $Port -o StrictHostKeyChecking=accept-new $tgz "${target}:~/hashcats-miner.tgz"
  if ($LASTEXITCODE -ne 0) { throw "scp failed" }
  Write-Host "[$Name] running setup (apt, ICD, venv, selftest)"
  # --no-same-owner: the tarball is built by Windows tar, which stamps a uid/gid
  # Linux cannot apply (fatal on some providers' encrypted volumes).
  & ssh @sshOpts $target "cd ~ && rm -rf hashcats-miner && tar --no-same-owner -xzf hashcats-miner.tgz && cd hashcats-miner && ${sudo}bash deploy/setup-box.sh"
  if ($LASTEXITCODE -ne 0) { throw "setup failed on $Name" }
}

$remote = "cd ~/hashcats-miner && ${sudo}bash deploy/run-worker.sh --coordinator http://127.0.0.1:$CoordPort --token $Token --worker-name $Name"
while ($true) {
  Write-Host "[$Name] tunnel + worker starting $(Get-Date -Format HH:mm:ss)"
  & ssh @sshOpts -R "${CoordPort}:127.0.0.1:${CoordPort}" $target $remote
  Write-Host "[$Name] session ended (exit $LASTEXITCODE), restarting in 5s"
  Start-Sleep -Seconds 5
}
