"""Draws the apiM icon: the web app's three-dot mark on the app's dark background.

Writes icon.png (what the window and taskbar show) and apim.ico (what the .exe file shows) next to
this file. After changing it, rebuild the resource the program links:

    rc /nologo /fo apim.res apim.rc

Needs Pillow. Run: python make-icon.py
"""
import os
from PIL import Image, ImageDraw

BACK, EDGE, DOT = (0x19, 0x17, 0x15, 255), (0x40, 0x3C, 0x34, 255), (0xD9, 0x7F, 0x5D, 255)
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def render(n):
    """One size, drawn 8x too big and scaled down so the curves come out smooth."""
    s = n * 8
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    radius = round(s * 0.22)
    # A hairline rim from 32px up; below that it would only blur the corners.
    rim = max(8, round(s * 0.02)) if n >= 32 else 0
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=EDGE if rim else BACK)
    if rim:
        d.rounded_rectangle([rim, rim, s - 1 - rim, s - 1 - rim], radius=radius - rim, fill=BACK)
    size, gap = s * 0.205, s * 0.08
    left = (s - 3 * size - 2 * gap) / 2
    for i in range(3):
        x = left + i * (size + gap)
        # The middle dot is mid-bounce, as in the web app's splash.
        y = s * 0.53 - size / 2 - (s * 0.075 if i == 1 else 0)
        d.ellipse([x, y, x + size, y + size], fill=DOT)
    return im.resize((n, n), Image.LANCZOS)


here = os.path.dirname(os.path.abspath(__file__))
images = {n: render(n) for n in SIZES}
images[256].save(os.path.join(here, "icon.png"))
images[256].save(os.path.join(here, "apim.ico"), sizes=[(n, n) for n in SIZES], append_images=[images[n] for n in SIZES if n != 256])
print("wrote icon.png and apim.ico")
