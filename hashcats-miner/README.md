# hashcats-miner

A generic, parameterised OpenCL keccak256 nonce-search engine. It finds a
nonce such that keccak256(preimage) has at least N leading zero bits, at
whatever throughput the local GPU(s) allow. It has no chain code, no wallet
code, and no keys: it receives an opaque preimage template (hex), nonce
placement parameters, and a required-bits target, and returns the winning
nonce/hash. Nothing here signs or broadcasts anything, and nothing here ever
holds a private key, mnemonic, or RPC/API credential. A rented GPU box running
this worker should be treated as untrusted for anything beyond hashing.

## How the search space works

- `template`: the preimage bytes (1..135, a single keccak absorb block).
- `nonce_offset` / `nonce_width`: where the nonce field sits in the template
  and how wide it is (1..32 bytes). `nonce_endian` is `big` (default,
  Solidity `abi.encodePacked(uint256)` style) or `little`.
- The engine only iterates the low 8 bytes of the nonce field as a 64-bit
  counter. If the field is wider than 8 bytes, the remaining high bytes are
  filled with a random 32-bit session id plus the device index, so two GPUs
  or two machines never search the same space.
- `required_bits`: success once the 256-bit big-endian hash has at least
  that many leading zero bits.

## Windows (local)

```
cd hashcats-miner
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m unittest discover -s tests -v
.venv\Scripts\python -m worker.cli selftest
.venv\Scripts\python -m worker.cli bench --seconds 15
```

Requires an NVIDIA (or AMD) GPU with an OpenCL driver installed (ships with
the normal GPU driver on Windows; no separate SDK needed).

## Linux container (vast.ai / RunPod, NVIDIA)

Rented GPU containers frequently have the NVIDIA driver but no OpenCL ICD
loader wired up. Fix that first:

```
apt-get update && apt-get install -y ocl-icd-libopencl1 clinfo
mkdir -p /etc/OpenCL/vendors && echo libnvidia-opencl.so.1 > /etc/OpenCL/vendors/nvidia.icd
clinfo   # should list the GPU; if it doesn't, the ICD path above is the fix
```

Then set up the worker:

```
cd hashcats-miner
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m worker.cli selftest
.venv/bin/python -m worker.cli bench --seconds 15
```

Same code path as Windows; only the venv activation differs.

## Commands

All commands live under `worker/cli.py` (`python -m worker.cli <command>`).
`--devices 0,1` (top-level flag, before the subcommand) restricts to specific
GPU indices; omit it to use every GPU OpenCL device found.

- `bench --seconds 15`: runs a random 116-byte template (nonce offset 20,
  width 32, required_bits 255 so it never actually hits) on every selected
  device in parallel, then prints per-device and total hashes/second.
- `selftest`: (a) `hash_batch` kernel output vs the pure-Python reference
  across template lengths 84/116/135, nonce offsets 0/20/52 and widths
  8/32 (including offset 52 width 8, which spans the counter across two
  64-bit lanes) on 2000 random counters each; (b) a live 20-bit search that
  must find and re-verify a real hit. Exits 0 only if everything passes.
- `solve --template <hex> --nonce-offset N --nonce-width W [--nonce-endian big|little] --bits B [--timeout S]`:
  runs the search and prints one JSON line with the solution, or
  `{"found":false,...}` on timeout. Exit code 0 if found, 2 on timeout.
- `hash --template <hex> --nonce-offset N --nonce-width W --nonce <hex>`:
  patches the given literal nonce into the template and prints keccak256 of
  the result computed both by the pure-Python reference and by the OpenCL
  kernel; they must match.

Every hit the engine reports (from `search`, `solve`, or `selftest`) is
re-verified against the pure-Python reference (`worker/ref_keccak.py`) before
being returned; a hit that fails verification is logged as a kernel bug and
never surfaces as a solution.

## Design notes (why it's fast)

The kernel (`worker/keccak_miner.cl`) never touches template bytes at
hash time. The host precomputes the 17 absorbed 64-bit lanes once per job
(template + keccak padding, with the nonce's low 8-byte counter region
zeroed) and a small "patch plan" (which lane(s) the counter lands in, a bit
shift, and masks). Each work item does lane arithmetic to drop its counter
in, then runs a fully unrolled Keccak-f[1600] (24 rounds, 25 named `ulong`
registers, no arrays, no loops, no modulo in the round function) and checks
only lane 0 via `clz` of the byte-swapped lane for the common case
(`required_bits <= 64`). Several nonces are processed per work item
(`per_item`, auto-tuned) so kernel-launch overhead amortizes, against a large
global work size with a persistent result buffer (only a small counter reset
is copied between dispatches, not a full buffer reallocation).

## Known limitations

- Benchmark numbers drop noticeably when another GPU-heavy process (a
  browser, a game, another miner) shares the same GPU. A dedicated GPU (a
  rented cloud box, or an otherwise idle desktop) measures meaningfully
  higher than a shared one.
- Multi-GPU `search`/`bench` run one Python thread per device; only tested
  end to end on a single local GPU.
- `required_bits > 64` uses a correctness-first fallback path (checks all
  four output lanes) that is not the optimized hot path; real HashCats
  targets have been well under 64 required bits historically.
