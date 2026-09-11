import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker.engine import (
    Job,
    apply_lane_patch,
    base_lanes_for_job,
    lane_patch_plan,
    pack_lanes,
    padded_block,
    patch_nonce,
)


def lanes_from_patch_nonce(job, counter, device_index, session_id):
    block = patch_nonce(job, counter, device_index, session_id)
    return pack_lanes(padded_block(block))


class LanePatchTest(unittest.TestCase):
    def _check(self, template_len, offset, width, endian, counters):
        job = Job(bytes(range(256))[:template_len] if template_len <= 256 else bytes(template_len), offset, width, endian, 0, 0, None, None)
        device_index = 3
        session_id = 0xDEADBEEF
        base = base_lanes_for_job(job, device_index, session_id)
        plan = lane_patch_plan(job)
        for counter in counters:
            with self.subTest(offset=offset, width=width, endian=endian, counter=counter):
                got = apply_lane_patch(base, plan, counter)
                expected = lanes_from_patch_nonce(job, counter, device_index, session_id)
                self.assertEqual(got, expected)

    def test_widths_both_endians(self):
        for width in (1, 3, 8, 20, 32):
            for endian in ("big", "little"):
                available_bits = min(8, width) * 8
                max_counter = (1 << available_bits) - 1
                counters = sorted({0, 1, max_counter, max_counter // 2, 255 & max_counter})
                self._check(84, 4, width, endian, counters)

    def test_lane_boundary_spanning_field(self):
        # offset 52, width 8: abs_pos=52, l0=52//8=6, s0=(52%8)*8=32 -> spans lanes 6 and 7.
        for endian in ("big", "little"):
            self._check(116, 52, 8, endian, [0, 1, 0xFF, 0x1234, (1 << 64) - 1])

    def test_lane_boundary_reported_by_plan(self):
        job = Job(bytes(116), 52, 8, "big", 0, 0, None, None)
        plan = lane_patch_plan(job)
        self.assertEqual(plan["l0"], 6)
        self.assertEqual(plan["l1"], 7)
        self.assertEqual(plan["s0"], 32)


if __name__ == "__main__":
    unittest.main()
