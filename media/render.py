"""Render the README pictures and GIF for Context Diet.

The before/after frames come from media/transcript.json (a jest run passed through the mod's own
compressor by media/transcript.ts); the panel frames are the real UI trees media/capture.tsx
prints with demo data. Usage: python3 media/render.py
"""

import json
import os
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
MENLO = '/System/Library/Fonts/Menlo.ttc'
SYMBOLS = '/System/Library/Fonts/Apple Symbols.ttf'
SIZE = 15

REGULAR = ImageFont.truetype(MENLO, SIZE, index=0)
BOLD = ImageFont.truetype(MENLO, SIZE, index=1)
FALLBACK = ImageFont.truetype(SYMBOLS, SIZE + 1)
MENLO_CMAP = TTFont(MENLO, fontNumber=0).getBestCmap()

CELL_W = round(REGULAR.getlength('M'))
CELL_H = 21

BG = (13, 17, 23)
CHROME = (22, 27, 34)
FG = (230, 237, 243)
COLORS = {
    'cyan': (86, 212, 221),
    'green': (63, 185, 80),
    'yellow': (210, 168, 47),
    'red': (248, 81, 73),
    'magenta': (188, 140, 255),
    'gray': (110, 118, 129),
    None: FG,
}


def mix(c, amount=0.48):
    return tuple(round(BG[i] + (c[i] - BG[i]) * amount) for i in range(3))


def text_of(node):
    return ''.join(ch if isinstance(ch, str) else text_of(ch) for ch in node.get('children', []))


# A rendered block is a list of lines; a line is a list of (text, style) segments.

def seg_len(line):
    return sum(len(t) for t, _ in line)


def truncate(line, width):
    out, used = [], 0
    for t, st in line:
        if used >= width:
            break
        room = width - used
        if len(t) > room:
            t = t[: max(0, room - 1)] + '…'
        out.append((t, st))
        used += len(t)
    return out


def pad_line(line, width):
    n = seg_len(line)
    return line + ([(' ' * (width - n), {})] if n < width else [])


def render(node, width):
    if node is None or node is False or node is True:
        return []
    if isinstance(node, str):
        return [truncate([(node, {})], width)]
    kind = node.get('type')
    props = node.get('props', {})
    if kind == 'Text':
        style = {'color': props.get('color'), 'dim': props.get('dimColor'), 'bold': props.get('bold')}
        return [truncate([(text_of(node), style)], width)]
    if kind == 'Button':
        label = props.get('label') or text_of(node)
        primary = props.get('variant') == 'primary'
        if props.get('plain'):
            hot = props.get('hotkey')
            parts = ([(f'{hot}: ', {'color': 'cyan'})] if hot else []) + [(label, {'dim': props.get('dimColor'), 'bold': not props.get('dimColor')})]
            return [truncate(parts, width)]
        style = {'color': 'cyan' if primary else None, 'dim': props.get('dimColor'), 'bold': primary}
        return [truncate([('[ ', style), (label, style), (' ]', style)], width)]
    if kind == 'Box':
        return render_box(node, props, width)
    return []


def natural_width(node):
    lines = render(node, 400)
    return max((seg_len(l) for l in lines), default=0)


def render_box(node, props, width):
    if props.get('display') == 'none':
        return []
    children = [c for c in node.get('children', []) if c not in (None, False, True)]
    pl = props.get('paddingLeft', props.get('paddingX', props.get('padding', 0))) or 0
    border = bool(props.get('borderStyle'))
    inner = width - pl - (2 if border else 0)
    if props.get('width') is not None and isinstance(props['width'], int):
        inner = min(inner, props['width'] - pl)
    lines = []
    if props.get('flexDirection', 'row') == 'column':
        for c in children:
            lines += render(c, inner)
    else:
        lines = render_row(children, props, inner)
    if pl:
        lines = [[(' ' * pl, {})] + l for l in lines]
    if border:
        w = width - 2
        color = {'color': 'gray', 'dim': True}
        lines = (
            [[('┌' + '─' * w + '┐', color)]]
            + [[('│', color)] + pad_line(truncate(l, w), w) + [('│', color)] for l in lines]
            + [[('└' + '─' * w + '┘', color)]]
        )
    top = [[]] * (props.get('marginTop', props.get('marginY', 0)) or 0)
    bottom = [[]] * (props.get('marginBottom', props.get('marginY', 0)) or 0)
    return top + lines + bottom


def render_row(children, props, width):
    gap = props.get('gap', 0) or 0
    wrap = props.get('flexWrap') == 'wrap'
    sized = []
    for c in children:
        cp = c.get('props', {}) if isinstance(c, dict) else {}
        fixed = cp.get('width') if isinstance(cp.get('width'), int) else None
        sized.append((c, fixed, cp.get('flexGrow', 0), fixed if fixed is not None else natural_width(c)))
    rows, cur, used = [], [], 0
    for item in sized:
        w = item[3]
        need = w + (gap if cur else 0)
        if wrap and cur and used + need > width:
            rows.append(cur)
            cur, used = [], 0
            need = w
        cur.append(item)
        used += need
    if cur:
        rows.append(cur)
    out = []
    for row in rows:
        fixed_total = sum(i[3] for i in row if not i[2]) + gap * (len(row) - 1)
        grow = [i for i in row if i[2]]
        spare = max(0, width - fixed_total)
        blocks, widths = [], []
        left = width
        for idx, (c, fixed, g, nat) in enumerate(row):
            w = (spare // len(grow)) if g else nat
            w = max(0, min(w, left))
            widths.append(w)
            blocks.append(render(c, w))
            left -= w + gap
        height = max((len(b) for b in blocks), default=0)
        for r in range(height):
            line = []
            for i, b in enumerate(blocks):
                part = b[r] if r < len(b) else []
                is_last = i == len(blocks) - 1
                line += part if is_last else pad_line(part, widths[i])
                if not is_last and gap:
                    line.append((' ' * gap, {}))
            out.append(truncate(line, width))
    return out



import textwrap


def draw_lines(lines, cols, title, path, caption=None, rows=None):
    """lines: list of [(text, style)]; caption: (text, color) drawn in a bar under the terminal."""
    rows = rows or len(lines)
    lines = (lines + [[]] * rows)[:rows]
    pad_x, pad_y, bar_h = 22, 18, 34
    cap_h = 46 if caption else 0
    w = cols * CELL_W + pad_x * 2
    h = rows * CELL_H + pad_y * 2 + bar_h + cap_h
    canvas = Image.new('RGB', (w + 40, h + 40), (245, 246, 248))
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle([20, 20, 20 + w, 20 + h], radius=12, fill=BG, outline=(48, 54, 61))
    d.rounded_rectangle([20, 20, 20 + w, 20 + bar_h], radius=12, fill=CHROME)
    d.rectangle([20, 20 + bar_h - 12, 20 + w, 20 + bar_h], fill=CHROME)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([36 + i * 20, 32, 48 + i * 20, 44], fill=c)
    tw = d.textlength(title, font=REGULAR)
    d.text((20 + (w - tw) / 2, 28), title, font=REGULAR, fill=(139, 148, 158))
    y = 20 + bar_h + pad_y
    for line in lines:
        x = 20 + pad_x
        for text, st in truncate(line, cols):
            color = COLORS.get(st.get('color'), FG)
            if st.get('dim'):
                color = mix(color)
            font = BOLD if st.get('bold') else REGULAR
            for ch in text:
                f = font if ord(ch) in MENLO_CMAP else FALLBACK
                d.text((x, y), ch, font=f, fill=color)
                x += CELL_W
        y += CELL_H
    if caption:
        text, color = caption
        top = 20 + h - cap_h
        d.rectangle([21, top, 19 + w, 19 + h - 10], fill=CHROME)
        d.rounded_rectangle([21, top, 19 + w, 19 + h], radius=12, fill=CHROME)
        d.rectangle([21, top, 19 + w, top + 12], fill=CHROME)
        d.text((20 + pad_x, top + 13), text, font=BOLD, fill=COLORS[color])
    canvas.save(path)
    return canvas


def style_output(text):
    if text.startswith('[Context Diet'):
        return {'color': 'cyan', 'dim': True}
    if text.startswith('… [') or 'similar line' in text:
        return {'color': 'yellow'}
    if text.startswith('FAIL') or 'Received' in text or text.strip().startswith('●') or 'failed' in text:
        return {'color': 'red', 'bold': text.startswith('FAIL') or 'failed' in text}
    if 'Expected' in text:
        return {'color': 'green'}
    if text.startswith('PASS'):
        return {'color': 'green', 'dim': True}
    if 'console.warn' in text:
        return {'color': 'yellow', 'dim': True}
    return {'dim': True}


def transcript(output, cols):
    lines = [[('> ', {'color': 'gray'}), ('run the tests and tell me what fails', {'bold': True})], [],
             [('● ', {'color': 'green'}), ('Bash', {'bold': True}), ('(npm test)', {})]]
    for i, text in enumerate(output):
        lines.append([('  ⎿  ' if i == 0 else '     ', {'color': 'gray'}), (text, style_output(text))])
    return lines


def main():
    t = json.load(open(os.path.join(HERE, 'transcript.json')))
    screens = {}
    with open(os.path.join(HERE, 'screens.jsonl')) as fh:
        for raw in fh:
            _, name, payload = raw.split(' ', 2)
            screens[name] = json.loads(payload)
    out = os.path.join(HERE, '..', 'docs', 'img') if os.path.isdir(os.path.join(HERE, '..', 'docs')) else os.path.join(HERE, 'img')
    os.makedirs(out, exist_ok=True)
    cols = 92
    raw_tok = round(t['rawChars'] / 4)
    kept_tok = round(t['keptChars'] / 4)
    fail_at = next(i for i, l in enumerate(t['raw']) if l.startswith('FAIL')) + 1

    note = textwrap.wrap(t['note'], cols - 6)
    rows = len(note) + len(t['digest']) + 4
    # before: a wall of output, scrolled through
    before = []
    for k, start in enumerate([0, 200, len(t['raw']) - (rows - 4)]):
        lines = transcript(t['raw'][start:start + rows - 4], cols)
        img = draw_lines(lines, cols, 'Claude Code · without Context Diet', os.path.join(out, f'before-{k}.png'),
                         (f'Claude reads all {len(t["raw"])} lines, ≈{raw_tok:,} tokens. The failure is line {fail_at}.', 'red'), rows)
        before.append(img)

    # after: what Claude reads with the mod
    after_lines = transcript(note + t['digest'], cols)
    after = draw_lines(after_lines, cols, 'Claude Code · with Context Diet', os.path.join(out, 'after.png'),
                       (f'Claude reads ≈{kept_tok:,} tokens: the failure, the summary, and where the full log is.', 'green'), rows)

    # the panel
    panel_lines = render(screens['panel-open'], 80)
    panel_lines += [[], [('◇ diet −151k tok · 5 cuts · 1 reopened', {'color': 'gray'})]]
    panel = draw_lines(panel_lines, cols, 'Context Diet · /diet', os.path.join(out, 'panel.png'),
                       ('Every cut, what it kept, and the file with the full output.', 'cyan'), rows)

    frames = before + [after, panel]
    W = max(f.width for f in frames)
    H = max(f.height for f in frames)
    padded = []
    for f in frames:
        c = Image.new('RGB', (W, H), (245, 246, 248))
        c.paste(f, (0, 0))
        padded.append(c.convert('P', palette=Image.ADAPTIVE, colors=96))
    padded[0].save(os.path.join(out, 'demo.gif'), save_all=True, append_images=padded[1:],
                   duration=[900, 700, 2200, 5200, 4200], loop=0, optimize=True)
    # the standalone picture of the panel without the GIF's padding
    draw_lines(panel_lines, cols, 'Context Diet · /diet', os.path.join(out, 'panel.png'),
               ('Every cut, what it kept, and the file with the full output.', 'cyan'))
    for k in range(3):
        if k:
            os.remove(os.path.join(out, f'before-{k}.png'))
    os.rename(os.path.join(out, 'before-0.png'), os.path.join(out, 'before.png'))
    print('rendered', ', '.join(sorted(os.listdir(out))))


if __name__ == '__main__':
    main()
