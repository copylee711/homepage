/** 基于雪碧图的绘制；每个函数在素材缺失时返回 false，由 render.ts 退回程序化绘制。 */
import { ENEMIES, ROOM_H, ROOM_W, TILE, WEAPON_ART, WORLD_H, WORLD_W, itemArt, themeOf } from './data'
import type { EnemyKind, ItemDef } from './data'
import { spikeState, ventState } from './game'
import type { Corpse, Enemy, Game, Hazard, Particle, Pickup, Prop, Trap } from './game'
import { DOOR_TILE, FLOOR, PIT, ROCK, rng, tileAt } from './map'
import type { Dir, Room } from './map'
import { cellCanvas, drawFrame, drawTile, has, meta } from './sprites'
import type { SheetName } from './sprites'

const TILESETS: SheetName[] = ['tilesStone', 'tilesMoss', 'tilesCrimson', 'tilesSand']

/** 每种怪物所在的表，以及该表参考帧（第一帧）的世界高度 */
const ENEMY_ART: Record<string, { sheet: SheetName; height: number }> = {
  slime: { sheet: 'enemiesA', height: 28 }, bat: { sheet: 'enemiesA', height: 28 },
  archer: { sheet: 'enemiesB', height: 40 }, totem: { sheet: 'enemiesB', height: 40 },
  boar: { sheet: 'enemiesC', height: 35 }, pumpkin: { sheet: 'enemiesC', height: 35 },
  mage: { sheet: 'enemiesD', height: 40 },
  mushroom: { sheet: 'enemiesE', height: 32 }, ghost: { sheet: 'enemiesE', height: 32 },
  lizard: { sheet: 'enemiesF', height: 24 }, shield: { sheet: 'enemiesF', height: 24 },
  mummy: { sheet: 'enemiesG', height: 36 }, worm: { sheet: 'enemiesG', height: 36 },
  kingSlime: { sheet: 'bossSlime', height: 74 }, golem: { sheet: 'bossGolem', height: 92 }, necro: { sheet: 'bossNecro', height: 86 },
  treant: { sheet: 'bossTreant', height: 88 }, dragon: { sheet: 'bossDragon', height: 70 }, pharaoh: { sheet: 'bossPharaoh', height: 80 },
}
const NEW_BOSSES = new Set(['treant', 'dragon', 'pharaoh'])

export const tilesetFor = (level: number) => TILESETS[themeOf(level)]
const loop = (t: number, fps: number, n: number) => Math.floor(t * fps) % n

// —— 房间 ——

const masked = new Map<string, HTMLCanvasElement>()
/** 取一格并加羽化遮罩，让带背景的岩石、门与地面融合。 */
function feathered(sheet: SheetName, index: number, inner = 0.62) {
  const key = `${sheet}:${index}:${inner}`
  const cached = masked.get(key)
  if (cached) return cached
  const c = cellCanvas(sheet, index, 192)
  if (!c) return null
  const g = c.getContext('2d')!
  g.globalCompositeOperation = 'destination-in'
  const grad = g.createRadialGradient(96, 96, 96 * inner, 96, 96, 96)
  grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 192, 192)
  masked.set(key, c)
  return c
}

const soft = new Map<string, HTMLCanvasElement>()
/** 地砖四边羽化，相邻块重叠绘制以消除接缝。 */
function softTile(sheet: SheetName, index: number) {
  const key = `${sheet}:${index}`
  const cached = soft.get(key)
  if (cached) return cached
  const c = cellCanvas(sheet, index, 192)
  if (!c) return null
  const g = c.getContext('2d')!
  g.globalCompositeOperation = 'destination-in'
  for (const [x0, y0, x1, y1] of [[0, 0, 192, 0], [0, 0, 0, 192]]) {
    const grad = g.createLinearGradient(x0, y0, x1, y1)
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(0.1, 'rgba(0,0,0,1)')
    grad.addColorStop(0.9, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grad; g.fillRect(0, 0, 192, 192)
  }
  soft.set(key, c)
  return c
}

export function paintRoomArt(g: CanvasRenderingContext2D, room: Room, level: number) {
  const sheet = tilesetFor(level)
  if (!has(sheet)) return false
  const random = rng(room.seed)
  g.fillStyle = '#050608'
  g.fillRect(0, 0, WORLD_W, WORLD_H)
  // 地面：每块贴图覆盖 2×2 格，保持石砖尺寸
  g.save()
  g.beginPath(); g.rect(TILE, TILE, WORLD_W - TILE * 2, WORLD_H - TILE * 2); g.clip()
  // 底色取自地砖本身，避免羽化边缘露出黑底
  drawTile(g, sheet, 0, TILE, TILE, WORLD_W - TILE * 2, WORLD_H - TILE * 2)
  const size = TILE * 2, pad = size * 0.14
  for (let y = 1; y < ROOM_H - 1; y += 2) for (let x = 1; x < ROOM_W - 1; x += 2) {
    const r = random(), flip = random() < 0.5
    const tile = softTile(sheet, r < 0.45 ? 0 : r < 0.75 ? 1 : r < 0.9 ? 2 : 3)
    if (!tile) continue
    g.save()
    g.translate(x * TILE + size / 2, y * TILE + size / 2)
    if (flip) g.scale(-1, 1)
    g.drawImage(tile, -size / 2 - pad, -size / 2 - pad, size + pad * 2, size + pad * 2)
    g.restore()
  }
  g.fillStyle = 'rgba(8,10,16,.18)'
  g.fillRect(TILE, TILE, WORLD_W - TILE * 2, WORLD_H - TILE * 2)
  g.restore()

  // 墙脚阴影
  const shade = (x: number, y: number, w: number, h: number, x1: number, y1: number, x2: number, y2: number) => {
    const grad = g.createLinearGradient(x1, y1, x2, y2)
    grad.addColorStop(0, 'rgba(0,0,0,.5)'); grad.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grad; g.fillRect(x, y, w, h)
  }
  shade(TILE, TILE, WORLD_W - TILE * 2, 26, 0, TILE, 0, TILE + 26)
  shade(TILE, TILE, 16, WORLD_H - TILE * 2, TILE, 0, TILE + 16, 0)
  shade(WORLD_W - TILE - 16, TILE, 16, WORLD_H - TILE * 2, WORLD_W - TILE, 0, WORLD_W - TILE - 16, 0)

  for (let y = 0; y < ROOM_H; y++) for (let x = 0; x < ROOM_W; x++) {
    const tile = tileAt(room, x, y), px = x * TILE, py = y * TILE
    if (tile === PIT) {
      g.fillStyle = '#030305'; g.fillRect(px, py, TILE, TILE)
      if (tileAt(room, x, y - 1) !== PIT) drawTile(g, sheet, 9, px, py, TILE, TILE)
    }
  }
  // 主题装饰：贴着墙边随机摆放，不挡路
  if (room.type !== 'boss' && has('props')) {
    const row = themeOf(level) * 4
    const spots: [number, number][] = []
    for (let x = 2; x < ROOM_W - 2; x++) if (Math.abs(x - 9) > 1) spots.push([x, 1], [x, ROOM_H - 2])
    for (let y = 2; y < ROOM_H - 2; y++) if (Math.abs(y - 5) > 1) spots.push([1, y], [ROOM_W - 2, y])
    const n = 2 + Math.floor(random() * 3)
    for (let i = 0; i < n; i++) {
      const [x, y] = spots[Math.floor(random() * spots.length)]
      if (tileAt(room, x, y) !== FLOOR) continue
      const index = row + Math.floor(random() * 4)
      g.globalAlpha = 0.92
      drawFrame(g, 'props', index, (x + 0.5) * TILE, (y + 0.95) * TILE, { height: 0, fit: index % 4 === 0 && row === 0 ? 30 : 24, anchor: 'bottom', flip: random() < 0.5 })
      g.globalAlpha = 1
    }
  }
  // 装饰：骨头与碎罐
  if (room.type === 'normal' && has('pickups')) {
    for (let i = 0; i < 2; i++) {
      if (random() < 0.45) continue
      const x = 2 + Math.floor(random() * (ROOM_W - 4)), y = 2 + Math.floor(random() * (ROOM_H - 4))
      if (tileAt(room, x, y) !== 0) continue
      g.globalAlpha = 0.85
      drawFrame(g, 'pickups', 11, (x + 0.5) * TILE, (y + 0.8) * TILE, { height: 0, fit: 18, anchor: 'bottom', flip: random() < 0.5 })
      g.globalAlpha = 1
    }
  }
  for (let y = 0; y < ROOM_H; y++) for (let x = 0; x < ROOM_W; x++) {
    if (tileAt(room, x, y) !== ROCK) continue
    const rock = feathered(sheet, random() < 0.5 ? 10 : 11, 0.55)
    if (rock) g.drawImage(rock, x * TILE - 8, y * TILE - 10, TILE + 16, TILE + 16)
  }

  // 墙：上方正面砖墙；左右与下方用墙顶石沿朝向房间
  for (let x = 0; x < ROOM_W; x++) {
    drawTile(g, sheet, 4, x * TILE, 0, TILE, TILE)
    drawTile(g, sheet, 5, x * TILE, WORLD_H - TILE, TILE, TILE)
  }
  for (let y = 1; y < ROOM_H - 1; y++) {
    for (const [x, rot] of [[0, Math.PI / 2], [ROOM_W - 1, -Math.PI / 2]] as const) {
      g.save(); g.translate((x + 0.5) * TILE, (y + 0.5) * TILE); g.rotate(rot)
      drawTile(g, sheet, 5, -TILE / 2, -TILE / 2, TILE, TILE)
      g.restore()
    }
  }
  g.fillStyle = 'rgba(0,0,0,.28)'
  g.fillRect(0, WORLD_H - TILE, WORLD_W, TILE)
  g.fillRect(0, TILE, TILE, WORLD_H - TILE * 2)
  g.fillRect(WORLD_W - TILE, TILE, TILE, WORLD_H - TILE * 2)
  return true
}

export function drawDoorsArt(ctx: CanvasRenderingContext2D, game: Game) {
  const sheet = tilesetFor(game.level)
  if (!has(sheet)) return false
  const room = game.room
  for (const [dir, other] of Object.entries(room.doors) as [Dir, Room][]) {
    const [tx, ty] = DOOR_TILE[dir]
    if (room.hidden[dir] !== undefined) {
      // 裂缝墙：越打越碎
      const hp = room.hidden[dir]!
      ctx.save()
      ctx.translate((tx + 0.5) * TILE, (ty + 0.5) * TILE)
      ctx.rotate(dir === 'n' ? 0 : dir === 's' ? Math.PI : dir === 'w' ? -Math.PI / 2 : Math.PI / 2)
      drawFrame(ctx, 'traps', 14, 0, 2, { height: 0, fit: 30, anchor: 'center', alpha: hp < 7 ? 1 : 0.85 })
      ctx.restore()
      continue
    }
    const index = !room.cleared ? 12 : other.type === 'boss' ? 14 : other.type === 'treasure' ? 15 : 13
    const art = feathered(sheet, index, 0.72)
    if (!art) continue
    ctx.save()
    ctx.translate((tx + 0.5) * TILE, (ty + 0.5) * TILE)
    ctx.rotate(dir === 'n' ? 0 : dir === 's' ? Math.PI : dir === 'w' ? -Math.PI / 2 : Math.PI / 2)
    ctx.drawImage(art, -34, -30, 68, 68)
    ctx.restore()
  }
  return true
}

export function torchSpots(room: Room): [number, number][] {
  return [[4, 0], [14, 0]].filter(([x]) => (!room.doors.n || room.hidden.n !== undefined) || Math.abs(x - 9) > 1).map(([x, y]) => [(x + 0.5) * TILE, (y + 0.75) * TILE])
}

export function drawTorchesArt(ctx: CanvasRenderingContext2D, game: Game, time: number) {
  if (!has('pickups')) return false
  // 生成的三帧火把支架位置不一致，固定用第一帧，火焰闪烁由程序叠加
  torchSpots(game.room).forEach(([x, y], i) => {
    const f = Math.sin(time * 11 + i * 2.1) * 0.5 + Math.sin(time * 17.3 + i) * 0.5
    drawFrame(ctx, 'pickups', 8, x, y + 12, { height: 0, fit: 26, anchor: 'pin', scaleY: 1 })
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const g = ctx.createRadialGradient(x + 2, y - 6, 0, x + 2, y - 6, 9 + f * 1.5)
    g.addColorStop(0, `rgba(255,200,110,${0.55 + f * 0.15})`); g.addColorStop(1, 'rgba(255,120,40,0)')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.ellipse(x + 2, y - 7 - f, 7, 10 + f * 1.5, 0, 0, 7); ctx.fill()
    ctx.restore()
  })
  return true
}

// —— 机关、可破坏物与地面危险区 ——

export function drawTrapsArt(ctx: CanvasRenderingContext2D, traps: Trap[], time: number) {
  if (!has('traps')) return false
  for (const t of traps) {
    if (t.kind === 'spike') drawFrame(ctx, 'traps', spikeState(time, t.offset), t.x, t.y, { height: 0, fit: 26, anchor: 'center', anchorFrom: 0 })
    else {
      const s = ventState(time, t.offset)
      drawFrame(ctx, 'traps', 3, t.x, t.y + 6, { height: 0, fit: 24, anchor: 'bottom' })
      if (s === 1) { ctx.fillStyle = `rgba(255,120,40,${0.25 + Math.sin(time * 30) * 0.15})`; ctx.beginPath(); ctx.ellipse(t.x, t.y - 4, 8, 3, 0, 0, 7); ctx.fill() }
    }
  }
  return true
}

/** 喷口的火柱在角色之后绘制，盖住站在上面的角色 */
export function drawVentFireArt(ctx: CanvasRenderingContext2D, traps: Trap[], time: number) {
  for (const t of traps) {
    if (t.kind !== 'vent' || ventState(time, t.offset) !== 2) continue
    drawFrame(ctx, 'traps', 4 + loop(time, 12, 2), t.x, t.y + 6, { height: 0, fit: 50, anchor: 'bottom', anchorFrom: 4 })
  }
}

export function drawPropArt(ctx: CanvasRenderingContext2D, p: Prop) {
  if (!has('traps')) return false
  if (p.broken) {
    if (p.kind === 'barrel') return true
    const alpha = Math.max(0, 1 - Math.max(0, p.t - 6) * 0.5)
    if (alpha <= 0) return true
    return drawFrame(ctx, 'traps', p.kind === 'crate' ? 9 : 11, p.x, p.y + p.r, { height: 0, fit: p.kind === 'crate' ? 18 : 14, anchor: 'bottom', flip: p.flip, alpha })
  }
  const index = p.kind === 'crate' ? 8 : p.kind === 'pot' ? 10 : 6
  return drawFrame(ctx, 'traps', index, p.x, p.y + p.r * 0.9, { height: 0, fit: p.kind === 'pot' ? 22 : 26, anchor: 'bottom', flip: p.flip })
}

export function drawHazardArt(ctx: CanvasRenderingContext2D, h: Hazard, time: number) {
  const a = h.warn > 0 ? 0 : Math.min(1, h.life / Math.min(0.5, h.max))
  if (h.kind === 'fire' && h.warn <= 0) {
    for (let i = 0; i < 3; i++) {
      const ox = Math.cos(i * 2.1 + h.x) * h.r * 0.45, oy = Math.sin(i * 2.1 + h.y) * h.r * 0.3
      drawFrame(ctx, 'traps', 4 + ((loop(time, 10, 2) + i) % 2), h.x + ox, h.y + oy + 4, { height: 0, fit: h.r * 1.4, anchor: 'bottom', anchorFrom: 4, alpha: a * 0.9 })
    }
    return has('traps')
  }
  if (h.kind === 'root' && h.warn <= 0) {
    // 树根：从地面刺出的尖木
    const t = 1 - h.life / h.max
    ctx.save()
    ctx.globalAlpha = a
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + h.x
      const x = h.x + Math.cos(ang) * h.r * 0.5, y = h.y + Math.sin(ang) * h.r * 0.3
      const tall = (h.r * 1.2 + i * 2) * Math.min(1, t * 6)
      ctx.fillStyle = i % 2 ? '#6b4a2b' : '#8a6a3d'
      ctx.beginPath(); ctx.moveTo(x - 4, y + 3); ctx.lineTo(x + Math.cos(ang) * 4, y - tall); ctx.lineTo(x + 4, y + 3); ctx.fill()
    }
    ctx.restore()
    return true
  }
  return false
}

// —— 掉落物 ——

export function drawPickupArt(ctx: CanvasRenderingContext2D, p: Pickup, time: number) {
  const bob = Math.sin(time * 3 + p.x) * 2
  switch (p.kind) {
    case 'heart': return drawFrame(ctx, 'pickups', 0, p.x, p.y - 2 + bob, { height: 0, fit: 14, anchor: 'center' })
    case 'energy': return drawFrame(ctx, 'pickups', 1, p.x, p.y, { height: 0, fit: 10, anchor: 'center', rotate: time * 4 })
    case 'coin': return drawFrame(ctx, 'shop', 4 + loop(time + p.x * 0.01, 8, 4), p.x, p.y + bob * 0.5, { height: 0, fit: 9, anchor: 'center', anchorFrom: 4 })
    case 'key': return drawFrame(ctx, 'shop', 9, p.x, p.y + bob, { height: 0, fit: 16, anchor: 'center', rotate: -0.5 })
    case 'chest': return drawFrame(ctx, 'pickups', p.used ? 3 : 2, p.x, p.y + 10, { height: 0, fit: 26, anchor: 'bottom' })
    case 'locked': return drawFrame(ctx, 'shop', 10, p.x, p.y + 12, { height: 0, fit: 26, anchor: 'bottom' })
    case 'stairs': return drawFrame(ctx, 'pickups', 4, p.x, p.y, { height: 0, fit: 34, anchor: 'center' })
    case 'fountain': return drawFrame(ctx, 'pickups', p.used ? 6 : 5, p.x, p.y + 14, { height: 0, fit: 46, anchor: 'bottom' })
    case 'merchant': return drawFrame(ctx, 'shop', loop(time, 2.5, 4), p.x, p.y + 16, { height: 0, fit: 40, anchor: 'bottom', anchorFrom: 0 })
    case 'altar': {
      if (!drawFrame(ctx, 'traps', p.altar === 'bless' ? 12 : 13, p.x, p.y + 16, { height: 0, fit: 40, anchor: 'bottom', alpha: p.used ? 0.55 : 1 })) return false
      return true
    }
    case 'ware': {
      if (!drawFrame(ctx, 'shop', 8, p.x, p.y + 4, { height: 0, fit: 22, anchor: 'center' })) return false
      if (p.ware === 'heart') drawFrame(ctx, 'pickups', 0, p.x, p.y - 6 + bob, { height: 0, fit: 15, anchor: 'center' })
      else if (p.ware === 'key') drawFrame(ctx, 'shop', 9, p.x, p.y - 6 + bob, { height: 0, fit: 17, anchor: 'center', rotate: -0.5 })
      else if (p.ware === 'weapon') weaponIcon(ctx, p.weapon!, p.x, p.y - 6 + bob, 26, -0.35)
      else itemIcon(ctx, p.item!, p.x, p.y - 8 + bob, 20)
      return true
    }
    case 'item': {
      if (!drawFrame(ctx, 'pickups', 7, p.x, p.y + 14, { height: 0, fit: 22, anchor: 'bottom' })) return false
      return itemIcon(ctx, p.item!, p.x, p.y - 12 + bob, 20)
    }
    case 'weapon': return weaponIcon(ctx, p.weapon!, p.x, p.y + bob, 26, -0.35)
  }
  return false
}

export function itemIcon(ctx: CanvasRenderingContext2D, item: ItemDef, x: number, y: number, size: number) {
  const [sheet, index] = itemArt(item.id)
  return drawFrame(ctx, sheet, index, x, y, { height: 0, fit: size, anchor: 'center' })
}

/** 按武器长度绘制图标（宽度约等于 length）。 */
export function weaponIcon(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, length: number, rotate = 0) {
  const [sheet, index] = WEAPON_ART[id]
  const box = meta(sheet).boxes?.[index]
  if (!box || !has(sheet)) return false
  const fit = length * (box[3] - box[1]) / (box[2] - box[0])
  return drawFrame(ctx, sheet, index, x, y, { height: 0, fit, anchor: 'center', rotate })
}

// —— 角色 ——

/** 武器在世界中的长度 */
const WEAPON_LENGTH: Record<string, number> = {
  pistol: 17, smg: 24, shotgun: 28, laser: 28, rocket: 34, bouncer: 22, frost: 30, saber: 34,
  bow: 24, crossbow: 24, flamer: 30, thunder: 30, boomerang: 16, gatling: 32, sniper: 38, axe: 30,
}

/** 各英雄的表、帧位置与参考高度 */
const HERO_ART = {
  knight: { sheet: 'player' as SheetName, height: 36, roll: 8, skill: -1, hurt: 12, death: 13 },
  ranger: { sheet: 'ranger' as SheetName, height: 34, roll: 8, skill: 12, hurt: 16, death: 17 },
  mage: { sheet: 'mage' as SheetName, height: 37, roll: 8, skill: 12, hurt: 16, death: 17 },
}

export function drawPlayerArt(ctx: CanvasRenderingContext2D, game: Game, time: number) {
  const p = game.player
  const art = HERO_ART[p.hero]
  if (!has(art.sheet)) return false
  const face = p.skillTime > 0 && p.hero !== 'mage' ? (p.skillX >= 0 ? 1 : -1) : Math.cos(p.aim) >= 0 ? 1 : -1
  const moving = Math.hypot(p.vx, p.vy) > 20
  let sheet = art.sheet, frame: number
  if (game.state === 'dead') frame = art.death + Math.min(2, Math.floor(game.deadTime * 6))
  else if (p.skillTime > 0) {
    const total = p.hero === 'knight' ? 0.42 : p.hero === 'ranger' ? 0.24 : 0.45
    const k = Math.min(3, Math.floor((1 - p.skillTime / total) * 4))
    if (p.hero === 'knight' && has('knightSkill')) { sheet = 'knightSkill'; frame = Math.min(2, k) }
    else frame = art.skill >= 0 ? art.skill + k : art.roll
  } else if (p.dashTime > 0) frame = art.roll + Math.min(3, Math.floor((1 - p.dashTime / 0.18) * 4))
  else if (p.invuln > 0.8) frame = art.hurt
  else if (moving) frame = 4 + Math.floor(p.walk * 0.9) % 4
  else frame = loop(time, 5, 4)
  const blink = p.invuln > 0 && game.state !== 'dead' && Math.floor(time * 20) % 2 ? 0.45 : 1
  const gun = () => {
    if (game.state === 'dead' || p.dashTime > 0 || (p.skillTime > 0 && p.hero !== 'mage')) return
    const w = game.weapon
    const swing = game.swings[0]
    const angle = swing ? swing.angle - 1.25 + Math.min(1, (1 - swing.life / swing.max) * 1.6) * 2.5 : p.aim
    if (w.melee && !swing && game.swings.length) return
    const len = WEAPON_LENGTH[w.id] ?? 18
    const [wsheet, index] = WEAPON_ART[w.id]
    const box = meta(wsheet).boxes?.[index]
    if (!box) return
    const fit = len * (box[3] - box[1]) / (box[2] - box[0])
    const shake = w.spin && p.spin > 0.2 ? (Math.random() - 0.5) * p.spin : 0
    const hx = p.x + face * 3 - Math.cos(angle) * p.recoil * 3, hy = p.y + 1 - Math.sin(angle) * p.recoil * 3 + shake
    ctx.globalAlpha = blink
    drawFrame(ctx, wsheet, index, hx, hy, { height: 0, fit, anchor: 'grip', rotate: angle, scaleY: Math.cos(angle) >= 0 ? 1 : -1 })
    ctx.globalAlpha = 1
  }
  const behind = Math.sin(p.aim) < -0.3
  if (behind) gun()
  ctx.globalAlpha = blink
  drawFrame(ctx, sheet, frame, p.x, p.y + 10, { height: art.height, flip: face < 0 })
  ctx.globalAlpha = 1
  if (!behind) gun()
  return true
}

function enemyFrame(e: Enemy, time: number): number {
  const a = e.anim
  const rage = e.hp < e.maxHp * 0.5
  switch (e.kind) {
    case 'slime': return e.state === 'hop' ? (e.timer > 0.2 ? 1 : 2) : loop(a, 3, 2) * 3
    case 'bat': return e.state === 'retreat' ? 12 + loop(a, 10, 2) : 8 + loop(a, 12, 4)
    case 'archer': return e.state === 'aim' ? (e.timer > 0.25 ? 4 : 5) : e.pose < 0.22 ? 6 : loop(a, 7, 4)
    case 'totem': return e.state === 'charge' ? 10 + loop(a, 8, 2) : e.pose < 0.25 ? 12 : e.flash > 0.6 ? 13 : 8 + loop(a, 2, 2)
    case 'boar': return e.state === 'windup' ? 4 + loop(a, 10, 2) : e.state === 'charge' ? 6 : e.state === 'stun' ? 7 : loop(a, 10, 4)
    case 'pumpkin': return e.state === 'fuse' ? (e.timer < 0.1 ? 15 : 12 + Math.min(2, Math.floor((1 - e.timer / 0.65) * 3))) : 8 + loop(a, 10, 4)
    case 'mage': return e.state === 'vanish' ? (e.timer < 0.17 ? 5 : 4) : e.state === 'appear' ? (e.timer < 0.17 ? 7 : 6) : e.state === 'cast' ? 2 + loop(a, 6, 2) : loop(a, 3, 2)
    case 'mushroom': return e.state === 'puff' ? 4 : e.state === 'spray' ? 5 : loop(a, 6, 4)
    case 'ghost': return e.state === 'fade' ? (e.timer > 0.8 ? 12 : 13) : 8 + loop(a, 6, 4)
    case 'lizard': return e.state === 'wind' ? 4 : e.state === 'breath' ? 5 : loop(a, 7, 4)
    case 'shield': return e.state === 'wind' || e.state === 'slash' ? 13 : e.pose < 0.2 ? 12 : 8 + loop(a, 6, 4)
    case 'mummy': return e.state === 'down' ? (e.pose < 0.2 ? 4 : 5) : e.state === 'rise' ? (e.timer > 0.3 ? 6 : 7) : loop(a, 5, 4)
    case 'worm': return e.state === 'under' ? 8 : e.state === 'emerge' ? (e.timer > 0.2 ? 9 : 10) : e.state === 'dive' ? 11 : e.pose < 0.35 ? 12 + loop(a, 8, 2) : 10
    case 'kingSlime': return e.state === 'rise' ? 1 : e.state === 'air' ? 2 : e.pose < 0.3 ? 3 : 0
    case 'golem': return e.state === 'chargeWind' || e.state === 'charge' ? 3 : e.state === 'slamWind' || e.state === 'rocksWind' ? (e.pose < 0.3 ? 2 : 1) : 0
    case 'necro': return e.state === 'spiral' || e.state === 'burst' ? 1 : e.state === 'summon' ? 2 : e.state === 'vanish' ? 3 : 0
    case 'treant': case 'dragon': case 'pharaoh': {
      if (e.state.endsWith('Wind')) return 1
      if (['roots', 'breath', 'beam'].includes(e.state) || e.pose < 0.3) return 2
      if (['spores', 'fly', 'storm'].includes(e.state)) return 3
      return rage ? 4 : 0
    }
  }
  void time
  return 0
}

export function drawEnemyArt(ctx: CanvasRenderingContext2D, e: Enemy, game: Game, time: number) {
  const art = ENEMY_ART[e.kind]
  if (!art || !has(art.sheet)) return false
  const scale = e.boss ? 1 : e.r / ENEMIES[e.kind as EnemyKind].radius
  if (e.spawn > 0) {
    const t = Math.max(0, 1 - e.spawn / (e.boss ? 1.2 : 0.7))
    drawFrame(ctx, 'fx', 15, e.x, e.y + e.r * 0.7, { height: 0, fit: e.r * (1.2 + t * 0.8), anchor: 'center', alpha: 0.9 - t * 0.3 })
    if (t < 0.4) return true
    ctx.globalAlpha = (t - 0.4) / 0.6
  }
  const charging = (e.kind === 'boar' && (e.state === 'charge' || e.state === 'windup')) || e.kind === 'shield' || (e.kind === 'ghost' && e.state === 'lunge') || (e.kind === 'lizard' && e.state !== 'idle') || (e.kind === 'mushroom' && e.state !== 'idle')
  const face = charging ? Math.cos(e.angle) >= 0 : game.player.x >= e.x
  const hover = e.kind === 'bat' ? Math.sin(e.anim * 5) * 2 : ['mage', 'necro', 'ghost', 'pharaoh'].includes(e.kind) ? Math.sin(e.anim * 2.5) * 2.5 : 0
  const tremble = e.state === 'windup' || e.state === 'slamWind' || e.state.endsWith('Wind') && e.boss ? (Math.random() - 0.5) * 1.5 : 0
  const sq = e.squash
  if (e.slow > 0) { ctx.fillStyle = 'rgba(155,231,255,.22)'; ctx.beginPath(); ctx.arc(e.x, e.y, e.r + 4, 0, 7); ctx.fill() }
  if (e.elite) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = 'rgba(255,209,102,.16)'; ctx.beginPath(); ctx.arc(e.x, e.y - e.r * 0.3, e.r * 1.6, 0, 7); ctx.fill(); ctx.restore() }
  if (e.kind === 'ghost') ctx.globalAlpha *= e.state === 'fade' ? Math.max(0.12, e.timer / 1.1) : 0.88
  drawFrame(ctx, art.sheet, enemyFrame(e, time), e.x + tremble, e.y + e.r * 0.85 - e.z + hover, {
    height: art.height * scale, flip: !face, flash: e.flash > 0.25 ? e.flash : 0,
    scaleX: 2 - sq, scaleY: sq,
  })
  ctx.globalAlpha = 1
  // 状态效果：冰冻罩一层冰蓝，燃烧与中毒在头顶显示小图标
  if (e.freeze > 0) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = 'rgba(150,220,255,.28)'; ctx.beginPath(); ctx.ellipse(e.x, e.y - e.r * 0.2, e.r * 1.25, e.r * 1.45, 0, 0, 7); ctx.fill()
    ctx.restore()
  }
  const icons = [e.burn > 0 ? 0 : -1, e.poison > 0 ? 1 : -1, e.freeze > 0 ? 2 : -1].filter(i => i >= 0)
  icons.forEach((icon, i) => drawFrame(ctx, 'ui2', icon, e.x + (i - (icons.length - 1) / 2) * 9, e.y - e.r * (e.boss ? 2.6 : 2) - 16 - e.z, { height: 0, fit: 8, anchor: 'center' }))
  if (!e.boss && e.hp < e.maxHp && e.spawn <= 0 && e.state !== 'under') {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(e.x - 11, e.y - e.r * 2 - 8, 22, 3.5)
    ctx.fillStyle = e.elite ? '#ffd166' : '#ff5d5d'; ctx.fillRect(e.x - 11, e.y - e.r * 2 - 8, 22 * Math.max(0, e.hp / e.maxHp), 3.5)
  }
  return true
}

const DEATH: Record<string, number[]> = {
  slime: [6, 7], bat: [14, 15], archer: [7], totem: [14, 15], boar: [7], mage: [4, 5],
  mushroom: [6, 7], ghost: [14, 15], lizard: [6, 7], shield: [14, 15], mummy: [4, 5], worm: [14, 15],
}
const STAYS = new Set(['slime', 'bat', 'archer', 'totem', 'mushroom', 'lizard', 'shield', 'mummy', 'worm'])

export function drawCorpses(ctx: CanvasRenderingContext2D, game: Game) {
  for (const c of game.corpses) drawCorpse(ctx, c)
}

function drawCorpse(ctx: CanvasRenderingContext2D, c: Corpse) {
  const art = ENEMY_ART[c.kind]
  if (!art || !has(art.sheet)) return
  if (NEW_BOSSES.has(c.kind)) {
    drawFrame(ctx, art.sheet, 5, c.x, c.y + 26, { height: art.height, flip: c.flip, alpha: Math.max(0.35, 1 - c.t * 0.2), flash: Math.max(0, 0.8 - c.t * 2) })
    return
  }
  const frames = DEATH[c.kind]
  if (!frames) {
    if (c.t > 1.2) return
    drawFrame(ctx, art.sheet, 0, c.x, c.y + 26, { height: art.height, flip: c.flip, alpha: 1 - c.t / 1.2, flash: 1 - c.t / 1.2 })
    return
  }
  const frame = frames[Math.min(frames.length - 1, Math.floor(c.t * 6))]
  const alpha = STAYS.has(c.kind) ? Math.max(0.55, 1 - c.t * 0.4) : Math.max(0, 1 - c.t * 1.6)
  if (alpha <= 0) return
  const radius = ENEMIES[c.kind as EnemyKind].radius * c.scale
  drawFrame(ctx, art.sheet, frame, c.x, c.y + radius * 0.85, { height: art.height * c.scale, flip: c.flip, alpha, flash: Math.max(0, 0.6 - c.t * 4) })
}

// —— 子弹与特效 ——

export function drawBulletsArt(ctx: CanvasRenderingContext2D, game: Game) {
  if (!has('fx')) return false
  for (const b of game.bullets) {
    const angle = Math.atan2(b.vy, b.vx)
    if (b.shape === 'arrow') { arrow(ctx, b.x, b.y, angle, b.r, b.color); continue }
    if (b.shape === 'flame') {
      const t = 1 - b.life / b.max
      ctx.save(); ctx.globalCompositeOperation = 'lighter'
      drawFrame(ctx, 'fx', 9, b.x, b.y, { height: 0, fit: b.r * 2, anchor: 'center', rotate: angle, alpha: Math.max(0, 0.9 - t * 0.9) })
      ctx.restore()
      continue
    }
    if (b.shape === 'boomerang') { weaponIcon(ctx, 'boomerang', b.x, b.y, b.r * 2.2, game.time * 18); continue }
    if (b.sprite === undefined) continue
    if (b.sprite === 2) {
      drawFrame(ctx, 'fx', 2, b.x, b.y, { height: 0, fit: b.r * 2.6, anchor: 'head', rotate: angle, scaleX: 1.4 })
    } else {
      drawFrame(ctx, 'fx', b.sprite, b.x, b.y, { height: 0, fit: b.r * (b.enemy ? 3.4 : 3.2), anchor: 'head', rotate: angle })
    }
    if (b.crit) drawFrame(ctx, 'fx', 7, b.x, b.y, { height: 0, fit: b.r * 3, anchor: 'center', rotate: game.time * 8 })
  }
  return true
}

function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, r: number, color: string) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle)
  const len = r * 4.4
  ctx.strokeStyle = '#7a5532'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(0, 0); ctx.stroke()
  ctx.fillStyle = '#dfe6ef'
  ctx.beginPath(); ctx.moveTo(r * 1.4, 0); ctx.lineTo(-r * 0.4, -r * 0.8); ctx.lineTo(-r * 0.4, r * 0.8); ctx.fill()
  ctx.fillStyle = color
  ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(-len - r * 0.8, -r * 0.9); ctx.lineTo(-len + r * 0.8, 0); ctx.lineTo(-len - r * 0.8, r * 0.9); ctx.fill()
  ctx.restore()
}

export function drawSwingsArt(ctx: CanvasRenderingContext2D, game: Game) {
  if (!has('fx')) return false
  for (const s of game.swings) {
    const t = 1 - s.life / s.max
    const a = s.angle - 0.6 + t * 1.2
    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    if (!s.deflect) ctx.filter = 'hue-rotate(160deg) saturate(.4) brightness(1.4)'
    drawFrame(ctx, 'fx', 6, s.x + Math.cos(a) * s.range * 0.55, s.y + Math.sin(a) * s.range * 0.55, { height: 0, fit: s.range * 1.5, anchor: 'center', rotate: a, alpha: 1 - t * 0.8 })
    ctx.restore()
  }
  return true
}

/** 爆炸、命中、枪口火光与弹壳；返回 true 表示已绘制。 */
export function drawParticleArt(ctx: CanvasRenderingContext2D, p: Particle) {
  const t = 1 - p.life / p.max
  switch (p.kind) {
    case 'explosion':
      return drawFrame(ctx, 'explosion', Math.min(5, Math.floor(t * 6)), p.x, p.y, { height: 0, fit: p.size * (0.7 + t * 0.4), anchor: 'center' })
    case 'impact':
      ctx.save(); ctx.globalCompositeOperation = 'lighter'
      drawFrame(ctx, 'fx', 14, p.x, p.y, { height: 0, fit: p.size * (0.6 + t * 0.6), anchor: 'center', rotate: p.angle, alpha: 1 - t })
      ctx.restore()
      return has('fx')
    case 'flash':
      return drawFrame(ctx, 'fx', 13, p.x, p.y, { height: 0, fit: p.size * 1.6, anchor: 'grip', rotate: p.angle, alpha: 1 - t * 0.5 })
    case 'shell':
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle ?? 0)
      ctx.fillStyle = p.color; ctx.fillRect(-p.size, -p.size * 0.5, p.size * 2, p.size)
      ctx.restore()
      return true
  }
  return false
}

// —— 界面 ——

export const uiIcon = (ctx: CanvasRenderingContext2D, index: number, x: number, y: number, size: number, alpha = 1) =>
  drawFrame(ctx, 'ui', index, x, y, { height: 0, fit: size, anchor: 'center', alpha })

export const ui2Icon = (ctx: CanvasRenderingContext2D, index: number, x: number, y: number, size: number, alpha = 1) =>
  drawFrame(ctx, 'ui2', index, x, y, { height: 0, fit: size, anchor: 'center', alpha })
