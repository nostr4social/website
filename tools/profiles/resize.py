#!/usr/bin/env python3
"""Square-crop and shrink a profile picture for the /about/ cards.

    python3 tools/profiles/resize.py <in> <out.jpg>

240px is twice the 72px the card draws, and 120px at the phone width,
so it stays crisp on a dense display. Called by fetch.mjs; needs Pillow.
"""
import sys

from PIL import Image, ImageOps

SIZE = 240

src, dst = sys.argv[1], sys.argv[2]
im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
w, h = im.size
s = min(w, h)
im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
im = im.resize((SIZE, SIZE), Image.LANCZOS)
im.save(dst, "JPEG", quality=84, optimize=True, progressive=True)
