import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker.ref_keccak import keccak256


# Vectors generated from the repo root with:
# node -e "import('viem').then(v=>console.log(v.keccak256('0x00')))"
# node -e "import('viem').then(v=>console.log(v.keccak256('0x' + '11'.repeat(84))))"
# node -e "import('viem').then(v=>console.log(v.keccak256('0x' + '22'.repeat(116))))"
# node -e "import('viem').then(v=>console.log(v.keccak256('0x' + '33'.repeat(135))))"
VECTORS = [
    (b"", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"),
    (bytes.fromhex("00"), "bc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a"),
    (
        bytes.fromhex("11" * 84),
        "eb9f01074fdd309ed340fd388b8a0782b03bf9f6626e9c811c69c8a22f4c7998",
    ),
    (
        bytes.fromhex("22" * 116),
        "0bbd1aa227e6361618cba746d7014489ef36fb6cc818eb1f3597592ee6109689",
    ),
    (
        bytes.fromhex("33" * 135),
        "425d083f83a7f247d441bc10c5abc5bdbb9edc05b59b61c4696195f9ba474763",
    ),
]


class RefKeccakTest(unittest.TestCase):
    def test_vectors(self):
        for payload, expected in VECTORS:
            with self.subTest(length=len(payload)):
                self.assertEqual(keccak256(payload).hex(), expected)


if __name__ == "__main__":
    unittest.main()
