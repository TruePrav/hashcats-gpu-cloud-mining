#!/usr/bin/env bash
# Runs the untrusted remote worker. All arguments are forwarded to
# worker/remote.py, e.g.:
#   bash deploy/run-worker.sh --coordinator http://127.0.0.1:8787 --token <t>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec .venv/bin/python -m worker.remote "$@"
