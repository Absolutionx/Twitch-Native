#!/usr/bin/env python3
"""Regenerates the NSIS installer sidebar (and header) bitmaps.

The visible text on the Welcome/Finish pages - "Twitch Native", the
tagline, and the version - is baked into sidebar.bmp as pixels, NOT
pulled from tauri.conf.json (only the file-metadata/registry version
uses the {{version}} template). So bumping the app version leaves a
stale version painted in the corner unless this image is regenerated.

Run from src-tauri/nsis/:  python3 make_sidebar.py 2.0.0
Version defaults to whatever tauri.conf.json says, so it stays correct
without passing an argument.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
CONF = HERE.parent / "tauri.conf.json"

# Palette lifted from the app + the original bitmap.
BG = (14, 14, 16)          # #0e0e10 app background
PURPLE = (145, 70, 255)    # #9146ff Twitch brand
WHITE = (239, 239, 241)    # #efeff1 app text
MUTED = (140, 140, 150)    # secondary text

SIDEBAR = (164, 314)       # NSIS MUI welcome/finish sidebar size
HEADER = (150, 57)         # NSIS header size (top strip on inner pages)

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def version() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    try:
        return json.loads(CONF.read_text())["version"]
    except Exception:
        return "0.0.0"


def make_sidebar(ver: str) -> Image.Image:
    w, h = SIDEBAR
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    # Accent bar down the left edge - a single clean vertical stripe,
    # echoing the purple accent the app uses on its own nav.
    d.rectangle([0, 0, 4, h], fill=PURPLE)

    title_a = ImageFont.truetype(FONT_BOLD, 26)
    title_b = ImageFont.truetype(FONT_BOLD, 26)
    tag = ImageFont.truetype(FONT_REG, 12)
    ver_f = ImageFont.truetype(FONT_REG, 12)

    x = 16
    # "Twitch" white over "Native" purple - the two-tone logo lockup
    # from the app's own wordmark.
    d.text((x, 40), "Twitch", font=title_a, fill=WHITE)
    d.text((x, 70), "Native", font=title_b, fill=PURPLE)

    # Thin divider under the wordmark.
    d.rectangle([x, 108, x + 92, 109], fill=(40, 40, 46))

    # Tagline, two short lines.
    d.text((x, 122), "Stream. Chat.", font=tag, fill=MUTED)
    d.text((x, 138), "No browser.", font=tag, fill=MUTED)

    # Version, bottom-left - now sourced from the real app version.
    d.text((x, h - 26), f"v{ver}", font=ver_f, fill=MUTED)

    return img


def make_header(ver: str) -> Image.Image:
    w, h = HEADER
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 3, h], fill=PURPLE)
    f = ImageFont.truetype(FONT_BOLD, 15)
    fv = ImageFont.truetype(FONT_REG, 10)
    d.text((12, 10), "Twitch Native", font=f, fill=WHITE)
    d.text((12, 32), f"v{ver}", font=fv, fill=MUTED)
    return img


def main():
    ver = version()
    # NSIS wants BMP3 (24-bit, no alpha); Pillow writes that by default
    # for an RGB image saved as .bmp.
    make_sidebar(ver).save(HERE / "sidebar.bmp")
    make_header(ver).save(HERE / "header.bmp")
    print(f"Regenerated sidebar.bmp + header.bmp at v{ver}")


if __name__ == "__main__":
    main()
