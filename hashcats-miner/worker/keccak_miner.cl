// Fast lane-based Keccak256 nonce search.
//
// The host precomputes the 17 absorbed template lanes (padding already XORed
// in, nonce region zeroed) once per job and passes them as a small constant
// buffer. It also precomputes a "patch plan": which lane(s) the low 8-byte
// counter lands in (l0, optionally l1), the bit shift s0, and masks to clear
// that region before OR-ing the counter in. None of that depends on the
// counter value, so every work item just does lane arithmetic, never touches
// template bytes, and runs a fully unrolled Keccak-f[1600] on named
// registers (no private arrays, no loops, no modulo in the round function).

inline ulong bswap64(ulong x) {
  x = (x >> 32) | (x << 32);
  x = ((x & 0xFFFF0000FFFF0000UL) >> 16) | ((x & 0x0000FFFF0000FFFFUL) << 16);
  x = ((x & 0xFF00FF00FF00FF00UL) >> 8) | ((x & 0x00FF00FF00FF00FFUL) << 8);
  return x;
}

// Pack the low `available` bytes of counter the way they would sit in the
// preimage's byte order, then reinterpret those bytes little-endian (how
// lanes are packed). For little-endian nonce fields this is the identity
// (masked); for big-endian fields it is a byte reversal within the field
// width. available is 1..8, uniform across the whole dispatch (job layout),
// so this branch never diverges between work items.
inline ulong pack_counter(ulong counter, uint available, uint big_endian) {
  if (!big_endian) {
    return available >= 8 ? counter : (counter & ((1UL << (available * 8)) - 1));
  }
  if (available == 8) return bswap64(counter);
  ulong result = 0;
  for (uint i = 0; i < available; i++) {
    result |= ((counter >> (8 * i)) & 0xFFUL) << (8 * (available - 1 - i));
  }
  return result;
}

// One fully unrolled Keccak-f[1600] round on named registers a0..a24.
// rc is a compile-time literal per call site (24 call sites below), so
// nothing here is array-indexed or loop-controlled.
#define KECCAK_ROUND(rc) do { \
    ulong c0 = a0 ^ a5 ^ a10 ^ a15 ^ a20; \
    ulong c1 = a1 ^ a6 ^ a11 ^ a16 ^ a21; \
    ulong c2 = a2 ^ a7 ^ a12 ^ a17 ^ a22; \
    ulong c3 = a3 ^ a8 ^ a13 ^ a18 ^ a23; \
    ulong c4 = a4 ^ a9 ^ a14 ^ a19 ^ a24; \
    ulong d0 = c4 ^ rotate(c1, 1UL); \
    ulong d1 = c0 ^ rotate(c2, 1UL); \
    ulong d2 = c1 ^ rotate(c3, 1UL); \
    ulong d3 = c2 ^ rotate(c4, 1UL); \
    ulong d4 = c3 ^ rotate(c0, 1UL); \
    a0 ^= d0; a5 ^= d0; a10 ^= d0; a15 ^= d0; a20 ^= d0; \
    a1 ^= d1; a6 ^= d1; a11 ^= d1; a16 ^= d1; a21 ^= d1; \
    a2 ^= d2; a7 ^= d2; a12 ^= d2; a17 ^= d2; a22 ^= d2; \
    a3 ^= d3; a8 ^= d3; a13 ^= d3; a18 ^= d3; a23 ^= d3; \
    a4 ^= d4; a9 ^= d4; a14 ^= d4; a19 ^= d4; a24 ^= d4; \
    ulong b0 = a0; \
    ulong b1 = rotate(a6, 44UL); \
    ulong b2 = rotate(a12, 43UL); \
    ulong b3 = rotate(a18, 21UL); \
    ulong b4 = rotate(a24, 14UL); \
    ulong b5 = rotate(a3, 28UL); \
    ulong b6 = rotate(a9, 20UL); \
    ulong b7 = rotate(a10, 3UL); \
    ulong b8 = rotate(a16, 45UL); \
    ulong b9 = rotate(a22, 61UL); \
    ulong b10 = rotate(a1, 1UL); \
    ulong b11 = rotate(a7, 6UL); \
    ulong b12 = rotate(a13, 25UL); \
    ulong b13 = rotate(a19, 8UL); \
    ulong b14 = rotate(a20, 18UL); \
    ulong b15 = rotate(a4, 27UL); \
    ulong b16 = rotate(a5, 36UL); \
    ulong b17 = rotate(a11, 10UL); \
    ulong b18 = rotate(a17, 15UL); \
    ulong b19 = rotate(a23, 56UL); \
    ulong b20 = rotate(a2, 62UL); \
    ulong b21 = rotate(a8, 55UL); \
    ulong b22 = rotate(a14, 39UL); \
    ulong b23 = rotate(a15, 41UL); \
    ulong b24 = rotate(a21, 2UL); \
    a0 = b0 ^ (~b1 & b2); a1 = b1 ^ (~b2 & b3); a2 = b2 ^ (~b3 & b4); a3 = b3 ^ (~b4 & b0); a4 = b4 ^ (~b0 & b1); \
    a5 = b5 ^ (~b6 & b7); a6 = b6 ^ (~b7 & b8); a7 = b7 ^ (~b8 & b9); a8 = b8 ^ (~b9 & b5); a9 = b9 ^ (~b5 & b6); \
    a10 = b10 ^ (~b11 & b12); a11 = b11 ^ (~b12 & b13); a12 = b12 ^ (~b13 & b14); a13 = b13 ^ (~b14 & b10); a14 = b14 ^ (~b10 & b11); \
    a15 = b15 ^ (~b16 & b17); a16 = b16 ^ (~b17 & b18); a17 = b17 ^ (~b18 & b19); a18 = b18 ^ (~b19 & b15); a19 = b19 ^ (~b15 & b16); \
    a20 = b20 ^ (~b21 & b22); a21 = b21 ^ (~b22 & b23); a22 = b22 ^ (~b23 & b24); a23 = b23 ^ (~b24 & b20); a24 = b24 ^ (~b20 & b21); \
    a0 ^= (rc); \
  } while (0)

// Patch lane `var` (compile-time index `idx`) with the counter bits if it is
// l0 or l1. l0/l1 are uniform across the dispatch (same job layout for every
// work item), so this if-chain never diverges between work items and lets
// the compiler keep a0..a24 in registers instead of a private array.
#define PATCH_LANE(idx, var) \
  if (l0 == (idx)) { var = (var & ~mask0) | lane0_bits; } \
  if (l1 == (idx)) { var = (var & ~mask1) | lane1_bits; }

// Absorb the (already-lane-packed) template plus one patched counter and run
// Keccak-f[1600], returning the first 4 output lanes (32 bytes) via pointers.
// The 17 base lanes are passed by value (already loaded once by the caller,
// outside its per-nonce loop) so they live in registers instead of being
// re-read from constant memory on every nonce.
inline void keccak_from_counter(
    ulong base0, ulong base1, ulong base2, ulong base3, ulong base4,
    ulong base5, ulong base6, ulong base7, ulong base8, ulong base9,
    ulong base10, ulong base11, ulong base12, ulong base13, ulong base14,
    ulong base15, ulong base16,
    int l0, int l1, uint s0, ulong mask0, ulong mask1,
    uint available, uint big_endian,
    ulong counter,
    ulong *r0, ulong *r1, ulong *r2, ulong *r3) {
  ulong packed = pack_counter(counter, available, big_endian);
  ulong lane0_bits = (packed << s0) & mask0;
  ulong lane1_bits = (l1 >= 0) ? ((packed >> (64 - s0)) & mask1) : 0UL;

  ulong a0 = base0, a1 = base1, a2 = base2, a3 = base3, a4 = base4;
  ulong a5 = base5, a6 = base6, a7 = base7, a8 = base8, a9 = base9;
  ulong a10 = base10, a11 = base11, a12 = base12, a13 = base13, a14 = base14;
  ulong a15 = base15, a16 = base16;
  ulong a17 = 0, a18 = 0, a19 = 0, a20 = 0, a21 = 0, a22 = 0, a23 = 0, a24 = 0;

  PATCH_LANE(0, a0) PATCH_LANE(1, a1) PATCH_LANE(2, a2) PATCH_LANE(3, a3) PATCH_LANE(4, a4)
  PATCH_LANE(5, a5) PATCH_LANE(6, a6) PATCH_LANE(7, a7) PATCH_LANE(8, a8) PATCH_LANE(9, a9)
  PATCH_LANE(10, a10) PATCH_LANE(11, a11) PATCH_LANE(12, a12) PATCH_LANE(13, a13) PATCH_LANE(14, a14)
  PATCH_LANE(15, a15) PATCH_LANE(16, a16)

  KECCAK_ROUND(0x0000000000000001UL);
  KECCAK_ROUND(0x0000000000008082UL);
  KECCAK_ROUND(0x800000000000808aUL);
  KECCAK_ROUND(0x8000000080008000UL);
  KECCAK_ROUND(0x000000000000808bUL);
  KECCAK_ROUND(0x0000000080000001UL);
  KECCAK_ROUND(0x8000000080008081UL);
  KECCAK_ROUND(0x8000000000008009UL);
  KECCAK_ROUND(0x000000000000008aUL);
  KECCAK_ROUND(0x0000000000000088UL);
  KECCAK_ROUND(0x0000000080008009UL);
  KECCAK_ROUND(0x000000008000000aUL);
  KECCAK_ROUND(0x000000008000808bUL);
  KECCAK_ROUND(0x800000000000008bUL);
  KECCAK_ROUND(0x8000000000008089UL);
  KECCAK_ROUND(0x8000000000008003UL);
  KECCAK_ROUND(0x8000000000008002UL);
  KECCAK_ROUND(0x8000000000000080UL);
  KECCAK_ROUND(0x000000000000800aUL);
  KECCAK_ROUND(0x800000008000000aUL);
  KECCAK_ROUND(0x8000000080008081UL);
  KECCAK_ROUND(0x8000000000008080UL);
  KECCAK_ROUND(0x0000000080000001UL);
  KECCAK_ROUND(0x8000000080008008UL);

  *r0 = a0; *r1 = a1; *r2 = a2; *r3 = a3;
}

// Verification entry point: one counter per work item, full 32-byte hash out.
// Not the hot path (search is); kept simple for correctness testing.
kernel void hash_batch(
    constant ulong *base_lanes,
    int l0, int l1, uint s0, ulong mask0, ulong mask1,
    uint available, uint big_endian,
    global const ulong *counters,
    global uchar *out) {
  uint gid = get_global_id(0);
  ulong b0 = base_lanes[0], b1 = base_lanes[1], b2 = base_lanes[2], b3 = base_lanes[3], b4 = base_lanes[4];
  ulong b5 = base_lanes[5], b6 = base_lanes[6], b7 = base_lanes[7], b8 = base_lanes[8], b9 = base_lanes[9];
  ulong b10 = base_lanes[10], b11 = base_lanes[11], b12 = base_lanes[12], b13 = base_lanes[13], b14 = base_lanes[14];
  ulong b15 = base_lanes[15], b16 = base_lanes[16];
  ulong r0, r1, r2, r3;
  keccak_from_counter(b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13, b14, b15, b16,
                       l0, l1, s0, mask0, mask1, available, big_endian, counters[gid], &r0, &r1, &r2, &r3);
  for (uint j = 0; j < 8; j++) out[gid * 32 + j] = (uchar)(r0 >> (8 * j));
  for (uint j = 0; j < 8; j++) out[gid * 32 + 8 + j] = (uchar)(r1 >> (8 * j));
  for (uint j = 0; j < 8; j++) out[gid * 32 + 16 + j] = (uchar)(r2 >> (8 * j));
  for (uint j = 0; j < 8; j++) out[gid * 32 + 24 + j] = (uchar)(r3 >> (8 * j));
}

// Hot path: `per_item` nonces per work item, lane-0-only leading-zero check
// via clz of the byte-swapped lane (the 256-bit big-endian hash's top 64
// bits equal bswap64(lane0); see keccak_from_counter's output convention).
kernel void search(
    constant ulong *base_lanes,
    int l0, int l1, uint s0, ulong mask0, ulong mask1,
    uint available, uint big_endian,
    uint required_bits,
    ulong base_counter, uint per_item,
    global ulong *result) {
  ulong gid = (ulong)get_global_id(0);
  ulong start = base_counter + gid * (ulong)per_item;
  ulong b0 = base_lanes[0], b1 = base_lanes[1], b2 = base_lanes[2], b3 = base_lanes[3], b4 = base_lanes[4];
  ulong b5 = base_lanes[5], b6 = base_lanes[6], b7 = base_lanes[7], b8 = base_lanes[8], b9 = base_lanes[9];
  ulong b10 = base_lanes[10], b11 = base_lanes[11], b12 = base_lanes[12], b13 = base_lanes[13], b14 = base_lanes[14];
  ulong b15 = base_lanes[15], b16 = base_lanes[16];
  for (uint i = 0; i < per_item; i++) {
    ulong counter = start + i;
    ulong r0, r1, r2, r3;
    keccak_from_counter(b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13, b14, b15, b16,
                         l0, l1, s0, mask0, mask1, available, big_endian, counter, &r0, &r1, &r2, &r3);

    uint hit;
    if (required_bits <= 64) {
      hit = clz(bswap64(r0)) >= required_bits;
    } else {
      // Rare path: required_bits > 64 needs the full 4-lane check.
      uint zeros;
      ulong v0 = bswap64(r0);
      if (v0 != 0) {
        zeros = clz(v0);
      } else {
        ulong v1 = bswap64(r1);
        if (v1 != 0) {
          zeros = 64 + clz(v1);
        } else {
          ulong v2 = bswap64(r2);
          if (v2 != 0) {
            zeros = 128 + clz(v2);
          } else {
            ulong v3 = bswap64(r3);
            zeros = (v3 != 0) ? (192 + clz(v3)) : 256;
          }
        }
      }
      hit = zeros >= required_bits;
    }

    if (hit) {
      uint slot = atomic_inc((volatile global uint *)result);
      if (slot < 8) result[slot + 1] = gid * (ulong)per_item + i;
    }
  }
}
