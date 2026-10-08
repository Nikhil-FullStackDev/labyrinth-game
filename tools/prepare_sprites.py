"""Rebuild public/img/*.webp from the source Labyrinth assets (tiles + treasure symbols).
Usage: python tools/prepare_sprites.py [SRC_DIR]"""
import sys, os
from PIL import Image, ImageDraw
SRC = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\Asus\Documents\Playground\Labyrinth-board-game-assets'
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'img')
os.makedirs(OUT, exist_ok=True)
T = 120   # tile px (rendered at <=70 css px on phones, 2x density ok)
S = 76    # max treasure px

for k in 'ILT':
    im = Image.open(os.path.join(SRC, f'labyrinth-tile-{k}.png')).convert('RGBA')
    im = im.crop((1, 1, im.width - 1, im.height - 1)).resize((T, T), Image.LANCZOS)
    m = Image.new('L', (T * 4, T * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, T * 4 - 1, T * 4 - 1), radius=T * 4 * 0.09, fill=255)
    im.putalpha(m.resize((T, T), Image.LANCZOS))
    im.save(os.path.join(OUT, f'tile-{k}.webp'), quality=82, method=6)

names = []
for f in sorted(os.listdir(os.path.join(SRC, 'treasure-symbols'))):
    im = Image.open(os.path.join(SRC, 'treasure-symbols', f)).convert('RGBA')
    im = im.crop(im.getbbox())
    im.thumbnail((S, S), Image.LANCZOS)
    im.save(os.path.join(OUT, f'tr-{os.path.splitext(f)[0]}.webp'), quality=84, method=6)
    names.append(os.path.splitext(f)[0])
print(names)

# PWA icons: dark rounded plate, T tile, crown
for s in (192, 512):
    bg = Image.new('RGBA', (s, s), (23, 18, 13, 255))
    ImageDraw.Draw(bg).rounded_rectangle((s * .08, s * .08, s * .92, s * .92), radius=s * .16, fill=(120, 72, 30, 255))
    t = Image.open(os.path.join(SRC, 'labyrinth-tile-T.png')).convert('RGBA').resize((int(s * .7), int(s * .7)))
    bg.paste(t, (int(s * .15), int(s * .15)))
    c = Image.open(os.path.join(SRC, 'treasure-symbols', 'crown.png')).convert('RGBA'); c = c.crop(c.getbbox()); c.thumbnail((int(s * .36), int(s * .36)))
    bg.alpha_composite(c, ((s - c.width) // 2, (s - c.height) // 2))
    bg.save(os.path.join(OUT, '..', f'icon-{s}.png'))
