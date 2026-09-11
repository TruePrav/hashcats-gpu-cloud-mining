import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker.ref_keccak import leading_zero_bits


class LeadingZeroBitsTest(unittest.TestCase):
    def test_counts_full_bytes_and_partial_byte(self):
        self.assertEqual(leading_zero_bits(bytes.fromhex("ff" + "00" * 31)), 0)
        self.assertEqual(leading_zero_bits(bytes.fromhex("0f" + "00" * 31)), 4)
        self.assertEqual(leading_zero_bits(bytes.fromhex("00" "7f" + "00" * 30)), 9)

    def test_all_zero_hash_counts_256(self):
        self.assertEqual(leading_zero_bits(bytes(32)), 256)

    def test_rejects_non_hash_length(self):
        with self.assertRaises(ValueError):
            leading_zero_bits(b"\x00")


if __name__ == "__main__":
    unittest.main()
