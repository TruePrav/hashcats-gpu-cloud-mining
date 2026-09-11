# Where to rent a GPU

Facts below were checked 2026-09-11 and are a snapshot, not a live price
feed. GPU rental prices move; re-check before committing to hours of rental.

## Start with a price comparison

https://getdeploying.com/gpus/nvidia-rtx-5090 is a price-comparison
aggregator (not a provider itself) listing RTX 5090 offers across Vast.ai,
RunPod, Salad, Novita, Theta EdgeCloud, and others. It showed a median
on-demand price around $0.68/hr on 2026-09-11. Compare there first, then
rent directly from whichever provider you pick: the aggregator does not
host anything itself.

**Recommended pick: an RTX 5090.** It is the fastest single card in the
`hashcat` reference numbers below (~6.4 GH/s) and rents for around the
median price, so it usually gives the most hashes per dollar. That ranking
comes from hashcat's keccak benchmark, not a 5090 run of this kernel, so
check the worker's `bench` output on your first box.

Other GPUs (4090, 3090, A6000, etc.) work fine too; rank candidates by
GH/s-per-dollar for this specific workload (keccak256 hashing is compute-
bound, not memory-bound, so raw hash-rate benchmarks matter more than VRAM).

## What a box needs

- Plain SSH access: a host, a port, and either root or sudo.
- `apt-get` (an Ubuntu or Debian-based image).
- SSH remote port forwarding support (`ssh -R`) from your machine to the box
  (this is what tunnels the coordinator's HTTP port to the rented GPU).
- Container or VM instances both work.

## Providers seen

- **Vast.ai** (https://vast.ai): container instances, root access. Offers
  Proxy SSH and Direct SSH, see
  https://docs.vast.ai/documentation/instances/connect/ssh. Prefer Direct
  SSH for the reverse tunnel this miner needs; test `-R` with the 30-second
  check below before committing to a longer rental.
- **RunPod** (https://runpod.io): pods run as root. "Basic SSH" goes through
  the `ssh.runpod.io` proxy and has no SCP/SFTP, so use "Full SSH" over an
  exposed TCP port (public IP + port) instead, see
  https://docs.runpod.io/pods/configuration/use-ssh and
  https://docs.runpod.io/pods/configuration/expose-ports. Community Cloud
  instance IPs can change on restart.
- **TensorDock** (https://www.tensordock.com), **CloudRift**
  (https://www.cloudrift.ai/rtx5090, listed around $0.65/hr on-demand for a
  5090 as of 2026-09-11), **Hyperstack** (VMs, https://www.hyperstack.cloud):
  seen in the aggregator listing; details beyond pricing not independently
  verified here. VM-style providers often log in as `ubuntu` with sudo
  rather than `root`; both deploy scripts accept a non-default user.
- Other names that showed up on the aggregator with a 5090 listing as of
  2026-09-11, price per GPU-hour, not independently verified beyond the
  listing: **Nova Cloud** ~$0.54, **GPUhub** ~$0.46, **HyperAI** ~$0.35,
  **EmpirioLabs AI** ~$1.10-1.26. Per-GPU price does not by itself tell you
  whether a given provider has an instance size in stock right now; check
  the provider's own page before paying. A bare-metal option with no hourly
  billing, **LeaderGPU** (https://www.leadergpu.com), takes daily/weekly
  bookings with next-business-day provisioning instead of instant start.
- **Do not use Salad** for this. Salad's consumer product runs *other
  people's* jobs on *your* GPU, the opposite direction from what this
  miner needs (renting someone else's GPU for your own job).

## Sizing: several small boxes beat hunting for one big one

You do not need an 8-GPU chassis to run 8 GPUs' worth of hashing. Each
worker process picks its own random 32-bit session id and mixes it with its
device index into the part of the nonce it searches (see "How the search
space works" in `hashcats-miner/README.md`), so two workers never overlap
their search space whether they are two GPUs in the same box or two
completely separate rented instances. Running `deploy/box.sh` /
`deploy/box.ps1` once per rented box (each with its own `-Name`/name, all
pointed at the same coordinator token and port) gives the same combined
hash rate as one box with that many GPUs.

This matters because multi-GPU chassis (8x, even 4x) are a much smaller,
more volatile slice of on-demand inventory than single-GPU instances of the
same card, and often cost more per GPU-hour than the same card rented
1-at-a-time. Unless your workload genuinely needs GPUs to share memory or
PCIe (this one does not: keccak256 hashing is fully independent per
device), price and shop by single-GPU $/hr, not by chassis size.

## Terms of service: read them before renting

PoW hashing for an NFT mint may count as "cryptocurrency mining" under a
provider's terms of service, even though the actual product here is an NFT,
not a coin. Vast.ai's terms (https://vast.ai/terms) ban crypto mining on
credits purchased with a credit card (crypto-funded credits are treated
differently). No explicit mining clause was found in RunPod's terms at the
time of writing; other providers were not checked. Read your chosen
provider's current terms yourself before renting: this list is not legal
advice and terms change.

## A 30-second tunnel test before paying for hours

From your own machine:

```
ssh -R 8787:127.0.0.1:8787 -p <ssh-port> <user>@<ssh-host>
```

Then, on the rented box, in the same session:

```
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/status
```

Expect `401` (the tunnel works and reached a coordinator that is up but
rejected the missing token) rather than "connection refused" (the tunnel, or
the coordinator, is not actually up). If nothing is listening locally yet,
start `mine-hashcats.mjs` first so there is something on the other end.

## Throughput and cost

Measured keccak256 kernel speeds with this codebase (your numbers will vary
by exact GPU and driver):

| GPU | Speed |
|---|---|
| RTX 3070 | 1.17 GH/s |
| RTX A6000 | ~2.05 GH/s each (~16.4 GH/s on an 8-GPU box) |

For reference only (`hashcat -m 17800`, a different implementation, not this
kernel): RTX 5090 ~6.4 GH/s, RTX 4090 ~5.1 GH/s, RTX 3090 ~2.2 GH/s.
Multiple GPUs and multiple boxes scale roughly linearly (each searches a
disjoint nonce range).

**Expected time per cat** = `2^bits / total_H/s`, where `bits` is the
current required difficulty. Read it live with `npm run status` (the
`derivedBits` field). Worked example: at 48 required bits and a combined
fleet rate of 2 GH/s, expected time is `2^48 / 2e9 ≈ 140,000 seconds ≈ 39
hours` per cat. Difficulty and price both move over time, so treat this as
an order-of-magnitude estimate, not a promise.

A rough GPU-cost-per-cat figure of $35-50 (2026-09-11 snapshot, at the
difficulty and rental prices seen that day) was estimated;
recompute it yourself from current `$/hr` and current `bits` before relying
on it: it does not adjust automatically and difficulty moves with network
activity.
