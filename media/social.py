"""Draws the 1280x640 GitHub social preview from the icon and the README's "after" picture.
Usage: python3 media/social.py <after.png> <out.png>"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from icon import draw as draw_icon  # noqa: E402

MENLO = '/System/Library/Fonts/Menlo.ttc'
BG, GRID = (13, 17, 23), (19, 24, 31)
FG, ORANGE, CYAN, GRAY, GREEN = (230, 237, 243), (218, 119, 86), (86, 212, 221), (139, 148, 158), (63, 185, 80)

img = Image.new('RGB', (1280, 640), BG)
d = ImageDraw.Draw(img)
for i in range(0, 1280, 32):
    d.line([(i, 0), (i, 640)], fill=GRID)
for i in range(0, 640, 32):
    d.line([(0, i), (1280, i)], fill=GRID)

font = lambda size, bold=False: ImageFont.truetype(MENLO, size, index=1 if bold else 0)
icon = draw_icon(cell=10, grid=False)
img.paste(icon, (70, 40), icon.convert('L').point(lambda v: 255 if v > 20 else 0))
d.text((250, 78), 'Context Diet', font=font(54, True), fill=FG)
d.text((253, 148), 'for Claude Code', font=font(28), fill=ORANGE)

bullets = ['Huge outputs, trimmed before', 'they fill the context', 'Errors and summaries kept', 'The full text one Read away']
y = 236
for i, line in enumerate(bullets):
    if i != 1:
        d.text((76, y), '▸', font=font(24), fill=ORANGE)
    d.text((106, y), line, font=font(27), fill=FG)
    y += 46 if i != 0 else 40

d.rounded_rectangle([72, 448, 586, 494], radius=8, fill=(17, 22, 29), outline=(48, 54, 61))
d.text((92, 456), 'same answers · fewer steps', font=font(24), fill=GREEN)
d.text((72, 526), 'github.com/drkokorev/context-diet', font=font(23), fill=GRAY)
d.text((72, 560), 'Unofficial community plugin · MIT', font=font(19), fill=(90, 99, 110))

after = Image.open(sys.argv[1]).convert('RGB')
shot = after.crop((20, 20, after.width - 20, 1060))
shot = shot.resize((520, round(shot.height * 520 / shot.width)), Image.LANCZOS)
shot = shot.crop((0, 0, 520, 560))
mask = Image.new('L', shot.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, shot.width - 1, shot.height - 1], radius=10, fill=255)
img.paste(shot, (712, 40), mask)
img.save(sys.argv[2])
