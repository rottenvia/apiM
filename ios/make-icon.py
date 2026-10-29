"""Draws the iOS app icon: the desktop's three-dot mark (desktop/assets/make-icon.py) on its dark background.

Full bleed and square, since iOS rounds the corners itself. Writes apiM/Assets.xcassets/AppIcon.appiconset/icon-1024.png.
Needs Pillow. Run: python make-icon.py
"""
import os
from PIL import Image, ImageDraw

BACK, DOT = (0x19, 0x17, 0x15, 255), (0xD9, 0x7F, 0x5D, 255)
N = 1024


def render():
    s = N * 4
    im = Image.new("RGB", (s, s), BACK[:3])
    d = ImageDraw.Draw(im)
    # A little smaller than on the desktop: iOS shows the icon with no rim, and the dots need the room around them.
    size, gap = s * 0.175, s * 0.07
    left = (s - 3 * size - 2 * gap) / 2
    for i in range(3):
        x = left + i * (size + gap)
        y = s * 0.53 - size / 2 - (s * 0.065 if i == 1 else 0)
        d.ellipse([x, y, x + size, y + size], fill=DOT[:3])
    return im.resize((N, N), Image.LANCZOS)


here = os.path.dirname(os.path.abspath(__file__))
render().save(os.path.join(here, "apiM", "Assets.xcassets", "AppIcon.appiconset", "icon-1024.png"))
print("wrote icon-1024.png")
