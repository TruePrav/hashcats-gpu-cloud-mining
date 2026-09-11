# AI setup guide

> Paste this to your AI assistant: "Read AI-SETUP-GUIDE.md in
> https://github.com/TruePrav/hashcats-gpu-cloud-mining and walk me through
> it step by step."

This file is written as a runbook for an AI assistant helping a human set up
and run this miner. If you are that assistant, follow the rules below before
anything else.

## Rules for the assistant

1. **Never ask the user to paste a private key or seed phrase into chat.**
   The user types keys into their own `.env` file themselves, in their own
   editor or terminal, never through you. If they paste one anyway, tell
   them to treat that key as compromised and move funds off it.
2. **Never run with `--send` until the user has seen a successful dry run
   and explicitly decides to go live.** Every command in this guide before
   the "Go live" step must omit `--send`.
3. **Recommend fresh wallets funded only with what they intend to spend**
   (mint price times the number of cats they're attempting, plus a gas
   buffer), not an existing wallet holding unrelated funds.
4. **Explain the GPU-rental ToS risk (see `docs/GPU-PROVIDERS.md`) before
   the user rents anything**, and let them decide.
5. **Never copy `.env` or any key material to a rented box.** Only
   `hashcats-miner/` (the untrusted worker code) goes to a rented box.
6. Verify each step actually worked before moving to the next one: this
   guide gives you a check for every step. Do not assume success.

## Steps

### 1. Prerequisites

- Node.js >= 20.12, `git`, an SSH client.
- Python 3.10+ only if the user wants to mine on a local GPU (not needed for
  a rented-box-only setup, since setup runs on the box itself).

Check: `node --version` (>= 20.12), `git --version`.

### 2. Clone and install

```
git clone https://github.com/TruePrav/hashcats-gpu-cloud-mining
cd hashcats-gpu-cloud-mining
npm install
```

Check: `npm install` exits 0 with no error.

### 3. Run the test suite

```
npx vitest run
```

Check: all tests pass. This exercises the preimage math, coordinator HTTP
surface, and wallet pool state machine against reproduced real on-chain
vectors, with no network access and no keys needed.

### 4. Read-only chain check

```
node mine-hashcats.mjs --status-only
```

Check: prints JSON with `mintPriceEth`, `derivedBits`, `arbBlockNumber`, etc.
No keys are read for this command. If it fails, the public RPC may be down;
try again or set `RPC_URL` in `.env` to an alternative.

### 5. Create wallets and fund them

The user needs at least one EVM wallet, funded on **Robinhood Chain (chain
id 4663)** with:
- enough native ETH to cover `mintPriceEth` (from step 4) per cat they want,
- plus a small gas buffer per attempt (a failed/reverted `mine()` costs gas
  only, refunding the mint value).

Recommend fresh wallets, not ones holding other funds. The user generates
these themselves (any standard EVM wallet tool works, this repo does not
include a wallet generator) and funds them by bridging or transferring ETH
to Robinhood Chain.

Check: the user confirms the wallet address(es) show a non-zero balance on
a Robinhood Chain block explorer before continuing.

### 6. Fill in `.env`

```
cp .env.example .env
```

The user opens `.env` in their own editor and fills in `PRIVATE_KEYS`
(comma-separated `0x...` keys, in the order they want wallets tried) and
optionally `RPC_URL`. You (the assistant) never see or handle the actual
key values.

Check: `node mine-hashcats.mjs --wallets 0` (see step 7) successfully prints
a wallet address without erroring: that confirms `.env` loaded and the key
parsed, without you ever needing to see it.

### 7. Dry-run the coordinator (no GPU needed yet)

```
node mine-hashcats.mjs --wallets 0
```

Without `--send` this only simulates found solutions; nothing is
broadcast. It prints the wallet table, starts polling the chain, and starts
a local HTTP server on `127.0.0.1:8787` printing a token. Leave it running;
open a new terminal for the next steps.

Check: it prints `coordinator listening on http://127.0.0.1:8787` and does
not exit with a FATAL error.

### 8. Local GPU (optional)

If the user has a GPU on the same machine:

```
cd hashcats-miner
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # Scripts\pip on Windows
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m worker.cli selftest
.venv/bin/python -m worker.remote --coordinator http://127.0.0.1:8787 --token <t>
```

On Windows, create the venv with `py -m venv .venv` and use
`.venv\Scripts\pip` / `.venv\Scripts\python` in place of the `.venv/bin/...`
paths above.

Check: `selftest` exits 0; `remote.py` prints "worker ... ready" and starts
logging job/rate lines.

### 9. Rent a cloud GPU (optional, or in addition to local)

Point the user at `docs/GPU-PROVIDERS.md` for where to rent and the terms of
service risk to be aware of first. The recommended starting point is
comparing RTX 5090 offers at https://getdeploying.com/gpus/nvidia-rtx-5090.
Once they have picked a provider and
have an SSH host/port:

```
cd hashcats-miner/deploy
./pack.sh          # or pack.ps1 on Windows: builds hashcats-miner.tgz
./box.sh <ssh-host> <ssh-port> <token> box1     # or box.ps1 on Windows
```

`box.sh`/`box.ps1` copies the tarball up, runs `setup-box.sh` once, then
holds a reverse SSH tunnel and the worker in a loop, restarting on drop.
If the provider logs in as a non-root user (often `ubuntu` on VM
providers), pass `--user ubuntu` to `box.sh` or `-User ubuntu` to `box.ps1`.

Check: before committing to paid hours, run the 30-second tunnel test in
`docs/GPU-PROVIDERS.md`. Once running, the coordinator terminal (step 7)
should start logging `[job ...]` lines and the worker should report a
hashrate.

### 10. Watch the fleet

```
node hashcats-dash.mjs --token <t>
```

Check: shows a live table of connected workers and combined hash rate.

### 11. Go live

Only after the user has confirmed a successful dry run and understands the
risk, re-run the coordinator with `--send`:

```
node mine-hashcats.mjs --wallets 0,1,2 --send
```

This broadcasts real transactions from the configured wallets. Confirm the
user explicitly wants this before you run or suggest running it.

### 12. Stop and cost control

- Stop the coordinator with Ctrl+C (writes a log to `logs/`).
- **Destroy rented GPU instances when done**: many providers keep billing
  while an instance is merely stopped, not destroyed. Tell the user to
  check their provider's billing page.

## Is it worth it?

Estimate expected time per cat with `2^bits / total_H/s` (read `bits` from
`npm run status`'s `derivedBits`, and hash rate from `hashcats-dash.mjs`).
Compare `(rental $/hr × expected hours) + gas` against the cat's expected
resale value, and remember mint price rises with each cat minted, so the
economics change as the run progresses, not just at the start. See
`docs/GPU-PROVIDERS.md` for a worked example.
