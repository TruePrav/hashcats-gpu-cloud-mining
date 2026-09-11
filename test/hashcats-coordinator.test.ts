import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toHex } from "viem";
import { createCoordinator } from "../hashcats-coordinator.mjs";
import { buildTemplate, NONCE_OFFSET, NONCE_WIDTH } from "../hashcats-lib.mjs";
import { WalletPool } from "../hashcats-wallets.mjs";

const vectors = JSON.parse(readFileSync(join(process.cwd(), "presets", "hashcats.vectors.json"), "utf8"));
const V = vectors.real[0];

const TOKEN = "test-token-123";
// A fresh port per test avoids Node's fetch (undici) reusing a keep-alive socket
// from a previous test's now-closed server on the same origin, which otherwise
// surfaces as a spurious ECONNRESET on the next request.
let nextPort = 18787;

function buildJobFieldsFor(v) {
  const template = buildTemplate(v.miner, v.prevWork, v.anchor);
  return {
    miner: v.miner,
    template_hex: toHex(template),
    nonce_offset: NONCE_OFFSET,
    nonce_width: NONCE_WIDTH,
    nonce_endian: "big",
    bits: 44,
    target_hex: toHex(BigInt(v.target)),
    prev_work_hex: toHex(BigInt(v.prevWork)),
    anchor_block: v.anchorBlock,
    anchor_hex: v.anchor,
    price_wei: "10080000000000000",
  };
}

function buildJobFields() {
  return buildJobFieldsFor(V);
}

let coordinator;

afterEach(async () => {
  if (coordinator) await coordinator.close();
  coordinator = null;
});

describe("hashcats coordinator", () => {
  it("publishes a job, long-polls it, accepts a valid solution, and calls the signer with mine(nonce, anchorBlock) and the right value", async () => {
    const port = nextPort++;
    const base = `http://127.0.0.1:${port}`;
    const mineMock = vi.fn(async () => ({ mined: true, hash: "0xdeadbeef", tokenId: 999n }));
    coordinator = createCoordinator({ token: TOKEN, signer: { mine: mineMock } });
    await coordinator.listen(port);

    const job = coordinator.publishJob(buildJobFields());
    expect(job.id).toBe(1);

    // Long-poll starting from "no job seen yet" (-1) should return immediately.
    const jobRes = await fetch(`${base}/job?since=-1`, { headers: { "x-hashcats-token": TOKEN } });
    expect(jobRes.status).toBe(200);
    const jobBody = await jobRes.json();
    expect(jobBody.id).toBe(1);
    expect(jobBody.miner).toBe(V.miner);

    const nonceHex = toHex(BigInt(V.nonce), { size: 32 });
    const solRes = await fetch(`${base}/solution`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hashcats-token": TOKEN },
      body: JSON.stringify({ job_id: 1, nonce_hex: nonceHex, hash_hex: V.hashHex, worker: "test-worker" }),
    });
    expect(solRes.status).toBe(200);
    const solBody = await solRes.json();
    expect(solBody.ok).toBe(true);
    expect(solBody.result.mined).toBe(true);

    expect(mineMock).toHaveBeenCalledTimes(1);
    const callArgs = mineMock.mock.calls[0][0];
    expect(callArgs.nonce).toBe(BigInt(V.nonce));
    expect(callArgs.anchorBlock).toBe(BigInt(V.anchorBlock));
    expect(callArgs.value).toBe(10080000000000000n);
  });

  // Regression guard for a bug that blocked every mint: the
  // Python worker reports the nonce and digest via bytes.hex(), which has NO
  // 0x prefix. The coordinator compared hash_hex as a raw string (so every
  // real solution was rejected 400) and called BigInt(nonce_hex), which throws
  // on hex letters and, for an all-digit nonce, would silently parse it as
  // DECIMAL and sign a completely wrong nonce. Every other test in this file
  // posts 0x-prefixed JS-shaped values, so none of them cross that boundary.
  it("accepts a solution shaped the way the Python worker sends it (unprefixed hex) and passes the true hex nonce to the signer", async () => {
    const port = nextPort++;
    const base = `http://127.0.0.1:${port}`;
    const mineMock = vi.fn(async () => ({ mined: true }));
    coordinator = createCoordinator({ token: TOKEN, signer: { mine: mineMock } });
    await coordinator.listen(port);
    coordinator.publishJob(buildJobFields());

    // Exactly what Python's bytes.hex() produces: no 0x on either field.
    const nonceHex = toHex(BigInt(V.nonce), { size: 32 }).slice(2);
    const hashHex = V.hashHex.slice(2);
    expect(nonceHex.startsWith("0x")).toBe(false);
    expect(hashHex.startsWith("0x")).toBe(false);

    const res = await fetch(`${base}/solution`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hashcats-token": TOKEN },
      body: JSON.stringify({ job_id: 1, nonce_hex: nonceHex, hash_hex: hashHex, worker: "py-worker" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(mineMock).toHaveBeenCalledTimes(1);
    // Must be the real hex value, never a decimal reinterpretation of the digits.
    expect(mineMock.mock.calls[0][0].nonce).toBe(BigInt(V.nonce));
  });

  it("rejects a stale job id with 409 and never calls the signer", async () => {
    const port = nextPort++;
    const base = `http://127.0.0.1:${port}`;
    const mineMock = vi.fn(async () => ({ mined: true }));
    coordinator = createCoordinator({ token: TOKEN, signer: { mine: mineMock } });
    await coordinator.listen(port);
    coordinator.publishJob(buildJobFields()); // job id 1
    coordinator.publishJob(buildJobFields()); // job id 2, supersedes 1

    const nonceHex = toHex(BigInt(V.nonce), { size: 32 });
    const res = await fetch(`${base}/solution`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hashcats-token": TOKEN },
      body: JSON.stringify({ job_id: 1, nonce_hex: nonceHex, hash_hex: V.hashHex, worker: "test-worker" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("stale job");
    expect(mineMock).not.toHaveBeenCalled();
  });

  it("rejects any request missing the token with 401", async () => {
    const port = nextPort++;
    const base = `http://127.0.0.1:${port}`;
    coordinator = createCoordinator({ token: TOKEN, signer: { mine: vi.fn() } });
    await coordinator.listen(port);
    coordinator.publishJob(buildJobFields());

    const noToken = await fetch(`${base}/status`);
    expect(noToken.status).toBe(401);

    const wrongToken = await fetch(`${base}/status`, { headers: { "x-hashcats-token": "wrong" } });
    expect(wrongToken.status).toBe(401);
  });

  it("never sends twice for the same job id", async () => {
    const port = nextPort++;
    const base = `http://127.0.0.1:${port}`;
    const mineMock = vi.fn(async () => ({ mined: true }));
    coordinator = createCoordinator({ token: TOKEN, signer: { mine: mineMock } });
    await coordinator.listen(port);
    coordinator.publishJob(buildJobFields());
    const nonceHex = toHex(BigInt(V.nonce), { size: 32 });
    const post = () => fetch(`${base}/solution`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hashcats-token": TOKEN },
      body: JSON.stringify({ job_id: 1, nonce_hex: nonceHex, hash_hex: V.hashHex, worker: "w" }),
    });
    const first = await post();
    expect(first.status).toBe(200);
    const second = await post();
    expect(second.status).toBe(409);
    expect(mineMock).toHaveBeenCalledTimes(1);
  });

  it("long-poll with since equal to the current job id waits for a new job", async () => {
    const port = nextPort++;
    const base = `http://127.0.0.1:${port}`;
    coordinator = createCoordinator({ token: TOKEN, signer: { mine: vi.fn() } });
    await coordinator.listen(port);
    const job = coordinator.publishJob(buildJobFields());
    // Poll with the current id: the coordinator should not resolve until a NEW job
    // arrives or the long-poll window elapses. We race it against a short new job
    // publish to keep the test fast instead of waiting the full 5s.
    const pollPromise = fetch(`${base}/job?since=${job.id}`, { headers: { "x-hashcats-token": TOKEN } });
    await new Promise((r) => setTimeout(r, 50));
    coordinator.publishJob(buildJobFields()); // id 2, should wake the long-poll
    const res = await pollPromise;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(2);
  });

  it("wallet pool: a solution for the next wallet's job is accepted while the first is inflight, and a second solution for a busy wallet is rejected wallet-busy", async () => {
    const port = nextPort++;
    const base = `http://127.0.0.1:${port}`;
    const V2 = vectors.real[1];
    const pool = new WalletPool([
      { label: "a", w: { address: V.miner, id: "a" } },
      { label: "b", w: { address: V2.miner, id: "b" } },
    ]);
    const mineMock = vi.fn(async () => ({ mined: false, broadcast: true }));
    const buildJob = vi.fn((entry) => buildJobFieldsFor(entry.record.w.address === V2.miner ? V2 : V));
    coordinator = createCoordinator({ token: TOKEN, signer: { mine: mineMock }, pool, buildJob });
    await coordinator.listen(port);

    // Job 1 published for wallet A (the pool's active wallet).
    coordinator.publishJob(buildJobFields());
    expect(pool.active().record.label).toBe("a");

    const nonceHexFor = (v) => toHex(BigInt(v.nonce), { size: 32 });
    const postSolution = (jobId, v) => fetch(`${base}/solution`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hashcats-token": TOKEN },
      body: JSON.stringify({ job_id: jobId, nonce_hex: nonceHexFor(v), hash_hex: v.hashHex, worker: "test-worker" }),
    });

    // Solution for job 1 (wallet A): claims A, and the coordinator should
    // fire-and-forget publish a new job for wallet B, the next active wallet.
    const first = await postSolution(1, V);
    expect(first.status).toBe(200);
    expect((await first.json()).ok).toBe(true);
    expect(pool.byAddress(V.miner).status).toBe("inflight");

    // The next-job publish is fire-and-forget; give its microtask a tick.
    await new Promise((r) => setTimeout(r, 20));
    expect(coordinator.currentJob.id).toBe(2);
    expect(coordinator.currentJob.miner).toBe(V2.miner);

    // Solution for job 2 (wallet B) is accepted while A is still inflight.
    const second = await postSolution(2, V2);
    expect(second.status).toBe(200);
    expect((await second.json()).ok).toBe(true);
    expect(pool.byAddress(V.miner).status).toBe("inflight"); // A: still inflight, untouched
    expect(pool.byAddress(V2.miner).status).toBe("inflight"); // B: now claimed too

    // No idle wallet remains, so no job 3 was published; job 2 stays current.
    expect(coordinator.currentJob.id).toBe(2);

    // A second (duplicate) valid solution for the now-busy wallet B, same
    // current job, is rejected wallet-busy rather than being sent again.
    const third = await postSolution(2, V2);
    expect(third.status).toBe(409);
    expect((await third.json()).reason).toBe("wallet-busy");
    expect(mineMock).toHaveBeenCalledTimes(2);
  });

  it("clearJob wakes a long-polling worker with 204 and /job returns 204 immediately with no current job", async () => {
    const port = nextPort++;
    const base = `http://127.0.0.1:${port}`;
    coordinator = createCoordinator({ token: TOKEN, signer: { mine: vi.fn() } });
    await coordinator.listen(port);
    const job = coordinator.publishJob(buildJobFields());

    const pollPromise = fetch(`${base}/job?since=${job.id}`, { headers: { "x-hashcats-token": TOKEN } });
    await new Promise((r) => setTimeout(r, 50));
    coordinator.clearJob();
    const res = await pollPromise;
    expect(res.status).toBe(204);

    const res2 = await fetch(`${base}/job?since=-1`, { headers: { "x-hashcats-token": TOKEN } });
    expect(res2.status).toBe(204);
  });
});
