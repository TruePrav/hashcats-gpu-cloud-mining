// One-shot end-to-end broadcast test for the HashCats mint path.
// Sends a real mine() with a DELIBERATELY non-winning nonce from one wallet,
// expecting a BadSolution (or OneCatPerBlock) revert. This exercises the entire
// send path on-chain (fees, gas, nonce, chainId, encoding, broadcast, receipt,
// revert decoding) for ~1-2 cents of gas; the mint value is returned on revert.
// It signs the same way the coordinator does. Use a wallet the coordinator is
// NOT currently mining to avoid a nonce collision.
//
//   node hashcats-testmint.mjs --wallet 1
//
import { createPublicClient, http, defineChain, encodeFunctionData, formatEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HASHCATS_ABI, decodeRevert } from "./hashcats-lib.mjs";

const CONTRACT = "0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721";
const CHAIN_ID = 4663;
const FALLBACK_RPC = "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER = "https://robinhoodchain.blockscout.com/tx/";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const errText = (e) => String(e?.shortMessage ?? e?.message ?? e).slice(0, 300);

const WALLET_INDEX = arg("wallet");
if (WALLET_INDEX === undefined) { console.error("FATAL: --wallet <index> required (a zero-based index into PRIVATE_KEYS)"); process.exit(1); }

try { process.loadEnvFile(); } catch { /* no .env in this directory; env vars may still be set another way */ }

const PRIVATE_KEYS_RAW = process.env.PRIVATE_KEYS;
if (!PRIVATE_KEYS_RAW) { console.error("FATAL: PRIVATE_KEYS env var required (comma-separated 0x hex keys, put it in a .env file in this directory)"); process.exit(1); }
const PRIVATE_KEYS = PRIVATE_KEYS_RAW.split(",").map((x) => x.trim()).filter(Boolean);
const key = PRIVATE_KEYS[Number(WALLET_INDEX)];
if (!key) { console.error(`FATAL: --wallet index ${WALLET_INDEX} out of range (PRIVATE_KEYS has ${PRIVATE_KEYS.length} key(s))`); process.exit(1); }

let account;
try {
  account = privateKeyToAccount(key);
} catch (e) {
  console.error(`FATAL: invalid PRIVATE_KEYS entry at index ${WALLET_INDEX}: ${errText(e)}`);
  process.exit(1);
}

const rpc = arg("rpc") || process.env.RPC_URL || FALLBACK_RPC;
const chain = defineChain({ id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });
const read = (functionName, args = []) => pub.readContract({ address: CONTRACT, abi: HASHCATS_ABI, functionName, args });

const [price, anchorPair, target, bal, nonce, fees] = await Promise.all([
  read("mintPrice"),
  read("currentAnchor"),
  read("targetFor", [account.address]),
  pub.getBalance({ address: account.address }),
  pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
  pub.estimateFeesPerGas(),
]);
const [anchorBlock] = anchorPair;

// A deliberately non-winning nonce: 1. At 47-50 required bits this cannot satisfy
// work < target, so the contract must revert (BadSolution). We are proving the
// transport, not solving the puzzle.
const badNonce = 1n;
const data = encodeFunctionData({ abi: HASHCATS_ABI, functionName: "mine", args: [badNonce, anchorBlock] });

console.log("test mint (expects a revert):");
console.log("  wallet   ", `wallet-${WALLET_INDEX}`, account.address);
console.log("  balance  ", formatEther(bal), "ETH");
console.log("  price    ", formatEther(price), "ETH (returned on revert)");
console.log("  anchor   ", anchorBlock.toString());
console.log("  nonce    ", nonce, "  gas 200000  maxFee", formatEther(fees.maxFeePerGas ?? 0n), "ETH");

const request = {
  to: CONTRACT, data, value: price, gas: 200000n, nonce,
  maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  chainId: CHAIN_ID, type: "eip1559",
};

let hash;
try {
  const serializedTransaction = await account.signTransaction(request);
  hash = await pub.sendRawTransaction({ serializedTransaction });
} catch (e) {
  const d = decodeRevert(e);
  console.log("\nSEND REJECTED:", d?.text ?? errText(e));
  console.log("(the node rejected the tx before mining; path issue to fix)");
  process.exit(2);
}
console.log("\nbroadcast:", EXPLORER + hash);

const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
const balAfter = await pub.getBalance({ address: account.address });
const gasSpent = bal - balAfter;
console.log("receipt status:", receipt.status, " gasUsed:", receipt.gasUsed.toString());
console.log("net cost (gas only, value returned):", formatEther(gasSpent), "ETH");
if (receipt.status === "reverted") {
  console.log("\nRESULT: reverted on-chain as expected. The full broadcast path works:");
  console.log("  sign -> send -> mine -> revert -> value returned. A WINNING nonce will mint.");
} else {
  console.log("\nRESULT: status success (unexpected for nonce=1). tokenId may have minted; check the wallet.");
}
process.exit(0);
