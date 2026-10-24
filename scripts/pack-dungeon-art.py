"""把生图得到的深渊骑士雪碧图切分、对齐、缩放并导出为 WebP 与清单。

用法（需要 numpy、scipy、Pillow）：
    python -I scripts/pack-dungeon-art.py <原始素材目录>

输出到 src/games/dungeon/art/：每张表一个 WebP（帧按网格排列）和 manifest.json。
原图网格常有元素越界，因此按连通区域的重心归属到格子，而不是直接按网格裁切。
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "games" / "dungeon" / "art"

# 名称: (文件, 列, 行, 有效帧数, 参考高度像素, 锚点方式)
# 参考高度：第一帧内容缩放后的高度；锚点 feet 为脚底中心，center 为格子中心。
SHEETS = {
    "player": ("dungeon-player.png", 4, 4, 16, 150, "feet"),
    "weapons": ("dungeon-weapons.png", 4, 2, 8, 60, "grip"),
    "enemiesA": ("dungeon-enemies-a.png", 4, 4, 16, 110, "feet"),
    "enemiesB": ("dungeon-enemies-b.png", 4, 4, 16, 130, "feet"),
    "enemiesC": ("dungeon-enemies-c.png", 4, 4, 16, 120, "feet"),
    "enemiesD": ("dungeon-enemies-d.png", 4, 2, 8, 130, "feet"),
    "bossSlime": ("dungeon-boss-slime.png", 2, 2, 4, 300, "feet"),
    "bossGolem": ("dungeon-boss-golem.png", 2, 2, 4, 320, "feet"),
    "bossNecro": ("dungeon-boss-necro.png", 2, 2, 4, 320, "feet"),
    "fx": ("dungeon-fx.png", 4, 4, 16, 90, "center"),
    "explosion": ("dungeon-explosion.png", 6, 1, 6, 260, "center"),
    "items": ("dungeon-items.png", 4, 4, 14, 110, "center"),
    "pickups": ("dungeon-pickups.png", 4, 3, 12, 120, "feet"),
    "ui": ("dungeon-ui.png", 4, 4, 16, 160, "center"),
}
TILES = {
    "tilesStone": "dungeon-tiles-stone.png",
    "tilesMoss": "dungeon-tiles-moss.png",
    "tilesCrimson": "dungeon-tiles-crimson.png",
    "tilesSand": "dungeon-tiles-sand.png",
}
TILE_PX = 192


def find(src: Path, name: str) -> Path:
    for candidate in (src / name, src / (name + ".png")):
        if candidate.exists():
            return candidate
    raise SystemExit(f"缺少素材：{name}")


def pack_sheet(path: Path, cols: int, rows: int, count: int, ref: int, anchor: str):
    image = Image.open(path).convert("RGBA")
    rgba = np.asarray(image).copy()
    alpha = rgba[..., 3]
    rgba[alpha < 10] = 0
    h, w = alpha.shape
    cw, ch = w / cols, h / rows

    # 连通区域按重心分配到格子，越界的武器、特效仍归属原帧
    labels, n = ndimage.label(alpha > 24, structure=np.ones((3, 3)))
    centers = ndimage.center_of_mass(alpha > 24, labels, range(1, n + 1))
    owner = np.zeros(n + 1, dtype=np.int32) - 1
    for i, (cy, cx) in enumerate(centers, start=1):
        owner[i] = min(rows - 1, int(cy // ch)) * cols + min(cols - 1, int(cx // cw))
    # 半透明光晕可能低于阈值：按最近的已标记像素归属
    _, (iy, ix) = ndimage.distance_transform_edt(labels == 0, return_indices=True)
    nearest = labels[iy, ix]
    cell_of = owner[nearest]
    cell_of[alpha == 0] = -1

    frames, boxes = [], []
    for index in range(count):
        mask = cell_of == index
        ys, xs = np.nonzero(mask)
        ox, oy = (index % cols) * cw, (index // cols) * ch
        if len(xs) == 0:
            frames.append(None); boxes.append(None)
            continue
        frame = np.zeros_like(rgba)
        frame[mask] = rgba[mask]
        frames.append((frame, ox, oy))
        boxes.append((xs.min() - ox, ys.min() - oy, xs.max() + 1 - ox, ys.max() + 1 - oy))

    # 所有帧共用一个相对格子原点的包围盒，保证动画帧对齐
    valid = [b for b in boxes if b]
    x0 = min(b[0] for b in valid); y0 = min(b[1] for b in valid)
    x1 = max(b[2] for b in valid); y1 = max(b[3] for b in valid)
    first = valid[0]
    scale = ref / (first[3] - first[1])
    fw, fh = int(np.ceil((x1 - x0) * scale)), int(np.ceil((y1 - y0) * scale))

    sheet = Image.new("RGBA", (fw * cols, fh * int(np.ceil(count / cols))))
    for index, item in enumerate(frames):
        if item is None:
            continue
        frame, ox, oy = item
        left, top = int(round(ox + x0)), int(round(oy + y0))
        crop = Image.fromarray(frame).crop((left, top, left + int(x1 - x0), top + int(y1 - y0)))
        crop = crop.resize((fw, fh), Image.LANCZOS)
        sheet.paste(crop, ((index % cols) * fw, (index // cols) * fh))

    if anchor == "feet":
        ax, ay = (cw / 2 - x0) * scale, (first[3] - y0) * scale
    elif anchor == "grip":
        ax, ay = (first[0] - x0 + (first[2] - first[0]) * 0.22) * scale, ((first[1] + first[3]) / 2 - y0) * scale
    else:
        ax, ay = (cw / 2 - x0) * scale, (ch / 2 - y0) * scale
    meta = {"fw": fw, "fh": fh, "cols": cols, "count": count, "ax": round(ax, 1), "ay": round(ay, 1), "ref": ref,
            "boxes": [None if b is None else [round((b[0] - x0) * scale), round((b[1] - y0) * scale),
                                              round((b[2] - x0) * scale), round((b[3] - y0) * scale)] for b in boxes]}
    return sheet, meta


def add_pins(sheet: Image.Image, meta: dict, frames: list[int]):
    """为火焰会变形的帧计算固定支点：取内容下 40% 的水平中心与底部。"""
    alpha = np.asarray(sheet.getchannel("A"))
    pins = {}
    for index in frames:
        x0, y0 = (index % meta["cols"]) * meta["fw"], (index // meta["cols"]) * meta["fh"]
        cell = alpha[y0:y0 + meta["fh"], x0:x0 + meta["fw"]] > 40
        ys, xs = np.nonzero(cell)
        top, bottom = ys.min(), ys.max() + 1
        lower = ys >= bottom - (bottom - top) * 0.4
        pins[str(index)] = [round((xs[lower].min() + xs[lower].max() + 1) / 2, 1), int(bottom)]
    meta["pins"] = pins


def pack_tiles(path: Path):
    image = Image.open(path).convert("RGB")
    w, h = image.size
    cw, ch = w / 4, h / 4
    inset = 0.04
    sheet = Image.new("RGB", (TILE_PX * 4, TILE_PX * 4))
    for index in range(16):
        x, y = (index % 4) * cw, (index // 4) * ch
        box = (int(x + cw * inset), int(y + ch * inset), int(x + cw * (1 - inset)), int(y + ch * (1 - inset)))
        sheet.paste(image.crop(box).resize((TILE_PX, TILE_PX), Image.LANCZOS), ((index % 4) * TILE_PX, (index // 4) * TILE_PX))
    return sheet, {"fw": TILE_PX, "fh": TILE_PX, "cols": 4, "count": 16}


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, (file, cols, rows, count, ref, anchor) in SHEETS.items():
        sheet, meta = pack_sheet(find(src, file), cols, rows, count, ref, anchor)
        if name == "pickups":
            add_pins(sheet, meta, [8, 9, 10])
        sheet.save(OUT / f"{name}.webp", "WEBP", quality=86, method=6)
        manifest[name] = meta
        print(name, sheet.size)
    for name, file in TILES.items():
        sheet, meta = pack_tiles(find(src, file))
        sheet.save(OUT / f"{name}.webp", "WEBP", quality=84, method=6)
        manifest[name] = meta
        print(name, sheet.size)
    hero = Image.open(find(src, "dungeon-hero.png")).convert("RGB")
    hero.thumbnail((1600, 900), Image.LANCZOS)
    hero.save(OUT / "hero.webp", "WEBP", quality=82, method=6)
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
