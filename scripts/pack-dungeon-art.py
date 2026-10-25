"""把生图得到的小游戏雪碧图切分、对齐、缩放并导出为 WebP 与清单。

用法（需要 numpy、scipy、Pillow）：
    python -P scripts/pack-dungeon-art.py <原始素材目录>

深渊骑士输出到 src/games/dungeon/art/：每张表一个 WebP（帧按网格排列）和 manifest.json；
合成大西瓜与三消输出到各自目录的 art/。
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
    # 第二批：英雄、新武器、新怪物与首领、商店、机关
    "ranger": ("dungeon2-hero-ranger.png", 4, 5, 20, 150, "feet"),
    "mage": ("dungeon2-hero-mage.png", 4, 5, 20, 150, "feet"),
    "knightSkill": ("dungeon2-hero-knight-skill.png", 4, 1, 4, 150, "feet"),
    "weapons2": ("dungeon2-weapons.png", 4, 2, 8, 80, "grip"),
    "enemiesE": ("dungeon2-enemies-e.png", 4, 4, 16, 120, "feet"),
    "enemiesF": ("dungeon2-enemies-f.png", 4, 4, 16, 110, "feet"),
    "enemiesG": ("dungeon2-enemies-g.png", 4, 4, 16, 120, "feet"),
    "bossTreant": ("dungeon2-boss-treant.png", 3, 2, 6, 300, "feet"),
    "bossDragon": ("dungeon2-boss-dragon.png", 3, 2, 6, 260, "feet"),
    "bossPharaoh": ("dungeon2-boss-pharaoh.png", 3, 2, 6, 300, "feet"),
    "items2": ("dungeon2-items.png", 4, 4, 16, 110, "center"),
    "shop": ("dungeon2-shop.png", 4, 3, 12, 130, "feet"),
    "traps": ("dungeon2-traps.png", 4, 4, 16, 110, "center"),
    "ui2": ("dungeon2-ui.png", 4, 4, 16, 140, "center"),
    "props": ("dungeon2-props.png", 4, 4, 16, 110, "feet"),
}
# 选角界面用的立绘，单独导出供页面 CSS 使用
PORTRAITS = ("dungeon2-hero-portraits.png", 3, 1, 3, 360, "center")
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
    for file, name, size in (("dungeon-hero.png", "hero", (1600, 900)), ("dungeon2-select-bg.png", "select-bg", (1600, 900))):
        image = Image.open(find(src, file)).convert("RGB")
        image.thumbnail(size, Image.LANCZOS)
        image.save(OUT.parent / "pages" / f"{name}.webp" if name != "hero" else OUT / "hero.webp", "WEBP", quality=80, method=6)
    sheet, meta = pack_sheet(find(src, PORTRAITS[0]), *PORTRAITS[1:])
    sheet.save(OUT.parent / "pages" / "portraits.webp", "WEBP", quality=84, method=6)
    print("portraits", sheet.size)
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    pack_casual(src)


# —— 合成大西瓜与三消 ——

def erase_grid(rgba: np.ndarray, cols: int, rows: int, band: int = 7):
    """去掉格线与半透明的浅灰底：只清除格线附近、低饱和度且不完全不透明的像素。"""
    h, w = rgba.shape[:2]
    near = np.zeros((h, w), bool)
    for i in range(cols + 1):
        x = round(i * w / cols); near[:, max(0, x - band):x + band] = True
    for j in range(rows + 1):
        y = round(j * h / rows); near[max(0, y - band):y + band, :] = True
    rgb = rgba[..., :3].astype(int)
    grey = (rgb.min(-1) > 150) & (rgb.max(-1) - rgb.min(-1) < 28)
    rgba[near & grey & (rgba[..., 3] < 250)] = 0
    rgba[rgba[..., 3] < 24] = 0


def pack_icons(path: Path, cols: int, rows: int, count: int, cell: int, grid: bool = False):
    """图标表：每格内容居中缩放到 cell 像素见方，保留各自的内容框。"""
    rgba = np.asarray(Image.open(path).convert("RGBA")).copy()
    if grid:
        erase_grid(rgba, cols, rows)
    rgba[rgba[..., 3] < 12] = 0
    h, w = rgba.shape[:2]
    cw, ch = w / cols, h / rows
    sheet = Image.new("RGBA", (cell * cols, cell * int(np.ceil(count / cols))))
    boxes = []
    for index in range(count):
        x0, y0 = int(index % cols * cw), int(index // cols * ch)
        crop = rgba[y0:int(y0 + ch), x0:int(x0 + cw)]
        labels, n = ndimage.label(crop[..., 3] > 40, structure=np.ones((3, 3)))
        if n:
            # 只保留较大的连通块，去掉越界进来的邻格碎片
            sizes = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
            keep = np.isin(labels, [i + 1 for i, s in enumerate(sizes) if s > sizes.max() * 0.02])
            grown = ndimage.binary_dilation(keep, iterations=6)
            crop = crop.copy(); crop[~grown] = 0
        ys, xs = np.nonzero(crop[..., 3] > 0)
        bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        side = max(bx1 - bx0, by1 - by0)
        k = (cell - 4) / side
        img = Image.fromarray(crop).crop((bx0, by0, bx1, by1))
        img = img.resize((max(1, round((bx1 - bx0) * k)), max(1, round((by1 - by0) * k))), Image.LANCZOS)
        ox, oy = (index % cols) * cell + (cell - img.width) // 2, (index // cols) * cell + (cell - img.height) // 2
        sheet.paste(img, (ox, oy))
        boxes.append([ox - (index % cols) * cell, oy - (index // cols) * cell, ox - (index % cols) * cell + img.width, oy - (index // cols) * cell + img.height])
    return sheet, {"fw": cell, "fh": cell, "cols": cols, "count": count, "boxes": boxes}


def save_cover(src_path: Path, out: Path, size, quality=80):
    image = Image.open(src_path).convert("RGB")
    image.thumbnail(size, Image.LANCZOS)
    image.save(out, "WEBP", quality=quality, method=6)


def pack_casual(src: Path):
    games = ROOT / "src" / "games"
    melon, sheep = games / "watermelon" / "art", games / "sheep" / "art"
    melon.mkdir(exist_ok=True); sheep.mkdir(exist_ok=True)
    manifest = {}
    sheet, manifest["fruits"] = pack_icons(find(src, "watermelon-fruits.png"), 4, 3, 11, 256, grid=True)
    # 每个水果主体的中心与等效半径（按不透明面积），让贴图与物理圆对齐
    alpha = np.asarray(sheet.getchannel("A")) > 128
    bodies = []
    for i in range(11):
        cell = alpha[(i // 4) * 256:(i // 4 + 1) * 256, (i % 4) * 256:(i % 4 + 1) * 256]
        ys, xs = np.nonzero(cell)
        bodies.append([round(float(xs.mean()), 1), round(float(ys.mean()), 1), round(float((cell.sum() / np.pi) ** 0.5), 1)])
    manifest["fruits"]["bodies"] = bodies
    sheet.save(melon / "fruits.webp", "WEBP", quality=86, method=6)
    (melon / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    save_cover(find(src, "watermelon-bg.png"), melon / "bg.webp", (720, 1080))
    save_cover(find(src, "watermelon-bg-dark.png"), melon / "bg-dark.webp", (720, 1080))
    manifest = {}
    sheet, manifest["icons"] = pack_icons(find(src, "sheep-icons.png"), 4, 4, 16, 160)
    sheet.save(sheep / "icons.webp", "WEBP", quality=86, method=6)
    sheet, manifest["ui"] = pack_icons(find(src, "sheep-ui.png"), 4, 2, 8, 200)
    sheet.save(sheep / "ui.webp", "WEBP", quality=86, method=6)
    (sheep / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    # 草地背景是左右并排的浅色与深色两张
    bg = Image.open(find(src, "sheep-bg.png")).convert("RGB")
    w, h = bg.size
    for name, box in (("bg", (8, 8, w // 2 - 8, h - 8)), ("bg-dark", (w // 2 + 8, 8, w - 8, h - 8))):
        part = bg.crop(box); part.thumbnail((720, 1080), Image.LANCZOS)
        part.save(sheep / f"{name}.webp", "WEBP", quality=78, method=6)
    covers = games / "covers"; covers.mkdir(exist_ok=True)
    save_cover(find(src, "cover-watermelon.png"), covers / "watermelon.webp", (1200, 700))
    save_cover(find(src, "cover-sheep.png"), covers / "sheep.webp", (800, 1200))


if __name__ == "__main__":
    main()
