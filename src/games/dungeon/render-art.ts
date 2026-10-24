/** 基于雪碧图的绘制；每个函数在素材缺失时返回 false，由 render.ts 退回程序化绘制。 */
import { ENEMIES, ITEMS, ROOM_H, ROOM_W, TILE, WORLD_H, WORLD_W } from './data'
import type { EnemyKind, ItemDef } from './data'
import type { Corpse, Enemy, Game, Particle, Pickup } from './game'
import { DOOR_TILE, PIT, ROCK, rng, tileAt } from './map'
import type { Dir, Room } from './map'
import { cellCanvas, drawFrame, drawTile, has, meta } from './sprites'
import type { SheetName } from './sprites'

const TILESETS: SheetName[] = ['tilesStone', 'tilesMoss', 'tilesCrimson', 'tilesSand']
const WEAPON_INDEX = ['pistol', 'smg', 'shotgun', 'laser', 'rocket', 'bouncer', 'frost', 'saber']

/** 每种怪物所在的表，以及该表参考帧（第一帧）的世界高度 */
const ENEMY_ART: Record<string, { sheet: SheetName; height: number }> = {
  slime: { sheet: 'enemiesA', height: 28 }, bat: { sheet: 'enemiesA', height: 28 },
  archer: { sheet: 'enemiesB', height: 40 }, totem: { sheet: 'enemiesB', height: 40 },
  boar: { sheet: 'enemiesC', height: 35 }, pumpkin: { sheet: 'enemiesC', height: 35 },
  mage: { sheet: 'enemiesD', height: 40 },
  kingSlime: { sheet: 'bossSlime', height: 74 }, golem: { sheet: 'bossGolem', height: 92 }, necro: { sheet: 'bossNecro', height: 86 },
}

export const tilesetFor = (level: number) => TILESETS[(level - 1) % TILESETS.length]
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
    const index = !room.cleared ? 12 : other.type === 'boss' ? 14 : other.type === 'treasure' ? 15 : 13
    const art = feathered(sheet, index, 0.72)
    if (!art) continue
    const [tx, ty] = DOOR_TILE[dir]
    ctx.save()
    ctx.translate((tx + 0.5) * TILE, (ty + 0.5) * TILE)
    ctx.rotate(dir === 'n' ? 0 : dir === 's' ? Math.PI : dir === 'w' ? -Math.PI / 2 : Math.PI / 2)
    ctx.drawImage(art, -34, -30, 68, 68)
    ctx.restore()
  }
  return true
}

export function torchSpots(room: Room): [number, number][] {
  return [[4, 0], [14, 0]].filter(([x]) => !room.doors.n || Math.abs(x - 9) > 1).map(([x, y]) => [(x + 0.5) * TILE, (y + 0.75) * TILE])
}

export function drawTorchesArt(ctx: CanvasRenderingContext2D, game: Game, time: number) {
  if (!has('pickups')) return false
  torchSpots(game.room).forEach(([x, y], i) => drawFrame(ctx, 'pickups', 8 + loop(time + i * 0.37, 8, 3), x, y + 12, { height: 0, fit: 26, anchor: 'bottom', anchorFrom: 8 }))
  return true
}

// —— 掉落物 ——

export function drawPickupArt(ctx: CanvasRenderingContext2D, p: Pickup, time: number) {
  const bob = Math.sin(time * 3 + p.x) * 2
  switch (p.kind) {
    case 'heart': return drawFrame(ctx, 'pickups', 0, p.x, p.y - 2 + bob, { height: 0, fit: 14, anchor: 'center' })
    case 'energy': return drawFrame(ctx, 'pickups', 1, p.x, p.y, { height: 0, fit: 10, anchor: 'center', rotate: time * 4 })
    case 'chest': return drawFrame(ctx, 'pickups', p.used ? 3 : 2, p.x, p.y + 10, { height: 0, fit: 26, anchor: 'bottom' })
    case 'stairs': return drawFrame(ctx, 'pickups', 4, p.x, p.y, { height: 0, fit: 34, anchor: 'center' })
    case 'fountain': return drawFrame(ctx, 'pickups', p.used ? 6 : 5, p.x, p.y + 14, { height: 0, fit: 46, anchor: 'bottom' })
    case 'item': {
      if (!drawFrame(ctx, 'pickups', 7, p.x, p.y + 14, { height: 0, fit: 22, anchor: 'bottom' })) return false
      return itemIcon(ctx, p.item!, p.x, p.y - 12 + bob, 20)
    }
    case 'weapon': return weaponIcon(ctx, p.weapon!, p.x, p.y + bob, 26, -0.35)
  }
  return false
}

export function itemIcon(ctx: CanvasRenderingContext2D, item: ItemDef, x: number, y: number, size: number) {
  return drawFrame(ctx, 'items', ITEMS.findIndex(i => i.id === item.id), x, y, { height: 0, fit: size, anchor: 'center' })
}

/** 按武器长度绘制图标（宽度约等于 length）。 */
export function weaponIcon(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, length: number, rotate = 0) {
  const index = WEAPON_INDEX.indexOf(id)
  const box = meta('weapons').boxes?.[index]
  if (!box || !has('weapons')) return false
  const fit = length * (box[3] - box[1]) / (box[2] - box[0])
  return drawFrame(ctx, 'weapons', index, x, y, { height: 0, fit, anchor: 'center', rotate })
}

// —— 角色 ——

/** 武器在世界中的长度 */
const WEAPON_LENGTH: Record<string, number> = { pistol: 17, smg: 24, shotgun: 28, laser: 28, rocket: 34, bouncer: 22, frost: 30, saber: 34 }

export function drawPlayerArt(ctx: CanvasRenderingContext2D, game: Game, time: number) {
  if (!has('player')) return false
  const p = game.player
  const face = Math.cos(p.aim) >= 0 ? 1 : -1
  const moving = Math.hypot(p.vx, p.vy) > 20
  let frame: number
  if (game.state === 'dead') frame = 12 + Math.min(3, 1 + Math.floor(game.deadTime * 6))
  else if (p.dashTime > 0) frame = 8 + Math.min(3, Math.floor((1 - p.dashTime / 0.18) * 4))
  else if (p.invuln > 0.8) frame = 12
  else if (moving) frame = 4 + Math.floor(p.walk * 0.9) % 4
  else frame = loop(time, 5, 4)
  const blink = p.invuln > 0 && game.state !== 'dead' && Math.floor(time * 20) % 2 ? 0.45 : 1
  const gun = () => {
    if (game.state === 'dead' || p.dashTime > 0) return
    const w = game.weapon
    const swing = game.swings[0]
    const angle = swing ? swing.angle - 1.25 + Math.min(1, (1 - swing.life / swing.max) * 1.6) * 2.5 : p.aim
    if (w.melee && !swing && game.swings.length) return
    const len = WEAPON_LENGTH[w.id] ?? 18
    const index = WEAPON_INDEX.indexOf(w.id)
    const box = meta('weapons').boxes?.[index]
    if (!box) return
    const fit = len * (box[3] - box[1]) / (box[2] - box[0])
    const hx = p.x + face * 3 - Math.cos(angle) * p.recoil * 3, hy = p.y + 1 - Math.sin(angle) * p.recoil * 3
    ctx.globalAlpha = blink
    drawFrame(ctx, 'weapons', index, hx, hy, { height: 0, fit, anchor: 'grip', rotate: angle, scaleY: Math.cos(angle) >= 0 ? 1 : -1 })
    ctx.globalAlpha = 1
  }
  const behind = Math.sin(p.aim) < -0.3
  if (behind) gun()
  ctx.globalAlpha = blink
  drawFrame(ctx, 'player', frame, p.x, p.y + 10, { height: 36, flip: face < 0 })
  ctx.globalAlpha = 1
  if (!behind) gun()
  return true
}

function enemyFrame(e: Enemy, time: number): number {
  const a = e.anim
  switch (e.kind) {
    case 'slime': return e.state === 'hop' ? (e.timer > 0.2 ? 1 : 2) : loop(a, 3, 2) * 3
    case 'bat': return e.state === 'retreat' ? 12 + loop(a, 10, 2) : 8 + loop(a, 12, 4)
    case 'archer': return e.state === 'aim' ? (e.timer > 0.25 ? 4 : 5) : e.pose < 0.22 ? 6 : loop(a, 7, 4)
    case 'totem': return e.state === 'charge' ? 10 + loop(a, 8, 2) : e.pose < 0.25 ? 12 : e.flash > 0.6 ? 13 : 8 + loop(a, 2, 2)
    case 'boar': return e.state === 'windup' ? 4 + loop(a, 10, 2) : e.state === 'charge' ? 6 : e.state === 'stun' ? 7 : loop(a, 10, 4)
    case 'pumpkin': return e.state === 'fuse' ? (e.timer < 0.1 ? 15 : 12 + Math.min(2, Math.floor((1 - e.timer / 0.65) * 3))) : 8 + loop(a, 10, 4)
    case 'mage': return e.state === 'vanish' ? (e.timer < 0.17 ? 5 : 4) : e.state === 'appear' ? (e.timer < 0.17 ? 7 : 6) : e.state === 'cast' ? 2 + loop(a, 6, 2) : loop(a, 3, 2)
    case 'kingSlime': return e.state === 'rise' ? 1 : e.state === 'air' ? 2 : e.pose < 0.3 ? 3 : 0
    case 'golem': return e.state === 'chargeWind' || e.state === 'charge' ? 3 : e.state === 'slamWind' || e.state === 'rocksWind' ? (e.pose < 0.3 ? 2 : 1) : 0
    case 'necro': return e.state === 'spiral' || e.state === 'burst' ? 1 : e.state === 'summon' ? 2 : e.state === 'vanish' ? 3 : 0
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
  const face = e.kind === 'boar' && (e.state === 'charge' || e.state === 'windup') ? Math.cos(e.angle) >= 0 : game.player.x >= e.x
  const hover = e.kind === 'bat' ? Math.sin(e.anim * 5) * 2 : e.kind === 'mage' || e.kind === 'necro' ? Math.sin(e.anim * 2.5) * 2.5 : 0
  const tremble = e.state === 'windup' || e.state === 'slamWind' ? (Math.random() - 0.5) * 1.5 : 0
  const sq = e.squash
  if (e.slow > 0) { ctx.fillStyle = 'rgba(155,231,255,.22)'; ctx.beginPath(); ctx.arc(e.x, e.y, e.r + 4, 0, 7); ctx.fill() }
  if (e.elite) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = 'rgba(255,209,102,.16)'; ctx.beginPath(); ctx.arc(e.x, e.y - e.r * 0.3, e.r * 1.6, 0, 7); ctx.fill(); ctx.restore() }
  drawFrame(ctx, art.sheet, enemyFrame(e, time), e.x + tremble, e.y + e.r * 0.85 - e.z + hover, {
    height: art.height * scale, flip: !face, flash: e.flash > 0.25 ? e.flash : 0,
    scaleX: 2 - sq, scaleY: sq,
  })
  ctx.globalAlpha = 1
  if (!e.boss && e.hp < e.maxHp && e.spawn <= 0) {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(e.x - 11, e.y - e.r * 2 - 8, 22, 3.5)
    ctx.fillStyle = e.elite ? '#ffd166' : '#ff5d5d'; ctx.fillRect(e.x - 11, e.y - e.r * 2 - 8, 22 * (e.hp / e.maxHp), 3.5)
  }
  return true
}

const DEATH: Record<string, number[]> = { slime: [6, 7], bat: [14, 15], archer: [7], totem: [14, 15], boar: [7], mage: [4, 5] }
const STAYS = new Set(['slime', 'bat', 'archer', 'totem'])

export function drawCorpses(ctx: CanvasRenderingContext2D, game: Game) {
  for (const c of game.corpses) drawCorpse(ctx, c)
}

function drawCorpse(ctx: CanvasRenderingContext2D, c: Corpse) {
  const art = ENEMY_ART[c.kind]
  if (!art || !has(art.sheet)) return
  const frames = DEATH[c.kind]
  if (!frames) {
    if (!['kingSlime', 'golem', 'necro'].includes(c.kind) || c.t > 1.2) return
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

export function drawSwingsArt(ctx: CanvasRenderingContext2D, game: Game) {
  if (!has('fx')) return false
  for (const s of game.swings) {
    const t = 1 - s.life / s.max
    const a = s.angle - 0.6 + t * 1.2
    ctx.save(); ctx.globalCompositeOperation = 'lighter'
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
