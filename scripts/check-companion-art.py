"""Pixel regressions: run with Python + Pillow after editing mascot PNGs."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
for path in (root / 'src/assets/companions').glob('pair-*.png'):
    image = Image.open(path)
    assert image.mode == 'RGBA' and image.size == (256, 256), path
    assert image.getpixel((0, 0))[3] == 0, path
    assert image.getpixel((100, 100))[3] == 255, 'Keep the character artwork opaque'

image = Image.open(root / 'src/assets/companions/pair-affectionate.png')
assert image.getpixel((115, 140))[3] == 0, 'Checkerboard pocket must be transparent'
assert image.getpixel((135, 140))[3] == 0, 'Both sides of heart must be transparent'
assert image.getpixel((128, 140))[3] == 255, 'Preserve the pink heart'
boot = Image.open(root / 'public/assets/nooki/boot-pair.png')
assert boot.mode == 'RGBA'
assert any(0 < alpha < 255 for alpha in boot.getchannel('A').tobytes()), 'Boot should retain soft alpha edges'
for name in ('icon-192.png', 'icon-512.png', 'apple-touch-icon.png'):
    image = Image.open(root / 'public/icons' / name)
    assert image.getpixel((int(image.width*.48), int(image.height*.54))) == image.getpixel((0,0)), name
print('Companion transparency, heart, boot alpha and icon matte checks passed.')
