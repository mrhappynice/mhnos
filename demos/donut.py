import sys
import time

W, H = 80, 22
SIZE = W * H
PALETTE = b".,-~:;=!*#$@"

def R(mul: int, shift: int, x: int, y: int):
    _ = x
    x -= (mul * y) >> shift
    y += (mul * _) >> shift
    _ = (3145728 - x * x - y * y) >> 11
    x = (x * _) >> 10
    y = (y * _) >> 10
    return x, y

def precompute_rotations(count: int, mul: int, shift: int, c0: int, s0: int):
    """Return lists of (c, s) for count steps, starting at (c0,s0), using R(mul,shift)."""
    cs = [0] * count
    ss = [0] * count
    c, s = c0, s0
    for k in range(count):
        cs[k] = c
        ss[k] = s
        c, s = R(mul, shift, c, s)
    return cs, ss

def render():
    sA, cA = 1024, 0
    sB, cB = 1024, 0

    # Clear once, then only cursor-up per frame
    sys.stdout.write("\x1b[2J\x1b[H")
    sys.stdout.flush()

    try:
        while True:
            # Precompute angle steps for this frame (big speed win in Python)
            ci_list, si_list = precompute_rotations(324, 5, 8, 1024, 0)  # i loop
            cj_list, sj_list = precompute_rotations(90,  9, 7, 1024, 0)  # j loop

            b = bytearray(b" " * SIZE)
            z = bytearray([127] * SIZE)

            R1, R2, K2 = 1, 2048, 5120 * 1024

            # local bindings (tiny but helps)
            Wloc = W
            Hloc = H
            pal = PALETTE
            zbuf = z
            bbuf = b

            for jj in range(90):
                cj = cj_list[jj]
                sj = sj_list[jj]

                # stuff depending only on j
                x0_base = R1 * cj + R2      # x0 when used with ci/si
                x2 = (cA * sj) >> 10
                x5 = (sA * sj) >> 10
                cjsB = (cj * sB) >> 10

                for ii in range(324):
                    ci = ci_list[ii]
                    si = si_list[ii]

                    x1 = (ci * x0_base) >> 10
                    x3 = (si * x0_base) >> 10
                    x4 = x2 - ((sA * x3) >> 10)
                    x6 = K2 + 1024 * x5 + cA * x3
                    x7 = (cj * si) >> 10

                    # project
                    x = 40 + (30 * (cB * x1 - sB * x4)) // x6
                    y = 12 + (15 * (cB * x4 + sB * x1)) // x6

                    # light
                    N = (
                        (
                            -cA * x7
                            - cB * (((-sA * x7) >> 10) + x2)
                            - ci * cjsB
                        ) >> 10
                    )
                    N = (N - x5) >> 7

                    if 0 < y < Hloc and 0 < x < Wloc:
                        o = x + Wloc * y
                        zz = (x6 - K2) >> 15
                        if zz < zbuf[o]:
                            zbuf[o] = zz if 0 <= zz <= 255 else 255
                            idx = N if N > 0 else 0
                            if idx >= len(pal):
                                idx = len(pal) - 1
                            bbuf[o] = pal[idx]

            # Build a single output blob (fewer writes = smoother)
            # Insert newlines every row
            out = bytearray((W + 1) * H)
            p = 0
            src = 0
            for _ in range(H):
                out[p:p+W] = b[src:src+W]
                out[p+W] = 10
                p += W + 1
                src += W

            sys.stdout.buffer.write(out)
            sys.stdout.flush()

            # rotate A/B for next frame
            cA, sA = R(5, 7, cA, sA)
            cB, sB = R(5, 8, cB, sB)

            time.sleep(0.015)
            sys.stdout.write("\x1b[23A")
    except KeyboardInterrupt:
        sys.stdout.write("\n")
        sys.stdout.flush()

if __name__ == "__main__":
    render()
