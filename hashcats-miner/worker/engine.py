from __future__ import annotations

import json
import os
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .ref_keccak import keccak256, leading_zero_bits

MASK64 = (1 << 64) - 1


class OpenCLUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Job:
    template: bytes
    nonce_offset: int
    nonce_width: int
    nonce_endian: str = "big"
    required_bits: int = 0
    start_counter: int = 0
    max_hashes: int | None = None
    timeout_s: float | None = None


def validate_job(job: Job):
    if not 1 <= len(job.template) <= 135:
        raise ValueError("template length must be 1..135 bytes")
    if not 0 <= job.nonce_offset < len(job.template):
        raise ValueError("nonce_offset must point inside the template")
    if not 1 <= job.nonce_width <= 32:
        raise ValueError("nonce_width must be 1..32 bytes")
    if job.nonce_offset + job.nonce_width > len(job.template):
        raise ValueError("nonce field must fit inside the template")
    if job.nonce_endian not in ("big", "little"):
        raise ValueError("nonce_endian must be big or little")
    if not 0 <= job.required_bits <= 256:
        raise ValueError("required_bits must be 0..256")
    if not 0 <= job.start_counter < (1 << 64):
        raise ValueError("start_counter must be a u64")


def patch_nonce(job: Job, counter: int, device_index: int, session_id: int | None = None) -> bytes:
    validate_job(job)
    session_id = secrets.randbits(32) if session_id is None else session_id & 0xFFFFFFFF
    available = min(8, job.nonce_width)
    if counter >= (1 << (available * 8)):
        raise ValueError("counter exceeds nonce field capacity")
    field = bytearray(job.template[job.nonce_offset : job.nonce_offset + job.nonce_width])
    if job.nonce_width > 8:
        prefix_len = job.nonce_width - 8
        prefix = session_id.to_bytes(4, "big") + bytes([device_index & 0xFF])
        field[:prefix_len] = (prefix + bytes(prefix_len))[:prefix_len]
        low_start = prefix_len
    else:
        low_start = 0
    low = counter.to_bytes(available, job.nonce_endian)
    field[low_start : low_start + available] = low
    patched = bytearray(job.template)
    patched[job.nonce_offset : job.nonce_offset + job.nonce_width] = field
    return bytes(patched)


# ---- lane helpers: the host precomputes the 17 absorbed template lanes once
# per job, plus a small "patch plan" (which lane(s) the 8-byte counter lands
# in and how to shift/mask it). The kernel then only does lane arithmetic; it
# never touches template bytes. ----


def pack_lanes(block136: bytes) -> list[int]:
    if len(block136) != 136:
        raise ValueError("block must be 136 bytes")
    return [int.from_bytes(block136[i * 8 : i * 8 + 8], "little") for i in range(17)]


def padded_block(template: bytes) -> bytes:
    block = bytearray(136)
    block[: len(template)] = template
    block[len(template)] ^= 0x01
    block[135] ^= 0x80
    return bytes(block)


def base_lanes_for_job(job: Job, device_index: int, session_id: int) -> list[int]:
    """The 17 absorbed lanes with the nonce's prefix (session id + device
    index) filled in and its low 8-byte counter region zeroed, padding XORed
    in. Constant for a job/device/session; the counter is OR-ed in per hash."""
    validate_job(job)
    base_block = patch_nonce(job, 0, device_index, session_id)
    return pack_lanes(padded_block(base_block))


def lane_patch_plan(job: Job) -> dict:
    """Where the low 8-byte counter region lands in the 17 lanes: lane
    index(es), bit shift, and masks. Depends only on job layout (offset,
    width, endian), not on the counter value or device/session."""
    validate_job(job)
    available = min(8, job.nonce_width)
    low_start = job.nonce_width - 8 if job.nonce_width > 8 else 0
    abs_pos = job.nonce_offset + low_start
    l0 = abs_pos // 8
    s0 = (abs_pos % 8) * 8
    width_bits = available * 8
    mask_bits = MASK64 if width_bits >= 64 else (1 << width_bits) - 1
    mask0 = (mask_bits << s0) & MASK64
    spans = s0 + width_bits > 64
    l1 = l0 + 1 if spans else -1
    mask1 = ((mask_bits >> (64 - s0)) & MASK64) if spans else 0
    return {
        "l0": l0,
        "l1": l1,
        "s0": s0,
        "mask0": mask0,
        "mask1": mask1,
        "available": available,
        "big_endian": 1 if job.nonce_endian == "big" else 0,
    }


def _pack_counter(counter: int, available: int, big_endian: int) -> int:
    if not big_endian:
        return counter if available >= 8 else counter & ((1 << (available * 8)) - 1)
    return int.from_bytes(counter.to_bytes(available, "big"), "little")


def apply_lane_patch(lanes: list[int], plan: dict, counter: int) -> list[int]:
    """Reference (host-side) implementation of what the kernel does per
    nonce: OR the counter into the precomputed lanes. Used by tests to prove
    the lane arithmetic matches patch_nonce exactly."""
    lanes = list(lanes)
    packed = _pack_counter(counter, plan["available"], plan["big_endian"])
    s0 = plan["s0"]
    combined = packed << s0
    l0, l1 = plan["l0"], plan["l1"]
    lanes[l0] = (lanes[l0] & (~plan["mask0"] & MASK64)) | (combined & plan["mask0"])
    if l1 >= 0:
        lanes[l1] = (lanes[l1] & (~plan["mask1"] & MASK64)) | ((combined >> 64) & plan["mask1"])
    return lanes


class HashcatMiner:
    def __init__(self, devices: list[int] | None = None, session_id: int | None = None):
        cache_dir = Path(__file__).resolve().parents[1] / ".cache"
        cache_dir.mkdir(exist_ok=True)
        os.environ.setdefault("XDG_CACHE_HOME", str(cache_dir))
        os.environ.setdefault("LOCALAPPDATA", str(cache_dir))
        os.environ.setdefault("PYOPENCL_COMPILER_OUTPUT", "0")
        try:
            import platformdirs

            platformdirs.user_cache_dir = lambda *args, **kwargs: str(cache_dir)
            import pyopencl as cl
        except Exception as exc:
            raise OpenCLUnavailable(str(exc)) from exc
        self.cl = cl
        self.session_id = secrets.randbits(32) if session_id is None else session_id & 0xFFFFFFFF
        self.devices = self._gpu_devices()
        if devices:
            self.devices = [self.devices[i] for i in devices]
        if not self.devices:
            raise OpenCLUnavailable("no GPU OpenCL devices found")
        self._contexts = []
        source = Path(__file__).with_name("keccak_miner.cl").read_text()
        for device in self.devices:
            ctx = cl.Context([device])
            queue = cl.CommandQueue(ctx)
            program = cl.Program(ctx, source).build()
            self._contexts.append((ctx, queue, program, device, cl.Kernel(program, "hash_batch"), cl.Kernel(program, "search")))
        self._job_lock = threading.Lock()
        self._job = None
        self._lane_cache = {}
        self._zero_result = np.zeros(10, dtype=np.uint64)
        self._result_bufs = []
        mf = cl.mem_flags
        for ctx, _queue, _program, _device, _hash_kernel, _search_kernel in self._contexts:
            self._result_bufs.append(cl.Buffer(ctx, mf.READ_WRITE | mf.COPY_HOST_PTR, hostbuf=self._zero_result.copy()))
        # Auto-tuned per device: how many nonces per work item, and the
        # global work size, chasing a ~150-300ms dispatch (see _retune).
        self._per_item = {i: 32 for i in range(len(self.devices))}
        self._global_size = {i: 1 << 20 for i in range(len(self.devices))}

    def _gpu_devices(self):
        devices = []
        for platform in self.cl.get_platforms():
            for device in platform.get_devices():
                if device.type & self.cl.device_type.GPU:
                    devices.append(device)
        return devices

    def replace_job(self, job: Job):
        validate_job(job)
        with self._job_lock:
            self._job = job

    def _lane_state(self, job: Job, device_index: int):
        """The precomputed 17-lane constant buffer + patch plan for this
        (job, device). Built once and cached; the kernel never touches
        template bytes and callers never reallocate this per batch."""
        key = (job, device_index)
        cached = self._lane_cache.get(key)
        if cached is not None:
            return cached
        cl = self.cl
        ctx, _queue, _program, _device, _hash_kernel, _search_kernel = self._contexts[device_index]
        plan = lane_patch_plan(job)
        lanes = base_lanes_for_job(job, device_index, self.session_id)
        lanes_np = np.array(lanes, dtype=np.uint64)
        mf = cl.mem_flags
        lanes_buf = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=lanes_np)
        state = (lanes_buf, plan)
        self._lane_cache[key] = state
        return state

    def hash_batch(self, job: Job, counters: list[int], device_index: int = 0):
        validate_job(job)
        if not counters:
            return []
        cl = self.cl
        ctx, queue, _program, _device, hash_kernel, _search_kernel = self._contexts[device_index]
        lanes_buf, plan = self._lane_state(job, device_index)
        counters_np = np.array(counters, dtype=np.uint64)
        out = np.empty(len(counters) * 32, dtype=np.uint8)
        mf = cl.mem_flags
        counters_buf = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=counters_np)
        out_buf = cl.Buffer(ctx, mf.WRITE_ONLY, out.nbytes)
        hash_kernel.set_args(
            lanes_buf,
            np.int32(plan["l0"]),
            np.int32(plan["l1"]),
            np.uint32(plan["s0"]),
            np.uint64(plan["mask0"]),
            np.uint64(plan["mask1"]),
            np.uint32(plan["available"]),
            np.uint32(plan["big_endian"]),
            counters_buf,
            out_buf,
        )
        cl.enqueue_nd_range_kernel(queue, hash_kernel, (len(counters),), None)
        cl.enqueue_copy(queue, out, out_buf).wait()
        return [bytes(out[i * 32 : (i + 1) * 32]) for i in range(len(counters))]

    def hash_raw(self, preimage: bytes, device_index: int = 0) -> bytes:
        """keccak256 of an already fully patched preimage (<=135 bytes), via
        the kernel's hash_batch path with a no-op patch plan (mask0=0, so no
        counter bits are OR-ed in). Used by `cli.py hash` to cross-check the
        kernel against the reference for a literal, caller-supplied nonce."""
        if not 1 <= len(preimage) <= 135:
            raise ValueError("preimage length must be 1..135 bytes")
        cl = self.cl
        ctx, queue, _program, _device, hash_kernel, _search_kernel = self._contexts[device_index]
        lanes_np = np.array(pack_lanes(padded_block(preimage)), dtype=np.uint64)
        mf = cl.mem_flags
        lanes_buf = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=lanes_np)
        counters_buf = cl.Buffer(ctx, mf.READ_ONLY | mf.COPY_HOST_PTR, hostbuf=np.array([0], dtype=np.uint64))
        out = np.empty(32, dtype=np.uint8)
        out_buf = cl.Buffer(ctx, mf.WRITE_ONLY, out.nbytes)
        hash_kernel.set_args(
            lanes_buf,
            np.int32(0),
            np.int32(-1),
            np.uint32(0),
            np.uint64(0),
            np.uint64(0),
            np.uint32(1),
            np.uint32(0),
            counters_buf,
            out_buf,
        )
        cl.enqueue_nd_range_kernel(queue, hash_kernel, (1,), None)
        cl.enqueue_copy(queue, out, out_buf).wait()
        return bytes(out)

    def _kernel_search_once(self, job: Job, base: int, global_size: int, device_index: int, per_item: int):
        """Dispatch one search batch of global_size * per_item nonces
        starting at `base`. Reuses the persistent lane/result buffers; only
        resets the result counter (a 10-ulong copy) between dispatches."""
        cl = self.cl
        ctx, queue, _program, _device, _hash_kernel, search_kernel = self._contexts[device_index]
        lanes_buf, plan = self._lane_state(job, device_index)
        result_buf = self._result_bufs[device_index]
        cl.enqueue_copy(queue, result_buf, self._zero_result)
        search_kernel.set_args(
            lanes_buf,
            np.int32(plan["l0"]),
            np.int32(plan["l1"]),
            np.uint32(plan["s0"]),
            np.uint64(plan["mask0"]),
            np.uint64(plan["mask1"]),
            np.uint32(plan["available"]),
            np.uint32(plan["big_endian"]),
            np.uint32(job.required_bits),
            np.uint64(base),
            np.uint32(per_item),
            result_buf,
        )
        cl.enqueue_nd_range_kernel(queue, search_kernel, (global_size,), None)
        result = np.empty(10, dtype=np.uint64)
        cl.enqueue_copy(queue, result, result_buf).wait()
        hit_count = min(int(result[0] & 0xFFFFFFFF), 8)
        found = [int(result[i + 1]) for i in range(hit_count)]
        return found, global_size * per_item

    def _retune(self, device_index: int, global_size: int, per_item: int, elapsed: float):
        """Chase a ~150-300ms dispatch time: grow global size first (cheap),
        then per_item (costs registers); shrink in the opposite order."""
        target_lo, target_hi = 0.15, 0.30
        if elapsed < target_lo:
            if global_size < (1 << 24):
                global_size <<= 1
            elif per_item < 64:
                per_item = min(64, per_item * 2)
        elif elapsed > target_hi:
            if per_item > 8:
                per_item = max(8, per_item // 2)
            elif global_size > (1 << 14):
                global_size >>= 1
        self._global_size[device_index] = global_size
        self._per_item[device_index] = per_item
        return global_size, per_item

    def _search_device(self, job: Job, device_index: int, on_progress, stop_event, corrupt_hits: bool):
        start_time = time.perf_counter()
        hashes_done = 0
        counter = job.start_counter
        max_counter = 1 << (min(8, job.nonce_width) * 8)
        global_size = self._global_size.get(device_index, 1 << 20)
        per_item = self._per_item.get(device_index, 32)

        while counter < max_counter and not stop_event.is_set():
            if job.timeout_s is not None and time.perf_counter() - start_time >= job.timeout_s:
                return None
            if job.max_hashes is not None and hashes_done >= job.max_hashes:
                return None
            remaining = max_counter - counter
            if job.max_hashes is not None:
                remaining = min(remaining, job.max_hashes - hashes_done)
            want = min(global_size * per_item, remaining)
            this_global = max(1, int((want + per_item - 1) // per_item))

            t0 = time.perf_counter()
            found, covered = self._kernel_search_once(job, counter, this_global, device_index, per_item)
            dispatch_elapsed = time.perf_counter() - t0

            for rel in found:
                hit_counter = counter + rel
                preimage = patch_nonce(job, hit_counter, device_index, self.session_id)
                digest = keccak256(preimage)
                if corrupt_hits:
                    digest = b"\xff" + digest[1:]
                zeros = leading_zero_bits(digest)
                if zeros >= job.required_bits:
                    seconds = time.perf_counter() - start_time
                    return {
                        "nonce_hex": preimage[job.nonce_offset : job.nonce_offset + job.nonce_width].hex(),
                        "preimage_hex": preimage.hex(),
                        "hash_hex": digest.hex(),
                        "leading_zero_bits": zeros,
                        "device": self.devices[device_index].name,
                        "hashes_done": hashes_done + rel + 1,
                        "seconds": seconds,
                    }
                print("KERNEL BUG: rejected unverifiable hit")
                if corrupt_hits:
                    return None

            hashes_done += covered
            counter += covered
            elapsed = time.perf_counter() - start_time
            if on_progress:
                on_progress({"hashes_done": hashes_done, "seconds": elapsed, "device": self.devices[device_index].name, "device_index": device_index})
            global_size, per_item = self._retune(device_index, global_size, per_item, dispatch_elapsed)
        return None

    def search(self, job: Job, on_progress=None, stop_event=None, corrupt_hits=False):
        validate_job(job)
        stop_event = stop_event or threading.Event()
        result_holder = {"solution": None}
        lock = threading.Lock()

        def worker(device_index):
            solution = self._search_device(job, device_index, on_progress, stop_event, corrupt_hits)
            if solution is not None:
                with lock:
                    if result_holder["solution"] is None:
                        result_holder["solution"] = solution
                stop_event.set()

        threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(len(self.devices))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return result_holder["solution"]

    def _bench_device(self, seconds: float, device_index: int):
        job = Job(os.urandom(116), 20, 32, "big", 255, 0, None, seconds)
        global_size = self._global_size.get(device_index, 1 << 20)
        per_item = self._per_item.get(device_index, 32)
        start = time.perf_counter()
        hashes = 0
        counter = 0
        while time.perf_counter() - start < seconds:
            t0 = time.perf_counter()
            _found, covered = self._kernel_search_once(job, counter, global_size, device_index, per_item)
            dispatch_elapsed = time.perf_counter() - t0
            hashes += covered
            counter += covered
            global_size, per_item = self._retune(device_index, global_size, per_item, dispatch_elapsed)
        elapsed = time.perf_counter() - start
        return {"device": self.devices[device_index].name, "hashes": hashes, "seconds": elapsed, "hps": hashes / elapsed}

    def bench(self, seconds: float):
        results = [None] * len(self.devices)

        def worker(device_index):
            results[device_index] = self._bench_device(seconds, device_index)

        threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(len(self.devices))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        total_hashes = sum(r["hashes"] for r in results)
        total_seconds = max(r["seconds"] for r in results)
        summary = {
            "devices": results,
            "device": results[0]["device"] if len(results) == 1 else f"{len(results)} devices",
            "hashes": total_hashes,
            "seconds": total_seconds,
            "hps": total_hashes / total_seconds,
        }
        return summary


def format_rate(hps):
    if hps >= 1_000_000_000:
        return f"{hps / 1_000_000_000:.3f} GH/s"
    if hps >= 1_000_000:
        return f"{hps / 1_000_000:.3f} MH/s"
    return f"{hps:.0f} H/s"


def json_dump(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)
