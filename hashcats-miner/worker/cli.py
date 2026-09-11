from __future__ import annotations

import argparse
import os
import random
import sys
import threading

from .engine import HashcatMiner, Job, OpenCLUnavailable, format_rate, json_dump, patch_nonce, validate_job
from .ref_keccak import keccak256, leading_zero_bits


def _make_miner(devices):
    return HashcatMiner(devices=devices)


def cmd_bench(args) -> int:
    try:
        miner = _make_miner(args.devices)
    except OpenCLUnavailable as exc:
        print(f"no OpenCL GPU device available: {exc}")
        return 1
    result = miner.bench(args.seconds)
    for dev in result["devices"]:
        print(json_dump({"device": dev["device"], "hashes": dev["hashes"], "seconds": round(dev["seconds"], 3), "hps": round(dev["hps"], 1)}))
    print(json_dump({"total_hashes": result["hashes"], "seconds": round(result["seconds"], 3), "hps": round(result["hps"], 1)}))
    print(f"total: {format_rate(result['hps'])} across {len(result['devices'])} device(s)")
    for dev in result["devices"]:
        print(f"  {dev['device']}: {format_rate(dev['hps'])}")
    return 0


def _selftest_hash_batch(miner) -> bool:
    rng = random.Random(2026)
    # Lengths/offsets/widths from the spec, including offset 52 width 8 which
    # spans lanes 6 and 7 (a lane-boundary-spanning counter region).
    cases = [
        (84, 0, 8), (84, 0, 32),
        (116, 20, 8), (116, 20, 32),
        (135, 52, 8), (135, 52, 32),
    ]
    ok = True
    for length, offset, width in cases:
        template = bytes(rng.randrange(256) for _ in range(length))
        job = Job(template, offset, width, "big", 0, 0, 2000, None)
        counters = [rng.randrange(0, 1 << min(64, width * 8)) for _ in range(2000)]
        hashes = miner.hash_batch(job, counters, device_index=0)
        for counter, got in zip(counters, hashes):
            expected = keccak256(patch_nonce(job, counter, 0, miner.session_id))
            if got != expected:
                print(f"FAIL hash_batch mismatch length={length} offset={offset} width={width} counter={counter}")
                ok = False
    print(f"hash_batch vs reference ({len(cases)} cases x 2000 counters): {'PASS' if ok else 'FAIL'}")
    return ok


def _selftest_search(miner) -> bool:
    job = Job(os.urandom(84), 10, 32, "big", 20, 0, None, 30)
    solution = miner.search(job, None, threading.Event())
    if solution is None:
        print("FAIL live search at 20 bits found no hit within timeout")
        return False
    digest = keccak256(bytes.fromhex(solution["preimage_hex"]))
    ok = digest.hex() == solution["hash_hex"] and leading_zero_bits(digest) >= 20
    print(f"live 20-bit search: {'PASS' if ok else 'FAIL'} ({solution['hashes_done']} hashes, {solution['seconds']:.2f}s)")
    return ok


def cmd_selftest(args) -> int:
    try:
        miner = _make_miner(args.devices)
    except OpenCLUnavailable as exc:
        print(f"no OpenCL GPU device available: {exc}")
        return 1
    results = [_selftest_hash_batch(miner), _selftest_search(miner)]
    passed = all(results)
    print("SELFTEST PASSED" if passed else "SELFTEST FAILED")
    return 0 if passed else 1


def cmd_solve(args) -> int:
    try:
        miner = _make_miner(args.devices)
    except OpenCLUnavailable as exc:
        print(f"no OpenCL GPU device available: {exc}")
        return 1
    template = bytes.fromhex(args.template)
    job = Job(template, args.nonce_offset, args.nonce_width, args.nonce_endian, args.bits, 0, None, args.timeout)
    validate_job(job)
    solution = miner.search(job)
    if solution is None:
        print(json_dump({"found": False, "seconds": args.timeout}))
        return 2
    print(json_dump({"found": True, **solution}))
    return 0


def cmd_hash(args) -> int:
    try:
        miner = _make_miner(args.devices)
    except OpenCLUnavailable as exc:
        print(f"no OpenCL GPU device available: {exc}")
        return 1
    template = bytes.fromhex(args.template)
    nonce = bytes.fromhex(args.nonce)
    job = Job(template, args.nonce_offset, args.nonce_width, "big", 0, 0, None, None)
    validate_job(job)
    if len(nonce) != job.nonce_width:
        print(f"--nonce must be exactly {job.nonce_width} bytes, got {len(nonce)}")
        return 1
    preimage = bytearray(template)
    preimage[job.nonce_offset : job.nonce_offset + job.nonce_width] = nonce
    preimage = bytes(preimage)
    reference_hash = keccak256(preimage)
    kernel_hash = miner.hash_raw(preimage, device_index=0)
    match = reference_hash == kernel_hash
    print(json_dump({
        "preimage_hex": preimage.hex(),
        "reference_hash_hex": reference_hash.hex(),
        "kernel_hash_hex": kernel_hash.hex(),
        "match": match,
    }))
    return 0 if match else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hashcats-miner", description="OpenCL keccak256 nonce search worker")
    parser.add_argument("--devices", type=lambda s: [int(x) for x in s.split(",")], default=None, help="comma-separated device indices to use (default: all GPUs)")
    sub = parser.add_subparsers(dest="command", required=True)

    bench_p = sub.add_parser("bench", help="benchmark hashes/second on the selected device(s)")
    bench_p.add_argument("--seconds", type=float, default=15.0)
    bench_p.set_defaults(func=cmd_bench)

    selftest_p = sub.add_parser("selftest", help="run correctness self-checks (hash_batch vs reference, live search)")
    selftest_p.set_defaults(func=cmd_selftest)

    solve_p = sub.add_parser("solve", help="search for a nonce meeting required_bits leading zero bits")
    solve_p.add_argument("--template", required=True, help="hex-encoded template bytes (1..135 bytes)")
    solve_p.add_argument("--nonce-offset", type=int, required=True)
    solve_p.add_argument("--nonce-width", type=int, required=True)
    solve_p.add_argument("--nonce-endian", choices=["big", "little"], default="big")
    solve_p.add_argument("--bits", type=int, required=True, dest="bits")
    solve_p.add_argument("--timeout", type=float, default=None)
    solve_p.set_defaults(func=cmd_solve)

    hash_p = sub.add_parser("hash", help="hash one explicit nonce via the reference and the kernel; they must match")
    hash_p.add_argument("--template", required=True, help="hex-encoded template bytes (1..135 bytes)")
    hash_p.add_argument("--nonce-offset", type=int, required=True)
    hash_p.add_argument("--nonce-width", type=int, required=True)
    hash_p.add_argument("--nonce", required=True, help="hex-encoded nonce field bytes, exactly nonce-width long")
    hash_p.set_defaults(func=cmd_hash)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
