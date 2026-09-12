#!/usr/bin/env bash
# One-time setup for a rented Ubuntu GPU container (Vast.ai / RunPod / similar, NVIDIA).
# Run as root (or with sudo), from inside the copied hashcats-miner/ directory:
#
#   scp -r hashcats-miner <user>@<ssh-host>:~/hashcats-miner
#   ssh -p <ssh-port> <user>@<ssh-host>
#   cd ~/hashcats-miner && bash deploy/setup-box.sh
#
# This box is untrusted: it never receives a private key, wallet label, RPC
# URL, or API key. It only runs worker/remote.py, which talks to the local
# reverse SSH tunnel to the coordinator on your own PC. See deploy/README.md.
set -euo pipefail

SUDO=""
if [ "$(id -u)" != "0" ]; then SUDO="sudo "; fi

echo "== apt: OpenCL loader + clinfo + python venv support =="
${SUDO}apt-get update
${SUDO}apt-get install -y ocl-icd-libopencl1 clinfo python3-venv

echo "== NVIDIA OpenCL ICD file =="
# Rented NVIDIA containers usually ship the driver's libnvidia-opencl.so.1 but
# no ICD registration for it, so clinfo / pyopencl see zero platforms without
# this file.
${SUDO}mkdir -p /etc/OpenCL/vendors
echo "libnvidia-opencl.so.1" | ${SUDO}tee /etc/OpenCL/vendors/nvidia.icd > /dev/null

echo "== clinfo (should list the rented GPU) =="
clinfo -l || echo "WARNING: clinfo found no platforms. Check the driver is mounted into the container."

echo "== python venv (pinned requirements.txt, do not change the pins) =="
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

echo "== selftest =="
.venv/bin/python -m worker.cli selftest

echo "== clinfo -l (again, for the log) =="
clinfo -l

echo
echo "Setup complete. From your own PC, in a terminal that stays open:"
echo "  ssh -R 8787:127.0.0.1:8787 -p <ssh-port> <user>@<ssh-host>"
echo "Then on THIS box:"
echo "  bash deploy/run-worker.sh --coordinator http://127.0.0.1:8787 --token <t>"
echo "Keys never leave your PC: this box only ever sees a job template and returns a nonce."
