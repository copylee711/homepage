/** 羊了个羊式关卡生成：先排布卡片，再沿一条可行的消除顺序分配图案，保证有解。 */

export interface Tile {
  id: number
  type: number
  x: number
  y: number
  layer: number
}

/** 棋盘宽 7、高 8 个卡片单位；底部牌堆再占 1.5 单位。 */
export const BOARD_W = 7
export const BOARD_H = 8
export const PILE_H = 1.6

export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const overlaps = (a: Tile, b: Tile) => Math.abs(a.x - b.x) < 0.98 && Math.abs(a.y - b.y) < 0.98

/** 没有被更高层卡片压住即可点击。 */
export function isFree(tile: Tile, tiles: Tile[]) {
  return !tiles.some(other => other.layer > tile.layer && overlaps(tile, other))
}

export function settings(level: number) {
  if (level === 1) return { types: 3, target: 18, layers: 2, pile: 0 }
  const types = Math.min(5 + level, 16)
  return {
    types,
    target: Math.min(36 + level * 18, 168),
    layers: Math.min(2 + level, 9),
    pile: level >= 3 ? Math.min(4 + level * 2, 16) : 0,
  }
}

export function generate(level: number, seed = Math.floor(Math.random() * 2 ** 31)): Tile[] {
  const random = rng(seed)
  const { types, target, layers, pile } = settings(level)
  const spots: Omit<Tile, 'id' | 'type'>[] = []
  const boardTarget = target - pile * 2

  // 每层在半格偏移的网格上放卡片，左右对称更好看；前几关用较小的区域。
  const areaW = Math.min(BOARD_W, 3 + level * 2), areaH = Math.min(BOARD_H, 3 + level * 2)
  const left0 = (BOARD_W - areaW) / 2, top0 = (BOARD_H - areaH) / 2
  let layer = 0
  while (spots.length < boardTarget && layer < 40) {
    const half = layer % 2 ? 0.5 : 0
    const cols = Math.floor(areaW - half), rows = Math.floor(areaH - half)
    // 越靠上的层越集中在中央，形成金字塔
    const shrink = Math.min(Math.floor((rows - 1) / 2), Math.floor(layer / 3))
    const cells = cols * (rows - shrink * 2)
    const fill = Math.min(0.9, Math.max(0.35, boardTarget / layers / cells + random() * 0.15))
    for (let r = shrink; r < rows - shrink && spots.length < boardTarget; r++) {
      for (let c = 0; c < Math.ceil(cols / 2); c++) {
        if (random() > fill) continue
        const mirror = cols - 1 - c
        for (const col of mirror === c ? [c] : [c, mirror]) spots.push({ x: left0 + half + col, y: top0 + half + r, layer })
      }
    }
    layer++
  }
  // 左右两个底部牌堆，只能拿最上面一张
  for (let side = 0; side < (pile ? 2 : 0); side++) {
    for (let i = 0; i < pile; i++) spots.push({ x: (side ? 5.6 : 0.4) + i * (side ? -0.06 : 0.06), y: BOARD_H + 0.4, layer: 100 + i })
  }
  // 保留三的倍数：多余的先从最上层去掉
  spots.sort((a, b) => a.layer - b.layer)
  let cut = spots.length - pile * 2 - 1
  while (spots.length % 3) spots.splice(cut--, 1)

  const tiles: Tile[] = spots.map((s, id) => ({ ...s, id, type: -1 }))
  // 模拟一条消除路径：每次从当前可点的卡片里取 3 张赋同一图案
  const left = [...tiles]
  const order: Tile[] = []
  while (left.length) {
    const free = left.filter(t => isFree(t, left))
    const pick = free[Math.floor(random() * free.length)]
    order.push(pick)
    left.splice(left.indexOf(pick), 1)
  }
  const palette = shuffle(Array.from({ length: 16 }, (_, i) => i), random).slice(0, types)
  for (let i = 0; i < order.length; i += 3) {
    const type = palette[Math.floor(random() * palette.length)]
    for (const t of order.slice(i, i + 3)) t.type = type
  }
  return tiles
}

export function shuffle<T>(list: T[], random = Math.random): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]]
  }
  return list
}
