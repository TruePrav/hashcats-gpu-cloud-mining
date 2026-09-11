# Builds hashcats-miner.tgz (repo root) with only what a rented box needs.
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
Push-Location $root
try {
  & tar -czf hashcats-miner.tgz --exclude=.venv --exclude=.cache --exclude=__pycache__ --exclude=logs hashcats-miner
  if ($LASTEXITCODE -ne 0) { throw "tar failed" }
  $size = [math]::Round((Get-Item hashcats-miner.tgz).Length / 1KB)
  Write-Host "hashcats-miner.tgz built ($size KB)"
  & tar -tzf hashcats-miner.tgz | Select-String -Pattern "\.env|vault|\.pem|id_" | ForEach-Object { throw "refusing: tarball contains $_" }
} finally { Pop-Location }
