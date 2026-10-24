/** 深渊骑士的全部绘制：房间、角色、子弹、光照与界面。 */
import { BOSSES, ENEMIES, ROOM_H, ROOM_W, TILE, WEAPONS, WORLD_H, WORLD_W } from './data'
import type { BossKind, EnemyKind } from './data'
import type { Enemy, Game, Pickup } from './game'
import { DOOR, DOOR_TILE, PIT, ROCK, WALL, rng, tileAt } from './map'
import type { Dir, Room } from './map'
import type { TouchState } from './input'
import { touchLayout } from './input'
import {
  drawBulletsArt, drawCorpses, drawDoorsArt, drawEnemyArt, drawParticleArt, drawPickupArt, drawPlayerArt, drawSwingsArt,
  drawTorchesArt, itemIcon, paintRoomArt, uiIcon, weaponIcon,
} from './render-art'
import { artVersion } from './sprites'

interface Theme { floor: string; floor2: string; grout: string; wall: string; wallTop: string; wallDark: string; rock: string; moss: string; dark: string }

const THEMES: Theme[] = [
  { floor: '#2b2f3d', floor2: '#272a37', grout: '#1b1d27', wall: '#3d4256', wallTop: '#5a6079', wallDark: '#20222e', rock: '#6b6f80', moss: 'rgba(90,140,110,.18)', dark: '#090a10' },
  { floor: '#26332c', floor2: '#222e27', grout: '#18211b', wall: '#38483d', wallTop: '#55705c', wallDark: '#1b241e', rock: '#667a6b', moss: 'rgba(110,190,90,.22)', dark: '#070b08' },
  { floor: '#34262b', floor2: '#2f2226', grout: '#1f1619', wall: '#4c3238', wallTop: '#73505a', wallDark: '#26171b', rock: '#7d6268', moss: 'rgba(200,80,90,.14)', dark: '#0c0708' },
  { floor: '#352f25', floor2: '#302a21', grout: '#201c16', wall: '#4b4232', wallTop: '#6f634a', wallDark: '#241f17', rock: '#80745d', moss: 'rgba(230,190,90,.12)', dark: '#0c0a07' },
]

const FONT = 'Outfit Variable, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
const cache = new WeakMap<Room, { canvas: HTMLCanvasElement; scale: number; theme: number; version: number }>()
let light: HTMLCanvasElement | undefined
let flashing = false
const col = (c: string) => (flashing ? '#ffffff' : c)

export interface View { width: number; height: number; dpr: number; scale: number; ox: number; oy: number }

export function computeView(width: number, height: number, dpr: number): View {
  // 留出四周的界面空间，房间居中
  const scale = Math.min(width / (WORLD_W + 16), height / (WORLD_H + 56))
  return { width, height, dpr, scale, ox: (width - WORLD_W * scale) / 2, oy: (height - WORLD_H * scale) / 2 + Math.min(18, height * 0.03) }
}

export function render(ctx: CanvasRenderingContext2D, game: Game, view: View, touch: TouchState | null, time: number) {
  const { dpr, scale, ox, oy, width, height } = view
  const theme = THEMES[(game.level - 1) % THEMES.length]
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = theme.dark
  ctx.fillRect(0, 0, width, height)

  const shake = game.shake
  const sx = shake ? (Math.random() - 0.5) * shake * 1.4 : 0, sy = shake ? (Math.random() - 0.5) * shake * 1.4 : 0
  const kx = sx + game.kickX, ky = sy + game.kickY
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + kx * scale), dpr * (oy + ky * scale))

  drawRoom(ctx, game, theme, dpr * scale)
  drawDoors(ctx, game, theme, time)
  drawTorches(ctx, game, time)
  for (const p of game.roomPickups) drawPickup(ctx, p, time, game)
  drawTelegraphs(ctx, game, time)
  drawCorpses(ctx, game)

  // 影子先画，角色按 y 排序
  const actors: ({ y: number; draw: () => void })[] = []
  for (const e of game.enemies) {
    shadow(ctx, e.x, e.y + e.r * 0.85, e.r * (e.boss ? 1.05 : 0.95), e.z)
    actors.push({ y: e.y, draw: () => drawEnemy(ctx, e, game, time) })
  }
  if (game.state !== 'dead' || artVersion) {
    if (game.state !== 'dead') shadow(ctx, game.player.x, game.player.y + 9, 9, 0)
    actors.push({ y: game.player.y, draw: () => drawPlayer(ctx, game, time) })
  }
  actors.sort((a, b) => a.y - b.y).forEach(a => a.draw())

  drawSwings(ctx, game)
  drawBullets(ctx, game)
  drawParticles(ctx, game)
  if (game.player.stats.orbit && game.state !== 'dead') for (const o of game.orbits()) glowDot(ctx, o.x, o.y, 5, '#c3f0ff')

  drawLighting(ctx, game, view, theme, time)

  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy)
  if (touch?.active && touch.firing && game.state === 'play') drawAimGuide(ctx, game, touch, time)
  if (game.prompt && game.state === 'play') {
    const p = game.player
    const text = touch?.active ? game.prompt : `E  ${game.prompt}`
    label(ctx, text, p.x, p.y - 26, '#ffffff', 10)
  }
  for (const p of game.particles) if (p.kind === 'text') {
    ctx.globalAlpha = Math.min(1, p.life / p.max * 1.6)
    const pop = 1 + Math.max(0, (p.life / p.max - 0.75) * 2.4)
    label(ctx, p.text!, p.x, p.y, p.color, p.size * 0.9 * pop, false)
  }
  ctx.globalAlpha = 1

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  if (game.hurtFlash > 0) {
    const g = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.3, width / 2, height / 2, Math.max(width, height) * 0.7)
    g.addColorStop(0, 'rgba(255,40,60,0)')
    g.addColorStop(1, `rgba(255,40,60,${0.45 * game.hurtFlash})`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, width, height)
  }
  if (game.state === 'transition') {
    const t = game.transition
    ctx.fillStyle = `rgba(0,0,0,${t < 0.18 ? t / 0.18 : Math.max(0, 1 - (t - 0.18) / 0.18)})`
    ctx.fillRect(0, 0, width, height)
  }
  drawHud(ctx, game, view, touch, time)
}

// —— 房间 ——

function drawRoom(ctx: CanvasRenderingContext2D, game: Game, theme: Theme, pixel: number) {
  const themeIndex = (game.level - 1) % THEMES.length
  let entry = cache.get(game.room)
  if (!entry || Math.abs(entry.scale - pixel) > 0.01 || entry.theme !== themeIndex || entry.version !== artVersion) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(WORLD_W * pixel); canvas.height = Math.ceil(WORLD_H * pixel)
    const g = canvas.getContext('2d')!
    g.scale(pixel, pixel)
    if (!paintRoomArt(g, game.room, game.level)) paintRoom(g, game.room, theme)
    entry = { canvas, scale: pixel, theme: themeIndex, version: artVersion }
    cache.set(game.room, entry)
  }
  ctx.drawImage(entry.canvas, 0, 0, WORLD_W, WORLD_H)
}

function paintRoom(g: CanvasRenderingContext2D, room: Room, t: Theme) {
  const random = rng(room.seed)
  for (let y = 0; y < ROOM_H; y++) for (let x = 0; x < ROOM_W; x++) {
    const px = x * TILE, py = y * TILE
    const tile = tileAt(room, x, y)
    if (tile === WALL || tile === DOOR) continue
    g.fillStyle = (x + y) % 2 ? t.floor : t.floor2
    g.fillRect(px, py, TILE, TILE)
    // 石板：随机明暗与裂纹
    const shade = random()
    g.fillStyle = shade < 0.5 ? `rgba(255,255,255,${shade * 0.05})` : `rgba(0,0,0,${(shade - 0.5) * 0.12})`
    g.fillRect(px + 1, py + 1, TILE - 2, TILE - 2)
    g.strokeStyle = t.grout; g.lineWidth = 1.2
    g.strokeRect(px + 0.6, py + 0.6, TILE - 1.2, TILE - 1.2)
    if (random() < 0.12) {
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1
      g.beginPath(); let cx = px + 6 + random() * 20, cy = py + 6 + random() * 20; g.moveTo(cx, cy)
      for (let i = 0; i < 3; i++) { cx += (random() - 0.5) * 14; cy += (random() - 0.5) * 14; g.lineTo(cx, cy) }
      g.stroke()
    }
    if (random() < 0.08) { g.fillStyle = t.moss; g.beginPath(); g.ellipse(px + random() * TILE, py + random() * TILE, 6 + random() * 8, 4 + random() * 5, random() * 3, 0, 7); g.fill() }
  }
  // 墙脚阴影
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const grad = g.createLinearGradient(x0, y0, x1, y1)
    grad.addColorStop(0, 'rgba(0,0,0,.45)'); grad.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grad
  }
  edge(0, TILE, 0, TILE + 22); g.fillRect(TILE, TILE, WORLD_W - TILE * 2, 22)
  edge(TILE, 0, TILE + 14, 0); g.fillRect(TILE, TILE, 14, WORLD_H - TILE * 2)
  edge(WORLD_W - TILE, 0, WORLD_W - TILE - 14, 0); g.fillRect(WORLD_W - TILE - 14, TILE, 14, WORLD_H - TILE * 2)

  for (let y = 0; y < ROOM_H; y++) for (let x = 0; x < ROOM_W; x++) {
    const tile = tileAt(room, x, y), px = x * TILE, py = y * TILE
    if (tile === PIT) {
      g.fillStyle = '#05060a'
      g.fillRect(px, py, TILE, TILE)
      const up = tileAt(room, x, y - 1) !== PIT
      if (up) {
        const grad = g.createLinearGradient(0, py, 0, py + 12)
        grad.addColorStop(0, t.wallDark); grad.addColorStop(1, 'rgba(5,6,10,0)')
        g.fillStyle = grad; g.fillRect(px, py, TILE, 12)
      }
    } else if (tile === ROCK) {
      g.fillStyle = 'rgba(0,0,0,.35)'
      g.beginPath(); g.ellipse(px + 16, py + 27, 14, 5, 0, 0, 7); g.fill()
      const grad = g.createLinearGradient(px, py, px + 10, py + TILE)
      grad.addColorStop(0, lighten(t.rock, 30)); grad.addColorStop(1, t.wallDark)
      g.fillStyle = grad
      g.beginPath()
      const n = 7, r = 13
      for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; const rr = r * (0.82 + random() * 0.25); g.lineTo(px + 16 + Math.cos(a) * rr, py + 15 + Math.sin(a) * rr * 0.92) }
      g.fill()
      g.fillStyle = 'rgba(255,255,255,.12)'
      g.beginPath(); g.ellipse(px + 12, py + 9, 5, 3, -0.5, 0, 7); g.fill()
    }
  }

  // 四周墙壁：砖缝与顶部高光
  for (let y = 0; y < ROOM_H; y++) for (let x = 0; x < ROOM_W; x++) {
    const tile = tileAt(room, x, y)
    if (tile !== WALL && tile !== DOOR) continue
    const px = x * TILE, py = y * TILE
    g.fillStyle = t.wall
    g.fillRect(px, py, TILE, TILE)
    g.strokeStyle = t.wallDark; g.lineWidth = 1.5
    for (let row = 0; row < 4; row++) {
      const yy = py + row * 8
      g.beginPath(); g.moveTo(px, yy); g.lineTo(px + TILE, yy); g.stroke()
      const off = (row + x) % 2 ? 0 : 12
      for (let bx = off; bx < TILE; bx += 24) { g.beginPath(); g.moveTo(px + bx, yy); g.lineTo(px + bx, yy + 8); g.stroke() }
    }
    if (random() < 0.15) { g.fillStyle = t.moss; g.fillRect(px + random() * 20, py + random() * 20, 10, 6) }
  }
  g.fillStyle = t.wallTop
  g.fillRect(TILE - 3, TILE - 3, WORLD_W - TILE * 2 + 6, 3)
  g.fillRect(TILE - 3, WORLD_H - TILE, WORLD_W - TILE * 2 + 6, 3)
  g.fillRect(TILE - 3, TILE - 3, 3, WORLD_H - TILE * 2 + 6)
  g.fillRect(WORLD_W - TILE, TILE - 3, 3, WORLD_H - TILE * 2 + 6)
  g.fillStyle = 'rgba(0,0,0,.35)'
  g.fillRect(0, 0, WORLD_W, 5); g.fillRect(0, WORLD_H - 5, WORLD_W, 5)
}

function drawDoors(ctx: CanvasRenderingContext2D, game: Game, theme: Theme, time: number) {
  if (drawDoorsArt(ctx, game)) return
  const room = game.room
  for (const [dir, other] of Object.entries(room.doors) as [Dir, Room][]) {
    const [tx, ty] = DOOR_TILE[dir]
    const px = tx * TILE, py = ty * TILE
    const accent = other.type === 'boss' ? '#ff4d5e' : other.type === 'treasure' ? '#ffd166' : other.type === 'heal' ? '#5ee7ff' : theme.wallTop
    ctx.save()
    ctx.translate(px + TILE / 2, py + TILE / 2)
    ctx.rotate(dir === 'n' ? 0 : dir === 's' ? Math.PI : dir === 'w' ? -Math.PI / 2 : Math.PI / 2)
    // 门框
    ctx.fillStyle = theme.wallDark
    ctx.fillRect(-17, -16, 34, 32)
    ctx.fillStyle = '#050608'
    ctx.beginPath(); ctx.moveTo(-12, 16); ctx.lineTo(-12, -6); ctx.arc(0, -6, 12, Math.PI, 0); ctx.lineTo(12, 16); ctx.fill()
    ctx.strokeStyle = accent; ctx.lineWidth = 2.5
    ctx.beginPath(); ctx.moveTo(-14, 16); ctx.lineTo(-14, -6); ctx.arc(0, -6, 14, Math.PI, 0); ctx.lineTo(14, 16); ctx.stroke()
    if (!room.cleared) {
      // 关闭时的铁栅栏
      ctx.strokeStyle = '#8b93a7'; ctx.lineWidth = 2.4
      for (let i = -8; i <= 8; i += 5.3) { ctx.beginPath(); ctx.moveTo(i, 16); ctx.lineTo(i, -12 + Math.abs(i) * 0.3); ctx.stroke() }
      ctx.beginPath(); ctx.moveTo(-12, 4); ctx.lineTo(12, 4); ctx.stroke()
    } else if (other.type === 'boss') {
      ctx.fillStyle = `rgba(255,60,80,${0.25 + Math.sin(time * 4) * 0.1})`
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, 7); ctx.fill()
    }
    ctx.restore()
  }
}

function torchSpots(room: Room): [number, number][] {
  return [[4, 0], [14, 0]].filter(([x]) => !room.doors.n || Math.abs(x - 9) > 1).map(([x, y]) => [(x + 0.5) * TILE, (y + 0.75) * TILE])
}

function drawTorches(ctx: CanvasRenderingContext2D, game: Game, time: number) {
  if (drawTorchesArt(ctx, game, time)) return
  for (const [x, y] of torchSpots(game.room)) {
    ctx.fillStyle = '#4a3423'
    ctx.fillRect(x - 2, y - 2, 4, 9)
    const f = Math.sin(time * 12 + x) * 1.2
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = 'rgba(255,140,40,.55)'
    ctx.beginPath(); ctx.ellipse(x, y - 5, 4.5, 7 + f, 0, 0, 7); ctx.fill()
    ctx.fillStyle = 'rgba(255,230,150,.9)'
    ctx.beginPath(); ctx.ellipse(x, y - 3, 2, 3.5 + f * 0.5, 0, 0, 7); ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }
}

// —— 掉落物 ——

function drawPickup(ctx: CanvasRenderingContext2D, p: Pickup, time: number, game: Game) {
  const bob = Math.sin(time * 3 + p.x) * 2
  if (p.kind === 'energy') { ctx.globalCompositeOperation = 'lighter'; halo(ctx, p.x, p.y, 9, '#4dd2ff', 0.45); ctx.globalCompositeOperation = 'source-over' }
  if (p.kind === 'item' || p.kind === 'weapon') halo(ctx, p.x, p.y - (p.kind === 'item' ? 12 : 0) + bob, 22, p.kind === 'item' ? p.item!.color : WEAPONS[p.weapon!].color, 0.3)
  if (drawPickupArt(ctx, p, time)) {
    const near = Math.hypot(game.player.x - p.x, game.player.y - p.y)
    if (p.kind === 'weapon' && near < 50) label(ctx, WEAPONS[p.weapon!].name, p.x, p.y + 18, WEAPONS[p.weapon!].color, 8)
    if (p.kind === 'item' && near < 60) label(ctx, p.item!.name, p.x, p.y + 24, p.item!.color, 8)
    if (p.kind === 'stairs') label(ctx, '下一层', p.x, p.y - 22, '#8ab4ff', 8)
    return
  }
  switch (p.kind) {
    case 'energy':
      glowDot(ctx, p.x, p.y, 3, '#4dd2ff')
      break
    case 'heart':
      shadow(ctx, p.x, p.y + 8, 6, 0)
      heart(ctx, p.x, p.y - 2 + bob, 7, '#ff4d6d', 1)
      break
    case 'weapon': {
      shadow(ctx, p.x, p.y + 8, 10, 0)
      const w = WEAPONS[p.weapon!]
      halo(ctx, p.x, p.y + bob, 18, w.color, 0.25)
      ctx.save(); ctx.translate(p.x, p.y + bob); ctx.rotate(-0.4); drawWeapon(ctx, w.id, 0, 1.2); ctx.restore()
      if (Math.hypot(game.player.x - p.x, game.player.y - p.y) < 50) label(ctx, w.name, p.x, p.y + 20, w.color, 8)
      break
    }
    case 'item': {
      ctx.fillStyle = '#4b4f63'
      ctx.fillRect(p.x - 12, p.y + 2, 24, 12)
      ctx.fillStyle = '#6c7189'
      ctx.fillRect(p.x - 14, p.y, 28, 4)
      halo(ctx, p.x, p.y - 12 + bob, 22, p.item!.color, 0.35)
      glyph(ctx, p.item!.glyph, p.x, p.y - 12 + bob, 9, p.item!.color)
      if (Math.hypot(game.player.x - p.x, game.player.y - p.y) < 60) label(ctx, p.item!.name, p.x, p.y + 24, p.item!.color, 8)
      break
    }
    case 'chest': {
      shadow(ctx, p.x, p.y + 9, 13, 0)
      ctx.fillStyle = '#8a5a2b'; roundRect(ctx, p.x - 13, p.y - 8, 26, 17, 3); ctx.fill()
      ctx.fillStyle = '#a8713a'; roundRect(ctx, p.x - 13, p.y - 11, 26, 8, 3); ctx.fill()
      ctx.fillStyle = '#ffd166'; ctx.fillRect(p.x - 13, p.y - 4, 26, 2.5); ctx.fillRect(p.x - 2.5, p.y - 6, 5, 7)
      break
    }
    case 'stairs': {
      ctx.fillStyle = '#05060a'; roundRect(ctx, p.x - 16, p.y - 12, 32, 24, 3); ctx.fill()
      ctx.fillStyle = '#3a3f52'
      for (let i = 0; i < 4; i++) ctx.fillRect(p.x - 13 + i * 2, p.y - 9 + i * 5, 26 - i * 4, 3)
      halo(ctx, p.x, p.y, 26, '#8ab4ff', 0.2 + Math.sin(time * 3) * 0.08)
      label(ctx, '下一层', p.x, p.y - 20, '#8ab4ff', 8)
      break
    }
    case 'fountain': {
      shadow(ctx, p.x, p.y + 12, 22, 0)
      ctx.fillStyle = '#6c7189'; ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 22, 11, 0, 0, 7); ctx.fill()
      ctx.fillStyle = p.used ? '#2b2f3d' : '#2fa8d8'; ctx.beginPath(); ctx.ellipse(p.x, p.y + 3, 17, 7.5, 0, 0, 7); ctx.fill()
      ctx.fillStyle = '#8a8fa6'; ctx.fillRect(p.x - 3, p.y - 14, 6, 16)
      if (!p.used) {
        halo(ctx, p.x, p.y, 30, '#5ee7ff', 0.2)
        for (let i = 0; i < 3; i++) { const t = (time * 1.5 + i / 3) % 1; ctx.fillStyle = `rgba(160,230,255,${1 - t})`; ctx.beginPath(); ctx.arc(p.x + (i - 1) * 5, p.y - 14 + t * 16, 1.5, 0, 7); ctx.fill() }
      }
      break
    }
  }
}

// —— 角色 ——

function drawPlayer(ctx: CanvasRenderingContext2D, game: Game, time: number) {
  if (drawPlayerArt(ctx, game, time)) return
  if (game.state === 'dead') return
  const p = game.player
  if (p.invuln > 0 && Math.floor(time * 20) % 2) ctx.globalAlpha = 0.45
  const face = Math.cos(p.aim) >= 0 ? 1 : -1
  const moving = Math.hypot(p.vx, p.vy) > 20
  const bob = moving ? Math.abs(Math.sin(p.walk)) * 1.6 : Math.sin(time * 3) * 0.5
  const weaponBehind = Math.sin(p.aim) < -0.3
  const w = game.weapon
  const drawGun = () => {
    if (w.melee && game.swings.length) return
    ctx.save()
    ctx.translate(p.x, p.y + 2 - bob)
    ctx.rotate(p.aim)
    if (face < 0) ctx.scale(1, -1)
    drawWeapon(ctx, w.id, -p.recoil * 3, 1)
    ctx.restore()
  }
  if (weaponBehind) drawGun()
  ctx.save()
  ctx.translate(p.x, p.y - bob)
  ctx.scale(face, 1)
  // 脚
  const step = moving ? Math.sin(p.walk) * 2.5 : 0
  ctx.fillStyle = '#2b2f42'
  ctx.fillRect(-6 + step, 6 + bob, 4, 4); ctx.fillRect(2 - step, 6 + bob, 4, 4)
  // 披风
  ctx.fillStyle = '#3157d6'
  ctx.beginPath(); ctx.moveTo(-6, -4); ctx.quadraticCurveTo(-13, 4 + Math.sin(time * 6) * 1.5, -9, 9); ctx.lineTo(4, 8); ctx.closePath(); ctx.fill()
  // 身体
  ctx.fillStyle = '#c9d2e3'
  roundRect(ctx, -7, -3, 14, 12, 4); ctx.fill()
  ctx.fillStyle = '#9aa6bf'
  ctx.fillRect(-7, 3, 14, 2)
  // 头盔
  const g = ctx.createLinearGradient(-8, -16, 6, -2)
  g.addColorStop(0, '#f2f5fb'); g.addColorStop(1, '#9aa6bf')
  ctx.fillStyle = g
  ctx.beginPath(); ctx.arc(0, -8, 8.5, 0, 7); ctx.fill()
  ctx.fillStyle = '#151824'
  roundRect(ctx, 0, -10, 8, 4, 2); ctx.fill()
  ctx.fillStyle = '#7fd1ff'
  ctx.fillRect(4, -9, 2, 2)
  // 羽饰
  ctx.fillStyle = '#ff5d5d'
  ctx.beginPath(); ctx.moveTo(-2, -16); ctx.quadraticCurveTo(-10, -22, -12, -14); ctx.quadraticCurveTo(-7, -16, -3, -13); ctx.fill()
  ctx.restore()
  if (!weaponBehind) drawGun()
  ctx.globalAlpha = 1
}

export function drawWeapon(ctx: CanvasRenderingContext2D, id: string, recoil: number, size: number) {
  ctx.save()
  ctx.translate(6 + recoil, 0)
  ctx.scale(size, size)
  const w = WEAPONS[id]
  ctx.fillStyle = '#2b2f42'
  switch (id) {
    case 'pistol':
      ctx.fillStyle = '#585f78'; ctx.fillRect(0, -2.5, 11, 5)
      ctx.fillStyle = '#3a3f52'; ctx.fillRect(0, 0, 4, 6)
      ctx.fillStyle = w.color; ctx.fillRect(8, -2.5, 3, 1.5); break
    case 'smg':
      ctx.fillStyle = '#4a5068'; ctx.fillRect(-2, -3, 17, 6)
      ctx.fillStyle = '#2b2f42'; ctx.fillRect(4, 2, 3, 7); ctx.fillRect(-4, -2, 3, 5)
      ctx.fillStyle = w.color; ctx.fillRect(13, -1, 3, 2); break
    case 'shotgun':
      ctx.fillStyle = '#7a4b2a'; ctx.fillRect(-5, -2, 8, 5)
      ctx.fillStyle = '#5a6079'; ctx.fillRect(2, -3, 18, 3); ctx.fillRect(2, 0.5, 18, 2.5)
      ctx.fillStyle = w.color; ctx.fillRect(9, -3.5, 4, 1); break
    case 'laser':
      ctx.fillStyle = '#e8ecf5'; roundRect(ctx, -3, -3, 20, 6, 3); ctx.fill()
      ctx.fillStyle = w.color; ctx.fillRect(2, -1, 15, 2)
      ctx.fillStyle = '#9aa6bf'; ctx.fillRect(1, 2, 3, 5); break
    case 'rocket':
      ctx.fillStyle = '#4f6b3a'; roundRect(ctx, -6, -4.5, 24, 9, 3); ctx.fill()
      ctx.fillStyle = '#2b2f42'; ctx.fillRect(16, -5, 4, 10); ctx.fillRect(2, 3, 3, 6)
      ctx.fillStyle = w.color; ctx.fillRect(-6, -1, 3, 2); break
    case 'bouncer':
      ctx.fillStyle = '#6c4ab6'; roundRect(ctx, -2, -4, 14, 8, 4); ctx.fill()
      ctx.fillStyle = w.color; ctx.beginPath(); ctx.arc(13, 0, 3.2, 0, 7); ctx.fill(); break
    case 'frost':
      ctx.strokeStyle = '#8a6a4a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(14, 0); ctx.stroke()
      ctx.fillStyle = w.color; ctx.beginPath(); ctx.moveTo(14, -5); ctx.lineTo(20, 0); ctx.lineTo(14, 5); ctx.lineTo(11, 0); ctx.fill(); break
    case 'saber':
      ctx.fillStyle = '#9aa6bf'; ctx.fillRect(-3, -2, 7, 4)
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = 'rgba(124,255,178,.35)'; roundRect(ctx, 3, -3, 24, 6, 3); ctx.fill()
      ctx.fillStyle = '#d9ffe9'; roundRect(ctx, 4, -1.2, 22, 2.4, 1.2); ctx.fill()
      ctx.globalCompositeOperation = 'source-over'; break
  }
  ctx.restore()
}

function drawEnemy(ctx: CanvasRenderingContext2D, e: Enemy, game: Game, time: number) {
  if (drawEnemyArt(ctx, e, game, time)) return
  if (e.spawn > 0) {
    // 刷怪法阵
    const t = Math.max(0, 1 - e.spawn / 0.7)
    ctx.strokeStyle = `rgba(255,80,110,${0.8 - t * 0.4})`
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.ellipse(e.x, e.y + e.r * 0.6, e.r * (0.6 + t), e.r * (0.3 + t * 0.5), 0, 0, 7); ctx.stroke()
    ctx.save(); ctx.translate(e.x, e.y + e.r * 0.6); ctx.rotate(time * 3); ctx.scale(1, 0.5)
    for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.fillStyle = 'rgba(255,80,110,.7)'; ctx.fillRect(e.r * (0.6 + t) - 2, -1.5, 4, 3) }
    ctx.restore()
    if (t < 0.4) return
    ctx.globalAlpha = (t - 0.4) / 0.6
  }
  flashing = e.flash > 0.6
  const fx = e.x, fy = e.y - e.z
  const face = game.player.x >= e.x ? 1 : -1
  ctx.save()
  ctx.translate(fx, fy)
  if (e.slow > 0) { ctx.fillStyle = 'rgba(155,231,255,.25)'; ctx.beginPath(); ctx.arc(0, 0, e.r + 3, 0, 7); ctx.fill() }
  if (e.elite) { halo(ctx, 0, 0, e.r * 1.9, '#ffd166', 0.25) }
  const anim = e.anim
  switch (e.kind as EnemyKind | BossKind) {
    case 'slime': {
      const squash = e.state === 'hop' ? 0.82 : 1 + Math.sin(anim * 8) * 0.06
      blob(ctx, e.r, squash, ENEMIES.slime.color, face)
      break
    }
    case 'bat': {
      const flap = Math.sin(anim * 22)
      ctx.fillStyle = col('#5b3c9e')
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * 4, -2); ctx.lineTo(s * 17, -8 + flap * 7); ctx.lineTo(s * 12, 1); ctx.lineTo(s * 15, 5 + flap * 3); ctx.lineTo(s * 4, 4); ctx.fill() }
      ctx.fillStyle = col(ENEMIES.bat.color)
      ctx.beginPath(); ctx.arc(0, 0, e.r * 0.8, 0, 7); ctx.fill()
      eyes(ctx, 2.5, -1, 2, '#ff4d6d', face)
      break
    }
    case 'archer': {
      ctx.fillStyle = col('#3a3a46'); roundRect(ctx, -6, 0, 12, 10, 3); ctx.fill()
      ctx.fillStyle = col(ENEMIES.archer.color); ctx.beginPath(); ctx.arc(0, -5, 8, 0, 7); ctx.fill()
      ctx.fillRect(-4, 1, 8, 3)
      ctx.fillStyle = '#1b1b22'; ctx.beginPath(); ctx.arc(face * 2.5, -5, 2.2, 0, 7); ctx.arc(face * -2, -5, 2, 0, 7); ctx.fill()
      // 弓
      const a = Math.atan2(game.player.y - e.y, game.player.x - e.x)
      ctx.save(); ctx.rotate(a)
      ctx.strokeStyle = col('#a0703f'); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(5, 0, 9, -1.1, 1.1); ctx.stroke()
      ctx.strokeStyle = e.state === 'aim' ? '#ff6b6b' : '#ddd'; ctx.lineWidth = 0.8
      ctx.beginPath(); ctx.moveTo(5 + Math.cos(-1.1) * 9, Math.sin(-1.1) * 9); ctx.lineTo(e.state === 'aim' ? 1 : 5 + Math.cos(1.1) * 9 - 3, 0); ctx.lineTo(5 + Math.cos(1.1) * 9, Math.sin(1.1) * 9); ctx.stroke()
      ctx.restore()
      break
    }
    case 'totem': {
      const glow = e.state === 'charge' ? 1 - e.timer / 0.55 : 0
      if (glow) halo(ctx, 0, -2, 26, '#ffa94d', glow * 0.5)
      ctx.fillStyle = col('#7a4f2c'); roundRect(ctx, -10, -16, 20, 28, 5); ctx.fill()
      ctx.fillStyle = col(ENEMIES.totem.color); roundRect(ctx, -10, -16, 20, 9, 4); ctx.fill()
      ctx.fillStyle = col(glow ? '#ffd166' : '#2b1d14')
      ctx.fillRect(-6, -3, 4, 3); ctx.fillRect(2, -3, 4, 3); ctx.fillRect(-4, 4, 8, 2)
      break
    }
    case 'boar': {
      const tremble = e.state === 'windup' ? (Math.random() - 0.5) * 2 : 0
      ctx.translate(tremble, 0)
      ctx.scale(face, 1)
      ctx.fillStyle = col(ENEMIES.boar.color); ctx.beginPath(); ctx.ellipse(0, 0, e.r * 1.1, e.r * 0.8, 0, 0, 7); ctx.fill()
      ctx.fillStyle = col('#8a5442'); ctx.beginPath(); ctx.ellipse(-4, -6, 8, 4, 0, 0, 7); ctx.fill()
      ctx.fillStyle = col('#d79a86'); ctx.beginPath(); ctx.ellipse(11, 2, 4.5, 3.5, 0, 0, 7); ctx.fill()
      ctx.fillStyle = col('#f4ead5'); ctx.beginPath(); ctx.moveTo(9, 5); ctx.lineTo(14, 9); ctx.lineTo(11, 4); ctx.fill()
      ctx.fillStyle = e.state === 'windup' || e.state === 'charge' ? '#ff4d4d' : '#1b1b22'; ctx.beginPath(); ctx.arc(6, -3, 1.8, 0, 7); ctx.fill()
      if (e.state === 'stun') for (let i = 0; i < 3; i++) { const a = time * 5 + i * 2.1; ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.arc(Math.cos(a) * 8, -14 + Math.sin(a) * 3, 1.6, 0, 7); ctx.fill() }
      break
    }
    case 'pumpkin': {
      const fuse = e.state === 'fuse'
      const s = fuse ? 1 + (1 - e.timer / 0.65) * 0.25 : 1
      ctx.scale(s, s)
      const blink = fuse && Math.floor(time * 16) % 2
      ctx.fillStyle = col(blink ? '#ffffff' : ENEMIES.pumpkin.color)
      for (const ox of [-5, 0, 5]) { ctx.beginPath(); ctx.ellipse(ox, 0, 7, e.r * 0.9, 0, 0, 7); ctx.fill() }
      ctx.fillStyle = col('#4c8a3a'); ctx.fillRect(-1.5, -e.r - 3, 3, 5)
      ctx.fillStyle = fuse ? '#fff3b0' : '#ffd166'
      ctx.beginPath(); ctx.moveTo(-6, -3); ctx.lineTo(-3, -6); ctx.lineTo(-1, -2); ctx.fill()
      ctx.beginPath(); ctx.moveTo(6, -3); ctx.lineTo(3, -6); ctx.lineTo(1, -2); ctx.fill()
      ctx.beginPath(); ctx.moveTo(-6, 3); ctx.lineTo(6, 3); ctx.lineTo(3, 6); ctx.lineTo(0, 4); ctx.lineTo(-3, 6); ctx.fill()
      break
    }
    case 'mage': {
      const alpha = e.state === 'vanish' ? e.timer / 0.35 : e.state === 'appear' ? 1 - e.timer / 0.35 : 1
      ctx.globalAlpha *= Math.max(0.05, alpha)
      const hover = Math.sin(anim * 3) * 1.5
      ctx.translate(0, hover)
      ctx.fillStyle = col('#3d2c7a'); ctx.beginPath(); ctx.moveTo(-10, 10); ctx.lineTo(0, -12); ctx.lineTo(10, 10); ctx.closePath(); ctx.fill()
      ctx.fillStyle = col(ENEMIES.mage.color); ctx.beginPath(); ctx.arc(0, -6, 7, 0, 7); ctx.fill()
      ctx.fillStyle = '#120c26'; ctx.beginPath(); ctx.arc(face * 1.5, -5, 4.5, 0, 7); ctx.fill()
      ctx.fillStyle = '#d0b8ff'; ctx.fillRect(face * 1.5 - 3, -6, 2, 2); ctx.fillRect(face * 1.5 + 1, -6, 2, 2)
      if (e.state === 'cast') halo(ctx, face * 12, 0, 10 + (1 - e.timer / 0.45) * 8, '#b388ff', 0.6)
      break
    }
    case 'kingSlime': {
      const squash = e.state === 'rise' ? 0.75 : e.state === 'air' ? 1.12 : 1 + Math.sin(anim * 5) * 0.04
      blob(ctx, e.r, squash, BOSSES.kingSlime.color, face)
      ctx.fillStyle = col('#ffd166')
      ctx.translate(0, -e.r * squash * 0.95)
      ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(-13, -12); ctx.lineTo(-6, -6); ctx.lineTo(0, -15); ctx.lineTo(6, -6); ctx.lineTo(13, -12); ctx.lineTo(12, 0); ctx.closePath(); ctx.fill()
      ctx.fillStyle = '#ff4d6d'; ctx.beginPath(); ctx.arc(0, -4, 2.2, 0, 7); ctx.fill()
      break
    }
    case 'golem': {
      const wind = e.state.endsWith('Wind') ? 1 : 0
      const lift = e.state === 'slamWind' ? -6 * (1 - e.timer / 0.8) : 0
      ctx.fillStyle = col('#5d606b')
      roundRect(ctx, -26, -4 + lift, 12, 22, 5); ctx.fill(); roundRect(ctx, 14, -4 + lift, 12, 22, 5); ctx.fill()
      const g = ctx.createLinearGradient(0, -28, 0, 24)
      g.addColorStop(0, col('#a3a5ae')); g.addColorStop(1, col('#5d606b'))
      ctx.fillStyle = g
      roundRect(ctx, -18, -26, 36, 46, 10); ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(-10, -18); ctx.lineTo(-4, -8); ctx.lineTo(-8, 2); ctx.moveTo(8, 6); ctx.lineTo(12, 14); ctx.stroke()
      const eye = wind || e.state === 'charge' ? '#ff6b3d' : '#ffb347'
      halo(ctx, 0, -12, 16, eye, 0.35)
      ctx.fillStyle = eye; ctx.fillRect(-9, -15, 6, 4); ctx.fillRect(3, -15, 6, 4)
      ctx.fillStyle = eye; ctx.beginPath(); ctx.arc(0, 4, 4, 0, 7); ctx.fill()
      break
    }
    case 'necro': {
      const hover = Math.sin(anim * 2.5) * 3
      ctx.translate(0, hover - 6)
      if (e.state === 'spiral') halo(ctx, 0, 0, 40, '#b388ff', 0.3)
      ctx.fillStyle = col('#2a1f4d'); ctx.beginPath(); ctx.moveTo(-18, 22); ctx.quadraticCurveTo(-14, -10, 0, -18); ctx.quadraticCurveTo(14, -10, 18, 22); ctx.quadraticCurveTo(0, 16, -18, 22); ctx.fill()
      ctx.fillStyle = col('#e9e4d4'); ctx.beginPath(); ctx.arc(0, -10, 9, 0, 7); ctx.fill()
      ctx.fillStyle = '#7d5fff'; ctx.beginPath(); ctx.arc(-3.5, -10, 2.5, 0, 7); ctx.arc(3.5, -10, 2.5, 0, 7); ctx.fill()
      ctx.strokeStyle = col('#6b5137'); ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(face * 20, 22); ctx.lineTo(face * 16, -20); ctx.stroke()
      halo(ctx, face * 16, -23, 12, '#b388ff', 0.6)
      ctx.fillStyle = '#e0d4ff'; ctx.beginPath(); ctx.arc(face * 16, -23, 4, 0, 7); ctx.fill()
      for (let i = 0; i < 3; i++) { const a = time * 1.5 + i * 2.1; ctx.fillStyle = 'rgba(179,136,255,.7)'; ctx.fillRect(Math.cos(a) * 28 - 2, Math.sin(a) * 12 + 4 - 2, 4, 4) }
      break
    }
  }
  ctx.restore()
  flashing = false
  ctx.globalAlpha = 1
  if (!e.boss && e.hp < e.maxHp && e.spawn <= 0) {
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(e.x - 10, e.y - e.r - 9, 20, 3)
    ctx.fillStyle = e.elite ? '#ffd166' : '#ff5d5d'; ctx.fillRect(e.x - 10, e.y - e.r - 9, 20 * (e.hp / e.maxHp), 3)
  }
}

function blob(ctx: CanvasRenderingContext2D, r: number, squash: number, color: string, face: number) {
  const w = r * (2 - squash) * 1.05, h = r * squash
  const g = ctx.createRadialGradient(-w * 0.3, -h * 0.4, 1, 0, 0, Math.max(w, h))
  g.addColorStop(0, col(lighten(color, 50))); g.addColorStop(1, col(color))
  ctx.fillStyle = g
  ctx.beginPath(); ctx.ellipse(0, r - h, w, h, 0, Math.PI, 0); ctx.lineTo(w, r); ctx.lineTo(-w, r); ctx.closePath(); ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,.4)'
  ctx.beginPath(); ctx.ellipse(-w * 0.4, r - h * 1.45, w * 0.18, h * 0.12, -0.5, 0, 7); ctx.fill()
  eyes(ctx, r * 0.28, r - h * 0.9, Math.max(1.8, r * 0.13), '#1b1b22', face)
}

function eyes(ctx: CanvasRenderingContext2D, gap: number, y: number, size: number, color: string, face: number) {
  ctx.fillStyle = color
  ctx.beginPath(); ctx.arc(face * gap * 0.4 - gap, y, size, 0, 7); ctx.arc(face * gap * 0.4 + gap, y, size, 0, 7); ctx.fill()
}

function drawTelegraphs(ctx: CanvasRenderingContext2D, game: Game, time: number) {
  for (const e of game.enemies) {
    if ((e.kind === 'boar' || e.kind === 'golem') && (e.state === 'windup' || e.state === 'chargeWind')) {
      ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(e.angle)
      const g = ctx.createLinearGradient(0, 0, 220, 0)
      g.addColorStop(0, 'rgba(255,60,60,.35)'); g.addColorStop(1, 'rgba(255,60,60,0)')
      ctx.fillStyle = g; ctx.fillRect(0, -e.r * 0.8, 220, e.r * 1.6)
      ctx.restore()
    }
    if (e.kind === 'kingSlime' && (e.state === 'rise' || e.state === 'air')) {
      const pulse = 0.5 + Math.sin(time * 14) * 0.2
      ctx.strokeStyle = `rgba(255,70,90,${pulse})`; ctx.lineWidth = 2
      ctx.beginPath(); ctx.ellipse(e.tx, e.ty + e.r * 0.6, e.r, e.r * 0.45, 0, 0, 7); ctx.stroke()
      ctx.fillStyle = 'rgba(255,70,90,.12)'; ctx.fill()
    }
    if (e.kind === 'pumpkin' && e.state === 'fuse') {
      ctx.fillStyle = `rgba(255,120,40,${0.12 + (1 - e.timer / 0.65) * 0.18})`
      ctx.beginPath(); ctx.arc(e.x, e.y, 54, 0, 7); ctx.fill()
    }
    if (e.kind === 'archer' && e.state === 'aim') {
      ctx.strokeStyle = 'rgba(255,90,90,.35)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
      ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(game.player.x, game.player.y); ctx.stroke(); ctx.setLineDash([])
    }
  }
}

// —— 子弹与特效 ——

function drawBullets(ctx: CanvasRenderingContext2D, game: Game) {
  ctx.globalCompositeOperation = 'lighter'
  for (const b of game.bullets) {
    if (b.enemy) {
      ctx.fillStyle = hexA(b.color, 0.25)
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 2, 0, 7); ctx.fill()
    } else {
      const sp = Math.hypot(b.vx, b.vy) || 1
      ctx.strokeStyle = hexA(b.color, 0.5); ctx.lineWidth = b.r * 1.6; ctx.lineCap = 'round'
      ctx.beginPath(); ctx.moveTo(b.x - (b.vx / sp) * b.trail, b.y - (b.vy / sp) * b.trail); ctx.lineTo(b.x, b.y); ctx.stroke()
    }
  }
  ctx.globalCompositeOperation = 'source-over'
  if (drawBulletsArt(ctx, game)) return
  for (const b of game.bullets) {
    if (b.enemy) {
      ctx.fillStyle = b.color; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill()
      ctx.fillStyle = b.big ? '#efe9dc' : '#fff4f4'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.5, 0, 7); ctx.fill()
    } else {
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.75, 0, 7); ctx.fill()
    }
  }
}

function drawSwings(ctx: CanvasRenderingContext2D, game: Game) {
  if (drawSwingsArt(ctx, game)) return
  for (const s of game.swings) {
    const t = 1 - s.life / s.max
    const start = s.angle - 1.25 + t * 0.3, end = s.angle - 1.25 + Math.min(1, t * 1.6) * 2.5
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = hexA(s.color, 0.55 * (1 - t))
    ctx.lineWidth = 12
    ctx.beginPath(); ctx.arc(s.x, s.y, s.range * 0.7, start, end); ctx.stroke()
    ctx.strokeStyle = `rgba(230,255,240,${0.9 * (1 - t)})`
    ctx.lineWidth = 3
    ctx.beginPath(); ctx.arc(s.x, s.y, s.range * 0.78, start, end); ctx.stroke()
    ctx.globalCompositeOperation = 'source-over'
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, game: Game) {
  for (const p of game.particles) {
    if (drawParticleArt(ctx, p)) continue
    const a = Math.max(0, p.life / p.max)
    if (p.kind === 'spark') {
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = hexA(p.color, a)
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size * a + 1, p.size * a + 1)
      ctx.globalCompositeOperation = 'source-over'
    } else if (p.kind === 'dust') {
      ctx.globalAlpha = a * 0.8
      ctx.fillStyle = p.color
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.4 - a * 0.4), 0, 7); ctx.fill()
      ctx.globalAlpha = 1
    } else if (p.kind === 'ring') {
      ctx.strokeStyle = hexA(p.color, a * 0.8)
      ctx.lineWidth = 3 * a + 1
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - a * 0.7), 0, 7); ctx.stroke()
    } else if (p.kind === 'ghost') {
      ctx.fillStyle = hexA(p.color, a * 0.35)
      ctx.beginPath(); ctx.arc(p.x, p.y - 4, p.size, 0, 7); ctx.fill()
    } else if (p.kind === 'flash') {
      ctx.globalCompositeOperation = 'lighter'
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle ?? 0)
      ctx.fillStyle = hexA(p.color, 0.9)
      ctx.beginPath(); ctx.moveTo(-2, -p.size * 0.45); ctx.lineTo(p.size, 0); ctx.lineTo(-2, p.size * 0.45); ctx.fill()
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 3, 0, 7); ctx.fill()
      ctx.restore()
      ctx.globalCompositeOperation = 'source-over'
    }
  }
}

function drawLighting(ctx: CanvasRenderingContext2D, game: Game, view: View, theme: Theme, time: number) {
  const { width, height, dpr, scale, ox, oy } = view
  const w = Math.ceil(width * dpr / 2), h = Math.ceil(height * dpr / 2)
  light ??= document.createElement('canvas')
  if (light.width !== w || light.height !== h) { light.width = w; light.height = h }
  const g = light.getContext('2d')!
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalCompositeOperation = 'source-over'
  g.clearRect(0, 0, w, h)
  g.fillStyle = game.room.type === 'boss' ? 'rgba(4,2,8,.58)' : 'rgba(4,5,12,.5)'
  g.fillRect(0, 0, w, h)
  g.globalCompositeOperation = 'destination-out'
  const k = (scale * dpr) / 2
  const hole = (x: number, y: number, r: number, strength: number) => {
    const sx = (ox * dpr) / 2 + x * k, sy = (oy * dpr) / 2 + y * k, sr = r * k
    const grad = g.createRadialGradient(sx, sy, 0, sx, sy, sr)
    grad.addColorStop(0, `rgba(0,0,0,${strength})`); grad.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grad
    g.fillRect(sx - sr, sy - sr, sr * 2, sr * 2)
  }
  const p = game.player
  hole(p.x, p.y, 190, 0.95)
  for (const [x, y] of torchSpots(game.room)) hole(x, y + 10, 110 + Math.sin(time * 9 + x) * 6, 0.75)
  let n = 0
  for (const b of game.bullets) { if (n++ > 40) break; hole(b.x, b.y, b.enemy ? 26 : 30, 0.5) }
  for (const pk of game.roomPickups) if (pk.kind === 'item' || pk.kind === 'fountain' || pk.kind === 'stairs') hole(pk.x, pk.y, 70, 0.6)
  for (const s of game.swings) hole(s.x, s.y, 80, 0.5)
  for (const e of game.enemies) if (e.boss) hole(e.x, e.y, 90, 0.4)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(light, 0, 0, width * dpr, height * dpr)
  void theme
}

// —— 界面 ——

function drawHud(ctx: CanvasRenderingContext2D, game: Game, view: View, touch: TouchState | null, time: number) {
  const { width, height } = view
  const p = game.player
  const pad = Math.max(10, Math.min(18, width * 0.015))
  const s = Math.max(0.8, Math.min(1.15, Math.min(width / 900, height / 500)))

  // 生命与护甲
  let x = pad + 10 * s
  const y = pad + 10 * s
  for (let i = 0; i < p.maxHp / 2; i++) {
    const fill = Math.max(0, Math.min(1, (p.hp - i * 2) / 2))
    if (!uiIcon(ctx, fill >= 1 ? 0 : fill > 0 ? 1 : 2, x, y, 18 * s)) heart(ctx, x, y, 8 * s, '#ff4d6d', fill)
    x += 20 * s
  }
  for (let i = 0; i < p.maxArmor; i++) {
    if (!uiIcon(ctx, i < p.armor ? 3 : 4, x, y, 18 * s)) shieldIcon(ctx, x, y, 8 * s, i < p.armor)
    x += 20 * s
  }
  // 能量条
  const bw = 120 * s, by = y + 16 * s
  ctx.fillStyle = 'rgba(0,0,0,.55)'; roundRect(ctx, pad, by, bw, 9 * s, 4.5 * s); ctx.fill()
  ctx.fillStyle = '#3aa8ff'; roundRect(ctx, pad, by, bw * (p.energy / p.maxEnergy), 9 * s, 4.5 * s); ctx.fill()
  text(ctx, `${Math.floor(p.energy)}/${p.maxEnergy}`, pad + bw + 6 * s, by + 8 * s, '#9fd4ff', 10 * s, 'left')

  // 楼层与分数
  text(ctx, `第 ${game.level} 层`, width / 2, pad + 12 * s, '#ffd166', 13 * s, 'center', 700)
  text(ctx, `${game.score} 分`, width / 2, pad + 28 * s, 'rgba(255,255,255,.75)', 11 * s, 'center')

  drawMinimap(ctx, game, width - pad, pad, s)

  // 武器
  const wx = pad, wy = height - pad - 44 * s
  const touchMode = !!touch?.active
  if (!touchMode) {
    ctx.fillStyle = 'rgba(10,12,20,.65)'; roundRect(ctx, wx, wy, 150 * s, 44 * s, 10 * s); ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.stroke()
    const w = game.weapon
    if (!weaponIcon(ctx, w.id, wx + 27 * s, wy + 22 * s, 40 * s)) { ctx.save(); ctx.translate(wx + 26 * s, wy + 22 * s); ctx.scale(1.6 * s, 1.6 * s); drawWeapon(ctx, w.id, -6, 1); ctx.restore() }
    text(ctx, w.name, wx + 54 * s, wy + 19 * s, w.color, 12 * s, 'left', 700)
    text(ctx, w.cost ? `${w.cost} 能量/发` : '无消耗', wx + 54 * s, wy + 34 * s, 'rgba(255,255,255,.6)', 10 * s, 'left')
    if (p.weapons.length > 1) {
      const other = WEAPONS[p.weapons[(p.current + 1) % p.weapons.length]]
      text(ctx, `${touchMode ? '' : 'Q '}⇄ ${other.name}`, wx + 4, wy - 8 * s, 'rgba(255,255,255,.55)', 10 * s, 'left')
    }
  }

  // 首领血条
  const boss = game.boss
  if (boss && boss.state !== 'intro') {
    const bw2 = Math.min(360, width * 0.42), bx = (width - bw2) / 2, by2 = height - pad - 16 * s
    text(ctx, BOSSES[boss.kind as BossKind].name, width / 2, by2 - 6 * s, '#ffb3b3', 11 * s, 'center', 700)
    ctx.fillStyle = 'rgba(0,0,0,.6)'; roundRect(ctx, bx, by2, bw2, 9 * s, 4.5 * s); ctx.fill()
    ctx.fillStyle = '#ff4d5e'; roundRect(ctx, bx, by2, bw2 * Math.max(0, boss.hp / boss.maxHp), 9 * s, 4.5 * s); ctx.fill()
  }

  // 横幅
  if (game.banner) {
    const b = game.banner
    const a = Math.min(1, b.life * 2, (2.6 - b.life) * 4 + 0.2)
    ctx.globalAlpha = Math.max(0, Math.min(1, a))
    text(ctx, b.title, width / 2, height * 0.3, b.color, 26 * s, 'center', 800)
    text(ctx, b.text, width / 2, height * 0.3 + 24 * s, 'rgba(255,255,255,.85)', 13 * s, 'center')
    ctx.globalAlpha = 1
  }

  if (touchMode) drawTouch(ctx, game, view, touch!, time)
}

function drawMinimap(ctx: CanvasRenderingContext2D, game: Game, right: number, top: number, s: number) {
  const rooms = game.floor.rooms
  const known = rooms.filter(r => r.visited || Object.values(r.doors).some(o => o!.visited))
  const xs = known.map(r => r.gx), ys = known.map(r => r.gy)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const cw = 13 * s, ch = 9 * s, gap = 3 * s
  const w = (maxX - minX + 1) * (cw + gap) + gap, h = (maxY - minY + 1) * (ch + gap) + gap
  const x0 = right - w, y0 = top
  ctx.fillStyle = 'rgba(10,12,20,.6)'; roundRect(ctx, x0 - 4, y0 - 4, w + 8, h + 8, 8); ctx.fill()
  for (const r of known) {
    const x = x0 + gap + (r.gx - minX) * (cw + gap), y = y0 + gap + (r.gy - minY) * (ch + gap)
    ctx.fillStyle = r === game.room ? '#ffffff' : r.visited ? 'rgba(170,180,210,.7)' : 'rgba(120,130,160,.3)'
    roundRect(ctx, x, y, cw, ch, 2); ctx.fill()
    const icon = r.type === 'boss' ? '#ff4d5e' : r.type === 'treasure' ? '#ffd166' : r.type === 'heal' ? '#5ee7ff' : ''
    if ((r.type === 'boss' || r.type === 'treasure') && uiIcon(ctx, r.type === 'boss' ? 14 : 15, x + cw / 2, y + ch / 2, ch * 1.3)) continue
    if (icon) { ctx.fillStyle = icon; ctx.beginPath(); ctx.arc(x + cw / 2, y + ch / 2, 2.6 * s, 0, 7); ctx.fill() }
  }
}

function drawTouch(ctx: CanvasRenderingContext2D, game: Game, view: View, touch: TouchState, time: number) {
  const L = touchLayout(view.width, view.height)
  ctx.lineWidth = 2
  // 左摇杆
  const base = touch.stick ?? { x: L.stick.x, y: L.stick.y }
  const knob = touch.stick ? { x: base.x + touch.moveX * L.stick.r, y: base.y + touch.moveY * L.stick.r } : base
  if (!uiIcon(ctx, 8, base.x, base.y, L.stick.r * 2, 0.75) || !uiIcon(ctx, 9, knob.x, knob.y, L.stick.r * 0.9, 0.85)) {
    ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.strokeStyle = 'rgba(255,255,255,.22)'
    ctx.beginPath(); ctx.arc(base.x, base.y, L.stick.r, 0, 7); ctx.fill(); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,.35)'
    ctx.beginPath(); ctx.arc(knob.x, knob.y, L.stick.r * 0.42, 0, 7); ctx.fill()
  }
  // 右侧按钮
  const button = (b: { x: number; y: number; r: number }, label: string, active: boolean, color: string, ready = 1, icon = -1) => {
    if (icon >= 0 && uiIcon(ctx, icon, b.x, b.y, b.r * 2 * (active ? 0.92 : 1), active ? 1 : 0.82)) {
      if (ready < 1) { ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.arc(b.x, b.y, b.r * 0.86, -Math.PI / 2, -Math.PI / 2 + (1 - ready) * Math.PI * 2); ctx.fill() }
      return
    }
    ctx.fillStyle = active ? hexA(color, 0.45) : 'rgba(255,255,255,.1)'
    ctx.strokeStyle = hexA(color, 0.7)
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill(); ctx.stroke()
    if (ready < 1) { ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.arc(b.x, b.y, b.r, -Math.PI / 2, -Math.PI / 2 + (1 - ready) * Math.PI * 2); ctx.fill() }
    text(ctx, label, b.x, b.y + b.r * 0.18, '#fff', b.r * 0.42, 'center', 700)
  }
  // 射击键：按住时外圈亮起；拖动瞄准时按钮跟手偏移，并在边缘显示方向弧与箭头
  const aim = touch.aim, color = game.weapon.color, R = L.fire.r
  const shift = aim !== null ? touch.drag * R * 0.34 : 0
  const fire = { x: L.fire.x + (aim !== null ? Math.cos(aim) * shift : 0), y: L.fire.y + (aim !== null ? Math.sin(aim) * shift : 0), r: R }
  const ring = (front: boolean) => {
    if (!touch.firing) return
    ctx.save()
    if (!front) {
      ctx.strokeStyle = hexA(color, 0.3); ctx.lineWidth = 3
      ctx.beginPath(); ctx.arc(L.fire.x, L.fire.y, R * 1.25, 0, 7); ctx.stroke()
    } else if (aim !== null) {
      ctx.strokeStyle = color; ctx.lineWidth = 7; ctx.lineCap = 'round'
      ctx.shadowColor = color; ctx.shadowBlur = 12
      ctx.beginPath(); ctx.arc(L.fire.x, L.fire.y, R * 1.25, aim - 0.5, aim + 0.5); ctx.stroke()
      const ax = L.fire.x + Math.cos(aim) * R * 1.55, ay = L.fire.y + Math.sin(aim) * R * 1.55
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(ax + Math.cos(aim) * R * 0.22, ay + Math.sin(aim) * R * 0.22)
      ctx.lineTo(ax + Math.cos(aim + 2.4) * R * 0.17, ay + Math.sin(aim + 2.4) * R * 0.17)
      ctx.lineTo(ax + Math.cos(aim - 2.4) * R * 0.17, ay + Math.sin(aim - 2.4) * R * 0.17)
      ctx.fill()
    } else {
      // 自动瞄准：外圈四段刻度缓慢旋转
      ctx.strokeStyle = hexA(color, 0.85); ctx.lineWidth = 4; ctx.lineCap = 'round'
      for (let i = 0; i < 4; i++) { const a = time * 2 + (i * Math.PI) / 2; ctx.beginPath(); ctx.arc(L.fire.x, L.fire.y, R * 1.25, a - 0.18, a + 0.18); ctx.stroke() }
    }
    ctx.restore()
  }
  ring(false)
  button(fire, '射击', touch.firing, color, 1, 10)
  ring(true)
  const p = game.player
  button(L.dash, '翻滚', false, '#8ab4ff', p.dashCd > 0 ? 1 - p.dashCd / (0.85 * p.stats.dash) : 1, 11)
  if (p.weapons.length > 1) button(L.swap, '换枪', false, '#ffd166', 1, 12)
  const w = game.weapon
  text(ctx, w.cost ? `${w.name} · ${w.cost}能量` : w.name, L.fire.x + L.fire.r * 0.6, L.swap.y - L.swap.r - 10, w.color, Math.max(11, L.fire.r * 0.26), 'right', 700)
  if (game.prompt) button(L.interact, '拾取', false, '#7cffb2', 1, 13)
}

/** 触屏射击时在场景中显示瞄准方向：手动为虚线准星，自动为锁定框。 */
function drawAimGuide(ctx: CanvasRenderingContext2D, game: Game, touch: TouchState, time: number) {
  const p = game.player, color = game.weapon.color
  ctx.save()
  if (touch.aim !== null) {
    const a = touch.aim, len = 150
    const g = ctx.createLinearGradient(p.x, p.y, p.x + Math.cos(a) * len, p.y + Math.sin(a) * len)
    g.addColorStop(0, hexA(color, 0.75)); g.addColorStop(1, hexA(color, 0))
    ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.setLineDash([6, 6]); ctx.lineDashOffset = -time * 40
    ctx.beginPath(); ctx.moveTo(p.x + Math.cos(a) * 18, p.y + Math.sin(a) * 18); ctx.lineTo(p.x + Math.cos(a) * len, p.y + Math.sin(a) * len); ctx.stroke()
  } else {
    const t = game.nearestEnemy()
    if (t) {
      const r = t.r + 7 + Math.sin(time * 8) * 1.5
      ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'
      ctx.translate(t.x, t.y - t.z); ctx.rotate(time * 1.5)
      for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.moveTo(r, -5); ctx.lineTo(r, -r * 0.2 + 2); ctx.moveTo(r, 5); ctx.lineTo(r, r * 0.2 - 2); ctx.stroke() }
    }
  }
  ctx.restore()
}

// —— 小工具 ——

function shadow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, z: number) {
  const s = Math.max(0.4, 1 - z / 160)
  ctx.fillStyle = `rgba(0,0,0,${0.35 * s})`
  ctx.beginPath(); ctx.ellipse(x, y, r * s, r * 0.38 * s, 0, 0, 7); ctx.fill()
}

function halo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, hexA(color, alpha)); g.addColorStop(1, hexA(color, 0))
  ctx.fillStyle = g
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill()
}

function glowDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.globalCompositeOperation = 'lighter'
  halo(ctx, x, y, r * 3, color, 0.5)
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(x, y, r * 0.6, 0, 7); ctx.fill()
}

function heart(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, fill: number) {
  const path = () => {
    ctx.beginPath()
    ctx.moveTo(x, y + r * 0.9)
    ctx.bezierCurveTo(x - r * 1.3, y, x - r * 0.9, y - r * 1.1, x, y - r * 0.4)
    ctx.bezierCurveTo(x + r * 0.9, y - r * 1.1, x + r * 1.3, y, x, y + r * 0.9)
  }
  path(); ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fill()
  if (fill > 0) {
    ctx.save(); path(); ctx.clip()
    ctx.fillStyle = color; ctx.fillRect(x - r * 1.4, y - r * 1.2, r * 2.8 * fill, r * 2.4)
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.ellipse(x - r * 0.5, y - r * 0.35, r * 0.25, r * 0.18, -0.6, 0, 7); ctx.fill()
    ctx.restore()
  }
  path(); ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1.2; ctx.stroke()
}

function shieldIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, full: boolean) {
  ctx.beginPath()
  ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.85, y - r * 0.6); ctx.lineTo(x + r * 0.7, y + r * 0.3); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.7, y + r * 0.3); ctx.lineTo(x - r * 0.85, y - r * 0.6); ctx.closePath()
  ctx.fillStyle = full ? '#8ab4ff' : 'rgba(0,0,0,.5)'; ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1.2; ctx.stroke()
}

/** 道具图标：优先用雪碧图。 */
export function itemGlyph(ctx: CanvasRenderingContext2D, item: { id: string; glyph: string; color: string; name: string; text: string }, x: number, y: number, size: number) {
  if (!itemIcon(ctx, item, x, y, size * 2)) glyph(ctx, item.glyph, x, y, size, item.color)
}

export function glyph(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, r: number, color: string) {
  ctx.save(); ctx.translate(x, y)
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = r * 0.28; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  switch (kind) {
    case 'potion': ctx.beginPath(); ctx.arc(0, r * 0.25, r * 0.65, 0, 7); ctx.fill(); ctx.fillRect(-r * 0.22, -r, r * 0.44, r * 0.8); break
    case 'boot': ctx.beginPath(); ctx.moveTo(-r * 0.4, -r); ctx.lineTo(r * 0.1, -r); ctx.lineTo(r * 0.1, r * 0.1); ctx.lineTo(r * 0.9, r * 0.4); ctx.lineTo(r * 0.9, r * 0.8); ctx.lineTo(-r * 0.4, r * 0.8); ctx.fill(); break
    case 'spring': ctx.beginPath(); for (let i = 0; i <= 6; i++) ctx.lineTo((i % 2 ? 1 : -1) * r * 0.6, -r + (i / 6) * r * 2); ctx.stroke(); break
    case 'heart': heart(ctx, 0, 0, r * 0.9, color, 1); break
    case 'split': for (const a of [-0.6, 0, 0.6]) { ctx.beginPath(); ctx.arc(Math.sin(a) * r * 0.8, -Math.cos(a) * r * 0.6 + r * 0.3, r * 0.28, 0, 7); ctx.fill() } break
    case 'arrow': ctx.beginPath(); ctx.moveTo(-r, 0); ctx.lineTo(r * 0.6, 0); ctx.stroke(); ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(r * 0.3, -r * 0.5); ctx.lineTo(r * 0.3, r * 0.5); ctx.fill(); break
    case 'ball': ctx.beginPath(); ctx.arc(0, 0, r * 0.7, 0, 7); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.arc(0, 0, r * 0.7, -0.8, 0.8); ctx.stroke(); break
    case 'fang': ctx.beginPath(); ctx.moveTo(-r * 0.7, -r * 0.6); ctx.lineTo(r * 0.7, -r * 0.6); ctx.lineTo(0, r); ctx.closePath(); ctx.fill(); break
    case 'shield': shieldIcon(ctx, 0, 0, r, true); break
    case 'core': ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.7, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.7, 0); ctx.closePath(); ctx.fill(); break
    case 'eye': ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.55, 0, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, 7); ctx.fill(); break
    case 'orbit': ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.arc(r * 0.8, 0, r * 0.25, 0, 7); ctx.fill(); break
    case 'wind': for (const yy of [-0.4, 0.15, 0.7]) { ctx.beginPath(); ctx.moveTo(-r, yy * r); ctx.quadraticCurveTo(r * 0.2, yy * r - r * 0.3, r * 0.8, yy * r); ctx.stroke() } break
    default: ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill()
  }
  ctx.restore()
}

function label(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, color: string, size: number, box = true) {
  ctx.font = `600 ${size}px ${FONT}`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  if (box) {
    const w = ctx.measureText(value).width + 10
    ctx.fillStyle = 'rgba(8,10,16,.7)'; roundRect(ctx, x - w / 2, y - size * 0.85, w, size * 1.7, size * 0.5); ctx.fill()
  } else {
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(value, x, y)
  }
  ctx.fillStyle = color; ctx.fillText(value, x, y)
  ctx.textBaseline = 'alphabetic'
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, color: string, size: number, align: CanvasTextAlign, weight = 500) {
  ctx.font = `${weight} ${size}px ${FONT}`
  ctx.textAlign = align
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(value, x, y)
  ctx.fillStyle = color; ctx.fillText(value, x, y)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(0, w), h, Math.min(r, Math.abs(w) / 2, h / 2))
}

function hexA(hex: string, alpha: number) {
  if (!hex.startsWith('#')) return hex
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

function lighten(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.min(255, v + amount)
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`
}
