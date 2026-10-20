#!/usr/bin/env python3
"""Generate every Kora icon and in-app asset from the pixel sprite - Kora's 12x12 creature (the classic body:
apps/web/src/components/sprite/spriteData.ts, BASE) - in near-white on the near-black tile.

The sprite is drawn from the same ASCII map as the app (a test in the web app checks the two stay in step) and scaled
with nearest-neighbour by a WHOLE number of device pixels per sprite pixel, so every edge is crisp at any size. Outputs
(all committed):

  assets/{prod,dev,nightly}/...        macOS icon (1024 canvas, 824 squircle - Apple's pre-Tahoe grid), full-bleed
                                       iOS/universal 1024 PNGs, web favicons (16/32/ICO), apple-touch 180, Windows ICO
  assets/icons/kora-dev/mac-1024.png   the Kora Dev icon: the same sprite with a DEV tag
  apps/web/public/...                  favicon.ico, favicon-16x16.png, favicon-32x32.png, apple-touch-icon.png

The in-app logo is an inline SVG (apps/web/src/components/KoraWordmark.tsx) and the boot splash an inline SVG in
apps/web/index.html, so there is no logo bitmap to regenerate.

The brand mark is the PLAIN body on purpose: it stands for the product (every blob shares that body), while Kora the
Chief wears the crown in-app. Do not add the crown here without also changing the boot splash and favicon.

Run from the repo root:
  python3 scripts/brand/make-icons.py        (needs Pillow)
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
DARK_TOP = (30, 30, 32)
DARK_BOTTOM = (8, 8, 9)
BODY = (237, 237, 240)  # Ink text/strong - the sprite's W
EYE = (9, 9, 11)  # the sprite's K (#0a0a0b is used for the pixels; this is the DEV tag ink)

# The mono palette from spriteData.ts (MONO).
PALETTE = {"W": (237, 237, 240), "S": (169, 171, 179), "K": (10, 10, 11)}

# spriteData.ts BASE, cropped to the 8x8 body (x 2..9, y 3..10): body, shade (S), eyes (K), legs.
BASE = [
    "............",
    "............",
    "............",
    "....WWWW....",
    "...WWWWWS...",
    "..WWWWWWWS..",
    "..WKWWWKWS..",
    "..WKWWWKWS..",
    "..WWWWWWWS..",
    "...WWWWWS...",
    "...WS..WS...",
    "............",
]
BODY_ROWS = [row[2:10] for row in BASE[3:11]]


def sprite(unit: int) -> Image.Image:
    """The 8x8 body at `unit` device px per sprite pixel (nearest-neighbour, crisp)."""
    small = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    for y, row in enumerate(BODY_ROWS):
        for x, ch in enumerate(row):
            if ch != ".":
                small.putpixel((x, y), PALETTE[ch] + (255,))
    return small.resize((8 * unit, 8 * unit), Image.NEAREST)


def mark(size: int, ratio: float) -> Image.Image:
    """The sprite sized to about `ratio` of a size x size square, a whole number of px per sprite pixel."""
    unit = max(1, int(size * ratio) // 8)
    return sprite(unit)


def gradient(size: int) -> Image.Image:
    g = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        g.putpixel((0, y), tuple(round(DARK_TOP[i] + (DARK_BOTTOM[i] - DARK_TOP[i]) * t) for i in range(3)) + (255,))
    return g.resize((size, size))


def rounded_mask(size: int, radius: float, ss: int = 4) -> Image.Image:
    m = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size * ss - 1, size * ss - 1), radius=radius * ss, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def tile(size: int, radius_ratio: float, mark_ratio: float) -> Image.Image:
    """Dark rounded (or square, radius 0) tile filling the canvas with the pixel sprite centred."""
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(gradient(size), (0, 0), rounded_mask(size, size * radius_ratio) if radius_ratio else None)
    m = mark(size, mark_ratio)
    out.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return out


def macos_icon() -> Image.Image:
    """1024 canvas, 824 squircle at 100 px inset, soft drop shadow (Apple's macOS icon grid)."""
    size, body, inset = 1024, 824, 100
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 110), (inset, inset + 12), rounded_mask(body, body * 0.225))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
    canvas.alpha_composite(tile(body, 0.225, 0.56), (inset, inset))
    return canvas


def dev_icon() -> Image.Image:
    """The Kora Dev icon: the macOS icon with a small DEV tag, so the two apps are told apart in the Dock."""
    icon = macos_icon()
    draw = ImageDraw.Draw(icon)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/SFNSMono.ttf", 80)
    except OSError:
        font = ImageFont.load_default()
    text = "DEV"
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    pw, ph = r - l + 56, b - t + 30
    x0, y0 = (1024 - pw) // 2, 100 + 824 - ph - 40
    draw.rounded_rectangle((x0, y0, x0 + pw, y0 + ph), radius=ph // 2, fill=BODY + (255,))
    draw.text((x0 + 28 - l, y0 + 15 - t), text, font=font, fill=EYE + (255,))
    return icon


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size // 1024} KB")


def save_ico(path: Path, sizes: list[int]) -> None:
    big = tile(256, 0.2, 0.66)
    big.save(path, sizes=[(s, s) for s in sizes])
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size // 1024} KB")


def main() -> None:
    # release: the shipped app; checkout: the app run from a source checkout (pnpm start / dev)
    for flavor in ("release", "checkout"):
        d = ROOT / "assets" / "icons" / flavor
        save_png(macos_icon(), d / "mac-1024.png")
        save_png(tile(1024, 0, 0.56), d / "square-1024.png")
        save_png(tile(180, 0, 0.66), d / "apple-touch-180.png")
        save_png(tile(16, 0.2, 0.5), d / "favicon-16.png")
        save_png(tile(32, 0.2, 0.75), d / "favicon-32.png")
        save_ico(d / "favicon.ico", [16, 32, 48])
        save_ico(d / "windows.ico", [16, 24, 32, 48, 64, 128, 256])

    save_png(dev_icon(), ROOT / "assets/icons/kora-dev/mac-1024.png")

    public = ROOT / "apps/web/public"
    save_png(tile(16, 0.2, 0.5), public / "favicon-16x16.png")
    save_png(tile(32, 0.2, 0.75), public / "favicon-32x32.png")
    save_png(tile(180, 0, 0.66), public / "apple-touch-icon.png")
    save_ico(public / "favicon.ico", [16, 32, 48])


if __name__ == "__main__":
    main()
