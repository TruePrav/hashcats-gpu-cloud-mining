// HTTP coordinator for the HashCats miner. Bind 127.0.0.1 only.
// Owns job state and solution verification; never touches keys, never
// picks wallets. mine-hashcats.mjs polls the chain and calls publishJob();
// this module wires the HTTP surface a remote worker talks to and hands a
// verified solution to the injected `signer`.
//
// Routes: GET /job?since=<id> (long-poll up to 5s, 204 if unchanged, and
// immediately if there is no current job at all, e.g. after clearJob()),
// GET /status, POST /solution {job_id, nonce_hex, hash_hex, worker},
// POST /progress {worker, hps}. All require header x-hashcats-token (401
// if missing/wrong, unless no token was configured).
//
// Optional wallet pool wiring (mine-hashcats.mjs): pass `pool` (a
// WalletPool-shaped object exposing claim(address)/active()) to gate a
// solution on the wallet matching job.miner actually being idle: any other
// address, or that same address once it is no longer idle, is rejected 409
// "wallet-busy". Pass `buildJob(nextEntry) -> jobFields|null|Promise<...>`
// to have the coordinator publish a job for the next active wallet the
// moment a claim succeeds, without waiting for signer.mine() to resolve, so
// workers keep hashing while the current wallet's send/receipt is pending.
import { createServer } from "node:http";
import { verifySolution } from "./hashcats-lib.mjs";

const LONG_POLL_MS = 5000;

// The Python worker reports the nonce and digest via bytes.hex(), which has no
// 0x prefix. BigInt() on an unprefixed string either throws or, for an
// all-digit nonce, silently parses it as DECIMAL and yields a completely wrong
// value that would be signed and reverted on-chain. Always prefix before
// converting.
const withHexPrefix = (s) => (typeof s === "string" && !/^0[xX]/.test(s) ? `0x${s}` : s);

export function createCoordinator(opts = {}) {
  const {
    token,
    signer, // { mine: async ({ nonce, anchorBlock, value, gasLimit, miner }) => result }: result.mined signals a landed cat
    reader, // optional chain-state reader, unused by the coordinator itself; kept for callers that want to hand it through
    pool, // optional WalletPool (see header comment)
    buildJob, // optional (nextEntry) => jobFields, used with `pool` to auto-republish
    gasLimit = 200000n,
    onEvent = () => {},
    now = () => Date.now(),
  } = opts;

  let job = null;
  let nextJobId = 1;
  const waiters = new Set();
  const workers = new Map();
  const solvedJobIds = new Set();
  const startedMs = now();

  function wakeWaiters() {
    const toWake = [...waiters];
    waiters.clear();
    for (const wake of toWake) wake();
  }

  function publishJob(fields) {
    job = { ...fields, id: nextJobId++, issued_ms: now() };
    wakeWaiters();
    onEvent({ type: "job", job });
    return job;
  }

  // Price-cap gate: clears the current job instead of leaving a
  // stale one published. Long-polling workers wake immediately to 204.
  function clearJob() {
    if (job === null) return;
    job = null;
    wakeWaiters();
    onEvent({ type: "job_cleared" });
  }

  function getStatus() {
    return {
      job_id: job?.id ?? null,
      bits: job?.bits ?? null,
      price_wei: job?.price_wei ?? null,
      miner: job?.miner ?? null,
      solvedJobs: solvedJobIds.size,
      workers: [...workers.entries()].map(([worker, w]) => ({ worker, hps: w.hps, lastSeenMs: w.lastSeenMs })),
      uptimeMs: now() - startedMs,
    };
  }

  function checkToken(req) {
    return !token || req.headers["x-hashcats-token"] === token;
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }

  async function handleJob(req, res, url) {
    const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : -1;
    const deadline = now() + LONG_POLL_MS;
    while (true) {
      if (job === null) { res.writeHead(204); return res.end(); }
      if (job.id !== since) return sendJson(res, 200, job);
      const remaining = deadline - now();
      if (remaining <= 0) { res.writeHead(204); return res.end(); }
      await new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(wake); resolve(); }, Math.min(remaining, 1000));
        function wake() { clearTimeout(timer); resolve(); }
        waiters.add(wake);
      });
    }
  }

  async function handleSolution(req, res) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { ok: false, reason: "bad json body" });
    }
    const { job_id, nonce_hex, hash_hex, worker } = payload ?? {};
    if (!job || job_id !== job.id) {
      onEvent({ type: "stale", job_id, current_job_id: job?.id ?? null, worker });
      return sendJson(res, 409, { ok: false, reason: "stale job" });
    }
    if (!pool && solvedJobIds.has(job.id)) {
      return sendJson(res, 409, { ok: false, reason: "already handled" });
    }
    const verified = verifySolution(job, nonce_hex);
    if (!verified.ok) {
      onEvent({ type: "rejected", job_id, worker, reason: verified.reason });
      return sendJson(res, 400, { ok: false, reason: verified.reason });
    }
    // Normalize before comparing: the Python worker reports the digest via
    // bytes.hex() (no 0x prefix) while verifySolution returns viem's keccak256
    // (0x-prefixed). Comparing them raw rejected every real solution.
    const normHex = (s) => (s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s).toLowerCase();
    if (typeof hash_hex === "string" && verified.hashHex && normHex(hash_hex) !== normHex(verified.hashHex)) {
      onEvent({ type: "rejected", job_id, worker, reason: "hash_hex mismatch" });
      return sendJson(res, 400, { ok: false, reason: "hash_hex mismatch" });
    }

    if (pool) {
      // The wallet pool is the source of truth: only the current active
      // wallet can be claimed, and only once. Any other address, or the same
      // address a second time while inflight, is rejected wallet-busy.
      const claim = pool.claim(job.miner);
      if (!claim.ok) {
        onEvent({ type: "rejected", job_id, worker, reason: "wallet-busy" });
        return sendJson(res, 409, { ok: false, reason: "wallet-busy" });
      }
      // Re-publish for the next idle wallet right away, without waiting for
      // signer.mine() (which may hang on a broadcast); fire and forget.
      if (buildJob) {
        const next = pool.active();
        if (next) {
          Promise.resolve(buildJob(next))
            .then((fields) => { if (fields) publishJob(fields); })
            .catch((e) => onEvent({ type: "next_job_error", job_id, error: String(e?.message ?? e).slice(0, 200) }));
        }
      }
    } else {
      solvedJobIds.add(job.id); // never send twice for the same job id, even on a second valid POST
    }

    onEvent({ type: "solution", job_id, worker, work: verified.work.toString(), hashHex: verified.hashHex });
    if (!signer) return sendJson(res, 200, { ok: true, result: { mined: false, reason: "no signer configured" } });
    try {
      const result = await signer.mine({
        nonce: BigInt(withHexPrefix(nonce_hex)),
        anchorBlock: BigInt(job.anchor_block),
        value: BigInt(job.price_wei),
        miner: job.miner,
        gasLimit,
      });
      onEvent({ type: "mine_result", job_id, worker, result });
      return sendJson(res, 200, { ok: true, result });
    } catch (e) {
      const reason = String(e?.message ?? e).slice(0, 200);
      onEvent({ type: "mine_error", job_id, worker, error: reason });
      return sendJson(res, 200, { ok: false, reason });
    }
  }

  async function handleProgress(req, res) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { ok: false, reason: "bad json body" });
    }
    const { worker, hps } = payload ?? {};
    if (typeof worker !== "string") return sendJson(res, 400, { ok: false, reason: "worker required" });
    workers.set(worker, { hps: Number(hps) || 0, lastSeenMs: now() });
    onEvent({ type: "progress", worker, hps });
    return sendJson(res, 200, { ok: true });
  }

  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return sendJson(res, 400, { ok: false, reason: "bad url" });
    }
    if (!checkToken(req)) return sendJson(res, 401, { ok: false, reason: "missing or invalid token" });
    if (req.method === "GET" && url.pathname === "/job") return void handleJob(req, res, url);
    if (req.method === "GET" && url.pathname === "/status") return sendJson(res, 200, getStatus());
    if (req.method === "POST" && url.pathname === "/solution") return void handleSolution(req, res);
    if (req.method === "POST" && url.pathname === "/progress") return void handleProgress(req, res);
    return sendJson(res, 404, { ok: false, reason: "not found" });
  });

  return {
    server,
    reader,
    pool,
    publishJob,
    clearJob,
    getStatus,
    get currentJob() {
      return job;
    },
    listen(port, host = "127.0.0.1") {
      return new Promise((resolve) => server.listen(port, host, resolve));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
