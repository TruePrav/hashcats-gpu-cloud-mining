MASK64 = (1 << 64) - 1

RHO = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]

RC = [
    0x0000000000000001,
    0x0000000000008082,
    0x800000000000808A,
    0x8000000080008000,
    0x000000000000808B,
    0x0000000080000001,
    0x8000000080008081,
    0x8000000000008009,
    0x000000000000008A,
    0x0000000000000088,
    0x0000000080008009,
    0x000000008000000A,
    0x000000008000808B,
    0x800000000000008B,
    0x8000000000008089,
    0x8000000000008003,
    0x8000000000008002,
    0x8000000000000080,
    0x000000000000800A,
    0x800000008000000A,
    0x8000000080008081,
    0x8000000000008080,
    0x0000000080000001,
    0x8000000080008008,
]


def _rol(value, shift):
    shift &= 63
    if shift == 0:
        return value & MASK64
    return ((value << shift) | (value >> (64 - shift))) & MASK64


def _keccak_f(state):
    for rc in RC:
        c = [state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                state[x + 5 * y] ^= d[x]

        b = [0] * 25
        for x in range(5):
            for y in range(5):
                b[y + 5 * ((2 * x + 3 * y) % 5)] = _rol(state[x + 5 * y], RHO[x][y])

        for x in range(5):
            for y in range(5):
                state[x + 5 * y] = b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y]) & b[((x + 2) % 5) + 5 * y])

        state[0] ^= rc


def keccak256(payload):
    rate = 136
    state = [0] * 25
    offset = 0

    while offset + rate <= len(payload):
        block = payload[offset : offset + rate]
        for lane in range(rate // 8):
            state[lane] ^= int.from_bytes(block[lane * 8 : lane * 8 + 8], "little")
        _keccak_f(state)
        offset += rate

    block = bytearray(rate)
    tail = payload[offset:]
    block[: len(tail)] = tail
    block[len(tail)] ^= 0x01
    block[-1] ^= 0x80
    for lane in range(rate // 8):
        state[lane] ^= int.from_bytes(block[lane * 8 : lane * 8 + 8], "little")
    _keccak_f(state)

    out = bytearray()
    for lane in range(4):
        out.extend(state[lane].to_bytes(8, "little"))
    return bytes(out)


def leading_zero_bits(hash_bytes):
    if len(hash_bytes) != 32:
        raise ValueError("leading_zero_bits requires a 32-byte hash")
    total = 0
    for value in hash_bytes:
        if value == 0:
            total += 8
            continue
        return total + (8 - value.bit_length())
    return 256
