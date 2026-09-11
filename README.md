# HashCats GPU cloud mining

A standalone GPU proof-of-work miner for HashCats (https://hashcats.fun), a
keccak256 mining NFT on Robinhood Chain (chain id 4663). Coordinates one or
more rented (or local) GPUs to search for a winning nonce, then signs and
submits the on-chain `mine()` call from wallets you control.

This is not affiliated with the HashCats project. Not financial advice. Use
at your own risk: this is unaudited software that signs and broadcasts real
transactions when you pass `--send`. See `AI-SETUP-GUIDE.md` if you want an
AI assistant to walk you through setup.

## What it is

- A **coordinator** (`mine-hashcats.mjs`), run on your own machine, that
  reads chain state, hands out hashing jobs over a small local HTTP server,
  verifies solutions, and signs/broadcasts the winning `mine()` transaction.
- One or more **workers** (`hashcats-miner/worker/remote.py`), an OpenCL
  keccak256 kernel that can run locally or on a rented GPU box. Workers never
  see a private key, wallet label, RPC URL, or API key: they receive an
  opaque hashing job and return a nonce.

## Architecture

```
                 ssh -R 8787:127.0.0.1:8787
  [rented GPU box] ------tunnel------------>  [your machine]
  worker/remote.py                            mine-hashcats.mjs
  (hashes only, no keys)                      - polls Robinhood Chain
       |                                      - runs the coordinator HTTP
       | POST /solution                         server (127.0.0.1 only)
       v                                      - verifies + signs + sends
  hashcats-coordinator.mjs  <-- HTTP -->      (holds PRIVATE_KEYS from .env)
```

A local GPU runs the same worker directly against `127.0.0.1`, no tunnel
needed. Multiple boxes/workers can point at the same coordinator; jobs
rotate across a pool of wallets, one cat per wallet.

## Safety model

- The coordinator binds `127.0.0.1` only; nothing is reachable from outside
  your machine unless you deliberately expose it.
- A shared token (`--token` / `HASHCATS_TOKEN`) gates every worker request.
- Nothing is broadcast without `--send`. Without it, every found solution is
  simulated (`eth_call`/`estimateGas`) only.
- Private keys live in your own `.env` (`PRIVATE_KEYS`), read once at
  startup, and are never logged or sent to a worker.
- A rented GPU box only ever runs `worker/remote.py`, which has no key-
  loading code path at all.

## Quickstart

```
git clone https://github.com/TruePrav/hashcats-gpu-cloud-mining
cd hashcats-gpu-cloud-mining
npm install
npx vitest run
cp .env.example .env      # fill in RPC_URL / PRIVATE_KEYS yourself
node mine-hashcats.mjs --status-only     # read-only, no keys needed
node mine-hashcats.mjs --wallets 0       # dry run (no --send): simulates only
```

To rent GPUs, start by comparing RTX 5090 offers at
https://getdeploying.com/gpus/nvidia-rtx-5090, then read
`docs/GPU-PROVIDERS.md` (including the terms-of-service section) before you
pay for anything.

See `AI-SETUP-GUIDE.md` for the full step-by-step walkthrough (wallets,
funding, renting a GPU, going live), `docs/PROTOCOL.md` for the on-chain
mechanics this miner targets, `docs/GPU-PROVIDERS.md` for where to rent a
GPU and the ToS caveats, and `docs/TROUBLESHOOTING.md` for common failure
modes.

## Repository layout

```
mine-hashcats.mjs          coordinator: chain poller, HTTP job server, signer
hashcats-coordinator.mjs   the HTTP job/solution server (no chain, no keys)
hashcats-lib.mjs           pure preimage/target/verification math
hashcats-wallets.mjs       in-memory wallet pool state machine
hashcats-dash.mjs          read-only fleet dashboard (polls /status)
hashcats-e2e-test.mjs      local end-to-end test with a mock signer + throwaway difficulty
hashcats-testmint.mjs      one-shot real broadcast test (deliberately non-winning nonce)
presets/                   contract ABI + reproduced golden test vectors
test/                      vitest unit tests
hashcats-miner/            the OpenCL GPU worker (Python), deploy scripts
docs/                      protocol reference, GPU rental guide, troubleshooting
```

## Disclaimer

Not financial advice. Not affiliated with HashCats. This software is
provided as-is, unaudited, with no warranty (see `LICENSE`). You are
responsible for any funds, gas, and GPU rental costs you spend using it, and
for complying with your GPU provider's terms of service.
