import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toHex } from "viem";
import { bitsFromTarget, buildTemplate, NONCE_OFFSET, NONCE_WIDTH, searchBitsForTarget, verifySolution, workOf } from "../hashcats-lib.mjs";

const vectors = JSON.parse(readFileSync(join(process.cwd(), "presets", "hashcats.vectors.json"), "utf8"));
const allVectors = [...vectors.real, ...vectors.synthetic];

describe("workOf reproduces the vectors file", () => {
  for (const v of allVectors) {
    it(`reproduces hashHex for ${v.tokenId ?? v.label}`, () => {
      const work = workOf(v.miner, v.nonce, v.prevWork, v.anchor);
      expect(toHex(work, { size: 32 })).toBe(v.hashHex.toLowerCase());
    });
  }

  it("5/5 vectors reproduce (3 real + 2 synthetic)", () => {
    expect(allVectors.length).toBe(5);
  });
});

describe("buildTemplate", () => {
  it("zeroes the nonce field and matches workOf when patched", () => {
    const v = vectors.real[0];
    const template = buildTemplate(v.miner, v.prevWork, v.anchor);
    expect(template.length).toBe(116);
    for (let i = NONCE_OFFSET; i < NONCE_OFFSET + NONCE_WIDTH; i++) expect(template[i]).toBe(0);
    const job = { template_hex: toHex(template), nonce_offset: NONCE_OFFSET, nonce_width: NONCE_WIDTH, target_hex: toHex(BigInt(v.target)) };
    const nonceHex = toHex(BigInt(v.nonce), { size: 32 });
    const result = verifySolution(job, nonceHex);
    expect(result.ok).toBe(true);
    expect(result.hashHex).toBe(v.hashHex.toLowerCase());
  });
});

describe("bitsFromTarget", () => {
  it("is exact for a power-of-two target (2^208 -> 48)", () => {
    expect(bitsFromTarget(2n ** 208n)).toBe(48);
  });

  it("is conservative for a non-power-of-two target", () => {
    const target = BigInt(vectors.real[0].target);
    const bits = bitsFromTarget(target);
    // Conservative means: ANY hash with this many leading zero bits is < target.
    expect(2n ** BigInt(256 - bits)).toBeLessThanOrEqual(target);
    // And one fewer bit would NOT be a guarantee (the ceiling for that bit count exceeds target).
    expect(2n ** BigInt(256 - (bits - 1))).toBeGreaterThan(target);
  });
});

describe("searchBitsForTarget (the hint handed to GPU workers)", () => {
  // Regression: a real target had bit length 209,
  // so the contract accepted work < ~2^209, but handing workers the
  // conservative ceiling made them demand work < 2^208 and silently discard
  // half of every valid solution, halving the whole fleet's effective rate.
  const LIVE_TARGET = 822752278660603021077484591278675252491367932816789931674304511n;

  it("never misses a valid solution: its threshold is at or above target", () => {
    for (const target of [LIVE_TARGET, 2n ** 208n, BigInt(vectors.real[0].target), 3n, 1n << 255n]) {
      const bits = searchBitsForTarget(target);
      expect(2n ** BigInt(256 - bits)).toBeGreaterThanOrEqual(target);
    }
  });

  it("is at most one bit looser than the conservative ceiling", () => {
    for (const target of [LIVE_TARGET, 2n ** 208n, BigInt(vectors.real[0].target)]) {
      const diff = bitsFromTarget(target) - searchBitsForTarget(target);
      expect(diff === 0 || diff === 1).toBe(true);
    }
  });

  it("recovers the lost 2x on the live target (47, not 48)", () => {
    expect(searchBitsForTarget(LIVE_TARGET)).toBe(47);
    expect(bitsFromTarget(LIVE_TARGET)).toBe(48);
    // The ceiling's threshold was 2^208 while the contract accepted ~2x that.
    expect((LIVE_TARGET * 100n) / 2n ** BigInt(256 - bitsFromTarget(LIVE_TARGET))).toBe(199n);
  });
});

describe("verifySolution", () => {
  const v = vectors.real[2];
  const template = buildTemplate(v.miner, v.prevWork, v.anchor);
  const job = { template_hex: toHex(template), nonce_offset: NONCE_OFFSET, nonce_width: NONCE_WIDTH, target_hex: toHex(BigInt(v.target)) };
  const goodNonceHex = toHex(BigInt(v.nonce), { size: 32 });

  it("accepts the real solution", () => {
    const result = verifySolution(job, goodNonceHex);
    expect(result.ok).toBe(true);
    expect(result.hashHex).toBe(v.hashHex.toLowerCase());
  });

  it("rejects a wrong-length nonce", () => {
    const result = verifySolution(job, "0x1234");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/nonce must be/);
  });

  it("rejects a hash above target", () => {
    const impossibleJob = { ...job, target_hex: toHex(1n) };
    const result = verifySolution(impossibleJob, goodNonceHex);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("work >= target");
  });

  it("rejects a job/nonce mismatch (nonce from a different job)", () => {
    const other = vectors.real[0];
    const mismatchedNonceHex = toHex(BigInt(other.nonce), { size: 32 });
    const result = verifySolution(job, mismatchedNonceHex);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("work >= target");
  });
});
