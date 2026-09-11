import random
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker.engine import HashcatMiner, Job, OpenCLUnavailable, patch_nonce, validate_job
from worker.ref_keccak import keccak256, leading_zero_bits


class KernelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.miner = HashcatMiner()
        except OpenCLUnavailable as exc:
            raise unittest.SkipTest(f"no OpenCL GPU device: {exc}") from exc

    def test_hash_batch_matches_reference(self):
        rng = random.Random(12345)
        cases = [(84, 0, 8), (84, 20, 32), (116, 52, 32), (135, 60, 8), (135, 7, 32)]
        for length, offset, width in cases:
            template = bytes(rng.randrange(256) for _ in range(length))
            job = Job(template, offset, width, "big", 0, 0, 2000, None)
            counters = [rng.randrange(0, 1 << min(32, width * 8)) for _ in range(2000)]
            hashes = self.miner.hash_batch(job, counters, device_index=0)
            for counter, got in zip(counters, hashes):
                with self.subTest(length=length, offset=offset, width=width, counter=counter):
                    self.assertEqual(got, keccak256(patch_nonce(job, counter, 0, self.miner.session_id)))

    def test_search_finds_and_verifies_hit(self):
        job = Job(bytes.fromhex("42" * 116), 20, 32, "big", 20, 0, None, 10)
        solution = self.miner.search(job, None, threading.Event())
        self.assertIsNotNone(solution)
        self.assertGreaterEqual(solution["leading_zero_bits"], 20)
        self.assertEqual(bytes.fromhex(solution["hash_hex"]), keccak256(bytes.fromhex(solution["preimage_hex"])))

    def test_rejects_template_over_135_bytes(self):
        with self.assertRaisesRegex(ValueError, "template length"):
            validate_job(Job(bytes(136), 0, 8, "big", 0, 0, 1, None))

    def test_session_prefixes_are_disjoint(self):
        job = Job(bytes(84), 12, 32, "big", 0, 0, 1, None)
        one = patch_nonce(job, 5, device_index=0, session_id=0x11111111)[12:44]
        two = patch_nonce(job, 5, device_index=1, session_id=0x11111111)[12:44]
        three = patch_nonce(job, 5, device_index=0, session_id=0x22222222)[12:44]
        self.assertNotEqual(one[:5], two[:5])
        self.assertNotEqual(one[:4], three[:4])

    def test_corrupted_hit_is_rejected(self):
        job = Job(bytes.fromhex("55" * 84), 0, 8, "big", 8, 0, None, 5)
        solution = self.miner.search(job, None, threading.Event(), corrupt_hits=True)
        self.assertIsNone(solution)


if __name__ == "__main__":
    unittest.main()
