"""生成 ALT Magnifier 的扩展图标（16/32/48/128）。

用法（Windows）：
    python tools/make_icons.py

依赖 Pillow。生成结果写入 icons/，可直接被 manifest.json 引用。
图形语言：蓝紫渐变圆角方块 + 白色放大镜 + 橙色高光点。
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SS = 8  # 超采样倍数，保证小尺寸边缘干净

TOP = (59, 110, 246)
BOTTOM = (139, 92, 246)
ACCENT = (255, 176, 74)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def gradient(size: int) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = (
            round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
            round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
            round(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
        )
    return grad.resize((size, size), Image.NEAREST)


def draw_ring(d: ImageDraw.ImageDraw, cx: float, cy: float, r: float, w: float) -> None:
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 255), width=round(w))


def draw_handle(d: ImageDraw.ImageDraw, x1: float, y1: float, x2: float, y2: float, w: float) -> None:
    d.line([x1, y1, x2, y2], fill=(255, 255, 255, 255), width=round(w))
    r = w / 2.0
    for (x, y) in ((x1, y1), (x2, y2)):
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255))


def render(size: int) -> Image.Image:
    n = size * SS
    base = gradient(n).convert("RGBA")
    base.putalpha(rounded_mask(n, round(n * 0.22)))

    layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    cx, cy = n * 0.44, n * 0.42
    r = n * 0.21
    ring_w = max(1.0, n * 0.085)
    draw_ring(d, cx, cy, r, ring_w)

    # 手柄：从圆环右下角斜向外，长度随尺寸缩放
    sx = cx + r * 0.72
    sy = cy + r * 0.72
    ex = n * 0.78
    ey = n * 0.80
    draw_handle(d, sx, sy, ex, ey, ring_w * 1.18)

    # 镜片高光
    hr = r * 0.42
    d.ellipse(
        [cx - r * 0.55 - hr, cy - r * 0.55 - hr, cx - r * 0.55 + hr, cy - r * 0.55 + hr],
        fill=(255, 255, 255, 70),
    )

    # 橙色高光点：16px 下会糊成一小团，属于可接受的“跃动感”
    if size >= 32:
        pr = n * 0.055
        px, py = n * 0.79, n * 0.20
        d.ellipse([px - pr, py - pr, px + pr, py + pr], fill=ACCENT + (255,))

    out = Image.alpha_composite(base, layer)
    return out.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        img = render(size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        img.save(path, "PNG", optimize=True)
        print(f"wrote {os.path.relpath(path)} ({size}x{size}, {os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
