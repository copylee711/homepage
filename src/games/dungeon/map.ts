/** 每层的房间网格与房间内部布局。 */
import { ROOM_H, ROOM_W } from './data'

export const FLOOR = 0, WALL = 1, ROCK = 2, PIT = 3, DOOR = 4

export type RoomType = 'start' | 'normal' | 'treasure' | 'boss' | 'heal' | 'shop' | 'altar' | 'secret'
export type Dir = 'n' | 's' | 'e' | 'w'
export const DIRS: Record<Dir, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }
export const OPPOSITE: Record<Dir, Dir> = { n: 's', s: 'n', e: 'w', w: 'e' }
/** 四扇门在房间中的格子坐标。 */
export const DOOR_TILE: Record<Dir, [number, number]> = { n: [9, 0], s: [9, ROOM_H - 1], w: [0, 5], e: [ROOM_W - 1, 5] }

export interface Room {
  gx: number; gy: number
  type: RoomType
  tiles: Uint8Array
  doors: Partial<Record<Dir, Room>>
  cleared: boolean
  visited: boolean
  seed: number
  distance: number
  /** 尚未炸开的隐藏门（裂缝墙），以及裂缝墙剩余耐久 */
  hidden: Partial<Record<Dir, number>>
  /** 地图形状变化时递增，用于重绘缓存的房间背景 */
  version: number
}

export interface Floor { rooms: Room[]; start: Room; grid: Map<string, Room> }

// 9 行 × 17 列的内部布局：. 地面  R 岩石  P 深坑
const LAYOUTS = [
  [
    '.................',
    '.................',
    '...RR.......RR...',
    '...R.........R...',
    '.................',
    '...R.........R...',
    '...RR.......RR...',
    '.................',
    '.................',
  ],
  [
    '.................',
    '.....R.....R.....',
    '.....R.....R.....',
    '.................',
    '..RRR.......RRR..',
    '.................',
    '.....R.....R.....',
    '.....R.....R.....',
    '.................',
  ],
  [
    '.................',
    '.................',
    '....PPP...PPP....',
    '....PPP...PPP....',
    '.................',
    '....PPP...PPP....',
    '....PPP...PPP....',
    '.................',
    '.................',
  ],
  [
    '.................',
    '..R...........R..',
    '.................',
    '......RRRRR......',
    '......RRRRR......',
    '......RRRRR......',
    '.................',
    '..R...........R..',
    '.................',
  ],
  [
    '.................',
    '.................',
    '..PPPP.....PPPP..',
    '..PPPP.....PPPP..',
    '.................',
    '..PPPP.....PPPP..',
    '..PPPP.....PPPP..',
    '.................',
    '.................',
  ],
  [
    '.................',
    '...R...R...R.....',
    '.................',
    '.....R...R...R...',
    '.................',
    '...R...R...R.....',
    '.................',
    '.....R...R...R...',
    '.................',
  ],
  [
    '.................',
    '.................',
    '.......PPP.......',
    '..RR...PPP...RR..',
    '..RR...PPP...RR..',
    '..RR...PPP...RR..',
    '.......PPP.......',
    '.................',
    '.................',
  ],
  [
    '.................',
    '.RR...........RR.',
    '.R.............R.',
    '.................',
    '.......R.R.......',
    '.................',
    '.R.............R.',
    '.RR...........RR.',
    '.................',
  ],
]

export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const tileAt = (room: Room, x: number, y: number) =>
  x < 0 || y < 0 || x >= ROOM_W || y >= ROOM_H ? WALL : room.tiles[y * ROOM_W + x]

function buildTiles(room: Room, random: () => number) {
  const tiles = new Uint8Array(ROOM_W * ROOM_H)
  for (let y = 0; y < ROOM_H; y++) for (let x = 0; x < ROOM_W; x++) {
    tiles[y * ROOM_W + x] = x === 0 || y === 0 || x === ROOM_W - 1 || y === ROOM_H - 1 ? WALL : FLOOR
  }
  if (room.type === 'normal') {
    const layout = LAYOUTS[Math.floor(random() * LAYOUTS.length)]
    const flipX = random() < 0.5, flipY = random() < 0.5
    for (let y = 0; y < 9; y++) for (let x = 0; x < 17; x++) {
      const ch = layout[flipY ? 8 - y : y][flipX ? 16 - x : x]
      if (ch !== '.') tiles[(y + 1) * ROOM_W + x + 1] = ch === 'R' ? ROCK : PIT
    }
    // 门口两格必须是地面
    for (const [dx, dy] of [[9, 1], [9, 2], [9, 8], [9, 9], [1, 5], [2, 5], [16, 5], [17, 5]]) tiles[dy * ROOM_W + dx] = FLOOR
  }
  for (const dir of Object.keys(room.doors) as Dir[]) {
    if (room.hidden[dir] !== undefined) continue
    const [dx, dy] = DOOR_TILE[dir]
    tiles[dy * ROOM_W + dx] = DOOR
  }
  room.tiles = tiles
}

/** 炸开裂缝墙，露出隐藏房间的门。 */
export function revealDoor(room: Room, dir: Dir) {
  delete room.hidden[dir]
  const [dx, dy] = DOOR_TILE[dir]
  room.tiles[dy * ROOM_W + dx] = DOOR
  room.version++
}

/** 生成一层：从中心向外随机扩展，死胡同放 Boss、宝箱与泉水。 */
export function generateFloor(level: number, seed = Math.floor(Math.random() * 2 ** 31)): Floor {
  const random = rng(seed)
  const target = Math.min(7 + level * 2, 16)
  for (let attempt = 0; ; attempt++) {
    const grid = new Map<string, Room>()
    const key = (x: number, y: number) => `${x},${y}`
    const make = (gx: number, gy: number, distance: number): Room =>
      ({ gx, gy, type: 'normal', tiles: new Uint8Array(0), doors: {}, cleared: false, visited: false, seed: Math.floor(random() * 2 ** 31), distance, hidden: {}, version: 0 })
    const start = make(4, 4, 0)
    start.type = 'start'
    grid.set(key(4, 4), start)
    const queue = [start]
    while (queue.length && grid.size < target) {
      const room = queue.shift()!
      for (const [dx, dy] of Object.values(DIRS)) {
        if (grid.size >= target || random() < 0.5) continue
        const nx = room.gx + dx, ny = room.gy + dy
        if (nx < 0 || ny < 0 || nx > 8 || ny > 8 || grid.has(key(nx, ny))) continue
        const around = Object.values(DIRS).filter(([ax, ay]) => grid.has(key(nx + ax, ny + ay))).length
        if (around > 1) continue
        const next = make(nx, ny, room.distance + 1)
        grid.set(key(nx, ny), next)
        queue.push(next)
      }
      if (!queue.length && grid.size < target) queue.push(...grid.values())
    }
    const rooms = [...grid.values()]
    for (const room of rooms) {
      for (const [dir, [dx, dy]] of Object.entries(DIRS) as [Dir, [number, number]][]) {
        const other = grid.get(key(room.gx + dx, room.gy + dy))
        if (other) room.doors[dir] = other
      }
    }
    const ends = rooms.filter(r => r !== start && Object.keys(r.doors).length === 1).sort((a, b) => b.distance - a.distance)
    if (ends.length < 3 && attempt < 60) continue
    const boss = ends[0] ?? rooms[rooms.length - 1]
    boss.type = 'boss'
    // 其余死胡同依次放宝箱、商店、泉水和祭坛
    const extras: RoomType[] = ['treasure', 'shop', ...(level >= 2 ? ['heal' as const] : []), 'altar']
    ends.slice(1).forEach((room, i) => { if (extras[i]) room.type = extras[i] })
    // 隐藏房间：贴着一个普通房间的空位，入口是一面裂缝墙
    const spots: [number, number, Room, Dir][] = []
    for (const room of rooms) {
      if (room.type !== 'normal') continue
      for (const [dir, [dx, dy]] of Object.entries(DIRS) as [Dir, [number, number]][]) {
        const nx = room.gx + dx, ny = room.gy + dy
        if (nx < 0 || ny < 0 || nx > 8 || ny > 8 || grid.has(key(nx, ny))) continue
        if (Object.values(DIRS).filter(([ax, ay]) => grid.has(key(nx + ax, ny + ay))).length !== 1) continue
        spots.push([nx, ny, room, dir])
      }
    }
    if (spots.length) {
      const [nx, ny, host, dir] = spots[Math.floor(random() * spots.length)]
      const secret = make(nx, ny, host.distance + 1)
      secret.type = 'secret'
      grid.set(key(nx, ny), secret)
      rooms.push(secret)
      host.doors[dir] = secret
      host.hidden[dir] = 14
      secret.doors[OPPOSITE[dir]] = host
    }
    start.cleared = true; start.visited = true
    for (const room of rooms) {
      if (room.type !== 'normal' && room.type !== 'boss') room.cleared = true
      buildTiles(room, rng(room.seed))
    }
    return { rooms, start, grid }
  }
}

/** 房间内可站立、离门足够远的格子，用于刷怪。 */
export function spawnTiles(room: Room): [number, number][] {
  const list: [number, number][] = []
  for (let y = 2; y < ROOM_H - 2; y++) for (let x = 2; x < ROOM_W - 2; x++) {
    if (tileAt(room, x, y) !== FLOOR) continue
    const nearDoor = Object.keys(room.doors).some(d => {
      const [dx, dy] = DOOR_TILE[d as Dir]
      return Math.abs(dx - x) + Math.abs(dy - y) < 5
    })
    if (!nearDoor) list.push([x, y])
  }
  return list
}
