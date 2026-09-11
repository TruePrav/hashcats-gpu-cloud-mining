#!/usr/bin/env bash
# Builds hashcats-miner.tgz (repo root) with only what a rented box needs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"

tar -czf hashcats-miner.tgz --exclude=.venv --exclude=.cache --exclude=__pycache__ --exclude=logs hashcats-miner
size=$(( $(stat -c%s hashcats-miner.tgz 2>/dev/null || stat -f%z hashcats-miner.tgz) / 1024 ))
echo "hashcats-miner.tgz built (${size} KB)"

if tar -tzf hashcats-miner.tgz | grep -E "\.env|vault|\.pem|id_"; then
  echo "refusing: tarball contains a file matching .env|vault|.pem|id_ (see above)" >&2
  exit 1
fi
