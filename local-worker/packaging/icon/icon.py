"""Generate the original AIPSTER worker tray icon (stdlib only).

Design (see ICON.md): a near-black rounded tile in the brand palette carrying
a bold geometric peach "A", with a status dot at bottom-right (green = worker
running, red = error, gray = stopped). Legibility is verified at 16x16, the
smallest Windows tray size.

Outputs (all committed except previews/):
  packaging/windows/icons/tray-ok.ico, tray-warn.ico, tray-off.ico
  packaging/icon/tray.svg            vector master (same geometry)
  packaging/icon/previews/*.png      inspection renders (gitignored)

Usage:  python packaging/icon/icon.py
"""
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ICONS = HERE.parent / "windows" / "icons"

TILE = (11, 14, 18, 255)       # near-black, from the Connect illustration
PEACH = (242, 184, 135, 255)   # brand accent
GREEN = (152, 195, 121, 255)   # running
RED = (224, 108, 117, 255)     # error
GRAY = (107, 114, 128, 255)    # stopped
RING = (11, 14, 18, 255)       # status-dot separator ring

SIZES = (16, 20, 24, 32, 40, 48, 64)
STATES = {"ok": GREEN, "warn": RED, "off": GRAY}


class Canvas:
    def __init__(self, size):
        self.size = size
        self.px = bytearray(size * size * 4)

    def set(self, x, y, color):
        if 0 <= x < self.size and 0 <= y < self.size:
            i = (y * self.size + x) * 4
            self.px[i:i + 4] = bytes(color)

    def disc(self, cx, cy, r, color):
        for y in range(int(cy - r - 1), int(cy + r + 2)):
            for x in range(int(cx - r - 1), int(cx + r + 2)):
                if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r:
                    self.set(x, y, color)

    def rect(self, x0, y0, x1, y1, color):
        for y in range(y0, y1):
            for x in range(x0, x1):
                self.set(x, y, color)

    def rounded_tile(self):
        s = self.size
        r = max(2, round(s * 0.22))
        self.rect(r, 0, s - r, s, TILE)
        self.rect(0, r, s, s - r, TILE)
        for cx, cy in ((r, r), (s - 1 - r, r), (r, s - 1 - r), (s - 1 - r, s - 1 - r)):
            self.disc(cx, cy, r, TILE)

    def thick_line(self, x0, y0, x1, y1, w, color):
        steps = int(max(abs(x1 - x0), abs(y1 - y0), 1) * 2)
        for i in range(steps + 1):
            t = i / steps
            self.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, color)

    def glyph_a(self):
        """Bold geometric A: apex top-center, legs to the bottom corners."""
        s = self.size
        pad = max(2, round(s * 0.16))
        apex_x = s / 2 - 0.5
        apex_y = pad
        foot_y = s - pad
        foot_l = pad
        foot_r = s - 1 - pad
        w = max(2.0, s / 7.5)
        self.thick_line(apex_x, apex_y, foot_l, foot_y, w, PEACH)
        self.thick_line(apex_x, apex_y, foot_r, foot_y, w, PEACH)
        bar_y = apex_y + (foot_y - apex_y) * 0.62
        t = (bar_y - apex_y) / (foot_y - apex_y)
        self.thick_line(apex_x + (foot_l - apex_x) * t, bar_y,
                        apex_x + (foot_r - apex_x) * t, bar_y, w * 0.9, PEACH)

    def status_dot(self, color):
        s = self.size
        cx, cy = s - 1 - s * 0.16, s - 1 - s * 0.16
        self.disc(cx, cy, s * 0.17, RING)
        self.disc(cx, cy, s * 0.12, color)

    def png(self):
        s = self.size
        raw = b"".join(b"\x00" + bytes(self.px[y * s * 4:(y + 1) * s * 4])
                       for y in range(s))

        def chunk(kind, data):
            return (struct.pack(">I", len(data)) + kind + data
                    + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

        return (b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", s, s, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
                + chunk(b"IEND", b""))


def write_ico(path, renders):
    """ICO container with PNG-compressed entries (Windows Vista+)."""
    header = struct.pack("<HHH", 0, 1, len(renders))
    entries, offset, bodies = b"", 6 + 16 * len(renders), b""
    for size, data in renders:
        byte = size if size < 256 else 0
        entries += struct.pack("<BBBBHHII", byte, byte, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        bodies += data
    path.write_bytes(header + entries + bodies)


def draw(size, state):
    canvas = Canvas(size)
    canvas.rounded_tile()
    canvas.glyph_a()
    canvas.status_dot(STATES[state])
    return canvas.png()


def write_svg(path):
    s = 64
    pad = round(s * 0.16)
    apex_x = s / 2 - 0.5
    foot_y = s - pad
    foot_l, foot_r = pad, s - 1 - pad
    bar_y = pad + (foot_y - pad) * 0.62
    t = (bar_y - pad) / (foot_y - pad)
    w = s / 7.5
    dot_cx = dot_cy = s - 1 - s * 0.16
    path.write_text(
        f"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {s} {s}\">\n"
        f"<rect x=\"0\" y=\"0\" width=\"{s}\" height=\"{s}\" rx=\"{round(s * 0.22)}\" fill=\"#0b0e12\"/>\n"
        f"<g stroke=\"#f2b887\" stroke-width=\"{w:.1f}\" stroke-linecap=\"round\" fill=\"none\">\n"
        f"<path d=\"M{apex_x:.1f},{pad} L{foot_l},{foot_y} M{apex_x:.1f},{pad} L{foot_r},{foot_y} "
        f"M{apex_x + (foot_l - apex_x) * t:.1f},{bar_y:.1f} L{apex_x + (foot_r - apex_x) * t:.1f},{bar_y:.1f}\"/>\n"
        "</g>\n"
        f"<circle cx=\"{dot_cx:.1f}\" cy=\"{dot_cy:.1f}\" r=\"{s * 0.17:.1f}\" fill=\"#0b0e12\"/>\n"
        f"<circle cx=\"{dot_cx:.1f}\" cy=\"{dot_cy:.1f}\" r=\"{s * 0.12:.1f}\" fill=\"#98c379\"/>\n"
        "</svg>\n", encoding="utf-8")


def main():
    ICONS.mkdir(parents=True, exist_ok=True)
    previews = HERE / "previews"
    previews.mkdir(exist_ok=True)
    for state in STATES:
        renders = []
        for size in SIZES:
            data = draw(size, state)
            renders.append((size, data))
            (previews / f"tray-{state}-{size}.png").write_bytes(data)
        write_ico(ICONS / f"tray-{state}.ico", renders)
        print(f"tray-{state}.ico: {len(renders)} sizes")
    write_svg(HERE / "tray.svg")
    print("tray.svg written")


if __name__ == "__main__":
    main()
