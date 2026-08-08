#!/usr/bin/env python3
"""Generate the PWA icon set with no image-library dependency.

Draws a gradient tile plus a simple camera glyph, supersampled 4x for clean
edges, and writes PNGs by hand (zlib + CRC). Re-run after changing the palette:

    python3 tools/make-icons.py
"""

import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")

# Matches the .brand-mark gradient in css/styles.css.
GRAD = [(0x6D, 0x95, 0xFF), (0xB0, 0x6D, 0xFF), (0xFF, 0x7A, 0x9C)]
SS = 4  # supersampling factor


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(t):
    t = min(1.0, max(0.0, t))
    if t < 0.55:
        return lerp(GRAD[0], GRAD[1], t / 0.55)
    return lerp(GRAD[1], GRAD[2], (t - 0.55) / 0.45)


def in_rounded_rect(x, y, w, h, r, px, py):
    if not (x <= px <= x + w and y <= py <= y + h):
        return False
    if x + r <= px <= x + w - r or y + r <= py <= y + h - r:
        return True
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def render(size, radius_ratio=0.22, art_ratio=1.0):
    """RGBA rows for one icon.

    radius_ratio  corner rounding of the background tile (0 = square, .5 = circle)
    art_ratio     how much of the tile the camera glyph spans; shrink it for
                  maskable icons so a circular crop can't clip the artwork.
    """
    n = size * SS
    radius = n * radius_ratio

    span = n * art_ratio
    off = (n - span) / 2

    body_x = off + span * 0.17
    body_y = off + span * 0.31
    body_w = span * 0.66
    body_h = span * 0.42
    body_r = span * 0.085
    lens_cx = off + span * 0.50
    lens_cy = body_y + body_h * 0.52
    lens_r = span * 0.125
    ring_r = lens_r + span * 0.032
    hump_x = off + span * 0.355
    hump_w = span * 0.19
    hump_y = body_y - span * 0.05
    hump_h = span * 0.065

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    px = x * SS + sx + 0.5
                    py = y * SS + sy + 0.5
                    if not in_rounded_rect(0, 0, n, n, radius, px, py):
                        continue

                    base = gradient(px / n * 0.55 + py / n * 0.45)
                    in_body = (
                        in_rounded_rect(body_x, body_y, body_w, body_h, body_r, px, py)
                        or in_rounded_rect(hump_x, hump_y, hump_w, hump_h, span * 0.02, px, py)
                    )
                    d = math.hypot(px - lens_cx, py - lens_cy)

                    # White camera body, with the lens punched back out to the
                    # gradient and a white ring left around it.
                    if in_body and (d > ring_r or lens_r < d <= ring_r):
                        col = (255, 255, 255)
                    else:
                        col = base

                    r += col[0]
                    g += col[1]
                    b += col[2]
                    a += 255

            total = SS * SS
            row += bytes((r // total, g // total, b // total, a // total))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + row for row in rows)
    comp = zlib.compress(raw, 9)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", comp)
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)
    print(f"{os.path.relpath(path)}  {len(png):,} bytes")


def main():
    os.makedirs(OUT, exist_ok=True)
    write_png(os.path.join(OUT, "icon-192.png"), render(192), 192)
    write_png(os.path.join(OUT, "icon-512.png"), render(512), 512)
    # iOS applies its own squircle mask, so go full-bleed with square corners.
    write_png(os.path.join(OUT, "apple-touch-icon.png"), render(180, radius_ratio=0.0), 180)
    # Maskable icons get cropped to a circle: keep the glyph in the safe zone.
    write_png(os.path.join(OUT, "maskable-512.png"), render(512, radius_ratio=0.0, art_ratio=0.72), 512)


if __name__ == "__main__":
    main()
