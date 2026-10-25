"""从站酷庆科黄油体（OFL）中只保留深渊骑士用到的字符，生成自托管的 WOFF 字体。

用法（需要 fonttools）：
    python -P scripts/build-game-font.py <ZCOOLQingKeHuangYou-Regular.ttf>

改动游戏里的文字后重新运行一次，新出现的汉字才会被包含进字体。
"""

import re
import sys
from pathlib import Path

from fontTools import subset

ROOT = Path(__file__).resolve().parent.parent
SOURCES = [*(ROOT / "src" / "games" / "dungeon").glob("*.ts"), *(ROOT / "src" / "games" / "dungeon").glob("*.vue"),
           ROOT / "src" / "games" / "GameOver.vue", ROOT / "src" / "games" / "HealthNotice.vue"]
OUT = ROOT / "src" / "games" / "dungeon" / "font" / "game.woff"


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    text = "".join(path.read_text(encoding="utf-8") for path in SOURCES)
    chars = set(re.findall(r"[^\x00-\x7f]", text)) | {chr(c) for c in range(0x20, 0x7f)}
    options = subset.Options()
    options.flavor = "woff"
    options.layout_features = ["*"]
    font = subset.load_font(sys.argv[1], options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text="".join(sorted(chars)))
    subsetter.subset(font)
    OUT.parent.mkdir(exist_ok=True)
    subset.save_font(font, str(OUT), options)
    print(len(chars), "chars,", OUT.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
