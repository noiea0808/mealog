/**
 * 시안 PNG(analysis-icons-colored.png)에서 아이콘 칩 크롭
 * 실행: node 불가 — python3 scripts/crop-analysis-icons-from-cyan.py
 * (Pillow 필요)
 */
from PIL import Image
from collections import deque
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'analysis-icons-colored.png')
OUT = os.path.join(ROOT, 'assets', 'analysis-icons')


def main():
    os.makedirs(OUT, exist_ok=True)
    im = Image.open(SRC).convert('RGBA')
    w, h = im.size
    rgb = im.convert('RGB')
    px = rgb.load()

    def is_bg(x, y):
        r, g, b = px[x, y]
        mx, mn = max(r, g, b), min(r, g, b)
        return mx >= 248 and mn >= 242 and (mx - mn) <= 12

    step = 2
    mw, mh = w // step, h // step
    mask = [[False] * mw for _ in range(mh)]
    for y in range(0, h, step):
        for x in range(0, w, step):
            if not is_bg(x, y):
                mask[y // step][x // step] = True

    visited = [[False] * mw for _ in range(mh)]
    raw = []
    for y in range(mh):
        for x in range(mw):
            if not mask[y][x] or visited[y][x]:
                continue
            q = [(y, x)]
            visited[y][x] = True
            minx = maxx = x
            miny = maxy = y
            cnt = 0
            while q:
                cy, cx = q.pop()
                cnt += 1
                minx = min(minx, cx)
                maxx = max(maxx, cx)
                miny = min(miny, cy)
                maxy = max(maxy, cy)
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < mh and 0 <= nx < mw and mask[ny][nx] and not visited[ny][nx]:
                        visited[ny][nx] = True
                        q.append((ny, nx))
            bx0, bx1 = minx * step, (maxx + 1) * step
            by0, by1 = miny * step, (maxy + 1) * step
            bw, bh = bx1 - bx0, by1 - by0
            aspect = bw / max(bh, 1)
            if 0.6 <= aspect <= 3.2 and 70 <= bw <= 320 and 50 <= bh <= 220 and cnt > 50:
                raw.append([by0, bx0, by1, bx1, bw, bh])

    def row_group(boxes, y0, y1, expect, aspect_lo=0.7, aspect_hi=1.5, min_w=70):
        sel = [
            b
            for b in boxes
            if y0 <= b[0] <= y1 and aspect_lo <= (b[4] / max(b[5], 1)) <= aspect_hi and b[4] >= min_w
        ]
        sel.sort(key=lambda b: b[1])
        out = []
        for b in sel:
            if out and abs(b[1] - out[-1][1]) < 40:
                continue
            out.append(b)
        if len(out) != expect:
            print(f'WARN y={y0}-{y1}: got {len(out)} expected {expect}')
        return out[:expect]

    groups = {
        'how': row_group(raw, 240, 420, 7),
        'what': row_group(raw, 520, 720, 6),
        'with': row_group(raw, 820, 1000, 8),
        'rating': row_group(raw, 1080, 1260, 5, aspect_lo=1.5, aspect_hi=3.0, min_w=120),
        'satiety': row_group(raw, 1280, 1500, 5, aspect_lo=0.9, aspect_hi=1.6, min_w=100),
    }
    names = {
        'how': ['how-home', 'how-utensils', 'how-wine', 'how-motorcycle', 'how-building', 'how-ellipsis', 'how-skip'],
        'what': ['what-soup', 'what-pizza', 'what-fish', 'what-bowl', 'what-sandwich', 'what-coffee'],
        'with': [
            'with-user',
            'with-users',
            'with-heart',
            'with-friends',
            'with-briefcase',
            'with-graduation',
            'with-party',
            'with-ellipsis',
        ],
        'rating': [f'rating-{i}' for i in range(1, 6)],
        'satiety': [f'satiety-{i}' for i in range(1, 6)],
    }

    def crop_square(box, pad=2, size=128):
        y0, x0, y1, x1, bw, bh = box
        x0 = max(0, x0 - pad)
        y0 = max(0, y0 - pad)
        x1 = min(w, x1 + pad)
        y1 = min(h, y1 + pad)
        crop = im.crop((x0, y0, x1, y1))
        cw, ch = crop.size
        side = max(cw, ch)
        canvas = Image.new('RGBA', (side, side), (255, 252, 250, 255))
        canvas.paste(crop, ((side - cw) // 2, (side - ch) // 2), crop)
        return canvas.resize((size, size), Image.Resampling.LANCZOS)

    n = 0
    for key, boxes in groups.items():
        for name, box in zip(names[key], boxes):
            crop_square(box).save(os.path.join(OUT, f'{name}.png'), 'PNG', optimize=True)
            n += 1
            print('saved', name)
    print(f'done: {n} pngs → {OUT}')


if __name__ == '__main__':
    main()
