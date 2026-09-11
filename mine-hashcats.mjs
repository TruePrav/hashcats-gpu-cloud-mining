// HashCats coordinator + submitter. Robinhood Chain 4663, contract
// 0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721. Protocol facts: docs/PROTOCOL.md.
//
// Rented GPU boxes run hashcats-miner/worker/remote.py against this coordinator's
// HTTP surface (created in hashcats-coordinator.mjs) over a reverse SSH tunnel.
// They receive only a job (miner address, template hex, nonce params, bits,
// deadline) and return a nonce + hash. They never see keys, wallet labels, RPC
// URLs, or API keys.
//
//   node mine-hashcats.mjs --help
//   node mine-hashcats.mjs --status-only
//   node mine-hashcats.mjs --wallets 0,1,2 [--send]
//
// Without --send, every solution is verified and SIMULATED (eth_call /
// estimateGas) from the wallet; nothing is broadcast.
//
// Wallets are a pool (hashcats-wallets.mjs), not a single pointer: the
// active wallet is the first idle one, jobs are only ever published for its
// address, and a solved job immediately hands the coordinator a fresh job
// for the NEXT idle wallet so workers keep hashing while the send/receipt
// for the current one is still in flight.
import { createPublicClient, http, defineChain, encodeFunctionData, formatEther, parseEventLogs, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HASHCATS_ABI, bitsFromTarget, buildTemplate, decodeRevert, NONCE_OFFSET, NONCE_WIDTH, searchBitsForTarget } from "./hashcats-lib.mjs";
import { createCoordinator } from "./hashcats-coordinator.mjs";
import { WalletPool } from "./hashcats-wallets.mjs";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const CONTRACT = "0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721";
const CHAIN_ID = 4663;
const FALLBACK_RPC = "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER = "https://robinhoodchain.blockscout.com/tx/";
const ARBSYS_ADDRESS = "0x0000000000000000000000000000000000000064";
const ARBSYS_ABI = [{ type: "function", name: "arbBlockNumber", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
const ANCHOR_MAX_AGE_BLOCKS = 120n; // ANCHOR_WINDOW is 250; refresh well inside it
const RECEIPT_TIMEOUT_MS = 20_000;

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes("--" + n);
const errText = (e) => String(e?.shortMessage ?? e?.message ?? e).slice(0, 200);

function printUsage() {
  console.log(`HashCats miner coordinator + submitter.

  node mine-hashcats.mjs --help
  node mine-hashcats.mjs --status-only
  node mine-hashcats.mjs --wallets 0,1,2 [options]

Requires a PRIVATE_KEYS env var (comma-separated 0x hex keys, put it in .env
in this directory) for anything other than --help / --status-only.

Options:
  --wallets 0,1,2       zero-based indices into PRIVATE_KEYS, one cat per wallet, used in order (default: all keys, in order)
  --max-cats N          stop after N mints (default: number of wallets)
  --max-price-wei W     refuse to publish a job while mintPrice() > W (default 50000000000000000 = 0.05 ETH)
  --port 8787           coordinator HTTP port (127.0.0.1 only)
  --token <secret>      shared secret workers send as x-hashcats-token (default: HASHCATS_TOKEN env, else random and printed)
  --rpc <url>           override the RPC endpoint (default: RPC_URL env, else the public fallback)
  --send                broadcast mine() calls; without it, everything is simulated only
  --gas-limit 200000    gas limit for mine()
  --poll-ms 700         chain poll interval
  --status-only         read-only: print prevWork/currentAnchor/targetFor/mintPrice/arbBlockNumber and exit
`);
}

if (has("help")) { printUsage(); process.exit(0); }

const PORT = Number(arg("port", "8787"));
const SEND = has("send");
const GAS_LIMIT = BigInt(arg("gas-limit", "200000"));
const POLL_MS = Math.max(200, Number(arg("poll-ms", "700")) || 700);
const MAX_PRICE_WEI = BigInt(arg("max-price-wei", "50000000000000000"));
const STATUS_ONLY = has("status-only");
const WALLETS_ARG = arg("wallets");

try { process.loadEnvFile(); } catch { /* no .env in this directory; env vars may still be set another way */ }

const TOKEN = arg("token", process.env.HASHCATS_TOKEN || randomBytes(16).toString("hex"));
const rpc = arg("rpc") || process.env.RPC_URL || FALLBACK_RPC;
const chain = defineChain({
  id: CHAIN_ID, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const pub = createPublicClient({ chain, transport: http(rpc) });
const read = (functionName, args = []) => pub.readContract({ address: CONTRACT, abi: HASHCATS_ABI, functionName, args });

async function readArbBlockNumber() {
  try {
    return await pub.readContract({ address: ARBSYS_ADDRESS, abi: ARBSYS_ABI, functionName: "arbBlockNumber" });
  } catch {
    return await pub.getBlockNumber();
  }
}

// ---------------------------------------------------------------- status-only

if (STATUS_ONLY) {
  const [prevWork, anchorPair, target, price, arbBlock] = await Promise.all([
    read("prevWork"),
    read("currentAnchor"),
    read("targetFor", ["0x0000000000000000000000000000000000000001"]),
    read("mintPrice"),
    readArbBlockNumber(),
  ]);
  const [anchorBlock, anchor] = anchorPair;
  const out = {
    chainId: CHAIN_ID,
    rpc: new URL(rpc).host,
    contract: CONTRACT,
    prevWork: prevWork.toString(),
    anchorBlock: anchorBlock.toString(),
    anchor,
    arbBlockNumber: arbBlock.toString(),
    "targetFor(0x...0001)": target.toString(),
    mintPriceWei: price.toString(),
    mintPriceEth: formatEther(price),
    derivedBits: bitsFromTarget(target),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------- logging

const T0 = performance.now();
const LOGBUF = [];
const LOG_PATH = `logs/hashcats-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const L = (event, data = {}) => { LOGBUF.push({ ms: +(performance.now() - T0).toFixed(1), at: new Date().toISOString(), event, ...data }); };
function flushLog() {
  try {
    mkdirSync("logs", { recursive: true });
    writeFileSync(LOG_PATH, JSON.stringify({ totalMs: +(performance.now() - T0).toFixed(1), events: LOGBUF }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } catch (e) {
    console.error("log write failed:", String(e).slice(0, 120));
  }
}
setInterval(flushLog, 60_000).unref?.();

// ---------------------------------------------------------------- keys + wallets

const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEYS;
if (!PRIVATE_KEYS_RAW) {
  console.error("FATAL: PRIVATE_KEYS env var required (comma-separated 0x hex keys, put it in a .env file in this directory). Use --status-only or --help if you don't need to sign anything.");
  process.exit(1);
}
const PRIVATE_KEYS = PRIVATE_KEYS_RAW.split(",").map((x) => x.trim()).filter(Boolean);
if (PRIVATE_KEYS.length === 0) {
  console.error("FATAL: PRIVATE_KEYS is set but empty.");
  process.exit(1);
}

let accountsByIndex;
try {
  accountsByIndex = PRIVATE_KEYS.map((k) => privateKeyToAccount(k));
} catch (e) {
  console.error(`FATAL: invalid entry in PRIVATE_KEYS: ${errText(e)}`);
  process.exit(1);
}

const indices = WALLETS_ARG
  ? WALLETS_ARG.split(",").map((x) => x.trim()).filter(Boolean).map(Number)
  : accountsByIndex.map((_, i) => i);

const keyByAddress = new Map();
const records = indices.map((i) => {
  const account = accountsByIndex[i];
  if (!Number.isInteger(i) || !account) {
    console.error(`FATAL: --wallets index '${i}' is out of range (PRIVATE_KEYS has ${PRIVATE_KEYS.length} key(s), valid indices 0-${PRIVATE_KEYS.length - 1})`);
    process.exit(1);
  }
  keyByAddress.set(account.address.toLowerCase(), PRIVATE_KEYS[i]);
  return { label: `wallet-${i}`, w: { id: `wallet-${i}`, address: account.address } };
});

const MAX_CATS = Math.max(1, Number(arg("max-cats", String(records.length))) || records.length);
const pool = new WalletPool(records);

const chainId = await pub.getChainId();
if (chainId !== CHAIN_ID) { console.error(`FATAL: RPC ${new URL(rpc).host} reports chain ${chainId}, expected ${CHAIN_ID}`); process.exit(1); }
const code = await pub.getBytecode({ address: CONTRACT });
if (!code || code === "0x") { console.error(`FATAL: no contract code at ${CONTRACT} on chain ${CHAIN_ID}`); process.exit(1); }

console.log(`wallets: ${records.map((r) => `${r.label}(${r.w.address})`).join(", ")}`);
console.log(`mode: ${SEND ? "SEND (will broadcast)" : "DRY-RUN (simulate only)"}  max-cats: ${MAX_CATS}  gas-limit: ${GAS_LIMIT}`);
console.log(`coordinator token: ${TOKEN}`);
console.log("note: difficulty includes a per-address streak (each recent mint from the same address roughly doubles that address's required difficulty, capped, and cools down over time). Fresh or idle addresses mine at the lowest difficulty available.");

// ---------------------------------------------------------------- balance gate

function requiredWei(price, fees) {
  const maxFee = fees?.maxFeePerGas ?? 0n;
  return price + GAS_LIMIT * maxFee;
}

// Balance-checks the given wallet entry; skips it (pool.skip) and logs a
// shortfall warning if it cannot cover price + gas. Returns true if usable.
async function checkAffordable(entry, price, fees) {
  const address = entry.record.w.address;
  const balance = await pub.getBalance({ address });
  const need = requiredWei(price, fees);
  if (balance < need) {
    const shortfall = need - balance;
    console.warn(`SKIP ${entry.record.label} (${address}): balance ${formatEther(balance)} ETH < required ${formatEther(need)} ETH (short ${formatEther(shortfall)} ETH)`);
    pool.skip(address, `insufficient balance (short ${formatEther(shortfall)} ETH)`);
    return false;
  }
  return true;
}

// Advances past any wallet that fails the balance gate; returns the first
// active entry that passes, or null if none do.
async function ensureActiveAffordable(price, fees) {
  let active = pool.active();
  while (active) {
    if (await checkAffordable(active, price, fees)) return active;
    active = pool.active();
  }
  return null;
}

const startupPrice = await read("mintPrice");
let cachedFees = {};
try { cachedFees = await pub.estimateFeesPerGas(); } catch (e) { console.warn("initial fee estimate failed:", errText(e)); }
await ensureActiveAffordable(startupPrice, cachedFees);

console.log("\nstartup wallet table:");
console.log("label            address                                     balance ETH   status");
for (const entry of pool.all()) {
  const balance = await pub.getBalance({ address: entry.record.w.address });
  console.log(`${entry.record.label.padEnd(16)} ${entry.record.w.address}  ${formatEther(balance).padEnd(12)} ${entry.status}`);
}
console.log("");

// ---------------------------------------------------------------- signer (hot path)

async function decodeTokenId(receipt) {
  try {
    const logs = parseEventLogs({ abi: HASHCATS_ABI, logs: receipt.logs, eventName: "Mined" });
    return logs[0]?.args?.tokenId?.toString() ?? null;
  } catch {
    return null;
  }
}

function maybeStop() {
  if (pool.isExhausted(MAX_CATS)) {
    console.log(`stopping: ${pool.minedCount()}/${MAX_CATS} cats mined, ${pool.remaining()} wallet(s) still usable.`);
    void shutdown(0);
  }
}

// Background receipt handling for a broadcast tx: never awaited by the
// coordinator's HTTP handler, so a solution response never waits on it.
function watchReceipt(record, hash) {
  void (async () => {
    try {
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      const entry = pool.byAddress(record.w.address);
      if (receipt.status === "success") {
        const tokenId = await decodeTokenId(receipt);
        pool.release(record.w.address, { mined: true });
        L("mined", { wallet: record.label, hash, tokenId });
        console.log(`MINTED tokenId=${tokenId ?? "?"} wallet=${record.label} ${EXPLORER}${hash}`);
      } else {
        pool.release(record.w.address, { mined: false });
        L("reverted", { wallet: record.label, hash });
        console.log(`[${record.label}] reverted on-chain ${hash}`);
      }
      if (entry) entry.nonce = await pub.getTransactionCount({ address: record.w.address, blockTag: "pending" }).catch(() => null);
      maybeStop();
    } catch (e) {
      pool.release(record.w.address, { mined: false });
      L("receipt_error", { wallet: record.label, hash, error: errText(e) });
      console.log(`[${record.label}] receipt error/timeout: ${errText(e)}`);
      maybeStop();
    }
  })();
}

async function signerMine({ nonce, anchorBlock, value, gasLimit, miner }) {
  const entry = pool.byAddress(miner);
  if (!entry) return { mined: false, error: `no wallet for miner ${miner}` };
  const record = entry.record;
  const account = privateKeyToAccount(keyByAddress.get(record.w.address.toLowerCase()));
  const args = [nonce, anchorBlock];

  if (!SEND) {
    // Dry run: latency does not matter here, so simulateContract is fine.
    try {
      await pub.simulateContract({ account: account.address, address: CONTRACT, abi: HASHCATS_ABI, functionName: "mine", args, value, gas: gasLimit });
      return { simulated: true, mined: false, wallet: record.label };
    } catch (e) {
      const decoded = decodeRevert(e);
      return { simulated: true, mined: false, wallet: record.label, error: decoded?.text ?? errText(e) };
    }
  }

  // Hot path: the ONLY network call between the solution arriving and
  // broadcast is the send itself. Nonce and fees are cached from the poll
  // loop / wallet-activation, and the request is built + signed locally
  // (no prepareTransactionRequest round trip).
  const t0 = performance.now();
  const nonceForTx = entry.nonce ?? await pub.getTransactionCount({ address: record.w.address, blockTag: "pending" });
  const fees = cachedFees?.maxFeePerGas ? cachedFees : await pub.estimateFeesPerGas();
  const request = {
    to: CONTRACT,
    data: encodeFunctionData({ abi: HASHCATS_ABI, functionName: "mine", args }),
    value,
    gas: gasLimit,
    nonce: nonceForTx,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    chainId: CHAIN_ID,
    type: "eip1559",
  };
  let hash;
  try {
    const serializedTransaction = await account.signTransaction(request);
    hash = await pub.sendRawTransaction({ serializedTransaction });
  } catch (e) {
    const decoded = decodeRevert(e);
    pool.release(record.w.address, { mined: false });
    L("send_error", { wallet: record.label, error: decoded?.text ?? errText(e) });
    return { mined: false, wallet: record.label, error: decoded?.text ?? errText(e) };
  }
  const msToBroadcast = +(performance.now() - t0).toFixed(1);
  L("ms_to_broadcast", { wallet: record.label, hash, ms: msToBroadcast });
  console.log(`[${record.label}] broadcast ${hash} in ${msToBroadcast}ms`);
  watchReceipt(record, hash);
  return { mined: false, broadcast: true, hash, wallet: record.label, address: record.w.address };
}

// ---------------------------------------------------------------- coordinator + poll loop

function onEvent(evt) {
  L(evt.type, evt);
  if (evt.type === "job") {
    console.log(`[job ${evt.job.id}] miner=${evt.job.miner} bits=${evt.job.bits} price=${formatEther(BigInt(evt.job.price_wei))} ETH anchor=${evt.job.anchor_block}`);
  } else if (evt.type === "solution") {
    console.log(`[job ${evt.job_id}] solution from ${evt.worker} work=${evt.work}`);
  } else if (evt.type === "stale") {
    console.log(`[job ${evt.job_id}] STALE solution from ${evt.worker} (current job ${evt.current_job_id})`);
  } else if (evt.type === "rejected") {
    console.log(`[job ${evt.job_id}] rejected solution from ${evt.worker}: ${evt.reason}`);
  } else if (evt.type === "mine_result") {
    console.log(`[job ${evt.job_id}] ${evt.worker}: ${JSON.stringify(evt.result, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  } else if (evt.type === "mine_error") {
    console.log(`[job ${evt.job_id}] mine error from ${evt.worker}: ${evt.error}`);
  } else if (evt.type === "job_cleared") {
    console.log("job cleared (price cap or no idle wallet)");
  } else if (evt.type === "next_job_error") {
    console.log(`[job ${evt.job_id}] failed to build next job: ${evt.error}`);
  }
}

// Builds job fields for `entry`'s wallet from the LAST polled chain state
// (prevWork/anchor/price), refreshing only targetFor(address), the one
// field that is per-wallet, so the auto-republish after a claim stays fast.
async function buildJobForEntry(entry) {
  if (!lastState) return null;
  const address = entry.record.w.address;
  const target = await read("targetFor", [address]);
  const template = buildTemplate(address, lastState.prevWork, lastState.anchor);
  return {
    miner: address,
    template_hex: toHex(template),
    nonce_offset: NONCE_OFFSET,
    nonce_width: NONCE_WIDTH,
    nonce_endian: "big",
    bits: searchBitsForTarget(target),
    target_hex: toHex(target),
    prev_work_hex: toHex(lastState.prevWork),
    anchor_block: lastState.anchorBlock.toString(),
    anchor_hex: lastState.anchor,
    price_wei: lastState.price.toString(),
    issued_ms: Date.now(),
    expires_ms: Date.now() + 25_000,
  };
}

const coordinator = createCoordinator({ token: TOKEN, signer: { mine: signerMine }, gasLimit: GAS_LIMIT, onEvent, pool, buildJob: buildJobForEntry });

let lastState = null; // { prevWork, target, price, miner, anchor, anchorBlock }
let lastActiveAddress = null;
let priceCapped = false;
let pollTimer = null;

async function pollOnce() {
  const active = pool.active();
  if (!active) { maybeStop(); return; }
  const address = active.record.w.address;
  try {
    const [prevWork, anchorPair, target, price, arbBlock, fees] = await Promise.all([
      read("prevWork"),
      read("currentAnchor"),
      read("targetFor", [address]),
      read("mintPrice"),
      readArbBlockNumber(),
      pub.estimateFeesPerGas().catch(() => cachedFees), // cache every poll, fall back to last good value
    ]);
    if (fees?.maxFeePerGas) cachedFees = fees;
    const [anchorBlock, anchor] = anchorPair;

    if (price > MAX_PRICE_WEI) {
      if (!priceCapped) {
        console.warn(`mintPrice ${formatEther(price)} ETH exceeds --max-price-wei cap (${formatEther(MAX_PRICE_WEI)} ETH); clearing job, workers idle until it drops.`);
        priceCapped = true;
        lastState = null;
        coordinator.clearJob();
      }
      return;
    }
    if (priceCapped) { priceCapped = false; } // price back under cap: fall through and republish below

    // Wallet just became active (fresh or after a release): re-check its
    // balance and cache a fresh nonce before it can ever be used.
    if (address !== lastActiveAddress) {
      const usable = await checkAffordable(active, price, cachedFees);
      if (!usable) { lastState = null; return; } // pollOnce again next tick with the new active wallet
      active.nonce = await pub.getTransactionCount({ address, blockTag: "pending" });
      lastActiveAddress = address;
    }

    const anchorAge = arbBlock - anchorBlock;
    const changed = !lastState
      || lastState.prevWork !== prevWork
      || lastState.target !== target
      || lastState.price !== price
      || lastState.miner !== address
      || anchorAge > ANCHOR_MAX_AGE_BLOCKS;
    lastState = { prevWork, target, price, miner: address, anchor, anchorBlock };
    if (!changed) return;
    const template = buildTemplate(address, prevWork, anchor);
    coordinator.publishJob({
      miner: address,
      template_hex: toHex(template),
      nonce_offset: NONCE_OFFSET,
      nonce_width: NONCE_WIDTH,
      nonce_endian: "big",
      bits: searchBitsForTarget(target),
      target_hex: toHex(target),
      prev_work_hex: toHex(prevWork),
      anchor_block: anchorBlock.toString(),
      anchor_hex: anchor,
      price_wei: price.toString(),
      issued_ms: Date.now(),
      expires_ms: Date.now() + 25_000,
    });
  } catch (e) {
    console.error("poll error:", errText(e));
  }
}

async function shutdown(code) {
  if (state.stopping) return;
  state.stopping = true;
  if (pollTimer) clearInterval(pollTimer);
  flushLog();
  await coordinator.close();
  console.log(`log written: ${LOG_PATH}`);
  process.exit(code);
}

const state = { stopping: false };

process.on("SIGINT", () => { console.log("\nSIGINT received, shutting down..."); void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });

await coordinator.listen(PORT, "127.0.0.1");
console.log(`coordinator listening on http://127.0.0.1:${PORT} (workers must send x-hashcats-token: ${TOKEN})`);
await pollOnce();
pollTimer = setInterval(pollOnce, POLL_MS);
