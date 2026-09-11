import { describe, expect, it } from "vitest";
import { STATUS, WalletPool } from "../hashcats-wallets.mjs";

function makeRecord(label, address) {
  return { label, w: { address, id: label } };
}

function makePool() {
  return new WalletPool([makeRecord("a", "0xAAA0000000000000000000000000000000000a"), makeRecord("b", "0xBBB0000000000000000000000000000000000b")]);
}

describe("WalletPool", () => {
  it("starts with every wallet idle and the first one active", () => {
    const pool = makePool();
    expect(pool.all().every((e) => e.status === STATUS.IDLE)).toBe(true);
    expect(pool.active()?.record.label).toBe("a");
  });

  it("rejects claim of a non-active address (uppercase/lowercase both)", () => {
    const pool = makePool();
    const claim = pool.claim("0xbbb0000000000000000000000000000000000b");
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe("wallet-busy");
    expect(pool.byAddress("0xbbb0000000000000000000000000000000000b").status).toBe(STATUS.IDLE);
  });

  it("active address advances on claim", () => {
    const pool = makePool();
    const claim = pool.claim(pool.active().record.w.address);
    expect(claim.ok).toBe(true);
    expect(claim.entry.status).toBe(STATUS.INFLIGHT);
    expect(pool.active()?.record.label).toBe("b");
  });

  it("a second claim of the same (now busy) address is rejected", () => {
    const pool = makePool();
    const address = pool.active().record.w.address;
    pool.claim(address);
    const second = pool.claim(address);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("wallet-busy");
  });

  it("release(mined: false) returns the wallet to idle and it becomes active again if first", () => {
    const pool = makePool();
    const address = pool.active().record.w.address; // "a"
    pool.claim(address);
    expect(pool.active()?.record.label).toBe("b");
    pool.release(address, { mined: false });
    expect(pool.byAddress(address).status).toBe(STATUS.IDLE);
    expect(pool.active()?.record.label).toBe("a"); // first in list order again
  });

  it("release(mined: true) marks the wallet done permanently", () => {
    const pool = makePool();
    const address = pool.active().record.w.address;
    pool.claim(address);
    pool.release(address, { mined: true });
    expect(pool.byAddress(address).status).toBe(STATUS.DONE);
    expect(pool.active()?.record.label).toBe("b");
  });

  it("skip removes a wallet from candidacy without marking it done", () => {
    const pool = makePool();
    const address = pool.active().record.w.address; // "a"
    pool.skip(address, "insufficient balance");
    expect(pool.byAddress(address).status).toBe(STATUS.SKIPPED);
    expect(pool.byAddress(address).lastError).toBe("insufficient balance");
    expect(pool.active()?.record.label).toBe("b");
  });

  it("remaining counts idle and inflight wallets, not done/skipped", () => {
    const pool = makePool();
    expect(pool.remaining()).toBe(2);
    const address = pool.active().record.w.address;
    pool.claim(address); // now inflight, still counts
    expect(pool.remaining()).toBe(2);
    pool.release(address, { mined: true }); // now done
    expect(pool.remaining()).toBe(1);
  });

  it("isExhausted stops once max-cats is reached", () => {
    const pool = makePool();
    const address = pool.active().record.w.address;
    pool.claim(address);
    pool.release(address, { mined: true });
    expect(pool.minedCount()).toBe(1);
    expect(pool.isExhausted(1)).toBe(true);
    expect(pool.isExhausted(2)).toBe(false);
  });

  it("isExhausted stops when no idle wallet remains even below max-cats", () => {
    const pool = makePool();
    for (const e of pool.all()) pool.skip(e.record.w.address, "insufficient balance");
    expect(pool.active()).toBeNull();
    expect(pool.isExhausted(5)).toBe(true);
  });
});
