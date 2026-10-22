"""Draw the Open Graph card (og-image.png) with the Datasetto mark.

Usage: python scripts/brand-assets.py public   (needs Pillow; fonts are read from C:/Windows/Fonts,
adjust FONT_BOLD/FONT_REG on other systems). Re-run when the tagline or the logo changes.
The mark comes from brand/logo-1024.png; the app icons are drawn by brand/generate.mjs, not here.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = sys.argv[1]
TEAL = (18, 168, 157)  # brand teal #12A89D
ORANGE = (255, 106, 61)  # brand persimmon #FF6A3D
BASE = (30, 31, 34)
BRIGHT = (242, 243, 245)
MUTED = (148, 155, 164)
BRAND = (88, 101, 242)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_REG = "C:/Windows/Fonts/segoeui.ttf"
MARK = Path(__file__).resolve().parents[2] / "brand" / "logo-1024.png"


def gradient(size, c1, c2):
    """Diagonal gradient image c1 (top-left) -> c2 (bottom-right)."""
    g = Image.linear_gradient("L").rotate(45, expand=True).resize((size, size))
    a = Image.new("RGB", (size, size), c1)
    b = Image.new("RGB", (size, size), c2)
    return Image.composite(b, a, g)


def logo(size):
    """The Datasetto mark (brand/logo-1024.png, drawn by brand/generate.mjs) at size x size px."""
    return Image.open(MARK).convert("RGBA").resize((size, size), Image.LANCZOS)


def social_card():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), BASE)
    glow = Image.new("RGB", (W, H), BASE)
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-150, -200, 650, 500), fill=(52, 57, 110))
    gd.ellipse((700, -250, 1400, 350), fill=(24, 74, 76))
    gd.ellipse((800, 350, 1400, 800), fill=(84, 54, 40))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    img = Image.blend(img, glow, 0.9)
    d = ImageDraw.Draw(img)

    mark = logo(168)
    img.paste(mark, (96, 118), mark)

    title = ImageFont.truetype(FONT_BOLD, 92)
    sub = ImageFont.truetype(FONT_REG, 36)
    chip_font = ImageFont.truetype(FONT_BOLD, 24)
    d.text((300, 108), "Datasetto", font=title, fill=BRIGHT)
    d.text((302, 226), "Self-hosted voice, video, streaming", font=sub, fill=MUTED)
    d.text((302, 272), "and chat for your friends", font=sub, fill=MUTED)

    x = 300
    for label, color in (("Voice", BRAND), ("Live streams", (237, 66, 69)), ("Screen share", TEAL), ("Arcade", (240, 178, 50))):
        w = d.textlength(label, font=chip_font) + 44
        d.rounded_rectangle((x, 352, x + w, 400), radius=24, fill=tuple(int(c * 0.35 + b * 0.65) for c, b in zip(color, BASE)), outline=color, width=2)
        d.text((x + 22, 362), label, font=chip_font, fill=BRIGHT)
        x += w + 14

    foot = ImageFont.truetype(FONT_REG, 26)
    d.text((300, 470), "Free and open source · One small server · No tracking", font=foot, fill=(109, 111, 120))
    d.rounded_rectangle((96, 540, 1104, 546), radius=3, fill=None)
    g = gradient(1008, TEAL, ORANGE).resize((1008, 6))
    img.paste(g, (96, 540))
    return img


social_card().save(f"{OUT}/og-image.png", optimize=True)
print("og-image.png written")
