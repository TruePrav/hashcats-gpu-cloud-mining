#!/usr/bin/env bash
# One rented box, one terminal. Copies the miner up, runs setup once, then keeps
# a reverse tunnel + worker alive in a single SSH session (restarts on drop).
#
#   ./hashcats-miner/deploy/box.sh <ssh-host> <ssh-port> <token> [name] [--skip-setup] [--user <user>] [--coord-port <port>]
#
# The box only ever receives hashcats-miner.tgz (no .env, no private keys).
set -euo pipefail

SSH_HOST="${1:?usage: box.sh <ssh-host> <ssh-port> <token> [name]}"
SSH_PORT="${2:?usage: box.sh <ssh-host> <ssh-port> <token> [name]}"
TOKEN="${3:?usage: box.sh <ssh-host> <ssh-port> <token> [name]}"
NAME="${4:-${SSH_HOST}-${SSH_PORT}}"
USER_NAME="root"
COORD_PORT="8787"
SKIP_SETUP="0"

shift 4 2>/dev/null || shift $# # drop the four positional args already consumed, if present

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-setup) SKIP_SETUP="1"; shift ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --coord-port) COORD_PORT="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tgz="$root/hashcats-miner.tgz"
target="${USER_NAME}@${SSH_HOST}"
ssh_opts=(-p "$SSH_PORT" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
# Non-root logins (e.g. ubuntu on VM providers) need sudo for apt and the ICD file.
sudo_prefix=""
if [ "$USER_NAME" != "root" ]; then sudo_prefix="sudo "; fi

if [ "$SKIP_SETUP" != "1" ]; then
  if [ ! -f "$tgz" ]; then echo "missing $tgz (build it with deploy/pack.sh)" >&2; exit 1; fi
  echo "[$NAME] copying hashcats-miner.tgz"
  scp -P "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$tgz" "${target}:~/hashcats-miner.tgz"
  echo "[$NAME] running setup (apt, ICD, venv, selftest)"
  ssh "${ssh_opts[@]}" "$target" "cd ~ && rm -rf hashcats-miner && tar --no-same-owner -xzf hashcats-miner.tgz && cd hashcats-miner && ${sudo_prefix}bash deploy/setup-box.sh"
fi

remote_cmd="cd ~/hashcats-miner && ${sudo_prefix}bash deploy/run-worker.sh --coordinator http://127.0.0.1:${COORD_PORT} --token ${TOKEN} --worker-name ${NAME}"
while true; do
  echo "[$NAME] tunnel + worker starting $(date +%H:%M:%S)"
  ssh "${ssh_opts[@]}" -R "${COORD_PORT}:127.0.0.1:${COORD_PORT}" "$target" "$remote_cmd" || true
  echo "[$NAME] session ended, restarting in 5s"
  sleep 5
done
