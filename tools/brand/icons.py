#!/usr/bin/env python3
"""Cut every icon and image of the mark from one master.

    python3 tools/brand/icons.py path/to/mark.png

The master is a square RGBA PNG of the mark alone on transparency. This
trims it to its content and writes, all on the site's ground colour:
favicon.ico (16/32/48), apple-touch-icon.png, icon-192.png, icon-512.png,
icon-512-maskable.png (mark inside the 80% safe zone) and the Open Graph
default; and, on transparency, assets/images/nostr4-mark.png for the lockup.
Pillow only.
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
GROUND = (0x14, 0x11, 0x1C, 255)
MARK_HEIGHT = 576  # the lockup file's height; its width follows the mark

def trimmed(path):
    im = Image.open(path).convert("RGBA")
    return im.crop(im.getbbox())

def place(mark, size, height_ratio, ground=GROUND):
    """The mark centred on a canvas, scaled to `height_ratio` of the canvas height."""
    w, h = size if isinstance(size, tuple) else (size, size)
    mh = round(h * height_ratio)
    mw = round(mark.width * mh / mark.height)
    m = mark.resize((mw, mh), Image.LANCZOS)
    out = Image.new("RGBA", (w, h), ground)
    out.alpha_composite(m, ((w - mw) // 2, (h - mh) // 2))
    return out

def main(src):
    mark = trimmed(src)
    jobs = {
        "apple-touch-icon.png": (180, 0.72),
        "icon-192.png": (192, 0.72),
        "icon-512.png": (512, 0.72),
        "icon-512-maskable.png": (512, 0.52),
        "assets/images/og/default.png": ((1200, 630), 0.53),
    }
    for name, (size, ratio) in jobs.items():
        place(mark, size, ratio).convert("RGB").save(ROOT / name, optimize=True)
        print("wrote", name)
    ico = [place(mark, s, 0.78).convert("RGB") for s in (48, 32, 16)]
    ico[0].save(ROOT / "favicon.ico", format="ICO", sizes=[(48, 48), (32, 32), (16, 16)], append_images=ico[1:])
    print("wrote favicon.ico")
    w = round(mark.width * MARK_HEIGHT / mark.height)
    mark.resize((w, MARK_HEIGHT), Image.LANCZOS).save(ROOT / "assets/images/nostr4-mark.png", optimize=True)
    print(f"wrote assets/images/nostr4-mark.png {w}x{MARK_HEIGHT} — set width/height on lib/lockup.html to match")

if __name__ == "__main__":
    main(sys.argv[1])
