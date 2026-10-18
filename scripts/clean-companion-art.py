"""Remove neutral matte residue from the mascots' background, not their artwork.

Run with Python + Pillow. Background-connected neutral pixels above the shoes
are cleared; the affectionate pose also has an enclosed checkerboard pocket.
The dark character outlines isolate eyes/teeth from the background flood.
The boot image is derived from the same happy artwork instead of a second cutout.
"""
from collections import deque
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def clean(path):
    image = Image.open(path).convert('RGBA')
    pixels = image.load()
    width, height = image.size
    seen = set()
    queue = deque()
    # Seed transparency throughout the image; keep opaque eyes/shoes untouched.
    for y in range(height):
        for x in range(width):
            if pixels[x, y][3] == 0:
                queue.append((x, y))
                seen.add((x, y))
    if path.stem == 'pair-affectionate':
        queue.append((115, 140))  # enclosed background, left of the pink heart
        seen.add((115, 140))
    cleared = 0
    while queue:
        x, y = queue.popleft()
        r, g, b, a = pixels[x, y]
        if a:
            pixels[x, y] = (0, 0, 0, 0)
            cleared += 1
        for nx, ny in ((x-1,y), (x+1,y), (x,y-1), (x,y+1)):
            if not (0 <= nx < width and 0 <= ny < 185) or (nx, ny) in seen:
                continue
            r, g, b, a = pixels[nx, ny]
            # Localized neutral matte: no global grey/white deletion, which
            # would damage the eyes, shoes and clothing details.
            if a == 0 or (max(r,g,b)-min(r,g,b) <= 35 and (r+g+b)/3 > 80):
                seen.add((nx, ny))
                queue.append((nx, ny))
    image.save(path, optimize=True)
    print(f'{path.name}: cleared {cleared} matte pixels')


def clean_icon(path):
    # Installed-app icons have a deliberate cream canvas. Replace only the
    # enclosed grey matte with that canvas, preserving the icon's own artwork.
    image = Image.open(path).convert('RGB')
    pixels = image.load()
    width, height = image.size
    background = pixels[0, 0]
    queue = deque([(int(width * .48), int(height * .54))])
    seen = set()
    while queue:
        x, y = queue.popleft()
        if (x, y) in seen or not (0 <= x < width and 0 <= y < height):
            continue
        seen.add((x, y))
        r, g, b = pixels[x, y]
        if max(r,g,b)-min(r,g,b) > 35 or not 80 < (r+g+b)/3 < 225:
            continue
        pixels[x, y] = background
        queue.extend(((x-1,y), (x+1,y), (x,y-1), (x,y+1)))
    image.save(path, optimize=True)


if __name__ == '__main__':
    for path in sorted((ROOT / 'src/assets/companions').glob('pair-*.png')):
        clean(path)
    happy = Image.open(ROOT / 'src/assets/companions/pair-happy.png').convert('RGBA')
    # Same tight framing as the previous boot artwork, with genuine soft alpha.
    happy.crop(happy.getbbox()).resize((302, 288), Image.Resampling.LANCZOS).save(
        ROOT / 'public/assets/nooki/boot-pair.png', optimize=True)

    for name in ('icon-192.png', 'icon-512.png', 'apple-touch-icon.png'):
        clean_icon(ROOT / 'public/icons' / name)
