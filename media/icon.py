"""Draws the Context Diet icon: Cockpit's pixel creature, slimmed down with a measuring tape
and a leaf on top. Usage: python3 media/icon.py <out.png>"""
import sys
from PIL import Image, ImageDraw

CELL, N = 64, 16
BG, GRID = (13, 17, 23), (20, 25, 32)
O, OD = (218, 119, 86), (170, 88, 58)        # orange, dark orange
E, C = (40, 46, 56), (86, 212, 221)          # eye socket, eye
G, GD, W = (63, 185, 80), (30, 110, 45), (236, 240, 244)

px = {}
def put(color, cells):
    for x, y in cells:
        px[(x, y)] = color

# leaf and stem
put(G, [(8, 1), (9, 1), (8, 2), (10, 0), (9, 0)])
put(GD, [(7, 2)])
# head and body
put(O, [(x, 3) for x in range(6, 10)])
put(O, [(x, 4) for x in range(4, 12)])
for y in range(5, 10):
    put(O, [(x, y) for x in range(3, 13)])
# eyes
for ex in (4, 10):
    put(E, [(ex, 6), (ex + 1, 6), (ex, 7), (ex + 1, 7)])
    put(C, [(ex + 1 if ex == 4 else ex, 6)])
# smile
put(OD, [(6, 8), (9, 8), (7, 9), (8, 9)])
# measuring tape around a slimmer waist
put(G, [(x, 10) for x in range(3, 13)])
put(GD, [(x, 10) for x in range(4, 13, 2)])
put(W, [(12, 11)])
put(G, [(13, 11), (13, 12)])
# hips and legs
put(O, [(x, 11) for x in range(4, 12)])
put(O, [(x, 12) for x in range(5, 11)])
put(OD, [(5, 13), (6, 13), (9, 13), (10, 13)])
put(OD, [(4, 14), (5, 14), (6, 14), (9, 14), (10, 14), (11, 14)])



def draw(cell=CELL, grid=True):
    img = Image.new('RGB', (cell * N, cell * N), BG)
    d = ImageDraw.Draw(img)
    if grid:
        for i in range(N + 1):
            d.line([(i * cell, 0), (i * cell, cell * N)], fill=GRID)
            d.line([(0, i * cell), (cell * N, i * cell)], fill=GRID)
    for (x, y), color in px.items():
        d.rectangle([x * cell, y * cell, (x + 1) * cell - 1, (y + 1) * cell - 1], fill=color)
    return img


if __name__ == '__main__':
    draw().save(sys.argv[1])
