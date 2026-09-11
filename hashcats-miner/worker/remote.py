"""HashCats untrusted remote GPU worker.

Talks ONLY to the coordinator's HTTP surface (mine-hashcats.mjs /
hashcats-coordinator.mjs). Receives a job (miner address, an opaque
116-byte template hex with the nonce zeroed, nonce offset/width/endian,
required leading-zero bits) and returns a nonce + hash. Holds no secrets:
no private keys, wallet labels, RPC URLs, or API keys ever reach this
process. Never signs or broadcasts anything.

Uses only the documented engine.py API: Job, HashcatMiner(devices=...),
search(job, on_progress, stop_event), format_rate. Does not import or
modify engine.py, keccak_miner.cl, cli.py, or ref_keccak.py.

    .venv/Scripts/python.exe -m worker.remote --coordinator http://127.0.0.1:8787 --token <t>
"""
from __future__ import annotations

import argparse
import json
import socket
import threading
import time
import urllib.error
import urllib.request

from .engine import HashcatMiner, Job, OpenCLUnavailable, format_rate

DEFAULT_COORDINATOR = "http://127.0.0.1:8787"
PROGRESS_INTERVAL_S = 10.0
MIN_BACKOFF_S = 0.5
MAX_BACKOFF_S = 10.0


def _hex_to_bytes(value: str) -> bytes:
    return bytes.fromhex(value[2:] if value.startswith("0x") else value)


def _request(url: str, token: str, method: str = "GET", body=None, timeout: float = 10):
    data = None
    headers = {"x-hashcats-token": token} if token else {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.status == 204 or not raw:
            return resp.status, None
        return resp.status, json.loads(raw.decode("utf-8"))


def fetch_job(base: str, token: str, since: int):
    """Long-polls /job. Returns the job dict, or None if unchanged (204) or on a
    transient network error. Raises RuntimeError only on a hard auth failure
    (401), which the caller treats as fatal (a bad token will never fix itself)."""
    try:
        status, body = _request(f"{base}/job?since={since}", token, timeout=8)
        return body if status == 200 else None
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise RuntimeError("coordinator rejected token (401)") from exc
        return None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError):
        return None


def post_solution(base: str, token: str, job_id, nonce_hex: str, hash_hex: str, worker_name: str):
    body = {"job_id": job_id, "nonce_hex": nonce_hex, "hash_hex": hash_hex, "worker": worker_name}
    try:
        return _request(f"{base}/solution", token, method="POST", body=body, timeout=10)
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        except Exception:
            return exc.code, None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as exc:
        return None, str(exc)


def post_progress(base: str, token: str, worker_name: str, hps: float):
    try:
        _request(f"{base}/progress", token, method="POST", body={"worker": worker_name, "hps": hps}, timeout=5)
    except Exception:
        pass  # progress reporting is best-effort, never fatal


def job_to_search_job(job: dict, start_counter: int = 0) -> Job:
    return Job(
        template=_hex_to_bytes(job["template_hex"]),
        nonce_offset=int(job.get("nonce_offset", 20)),
        nonce_width=int(job.get("nonce_width", 32)),
        nonce_endian=job.get("nonce_endian", "big"),
        required_bits=int(job.get("bits", 0)),
        start_counter=start_counter,
    )


def run_search(miner: HashcatMiner, job: dict, stop_event: threading.Event, base: str, token: str, worker_name: str, status: dict):
    """Runs search() against `job` until stop_event fires or the nonce space is
    exhausted. Posts every hit immediately and keeps searching (a job may yield
    more than one hit; only the first matters to the coordinator, which rejects
    late/duplicate ones, but the worker does not stop early on its own)."""
    start_counter = 0
    # Each device reports its own rate; the worker's rate is the sum. These live
    # in `status` (not a local) so they persist across the frequent job changes
    # (a new job arrives every ~12s when the chain's prevWork updates); otherwise
    # the per-device dict resets each job and the sum never reflects all devices.
    per_device = status.setdefault("per_device", {})

    def on_progress(info):
        rate = info["hashes_done"] / info["seconds"] if info["seconds"] > 0 else 0.0
        per_device[info.get("device_index", info.get("device"))] = rate
        now = time.perf_counter()
        if now - status.get("last_progress", 0.0) >= PROGRESS_INTERVAL_S:
            status["last_progress"] = now
            hps = sum(per_device.values())
            status["hps"] = hps
            post_progress(base, token, worker_name, hps)
            print(f"[job {job['id']}] {worker_name}: {format_rate(hps)} over {len(per_device)} device(s)")

    while not stop_event.is_set():
        search_job = job_to_search_job(job, start_counter=start_counter)
        hit = miner.search(search_job, on_progress=on_progress, stop_event=stop_event)
        if hit is None:
            return  # exhausted the nonce space, timed out, or stopped for a new job
        code, resp = post_solution(base, token, job["id"], hit["nonce_hex"], hit["hash_hex"], worker_name)
        print(f"[job {job['id']}] {worker_name}: posted solution -> {code} {resp}")
        # Keep searching past the found counter in case the job still has more
        # room (the coordinator will reject a second solution for this job id).
        start_counter = hit["hashes_done"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="HashCats remote GPU worker (untrusted, holds no secrets)")
    parser.add_argument("--coordinator", default=DEFAULT_COORDINATOR)
    parser.add_argument("--token", default="")
    parser.add_argument("--devices", default=None, help="comma-separated OpenCL GPU device indices (default: all)")
    parser.add_argument("--worker-name", default=socket.gethostname())
    args = parser.parse_args(argv)

    base = args.coordinator.rstrip("/")
    devices = [int(x) for x in args.devices.split(",")] if args.devices else None

    try:
        miner = HashcatMiner(devices=devices)
    except OpenCLUnavailable as exc:
        print(f"FATAL: no OpenCL GPU device available: {exc}")
        return 2

    print(f"worker '{args.worker_name}' ready, coordinator {base}, devices: {[d.name for d in miner.devices]}")

    since = -1
    current_job_id = None
    stop_event = threading.Event()
    search_thread = None
    status = {"hps": 0.0}
    backoff = MIN_BACKOFF_S

    while True:
        try:
            job = fetch_job(base, args.token, since)
            backoff = MIN_BACKOFF_S
        except RuntimeError as exc:
            print(f"FATAL: {exc}")
            return 1
        except Exception as exc:  # never exit on a transient failure
            print(f"coordinator error: {exc}; retrying in {backoff:.1f}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF_S)
            continue

        if job is None:
            continue  # long-poll returned unchanged (204); ask again immediately

        if job.get("id") != current_job_id:
            stop_event.set()
            if search_thread is not None:
                search_thread.join(timeout=5)
            stop_event = threading.Event()
            current_job_id = job["id"]
            since = job["id"]
            print(f"[job {job['id']}] new job: bits={job.get('bits')} miner={job.get('miner')}")
            search_thread = threading.Thread(
                target=run_search, args=(miner, job, stop_event, base, args.token, args.worker_name, status), daemon=True,
            )
            search_thread.start()


if __name__ == "__main__":
    raise SystemExit(main())
