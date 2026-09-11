// Pure helpers for the HashCats proof-of-work protocol (Robinhood Chain 4663,
// contract 0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721). No network I/O, no
// key access, no chain calls. Protocol facts: docs/PROTOCOL.md.
//
// Preimage (116 bytes, abi.encodePacked, big-endian):
//   miner(20) || nonce(32) || prevWork(32) || anchor(32)
//   work = uint256(keccak256(preimage)); success iff work < target
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, decodeErrorResult, encodePacked, getAddress, hexToBytes, keccak256, pad, toHex } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HASHCATS_ABI = JSON.parse(readFileSync(join(HERE, "presets", "hashcats.abi.json"), "utf8"));
const ABI_ERRORS = HASHCATS_ABI.filter((e) => e.type === "error");

export const NONCE_OFFSET = 20;
export const NONCE_WIDTH = 32;
export const PREIMAGE_LENGTH = 116;

function normalizeHex(value) {
  const s = typeof value === "string" ? value : bytesToHex(value);
  return s.startsWith("0x") ? s : `0x${s}`;
}

function bitLength(n) {
  if (n <= 0n) return 0;
  return n.toString(2).length;
}

// Smallest leading-zero-bit count N such that ANY hash with N leading zero
// bits is guaranteed < target (i.e. 2^(256-N) <= target). Exact for a
// power-of-two target; conservative (may overshoot by up to a bit) otherwise.
export function bitsFromTarget(targetBigInt) {
  const target = BigInt(targetBigInt);
  if (target <= 0n) return 256;
  const bits = 257 - bitLength(target);
  return Math.max(0, Math.min(256, bits));
}

// Leading-zero-bit count to hand a GPU worker as its SEARCH hint. This is the
// floor, not the ceiling: every hash with N leading zero bits satisfies
// work < 2^(256-N), which is the smallest power of two at or ABOVE target, so
// no valid solution is ever missed. The few candidates that land in
// [target, 2^(256-N)) are rejected by verifySolution's exact work < target
// check on the host before anything is signed.
//
// Using bitsFromTarget (the ceiling) here silently discarded up to half of all
// valid solutions: for a real target with bit length 209, the
// ceiling demanded work < 2^208 while the contract accepted work < ~2^209,
// halving effective hashrate across the whole fleet.
export function searchBitsForTarget(targetBigInt) {
  const target = BigInt(targetBigInt);
  if (target <= 0n) return 256;
  const bits = 256 - bitLength(target);
  return Math.max(0, Math.min(256, bits));
}

// 116-byte template with the nonce field zeroed.
export function buildTemplate(miner, prevWork, anchor) {
  const minerBytes = hexToBytes(getAddress(miner));
  const prevBytes = hexToBytes(toHex(BigInt(prevWork), { size: 32 }));
  const anchorBytes = hexToBytes(pad(normalizeHex(anchor), { size: 32 }));
  const template = new Uint8Array(PREIMAGE_LENGTH);
  template.set(minerBytes, 0);
  // bytes [NONCE_OFFSET, NONCE_OFFSET + NONCE_WIDTH) stay zero: the nonce field.
  template.set(prevBytes, NONCE_OFFSET + NONCE_WIDTH);
  template.set(anchorBytes, NONCE_OFFSET + NONCE_WIDTH + 32);
  return template;
}

// work = uint256(keccak256(abi.encodePacked(miner, nonce, prevWork, anchor)))
export function workOf(miner, nonce, prevWork, anchor) {
  const packed = encodePacked(
    ["address", "uint256", "uint256", "bytes32"],
    [getAddress(miner), BigInt(nonce), BigInt(prevWork), pad(normalizeHex(anchor), { size: 32 })],
  );
  return BigInt(keccak256(packed));
}

// Patches nonceHex into job.template_hex at job.nonce_offset/nonce_width, hashes
// the result, and checks it against job.target_hex. Does not trust or require a
// caller-supplied hash; recomputes from scratch. job = {template_hex, nonce_offset,
// nonce_width, target_hex} (nonce_offset/nonce_width default to the protocol
// constants above when omitted).
export function verifySolution(job, nonceHex) {
  try {
    if (!job || typeof job.template_hex !== "string" || typeof job.target_hex === "undefined") {
      return { ok: false, work: null, hashHex: null, reason: "job missing template_hex/target_hex" };
    }
    const offset = job.nonce_offset ?? NONCE_OFFSET;
    const width = job.nonce_width ?? NONCE_WIDTH;
    const nonceBytes = hexToBytes(normalizeHex(nonceHex));
    if (nonceBytes.length !== width) {
      return { ok: false, work: null, hashHex: null, reason: `nonce must be ${width} bytes, got ${nonceBytes.length}` };
    }
    const templateBytes = hexToBytes(normalizeHex(job.template_hex));
    if (offset + width > templateBytes.length) {
      return { ok: false, work: null, hashHex: null, reason: "nonce field does not fit inside template" };
    }
    const patched = Uint8Array.from(templateBytes);
    patched.set(nonceBytes, offset);
    const hashHex = keccak256(bytesToHex(patched));
    const work = BigInt(hashHex);
    const target = BigInt(job.target_hex);
    if (work >= target) {
      return { ok: false, work, hashHex, reason: "work >= target" };
    }
    return { ok: true, work, hashHex, reason: null };
  } catch (e) {
    return { ok: false, work: null, hashHex: null, reason: String(e?.message ?? e) };
  }
}

// Decodes a viem contract-call error's revert data against the HashCats ABI's
// custom errors. Same pattern as mint-suits.mjs's decodeRevert.
export function decodeRevert(err) {
  let data;
  try {
    const found = typeof err?.walk === "function"
      ? err.walk((e) => typeof e?.data === "string" && e.data.startsWith("0x") && e.data.length >= 10)
      : null;
    data = found?.data;
  } catch {}
  if (typeof data !== "string") {
    const m = /0x[0-9a-fA-F]{8,}/.exec(String(err?.details ?? err?.shortMessage ?? err?.message ?? ""));
    if (m) data = m[0];
  }
  if (typeof data !== "string" || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({ abi: ABI_ERRORS, data });
    const args = (decoded.args ?? []).map((a) => String(a)).join(", ");
    return { name: decoded.errorName, text: args ? `${decoded.errorName}(${args})` : decoded.errorName };
  } catch {
    return null;
  }
}
