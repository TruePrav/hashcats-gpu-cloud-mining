# HashCats protocol facts

Sanitized recon of the on-chain proof-of-work mechanics this miner targets.
Everything below is cited to an on-chain call (`eth_call`, `eth_getLogs`,
`eth_getBlockByNumber`) or a public block explorer, not to the project's own
site copy. For the human-facing explanation, see https://hashcats.fun. No
transaction is required to read any of this: every call listed is a free,
zero-gas read.

## Contract

- Name/symbol: `Hashcats` / `HCAT`.
- Chain: Robinhood Chain, chain id `4663`, an Arbitrum-Orbit-style L2 with an
  approximately 100ms block time.
- Contract: `0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721`.
- The contract's source is not verified on the public explorer. The facts
  below come from the ABI (`presets/hashcats.abi.json`), cross-checked
  against the deployed bytecode's function-selector dispatch table, and
  validated against real mint transactions decoded from `Mined` event logs
  (see `presets/hashcats.vectors.json` for reproduced examples).

## Submit function

```
function mine(uint256 nonce, uint256 anchorBlock) external payable returns (uint256 tokenId)
```

- `msg.value` must equal `mintPrice()` read immediately before the call;
  read it fresh each time, since it moves with every mint.
- `nonce`: the 256-bit value a miner searches over. Not otherwise
  range-checked.
- `anchorBlock`: an L2 block number. The contract re-derives
  `anchor = blockhash(anchorBlock)` (or the Arbitrum `ArbSys` equivalent)
  internally; you never pass the hash itself, only the number.
- Reverts relevant to submission: `BadSolution` (hash does not beat the
  target), `WrongPayment` (`msg.value != mintPrice()`), `OneCatPerBlock`
  (another mint already landed in the same L2 block, globally, not just for
  your address).

## Preimage (116 bytes, `abi.encodePacked`, big-endian, no padding)

| Offset | Length | Field | Notes |
|---|---|---|---|
| 0 | 20 | `miner` | the `mine()` caller's address |
| 20 | 32 | `nonce` | the value a GPU kernel iterates |
| 52 | 32 | `prevWork` | the contract's current `prevWork()` at call time |
| 84 | 32 | `anchor` | raw block hash of L2 block `anchorBlock` |

```
work = uint256(keccak256(abi.encodePacked(miner, nonce, prevWork, anchor)))
```

Success condition: `work < targetFor(miner)`.

## Job-building view calls

All are free reads, safe to call as often as needed:

| Need | Function | Returns |
|---|---|---|
| Fresh anchor pair | `currentAnchor()` | `(uint256 anchorBlock, bytes32 anchor)` |
| Previous mint's work | `prevWork()` | `uint256` |
| Your required threshold | `targetFor(address miner)` | `uint256 target` |
| Current mint price | `mintPrice()` | `uint256` wei |
| Verify a candidate off-chain | `workHash(address,uint256,uint256,bytes32)` | `uint256`, pure |
| Anchor validity window | `ANCHOR_WINDOW()` | `uint256` = 250 L2 blocks (~25s) |

Minimal correct sequence: read `anchorBlock, anchor` and `prevWork` and
`target`, search a `nonce` such that
`keccak256(abi.encodePacked(miner, nonce, prevWork, anchor)) < target`, read
`mintPrice()` fresh, then call `mine(nonce, anchorBlock)` with
`value = price` immediately: all four inputs can go stale the moment
another miner's transaction lands.

## Difficulty and streak

"Leading zero bits" is the friendlier framing you will see on the site, but
the contract compares `work < target` exactly, and `target` is not always an
exact power of two (the network retarget scales it). Expected hashes per
solution is about `2^256 / target`, and each extra required bit roughly
doubles it. The coordinator hands workers the loosest leading-zero-bit count
that cannot miss a valid solution (`searchBitsForTarget` in
`hashcats-lib.mjs`) and re-checks the exact `work < target` before signing;
using the stricter bit count instead would throw away up to half of all
valid solutions.
Required bits come from an epoch floor, plus a streak that roughly doubles
per recent mint from the *same address* (capped) and decays over time. This
means:

- A single wallet mining several cats in a row gets progressively harder for
  that address specifically; a fresh or idle address always starts at the
  network floor.
- The network also retargets periodically toward a target time per cat.
- One cat can land per L2 block, globally (not per address): a hard
  ceiling on total mint throughput regardless of fleet size.

## Rarity is not grindable

The renderer derives a token's traits only from `(workHash, a several-minute
time bucket)`. Nothing about the *search* (which nonce you try, how many
attempts) influences rarity: only whether you win the L2 block and which
timestamp bucket you land in, neither of which a miner controls precisely
enough to target a specific outcome.

## Timing / anchor rules

- An anchor is valid for `ANCHOR_WINDOW` (250) L2 blocks, about 25 seconds
  at a 100ms block time. Re-fetch `currentAnchor()`/`prevWork()` well before
  that window closes.
- `prevWork` changes the instant *any* miner's cat lands, yours or a
  competitor's, invalidating every nonce anyone else was searching for.
- A solved `(nonce, prevWork, anchor)` combination is bound to the specific
  address that solved it: it will not satisfy the target for a different
  address, even with the same nonce.

## Further reading

The full site docs (economics, mint price formula, art/rarity mechanics
beyond what mining needs) live at https://hashcats.fun: read those directly
rather than relying on a copy pasted here.
