// Live terminal dashboard for the HashCats fleet. Polls the coordinator's
// /status every 2s and redraws. Run in a spare terminal on the coordinator machine:
//
//   node hashcats-dash.mjs --token <t>
//   node hashcats-dash.mjs --port 8787 --token <t>
//
// Read-only: it only calls GET /status. Per-box stdout logs still live in each
// box's own box.ps1/box.sh terminal; this is the consolidated rate/health view.
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const PORT = arg("port", "8787");
const TOKEN = arg("token", process.env.HASHCATS_TOKEN);
if (!TOKEN) { console.error("FATAL: --token <t> or HASHCATS_TOKEN env required (the token the coordinator printed on startup)"); process.exit(1); }
const URL = `http://127.0.0.1:${PORT}/status`;
const STALE_MS = 25_000; // a worker silent this long is treated as dropped

const fmtRate = (h) => (h >= 1e9 ? (h / 1e9).toFixed(2) + " GH/s" : h >= 1e6 ? (h / 1e6).toFixed(1) + " MH/s" : Math.round(h) + " H/s");
const fmtDur = (s) => (s < 90 ? Math.round(s) + "s" : s < 5400 ? (s / 60).toFixed(1) + "m" : (s / 3600).toFixed(1) + "h");
const started = Date.now();

async function draw() {
  let s;
  try {
    const r = await fetch(URL, { headers: { "x-hashcats-token": TOKEN }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    s = await r.json();
  } catch (e) {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log("HashCats fleet dashboard\n");
    console.log("  coordinator unreachable at", URL);
    console.log("  ", String(e.message || e));
    console.log("\n  (is terminal A still running mine-hashcats.mjs? is the port/token right?)");
    return;
  }
  const now = Date.now();
  const workers = (s.workers || []).slice().sort((a, b) => a.worker.localeCompare(b.worker));
  const live = workers.filter((w) => now - w.lastSeenMs < STALE_MS);
  const total = live.reduce((a, w) => a + (+w.hps || 0), 0);
  const bits = Number(s.bits || 0);
  const cats = Number(s.catsMined ?? s.minedCount ?? 0);
  const price = s.price_wei ? (Number(s.price_wei) / 1e18).toFixed(5) : "?";

  process.stdout.write("\x1b[2J\x1b[H");
  console.log("HashCats fleet dashboard   " + new Date().toLocaleTimeString() + "   (Ctrl+C to close)\n");
  console.log("  worker        rate         last seen   status");
  console.log("  " + "-".repeat(52));
  for (const w of workers) {
    const age = (now - w.lastSeenMs) / 1000;
    const stale = now - w.lastSeenMs >= STALE_MS;
    const name = w.worker.padEnd(12);
    const rate = fmtRate(+w.hps || 0).padStart(11);
    const seen = (fmtDur(age) + " ago").padStart(10);
    console.log(`  ${name}${rate}   ${seen}   ${stale ? "STALE" : "ok"}`);
  }
  if (!workers.length) console.log("  (no workers connected yet)");
  console.log("  " + "-".repeat(52));
  console.log("  FLEET " + fmtRate(total).padStart(10) + `   over ${live.length} live worker(s)`);
  console.log("");
  console.log(`  job #${s.job_id ?? "?"}   difficulty ${bits} bits   price ${price} ETH   cats mined ${cats}`);
  if (total > 0 && bits > 0) {
    const line = [47, 48, 49, 50].map((b) => `${b}b:${fmtDur(Math.pow(2, b) / total)}`).join("   ");
    console.log("  expected per cat   " + line);
    console.log("  at current " + bits + " bits: ~" + fmtDur(Math.pow(2, bits) / total) + " per cat (expected; random)");
  }
  console.log("\n  dashboard uptime " + fmtDur((now - started) / 1000) + "   polling " + URL);
}

draw();
setInterval(draw, 2000);
