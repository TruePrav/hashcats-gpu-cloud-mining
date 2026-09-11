// Pure in-memory wallet pool for the HashCats miner. No I/O, no chain access,
// no key access: just the state machine that decides which one-time wallet
// is "active" (the address jobs get published for) and tracks the others.
//
// One entry per wallet: { record, status, nonce, lastError }.
//   status: idle | inflight | done | skipped
//   record: whatever the caller wants attached (mine-hashcats.mjs passes
//     { label, w }, the wallet record). Only record.w.address is used
//     here; everything else is opaque to the pool.
//   nonce: cached tx nonce for this wallet while it is active/inflight, or
//     null when it needs to be (re)fetched.
//
// The active wallet is the FIRST idle entry in list order. Jobs are only ever
// published for that address, so claim() rejects anything that is not
// exactly the current active entry (uniform reason "wallet-busy" whether the
// address is simply not active, or is the active address but no longer idle).
export const STATUS = { IDLE: "idle", INFLIGHT: "inflight", DONE: "done", SKIPPED: "skipped" };

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

export class WalletPool {
  constructor(records) {
    this.entries = records.map((record) => ({ record, status: STATUS.IDLE, nonce: null, lastError: null }));
  }

  all() {
    return this.entries;
  }

  byAddress(address) {
    return this.entries.find((e) => sameAddress(e.record.w.address, address)) ?? null;
  }

  // First idle wallet in list order. Jobs are published for this address only.
  active() {
    return this.entries.find((e) => e.status === STATUS.IDLE) ?? null;
  }

  // Claims the wallet for a solved job. Only the current active() entry can
  // ever be claimed; any other address (including an idle-but-not-first
  // wallet, or the active wallet once it is no longer idle) is rejected.
  claim(address) {
    const active = this.active();
    if (!active || !sameAddress(active.record.w.address, address)) {
      return { ok: false, reason: "wallet-busy" };
    }
    active.status = STATUS.INFLIGHT;
    active.lastError = null;
    return { ok: true, entry: active };
  }

  // Returns a wallet to idle (mined: false: send/receipt failed, try again
  // later) or marks it permanently done (mined: true).
  release(address, { mined }) {
    const entry = this.byAddress(address);
    if (!entry) return null;
    entry.status = mined ? STATUS.DONE : STATUS.IDLE;
    if (!mined) entry.nonce = null; // force a refetch next time it becomes active
    return entry;
  }

  // Removes a wallet from candidacy without ever sending for it (e.g. the
  // balance gate). Never overwrites a terminal status.
  skip(address, reason) {
    const entry = this.byAddress(address);
    if (!entry || entry.status === STATUS.DONE) return null;
    entry.status = STATUS.SKIPPED;
    entry.lastError = reason ?? null;
    return entry;
  }

  // Wallets that could still mine a cat (idle or currently inflight).
  remaining() {
    return this.entries.filter((e) => e.status === STATUS.IDLE || e.status === STATUS.INFLIGHT).length;
  }

  minedCount() {
    return this.entries.filter((e) => e.status === STATUS.DONE).length;
  }

  // Stop condition: enough cats mined, or no wallet left that could ever
  // produce one (all done/skipped).
  isExhausted(maxCats) {
    return this.minedCount() >= maxCats || this.active() === null;
  }
}
