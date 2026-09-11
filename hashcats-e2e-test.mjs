// End-to-end test of the ONE link the other tests never exercised: a REAL
// worker finding a hit on a real GPU and POSTing it to a live coordinator,
// which then verifies it and calls the signer with the right arguments.
//
// Everything else is already proven: the kernel matches the reference hash
// (unit tests), the coordinator accepts a posted solution and calls the signer
// with exact args (unit test with vector data), and the broadcast path works
// on-chain (hashcats-testmint.mjs). At the live 49-bit difficulty a worker
// never finds a hit quickly enough to observe the join between those pieces.
//
// This spins a THROWAWAY coordinator on port 8788 with an artificially low
// difficulty (24 bits, solved in milliseconds) and a MOCK signer. Nothing is
// signed, nothing is broadcast, no keys are loaded, and the real coordinator on
// 8787 is untouched.
//
//   node hashcats-e2e-test.mjs
//
import { spawn } from "node:child_process";
import { bytesToHex, toHex } from "viem";
import { createCoordinator } from "./hashcats-coordinator.mjs";
import { buildTemplate } from "./hashcats-lib.mjs";

const PORT = 8788;
const TOKEN = "e2e-test-token";
const BITS = 24;
const TARGET = 1n << BigInt(256 - BITS); // work < 2^232 == at least 24 leading zero bits
const TIMEOUT_MS = 90_000;

// Structurally identical to a real job, with an obviously synthetic address.
const MINER = "0x00000000000000000000000000000000000000e2";
const PREV_WORK = 0x00000000000012345678deadbeefcafe1234567890abcdef1234567890abcdefn;
const ANCHOR = "0x" + "ab".repeat(32);
const PRICE_WEI = "20320000000000000";
const ANCHOR_BLOCK = "60592018";

const signerCalls = [];
const signer = {
  async mine(args) {
    signerCalls.push(args);
    return { mined: false, mock: true, note: "MOCK signer: nothing signed or broadcast" };
  },
};

const seen = [];
const coord = createCoordinator({
  token: TOKEN,
  signer,
  onEvent: (e) => {
    seen.push(e.type);
    if (e.type === "solution") console.log(`  [coordinator] solution accepted from ${e.worker}, work=${e.work}`);
    else if (e.type === "rejected") console.log(`  [coordinator] REJECTED from ${e.worker}: ${e.reason}`);
    else if (e.type === "stale") console.log(`  [coordinator] stale post from ${e.worker}`);
  },
});

await coord.listen(PORT);
const template = buildTemplate(MINER, PREV_WORK, ANCHOR);
const job = coord.publishJob({
  miner: MINER,
  template_hex: bytesToHex(template),
  target_hex: toHex(TARGET),
  bits: BITS,
  nonce_offset: 20,
  nonce_width: 32,
  nonce_endian: "big",
  price_wei: PRICE_WEI,
  anchor_block: ANCHOR_BLOCK,
});
console.log(`coordinator up on 127.0.0.1:${PORT}, job #${job.id} published at ${BITS} bits (mock signer)`);
console.log("starting a real worker on the local GPU...\n");

const pythonPath = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
const worker = spawn(
  pythonPath,
  ["-m", "worker.remote", "--coordinator", `http://127.0.0.1:${PORT}`, "--token", TOKEN, "--worker-name", "e2e-local"],
  { cwd: "hashcats-miner", stdio: ["ignore", "pipe", "pipe"] },
);
worker.stdout.on("data", (b) => process.stdout.write("  [worker] " + b.toString()));
worker.stderr.on("data", (b) => {
  const s = b.toString();
  if (!/CompilerWarning|lambda:|warn/i.test(s)) process.stdout.write("  [worker:err] " + s);
});

const started = Date.now();
const done = await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (signerCalls.length > 0) { clearInterval(timer); resolve(true); }
    else if (Date.now() - started > TIMEOUT_MS) { clearInterval(timer); resolve(false); }
  }, 200);
});

worker.kill();
await coord.close();

console.log("");
if (!done) {
  console.log(`FAIL: no solution reached the signer within ${TIMEOUT_MS / 1000}s.`);
  console.log("events seen:", seen.join(",") || "(none)");
  process.exit(1);
}

const call = signerCalls[0];
const checks = [
  ["signer called exactly once", signerCalls.length === 1],
  ["nonce is a bigint", typeof call.nonce === "bigint"],
  ["anchorBlock matches the job", call.anchorBlock === BigInt(ANCHOR_BLOCK)],
  ["value equals the job price", call.value === BigInt(PRICE_WEI)],
  ["miner matches the job", String(call.miner).toLowerCase() === MINER.toLowerCase()],
  ["gasLimit passed through", typeof call.gasLimit === "bigint"],
  ["coordinator emitted a solution event", seen.includes("solution")],
  ["no rejection events", !seen.includes("rejected")],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
console.log(`\nsolved in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`signer received: nonce=0x${call.nonce.toString(16)} anchorBlock=${call.anchorBlock} value=${call.value} miner=${call.miner}`);
console.log(ok
  ? "\nRESULT: the full chain works. A real GPU hit travelled worker -> POST -> verify -> signer\nwith the exact arguments a live mint needs. Nothing was signed or broadcast."
  : "\nRESULT: the chain completed but an argument was wrong. See the FAIL lines above.");
process.exit(ok ? 0 : 1);
