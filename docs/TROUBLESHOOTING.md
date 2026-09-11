# Troubleshooting

## `clinfo` shows zero platforms on a rented box

The NVIDIA driver is usually mounted into rented containers, but its OpenCL
library is not registered with the ICD loader. `deploy/setup-box.sh` fixes
this by writing `/etc/OpenCL/vendors/nvidia.icd` containing
`libnvidia-opencl.so.1`. If `clinfo -l` still lists nothing after that, the
driver itself is not mounted into the container; check with the provider or
try a different image.

## numpy install fails or pulls the wrong version

`requirements.txt` pins numpy differently by Python version
(`2.5.3` for Python >=3.12, `2.2.6` for older). Rented boxes commonly ship
Python 3.10, which needs the older pin. Do not change the pins; install with
`pip install -r requirements.txt` as-is.

## Windows-built tarball fails to extract on Linux (owner/uid errors)

Windows `tar` stamps a uid/gid that some providers' encrypted volumes refuse.
Extract with `tar --no-same-owner -xzf hashcats-miner.tgz` (both `box.ps1`
and `box.sh` already pass it).

## Worker gets 401 from the coordinator

Token mismatch. The token the worker sends (`--token`, or the
`HASHCATS_TOKEN` env var) must exactly match what the coordinator printed on
startup or was given via `--token`/`HASHCATS_TOKEN`.

## Worker posts a solution and gets "stale job" (409)

Normal, not a bug. A new job is issued roughly every ~12 seconds as
`prevWork` changes on-chain (someone else's mint landed, or the anchor
refreshed). A worker that was searching the previous job's template when it
found a hit is too late; it discards the result and starts the new job. This
happens more often at higher network activity.

## Worker gets "wallet-busy" (409)

The wallet pool only accepts one in-flight solution per wallet at a time. If
a worker posts a second solution for a wallet whose previous solve is still
being sent/confirmed, it is rejected rather than double-spent. This is
expected under normal operation with multiple workers racing the same job.

## Price cap clears the job

If `mintPrice()` rises above `--max-price-wei`, the coordinator clears the
current job and workers idle (long-polling `/job` returns 204) until the
price drops back under the cap. This is deliberate, not an error.

## A reverted `mine()` only costs gas

If the coordinator broadcasts a transaction and it reverts on-chain (someone
else's mint landed first, the nonce no longer beats the target, etc.), the
mint value (`msg.value`) is returned automatically by the revert; you only
pay the gas for the failed attempt.

## Keep the coordinator terminal open

`mine-hashcats.mjs` holds the wallet pool state, the poll loop, and the
in-flight receipt watchers in memory. Closing its terminal (or the process
exiting) stops mining immediately; there is no persistence across restarts
beyond the `logs/` JSON dump.

## Hex-prefix mismatches between the worker and the coordinator

The Python worker reports nonces and hashes via `bytes.hex()`, which has no
`0x` prefix; the coordinator normalizes both sides before comparing or
converting to `BigInt`. This is already handled in
`hashcats-coordinator.mjs`: if you see a nonce or hash comparison failing
after modifying that file, check that normalization did not get dropped.
