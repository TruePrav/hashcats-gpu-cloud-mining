# Renting a GPU box for HashCats mining

Architecture invariant: rented GPU boxes never see keys. A rented box runs
only `worker/remote.py`. It receives a job id, miner address, a 116-byte
template hex (nonce zeroed), nonce offset/width/endian, required bits, and a
deadline. It returns a nonce + hash. It never receives a private key, wallet
label, RPC URL, or API key, and it never signs or broadcasts anything. The
coordinator (`mine-hashcats.mjs`, run on your own PC) holds the keys, reads
the chain, and does the actual signing/sending.

```
[rented box]  hashcats-miner/worker/remote.py  --coordinator http://127.0.0.1:8787
      | reverse SSH tunnel opened FROM your PC:  ssh -R 8787:127.0.0.1:8787 ...
[your PC]     mine-hashcats.mjs  (coordinator HTTP on 127.0.0.1:8787 + chain poller + signer)
```

A local GPU can run the same `remote.py` directly against
`http://127.0.0.1:8787` with no tunnel at all, since it is already on the
coordinator machine. See `docs/GPU-PROVIDERS.md` for where to rent a box.

## 1. Pick an instance

- Search for an Ubuntu image with CUDA already installed, e.g.
  `nvidia/cuda:12.x-runtime-ubuntu22.04` (any recent 12.x runtime image with
  the NVIDIA driver mounted in works; a "runtime" image is enough, no need
  for `devel`).
- One mid-to-high-end NVIDIA GPU is plenty; this workload is GPU-bound
  keccak256 hashing, not memory- or PCIe-bound.
- Rent it, note the SSH host and port your provider gives you.

## 2. Copy the code up (from your PC)

```
scp -r hashcats-miner <user>@<ssh-host>:~/hashcats-miner
```

Do not copy the repo's `.env` or anything under `logs/`.
`hashcats-miner/` on its own has no secrets in it.

## 3. Run setup on the box

```
ssh -p <ssh-port> <user>@<ssh-host>
cd ~/hashcats-miner
bash deploy/setup-box.sh
```

This installs `ocl-icd-libopencl1 clinfo python3-venv`, writes the NVIDIA
OpenCL ICD file (`/etc/OpenCL/vendors/nvidia.icd` -> `libnvidia-opencl.so.1`,
the fix rented NVIDIA containers usually need since the driver's OpenCL
library is present but not registered with the ICD loader), creates the
venv from the pinned `requirements.txt`, runs `cli.py selftest`, and prints
`clinfo -l` so you can see the GPU was actually found.

## 4. Open the reverse tunnel (from your PC, keep this terminal open)

```
ssh -R 8787:127.0.0.1:8787 -p <ssh-port> <user>@<ssh-host>
```

This makes `127.0.0.1:8787` on the RENTED BOX forward to `127.0.0.1:8787` on
your own PC, where `mine-hashcats.mjs` is listening. The box never gets a
direct route to anything else on your network.

Before paying for hours, do a 30-second tunnel test (see
`docs/GPU-PROVIDERS.md`) to confirm `-R` works on your provider.

## 5. Start the coordinator (your PC, separate terminal)

```
node mine-hashcats.mjs --wallets 0,1,2 --token <t> --port 8787
```

Keys come from the `PRIVATE_KEYS` entry in `.env`. Note the printed token if
you did not pass `--token` explicitly.

## 6. Start the worker (on the rented box, inside the SSH session from step 4 or a new one)

```
bash deploy/run-worker.sh --coordinator http://127.0.0.1:8787 --token <t>
```

The worker long-polls `/job`, searches on every OpenCL GPU device it finds
(`--devices 0,1` to restrict), and POSTs any hit to `/solution` immediately.
It reports `/progress` every 10s and backs off (0.5s to 10s) on transient
coordinator errors without ever exiting.

## Scripted deploy (one box, one terminal)

`deploy/box.ps1` (Windows) and `deploy/box.sh` (macOS/Linux) automate steps
2-4 and 6: they copy `hashcats-miner.tgz` (built by `deploy/pack.ps1` /
`deploy/pack.sh`), run setup once (unless `-SkipSetup` / `--skip-setup`),
then hold the reverse tunnel and worker in a loop, restarting a few seconds
after any drop.

```
# Windows
.\hashcats-miner\deploy\box.ps1 -SshHost <ssh-host> -Port <ssh-port> -Token <t> -Name box1

# macOS / Linux
./hashcats-miner/deploy/box.sh <ssh-host> <ssh-port> <t> box1
```

To use more than one rented box, run the same command again per box with a
different `-Name`/name and its own SSH host/port, all pointed at the same
`--token` and coordinator port. Each worker process salts its own search
space with a random session id, so separate boxes never overlap; see
`docs/GPU-PROVIDERS.md` for why several single-GPU boxes are usually easier
to rent (and cheaper per GPU) than one large multi-GPU chassis.

## Keys never leave your PC

- Your `.env` and `PRIVATE_KEYS` stay on your own PC; they are read only by
  `mine-hashcats.mjs`.
- The rented box's `remote.py` process has no key-loading code path, no RPC
  URL, no API key, and no wallet label in its argument list; `--coordinator`
  and `--token` are the only inputs it needs.
- The signed `mine()` transaction is built and (with `--send`) broadcast
  entirely on your PC; the rented box never sees calldata beyond the opaque
  job template it was given, and never sees a signature.
