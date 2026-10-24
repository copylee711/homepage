/** 深渊骑士核心逻辑：玩家、怪物、子弹、房间切换与计分。渲染与输入在其他模块。 */
import {
  BOSSES, BOSS_ORDER, ENEMIES, ITEMS, ROOM_H, ROOM_W, TILE, WEAPONS, WEAPON_POOL, WORLD_H, WORLD_W,
  enemyPool, hpScale,
} from './data'
import type { BossKind, EnemyKind, ItemDef, WeaponDef } from './data'
import { DIRS, DOOR, DOOR_TILE, FLOOR, OPPOSITE, PIT, ROCK, WALL, generateFloor, spawnTiles, tileAt } from './map'
import type { Dir, Floor, Room } from './map'

export type Sound = 'shoot' | 'shotgun' | 'laser' | 'rocket' | 'swing' | 'hit' | 'kill' | 'hurt' | 'explode' | 'pickup' | 'door' | 'dash' | 'boss' | 'stairs' | 'empty' | 'enemyShoot' | 'heal'

export interface Input {
  moveX: number; moveY: number
  /** 瞄准方向；null 表示自动瞄准最近的敌人 */
  aim: number | null
  fire: boolean
  dash: boolean
  swap: boolean
  interact: boolean
}

export interface Player {
  x: number; y: number; vx: number; vy: number; r: number
  hp: number; maxHp: number
  armor: number; maxArmor: number; calm: number
  energy: number; maxEnergy: number
  weapons: string[]; current: number
  cooldown: number
  dashTime: number; dashCd: number; dashX: number; dashY: number
  invuln: number
  aim: number
  walk: number
  recoil: number
  items: ItemDef[]
  stats: { damage: number; speed: number; rate: number; multishot: number; pierce: number; bounce: number; crit: number; vamp: number; orbit: number; dash: number; size: number; regen: number }
}

export interface Enemy {
  id: number
  kind: EnemyKind | BossKind
  boss: boolean
  x: number; y: number; vx: number; vy: number; r: number
  hp: number; maxHp: number
  speed: number
  state: string
  timer: number
  cd: number
  flash: number
  slow: number
  spawn: number
  elite: boolean
  angle: number
  tx: number; ty: number
  phase: number
  z: number
  flying: boolean
  anim: number
  /** 距上次攻击动作的时间，用于播放攻击帧 */
  pose: number
  /** 击退速度 */
  kx: number; ky: number
  /** 受击挤压动画 0→1 */
  squash: number
}

export interface Bullet {
  x: number; y: number; vx: number; vy: number; r: number
  damage: number
  enemy: boolean
  life: number
  pierce: number
  bounce: number
  explode: number
  color: string
  slow: boolean
  crit: boolean
  hit: Set<number>
  trail: number
  big?: boolean
  /** fx 雪碧图中的帧序号 */
  sprite?: number
}

export interface Swing { x: number; y: number; angle: number; range: number; life: number; max: number; damage: number; hit: Set<number>; color: string }

export type PickupKind = 'heart' | 'energy' | 'weapon' | 'item' | 'stairs' | 'chest' | 'fountain'
export interface Pickup { kind: PickupKind; x: number; y: number; vx: number; vy: number; weapon?: string; item?: ItemDef; used?: boolean; t: number }

export interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; kind: 'spark' | 'dust' | 'ring' | 'text' | 'ghost' | 'flash' | 'explosion' | 'impact' | 'shell'; text?: string; angle?: number; owner?: number; sum?: number }

export interface Corpse { kind: EnemyKind | BossKind; x: number; y: number; t: number; flip: boolean; scale: number }

export interface Banner { title: string; text: string; life: number; color: string }

const STEP = 1 / 60
/** 武器与敌方子弹颜色对应的 fx 帧 */
const PLAYER_FX: Record<string, number> = { pistol: 0, smg: 1, laser: 2, rocket: 3, bouncer: 4, frost: 5 }
const ENEMY_FX: Record<string, number> = { '#ff6b6b': 8, '#ffa94d': 9, '#ffc078': 9, '#b388ff': 10, '#ff8fab': 10, '#7bed9f': 11, '#c8c3b9': 12 }
const SOLID_WALK = new Set([WALL, ROCK, PIT])

let nextId = 1

export class Game {
  floor!: Floor
  room!: Room
  level = 1
  player: Player
  enemies: Enemy[] = []
  bullets: Bullet[] = []
  swings: Swing[] = []
  pickups = new Map<Room, Pickup[]>()
  particles: Particle[] = []
  corpses: Corpse[] = []
  /** 正在行动的怪物：它发射子弹时记为一次攻击动作 */
  private acting?: Enemy
  /** 镜头冲击：开火时向后、受击时随伤害方向偏移 */
  kickX = 0
  kickY = 0
  banner: Banner | null = null
  shake = 0
  hitStop = 0
  time = 0
  score = 0
  kills = 0
  bossesKilled = 0
  state: 'play' | 'transition' | 'dead' = 'play'
  transition = 0
  private pendingDoor: Dir | null = null
  flow = new Int16Array(ROOM_W * ROOM_H)
  private flowTimer = 0
  private carry = 0
  hurtFlash = 0
  deadTime = 0
  lowEnergyHint = 0
  prompt = ''
  onSound: (s: Sound) => void = () => {}
  onOver: () => void = () => {}

  constructor() {
    this.player = {
      x: WORLD_W / 2, y: WORLD_H / 2, vx: 0, vy: 0, r: 10,
      hp: 6, maxHp: 6, armor: 0, maxArmor: 0, calm: 0,
      energy: 160, maxEnergy: 160,
      weapons: ['pistol'], current: 0, cooldown: 0,
      dashTime: 0, dashCd: 0, dashX: 1, dashY: 0, invuln: 0, aim: 0, walk: 0, recoil: 0,
      items: [],
      stats: { damage: 1, speed: 1, rate: 1, multishot: 0, pierce: 0, bounce: 0, crit: 0, vamp: 0, orbit: 0, dash: 1, size: 1, regen: 0 },
    }
    this.enterFloor(1)
  }

  get weapon(): WeaponDef { return WEAPONS[this.player.weapons[this.player.current]] }
  get boss() { return this.enemies.find(e => e.boss) }

  // —— 楼层与房间 ——

  enterFloor(level: number) {
    this.level = level
    this.floor = generateFloor(level)
    this.pickups = new Map()
    this.room = this.floor.start
    this.player.x = WORLD_W / 2; this.player.y = WORLD_H / 2 + TILE
    this.player.energy = this.player.maxEnergy
    this.enemies = []; this.bullets = []; this.swings = []
    if (level === 1) this.drop(this.room, { kind: 'weapon', x: WORLD_W / 2 + 70, y: WORLD_H / 2 - 20, weapon: pick(['smg', 'shotgun', 'bouncer']) })
    this.banner = { title: `第 ${level} 层`, text: level === 1 ? '找到并击败本层首领' : '更深处，怪物更凶猛了', life: 2.6, color: '#ffd166' }
    this.computeFlow()
  }

  private drop(room: Room, p: Omit<Pickup, 'vx' | 'vy' | 't'> & Partial<Pick<Pickup, 'vx' | 'vy'>>) {
    const list = this.pickups.get(room) ?? []
    list.push({ vx: 0, vy: 0, t: 0, ...p })
    this.pickups.set(room, list)
  }

  get roomPickups() { return this.pickups.get(this.room) ?? [] }

  private enterRoom(room: Room, from: Dir) {
    this.room = room
    const [tx, ty] = DOOR_TILE[OPPOSITE[from]]
    const [dx, dy] = DIRS[from]
    this.player.x = (tx + 0.5) * TILE + dx * TILE * 1.3
    this.player.y = (ty + 0.5) * TILE + dy * TILE * 1.3
    this.bullets = []; this.swings = []
    this.enemies = []; this.corpses = []
    if (!room.visited) {
      room.visited = true
      if (room.type === 'normal') this.spawnWave(room)
      if (room.type === 'boss') this.spawnBoss()
      if (room.type === 'treasure') this.drop(room, { kind: 'item', x: WORLD_W / 2, y: WORLD_H / 2, item: this.randomItem() })
      if (room.type === 'heal') this.drop(room, { kind: 'fountain', x: WORLD_W / 2, y: WORLD_H / 2 })
    }
    this.computeFlow()
  }

  private randomItem(): ItemDef {
    const owned = new Set(this.player.items.map(i => i.id))
    const pool = ITEMS.filter(i => !owned.has(i.id) || ['power', 'spring', 'heart', 'split'].includes(i.id))
    return pick(pool.length ? pool : ITEMS)
  }

  private spawnWave(room: Room) {
    const tiles = shuffle(spawnTiles(room))
    const count = Math.min(11, 3 + Math.floor(this.level * 0.9) + Math.floor(Math.random() * 3))
    const pool = enemyPool(this.level)
    for (let i = 0; i < count && i < tiles.length; i++) {
      const [x, y] = tiles[i]
      this.spawnEnemy(pick(pool), (x + 0.5) * TILE, (y + 0.5) * TILE, this.level >= 3 && Math.random() < 0.08 + this.level * 0.02)
    }
  }

  spawnEnemy(kind: EnemyKind, x: number, y: number, elite = false, delay = 0.7) {
    const def = ENEMIES[kind]
    const hp = def.hp * hpScale(this.level) * (elite ? 1.7 : 1)
    const e: Enemy = {
      id: nextId++, kind, boss: false, x, y, vx: 0, vy: 0, r: def.radius * (elite ? 1.2 : 1),
      hp, maxHp: hp, speed: def.speed * (elite ? 1.15 : 1) * (1 + Math.min(0.3, (this.level - 1) * 0.04)),
      state: 'idle', timer: Math.random() * 1.2, cd: 1 + Math.random() * 1.5, flash: 0, slow: 0, spawn: delay,
      elite, angle: Math.random() * Math.PI * 2, tx: x, ty: y, phase: Math.random() * 10, z: 0, flying: !!def.flying, anim: Math.random() * 10, pose: 9, kx: 0, ky: 0, squash: 1,
    }
    this.enemies.push(e)
    return e
  }

  private spawnBoss() {
    const kind = BOSS_ORDER[(this.level - 1) % BOSS_ORDER.length]
    const def = BOSSES[kind]
    const hp = def.hp * (1 + (this.level - 1) * 0.35)
    this.enemies.push({
      id: nextId++, kind, boss: true, x: WORLD_W / 2, y: WORLD_H / 2 - TILE, vx: 0, vy: 0, r: def.radius,
      hp, maxHp: hp, speed: 40, state: 'intro', timer: 1.4, cd: 0, flash: 0, slow: 0, spawn: 1.2,
      elite: false, angle: 0, tx: 0, ty: 0, phase: 0, z: 0, flying: kind === 'necro', anim: 0, pose: 9, kx: 0, ky: 0, squash: 1,
    })
    this.banner = { title: def.name, text: `第 ${this.level} 层首领`, life: 2.2, color: '#ff5d5d' }
    this.onSound('boss')
  }

  // —— 主循环 ——

  /** 推进模拟，返回执行的步数；单次按键只在第一步生效。 */
  update(dt: number, input: Input) {
    this.carry = Math.min(this.carry + dt, 0.1)
    let steps = 0
    while (this.carry >= STEP) {
      this.carry -= STEP
      this.step(input)
      input.swap = false; input.interact = false; input.dash = false
      steps++
    }
    return steps
  }

  private step(input: Input) {
    const dt = STEP
    this.updateParticles(dt)
    if (this.banner && (this.banner.life -= dt) <= 0) this.banner = null
    this.shake = Math.max(0, this.shake - dt * 18)
    this.kickX *= 0.82; this.kickY *= 0.82
    for (const c of this.corpses) c.t += dt
    if (this.corpses.length > 30) this.corpses.splice(0, this.corpses.length - 30)
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5)
    this.lowEnergyHint = Math.max(0, this.lowEnergyHint - dt)
    if (this.state === 'dead') { this.deadTime += dt; return }
    if (this.hitStop > 0) { this.hitStop -= dt; return }
    if (this.state === 'transition') {
      this.transition += dt
      if (this.transition >= 0.18 && this.pendingDoor) {
        const target = this.room.doors[this.pendingDoor]!
        this.enterRoom(target, this.pendingDoor)
        this.pendingDoor = null
      }
      if (this.transition >= 0.36) this.state = 'play'
      return
    }
    this.time += dt
    if ((this.flowTimer -= dt) <= 0) { this.flowTimer = 0.2; this.computeFlow() }
    this.updatePlayer(dt, input)
    for (const e of [...this.enemies]) this.updateEnemy(e, dt)
    this.separateEnemies()
    this.updateBullets(dt)
    this.updateSwings(dt)
    this.updatePickups(dt, input)
    this.checkClear()
    this.checkDoors()
  }

  // —— 玩家 ——

  private updatePlayer(dt: number, input: Input) {
    const p = this.player
    p.invuln = Math.max(0, p.invuln - dt)
    p.dashCd = Math.max(0, p.dashCd - dt)
    p.cooldown = Math.max(0, p.cooldown - dt)
    p.recoil = Math.max(0, p.recoil - dt * 10)
    p.calm += dt
    if (p.maxArmor && p.armor < p.maxArmor && p.calm > 4) { p.armor++; p.calm = 2.5 }
    if (p.stats.regen) p.energy = Math.min(p.maxEnergy, p.energy + p.stats.regen * dt)

    let mx = input.moveX, my = input.moveY
    const len = Math.hypot(mx, my)
    if (len > 1) { mx /= len; my /= len }

    if (input.dash && p.dashCd <= 0 && p.dashTime <= 0) {
      const dir = len > 0.1 ? [mx / Math.max(len, 1e-6), my / Math.max(len, 1e-6)] : [Math.cos(p.aim), Math.sin(p.aim)]
      const n = Math.hypot(dir[0], dir[1]) || 1
      p.dashX = dir[0] / n; p.dashY = dir[1] / n
      p.dashTime = 0.18
      p.dashCd = 0.85 * p.stats.dash
      this.onSound('dash')
    }
    const speed = 130 * p.stats.speed
    if (p.dashTime > 0) {
      p.dashTime -= dt
      p.vx = p.dashX * speed * 3.4; p.vy = p.dashY * speed * 3.4
      if (Math.random() < 0.7) this.particles.push({ x: p.x, y: p.y, vx: 0, vy: 0, life: 0.22, max: 0.22, color: '#8ab4ff', size: p.r, kind: 'ghost', angle: p.aim })
      if (p.stats.dash < 1) for (const e of this.enemies) if (!e.spawn && dist(e, p) < e.r + p.r + 4) this.damageEnemy(e, 4 * p.stats.damage, p.dashX, p.dashY, false, 60)
    } else {
      p.vx += (mx * speed - p.vx) * Math.min(1, dt * 14)
      p.vy += (my * speed - p.vy) * Math.min(1, dt * 14)
    }
    if (len > 0.1) p.walk += dt * 10
    this.alignToDoor(mx, my, dt)
    this.moveActor(p, p.vx * dt, p.vy * dt, false)

    // 瞄准：优先手动方向，否则锁定最近可见的敌人
    const target = this.nearestEnemy()
    if (input.aim !== null) p.aim = input.aim
    else if (target) p.aim = Math.atan2(target.y - p.y, target.x - p.x)
    else if (len > 0.1) p.aim = Math.atan2(my, mx)

    if (input.swap && p.weapons.length > 1) { p.current = (p.current + 1) % p.weapons.length; p.cooldown = Math.max(p.cooldown, 0.15); this.onSound('pickup') }
    if (input.fire && p.cooldown <= 0 && p.dashTime <= 0) this.fire()
  }

  /** 朝门走时把玩家轻轻推向门洞中线，避免卡在门框。 */
  private alignToDoor(mx: number, my: number, dt: number) {
    if (!this.room.cleared) return
    const p = this.player, k = Math.min(1, dt * 12)
    for (const dir of Object.keys(this.room.doors) as Dir[]) {
      const [tx, ty] = DOOR_TILE[dir]
      const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE
      if (dir === 'e' && mx > 0.3 && p.x > WORLD_W - TILE * 2.4 && Math.abs(p.y - cy) < 26) p.y += (cy - p.y) * k
      if (dir === 'w' && mx < -0.3 && p.x < TILE * 2.4 && Math.abs(p.y - cy) < 26) p.y += (cy - p.y) * k
      if (dir === 's' && my > 0.3 && p.y > WORLD_H - TILE * 2.4 && Math.abs(p.x - cx) < 26) p.x += (cx - p.x) * k
      if (dir === 'n' && my < -0.3 && p.y < TILE * 2.4 && Math.abs(p.x - cx) < 26) p.x += (cx - p.x) * k
    }
  }

  nearestEnemy() {
    let best: Enemy | undefined, bestD = Infinity
    for (const e of this.enemies) {
      if (e.spawn > 0 || e.z > 8) continue
      const d = dist(e, this.player)
      if (d < bestD && this.lineOfSight(this.player.x, this.player.y, e.x, e.y, true)) { best = e; bestD = d }
    }
    return best
  }

  private fire() {
    const p = this.player, w = this.weapon
    if (p.energy < w.cost) {
      if (this.lowEnergyHint <= 0) { this.float(p.x, p.y - 20, '能量不足', '#4dd2ff'); this.lowEnergyHint = 1.2; this.onSound('empty') }
      p.cooldown = 0.25
      return
    }
    p.energy -= w.cost
    p.cooldown = w.cooldown / p.stats.rate
    p.recoil = 1
    this.kickX -= Math.cos(p.aim) * w.shake * 1.1; this.kickY -= Math.sin(p.aim) * w.shake * 1.1
    if (w.id === 'shotgun' || w.id === 'rocket') { p.vx -= Math.cos(p.aim) * 90; p.vy -= Math.sin(p.aim) * 90 }
    if (['pistol', 'smg', 'shotgun'].includes(w.id)) {
      const side = p.aim + (Math.cos(p.aim) >= 0 ? -Math.PI / 2 : Math.PI / 2)
      this.particles.push({ x: p.x + Math.cos(p.aim) * 8, y: p.y, vx: Math.cos(side) * 70 + (Math.random() - 0.5) * 30, vy: -90 - Math.random() * 40, life: 0.55, max: 0.55, color: '#e0b04a', size: 2.2, kind: 'shell', angle: Math.random() * 6 })
    }
    this.shake = Math.max(this.shake, w.shake)
    if (w.melee) {
      const crit = Math.random() < p.stats.crit
      this.swings.push({ x: p.x, y: p.y, angle: p.aim, range: w.size * (0.9 + p.stats.size * 0.1), life: w.life, max: w.life, damage: w.damage * p.stats.damage * (crit ? 2 : 1), hit: new Set(), color: w.color })
      this.onSound('swing')
      return
    }
    const count = w.count + p.stats.multishot
    for (let i = 0; i < count; i++) {
      const offset = count > 1 ? (i / (count - 1) - 0.5) * Math.max(w.spread, 0.12 * (count - 1)) : 0
      const angle = p.aim + offset + (Math.random() - 0.5) * w.spread * (w.count > 1 ? 0.5 : 1)
      const speed = w.speed * (w.count > 1 ? 0.85 + Math.random() * 0.3 : 1)
      const crit = Math.random() < p.stats.crit
      this.bullets.push({
        x: p.x + Math.cos(p.aim) * 16, y: p.y + Math.sin(p.aim) * 16,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        r: w.size * p.stats.size, damage: w.damage * p.stats.damage * (crit ? 2 : 1), enemy: false, life: w.life,
        pierce: (w.pierce ?? 0) + p.stats.pierce, bounce: (w.bounce ?? 0) + p.stats.bounce, explode: w.explode ?? 0,
        color: crit ? '#fff1a8' : w.color, slow: !!w.slow, crit, hit: new Set(), trail: w.id === 'laser' ? 26 : w.id === 'rocket' ? 14 : 8, sprite: PLAYER_FX[w.id] ?? 0,
      })
    }
    this.particles.push({ x: p.x + Math.cos(p.aim) * 20, y: p.y + Math.sin(p.aim) * 20, vx: 0, vy: 0, life: 0.06, max: 0.06, color: w.color, size: 9, kind: 'flash', angle: p.aim })
    this.onSound(w.id === 'shotgun' ? 'shotgun' : w.id === 'laser' ? 'laser' : w.id === 'rocket' ? 'rocket' : 'shoot')
  }

  hurtPlayer(amount = 1) {
    const p = this.player
    if (p.invuln > 0 || p.dashTime > 0 || this.state !== 'play') return
    p.calm = 0
    if (p.armor > 0) { p.armor--; amount-- }
    if (amount > 0) p.hp -= amount
    p.invuln = 1
    this.shake = Math.max(this.shake, 5)
    this.hurtFlash = 1
    this.hitStop = 0.05
    this.burst(p.x, p.y, '#ff5d5d', 10)
    this.onSound('hurt')
    if (p.hp <= 0) {
      p.hp = 0
      this.state = 'dead'
      this.burst(p.x, p.y, '#8ab4ff', 30)
      this.onOver()
    }
  }

  // —— 怪物 ——

  private updateEnemy(e: Enemy, dt: number) {
    if (e.hp <= 0) return
    this.acting = e
    e.flash = Math.max(0, e.flash - dt * 12)
    e.pose += dt
    e.squash += (1 - e.squash) * Math.min(1, dt * 14)
    if (e.kx || e.ky) {
      this.moveActor(e, e.kx * dt, e.ky * dt, e.flying)
      e.kx *= 0.82; e.ky *= 0.82
      if (Math.abs(e.kx) + Math.abs(e.ky) < 4) e.kx = e.ky = 0
    }
    e.anim += dt
    if (e.spawn > 0) { e.spawn -= dt; return }
    e.slow = Math.max(0, e.slow - dt)
    const slow = e.slow > 0 ? 0.5 : 1
    const p = this.player
    const dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy) || 1
    const sees = this.lineOfSight(e.x, e.y, p.x, p.y, true)
    e.cd -= dt * slow
    e.timer -= dt * slow

    if (e.boss) this.updateBoss(e, dt, slow, d, dx, dy)
    else switch (e.kind) {
      case 'slime': {
        if (e.state === 'hop') {
          this.moveActor(e, e.vx * dt * slow, e.vy * dt * slow, false)
          if (e.timer <= 0) { e.state = 'idle'; e.timer = 0.45 + Math.random() * 0.5 }
        } else if (e.timer <= 0) {
          const [cx, cy] = this.chaseDir(e)
          e.vx = cx * e.speed * 2.3; e.vy = cy * e.speed * 2.3
          e.state = 'hop'; e.timer = 0.38
        }
        break
      }
      case 'bat': {
        e.phase += dt * 6
        const wobble = Math.sin(e.phase) * 0.9
        const ang = Math.atan2(dy, dx) + wobble * (e.state === 'retreat' ? 0 : 1)
        const dir = e.state === 'retreat' ? -1 : 1
        if (e.state === 'retreat' && e.timer <= 0) e.state = 'idle'
        e.vx += (Math.cos(ang) * e.speed * dir - e.vx) * dt * 3
        e.vy += (Math.sin(ang) * e.speed * dir - e.vy) * dt * 3
        this.moveActor(e, e.vx * dt * slow, e.vy * dt * slow, true)
        break
      }
      case 'archer': {
        if (e.state === 'aim') {
          if (e.timer <= 0) {
            const spread = this.level >= 4 ? [-0.22, 0, 0.22] : [0]
            for (const s of spread) this.enemyShot(e.x, e.y, Math.atan2(dy, dx) + s, 165, 4.5, '#ff6b6b')
            e.state = 'idle'; e.cd = 1.7 + Math.random() * 0.8
          }
          break
        }
        const want = d < 110 ? -1 : d > 190 || !sees ? 1 : 0
        if (want) {
          const [cx, cy] = want > 0 ? this.chaseDir(e) : [-dx / d, -dy / d]
          this.moveActor(e, cx * e.speed * dt * slow, cy * e.speed * dt * slow, false)
        } else {
          e.angle += dt
          this.moveActor(e, Math.cos(e.angle) * e.speed * 0.4 * dt, Math.sin(e.angle) * e.speed * 0.4 * dt, false)
        }
        if (e.cd <= 0 && sees) { e.state = 'aim'; e.timer = 0.5 }
        break
      }
      case 'totem': {
        if (e.state === 'charge' && e.timer <= 0) {
          const n = this.level >= 4 ? 10 : 8
          for (let i = 0; i < n; i++) this.enemyShot(e.x, e.y, e.angle + (i / n) * Math.PI * 2, 115, 5, '#ffa94d')
          e.angle += Math.PI / n
          e.state = 'idle'; e.cd = 2.4
        } else if (e.state === 'idle' && e.cd <= 0) { e.state = 'charge'; e.timer = 0.55 }
        break
      }
      case 'boar': {
        if (e.state === 'windup') {
          if (e.timer <= 0) { e.state = 'charge'; e.timer = 0.9; e.vx = Math.cos(e.angle) * 330; e.vy = Math.sin(e.angle) * 330 }
        } else if (e.state === 'charge') {
          const hit = this.moveActor(e, e.vx * dt * slow, e.vy * dt * slow, false)
          if (Math.random() < 0.5) this.dust(e.x, e.y + e.r * 0.6)
          if (hit || e.timer <= 0) {
            e.state = 'stun'; e.timer = hit ? 0.9 : 0.4
            if (hit) { this.shake = Math.max(this.shake, 2.5); this.burst(e.x, e.y, '#b9a48c', 6) }
          }
        } else if (e.state === 'stun') {
          if (e.timer <= 0) { e.state = 'idle'; e.cd = 1.2 + Math.random() }
        } else {
          const [cx, cy] = this.chaseDir(e)
          this.moveActor(e, cx * e.speed * dt * slow, cy * e.speed * dt * slow, false)
          if (e.cd <= 0 && sees && d < 240) { e.state = 'windup'; e.timer = 0.6; e.angle = Math.atan2(dy, dx) }
        }
        break
      }
      case 'pumpkin': {
        if (e.state === 'fuse') {
          if (e.timer <= 0) { this.killEnemy(e); return }
          break
        }
        const [cx, cy] = this.chaseDir(e)
        this.moveActor(e, cx * e.speed * dt * slow, cy * e.speed * dt * slow, false)
        if (d < 40) { e.state = 'fuse'; e.timer = 0.65 }
        break
      }
      case 'mage': {
        if (e.state === 'vanish') {
          if (e.timer <= 0) {
            const spots = spawnTiles(this.room).filter(([x, y]) => { const r = Math.hypot((x + 0.5) * TILE - p.x, (y + 0.5) * TILE - p.y); return r > 100 && r < 230 })
            const [x, y] = spots.length ? pick(spots) : [Math.floor(e.x / TILE), Math.floor(e.y / TILE)]
            e.x = (x + 0.5) * TILE; e.y = (y + 0.5) * TILE
            e.state = 'appear'; e.timer = 0.35
            this.burst(e.x, e.y, '#a29bfe', 10)
          }
        } else if (e.state === 'appear') {
          if (e.timer <= 0) { e.state = 'cast'; e.timer = 0.45 }
        } else if (e.state === 'cast') {
          if (e.timer <= 0) {
            const n = this.level >= 5 ? 5 : 3
            for (let i = 0; i < n; i++) this.enemyShot(e.x, e.y, Math.atan2(dy, dx) + (i - (n - 1) / 2) * 0.28, 125, 6, '#b388ff')
            e.state = 'idle'; e.cd = 2.6 + Math.random()
          }
        } else if (e.cd <= 0) { e.state = 'vanish'; e.timer = 0.35; this.burst(e.x, e.y, '#a29bfe', 8) }
        break
      }
    }

    if (!e.boss && e.spawn <= 0 && e.state !== 'vanish' && dist(e, p) < e.r + p.r - 2 && e.z < 8) {
      this.hurtPlayer(ENEMIES[e.kind as EnemyKind].touch)
      if (e.kind === 'bat') { e.state = 'retreat'; e.timer = 0.6 }
    }
  }

  private updateBoss(e: Enemy, dt: number, slow: number, d: number, dx: number, dy: number) {
    const p = this.player
    const rage = e.hp < e.maxHp * 0.5
    const fast = 1 + Math.min(0.4, (this.level - 1) * 0.04)
    if (e.state === 'intro') { if (e.timer <= 0) { e.state = 'idle'; e.timer = 0.6 } return }
    if (dist(e, p) < e.r + p.r - 4 && e.z < 8) this.hurtPlayer(1)

    if (e.kind === 'kingSlime') {
      if (e.state === 'idle' && e.timer <= 0) {
        e.phase++
        if (e.phase % 3 === 0) { e.state = 'spit'; e.timer = 0; e.cd = 3 }
        else { e.state = 'rise'; e.timer = 0.35; e.tx = p.x; e.ty = p.y }
      } else if (e.state === 'rise') {
        if (e.timer <= 0) { e.state = 'air'; e.timer = rage ? 0.7 : 0.9 }
      } else if (e.state === 'air') {
        const total = rage ? 0.7 : 0.9
        const t = 1 - e.timer / total
        e.z = Math.sin(t * Math.PI) * 90
        e.x += (e.tx - e.x) * Math.min(1, dt * 4)
        e.y += (e.ty - e.y) * Math.min(1, dt * 4)
        this.clampToRoom(e)
        if (e.timer <= 0) {
          e.z = 0
          const n = rage ? 18 : 14
          for (let i = 0; i < n; i++) this.enemyShot(e.x, e.y, (i / n) * Math.PI * 2 + e.phase * 0.2, 135 * fast, 6, '#7bed9f')
          this.shake = 6
          e.pose = 0
          this.ring(e.x, e.y, '#7bed9f', 70)
          this.dustRing(e.x, e.y + e.r * 0.6)
          e.state = 'idle'; e.timer = rage ? 0.5 : 0.8
        }
      } else if (e.state === 'spit') {
        if (e.timer <= 0) {
          for (let i = -2; i <= 2; i++) this.enemyShot(e.x, e.y, Math.atan2(dy, dx) + i * 0.2, 165 * fast, 6, '#7bed9f')
          e.timer = 0.45; e.cd -= 1
          if (e.cd <= 0) { e.state = 'idle'; e.timer = 0.7 }
        }
      }
      // 血量减半和四分之一时分裂出小史莱姆
      const splits = e.hp < e.maxHp * 0.25 ? 2 : rage ? 1 : 0
      if (splits > e.angle && e.state !== 'air') {
        e.angle = splits
        for (let i = 0; i < 3; i++) this.spawnEnemy('slime', e.x + Math.cos(i * 2.1) * 40, e.y + Math.sin(i * 2.1) * 40, false, 0.3)
      }
    } else if (e.kind === 'golem') {
      if (e.state === 'idle') {
        const [cx, cy] = this.chaseDir(e)
        this.moveActor(e, cx * 34 * dt * slow, cy * 34 * dt * slow, false)
        if (e.timer <= 0) {
          e.phase++
          const moves = ['rocks', 'slam', 'rocks', 'charge']
          e.state = moves[e.phase % moves.length] + 'Wind'
          e.timer = e.state === 'slamWind' ? 0.8 : 0.6
          e.angle = Math.atan2(dy, dx)
          e.cd = rage ? 3 : 2
        }
      } else if (e.state === 'rocksWind' && e.timer <= 0) {
        for (let i = -1; i <= 1; i++) this.enemyShot(e.x, e.y, Math.atan2(dy, dx) + i * 0.24, 190 * fast, 9, '#c8c3b9', true)
        this.shake = Math.max(this.shake, 2)
        e.cd--
        e.timer = 0.5
        if (e.cd <= 0) { e.state = 'idle'; e.timer = 1.1 }
      } else if (e.state === 'slamWind' && e.timer <= 0) {
        const n = rage ? 30 : 24, gap = Math.floor(Math.random() * n)
        for (let i = 0; i < n; i++) if (Math.abs(i - gap) > 1) this.enemyShot(e.x, e.y, (i / n) * Math.PI * 2, 120 * fast, 6, '#ffc078')
        this.shake = 7
        this.ring(e.x, e.y, '#ffc078', 90)
        this.dustRing(e.x, e.y + e.r * 0.5)
        e.cd--
        e.timer = 0.55
        if (e.cd <= 0) { e.state = 'idle'; e.timer = 1.2 }
      } else if (e.state === 'chargeWind' && e.timer <= 0) {
        e.state = 'charge'; e.timer = 1.1; e.vx = Math.cos(e.angle) * 300; e.vy = Math.sin(e.angle) * 300
      } else if (e.state === 'charge') {
        const hit = this.moveActor(e, e.vx * dt, e.vy * dt, false)
        if (Math.random() < 0.6) this.dust(e.x, e.y + e.r * 0.7)
        if (hit || e.timer <= 0) {
          if (hit) {
            this.shake = 8
            for (let i = 0; i < 10; i++) this.enemyShot(e.x, e.y, Math.atan2(-e.vy, -e.vx) + (i - 4.5) * 0.2, 150, 6, '#c8c3b9')
          }
          e.state = 'idle'; e.timer = 1.4
        }
      }
    } else if (e.kind === 'necro') {
      e.phase += dt
      // 缓慢漂浮，与玩家保持距离
      const want = d < 140 ? -1 : d > 220 ? 1 : 0
      e.vx += ((dx / d) * 45 * want + Math.cos(e.phase * 0.7) * 30 - e.vx) * dt * 2
      e.vy += ((dy / d) * 45 * want + Math.sin(e.phase * 0.9) * 30 - e.vy) * dt * 2
      if (e.state !== 'vanish') this.moveActor(e, e.vx * dt, e.vy * dt, true)
      if (e.state === 'idle' && e.timer <= 0) {
        e.tx++
        const moves = ['spiral', 'burst', 'summon', 'spiral', 'vanish']
        e.state = moves[e.tx % moves.length]
        e.timer = e.state === 'spiral' ? 3.2 : e.state === 'vanish' ? 0.4 : 0.6
        e.cd = 0; e.ty = 0
      } else if (e.state === 'spiral') {
        if (e.cd <= 0) {
          e.cd = rage ? 0.1 : 0.13
          e.angle += 0.23
          const arms = rage ? 5 : 4
          for (let i = 0; i < arms; i++) this.enemyShot(e.x, e.y, e.angle + (i / arms) * Math.PI * 2, 105 * fast, 5, '#b388ff')
          if (rage) for (let i = 0; i < 2; i++) this.enemyShot(e.x, e.y, -e.angle * 1.3 + i * Math.PI, 80 * fast, 5, '#ff8fab')
        }
        if (e.timer <= 0) { e.state = 'idle'; e.timer = 0.9 }
      } else if (e.state === 'burst') {
        if (e.timer <= 0) {
          for (let i = -3; i <= 3; i++) this.enemyShot(e.x, e.y, Math.atan2(dy, dx) + i * 0.17, 160 * fast, 6, '#ff8fab')
          e.ty++
          e.timer = 0.5
          if (e.ty >= 3) { e.state = 'idle'; e.timer = 0.9 }
        }
      } else if (e.state === 'summon') {
        if (e.timer <= 0) {
          const alive = this.enemies.filter(x => !x.boss).length
          for (let i = 0; i < Math.min(2, 4 - alive); i++) {
            const a = Math.random() * Math.PI * 2
            const sx = clamp(e.x + Math.cos(a) * 60, TILE * 2, WORLD_W - TILE * 2), sy = clamp(e.y + Math.sin(a) * 60, TILE * 2, WORLD_H - TILE * 2)
            if (!SOLID_WALK.has(tileAt(this.room, Math.floor(sx / TILE), Math.floor(sy / TILE)))) this.spawnEnemy(pick<EnemyKind>(['archer', 'bat']), sx, sy, false, 0.6)
          }
          this.ring(e.x, e.y, '#7d5fff', 60)
          e.state = 'idle'; e.timer = 1
        }
      } else if (e.state === 'vanish' && e.timer <= 0) {
        const spots = spawnTiles(this.room).filter(([x, y]) => Math.hypot((x + 0.5) * TILE - p.x, (y + 0.5) * TILE - p.y) > 150)
        if (spots.length) { const [x, y] = pick(spots); this.burst(e.x, e.y, '#7d5fff', 12); e.x = (x + 0.5) * TILE; e.y = (y + 0.5) * TILE; this.burst(e.x, e.y, '#7d5fff', 12) }
        e.state = 'idle'; e.timer = 0.5
      }
    }
  }

  private enemyShot(x: number, y: number, angle: number, speed: number, r: number, color: string, big = false) {
    if (this.acting) this.acting.pose = 0
    this.bullets.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r, damage: big ? 2 : 1, enemy: true, life: 5, pierce: 0, bounce: 0, explode: 0, color, slow: false, crit: false, hit: new Set(), trail: 0, big, sprite: ENEMY_FX[color] })
    this.onSound('enemyShoot')
  }

  /** 沿流场追击；能直接看到玩家时直线前进。 */
  private chaseDir(e: Enemy): [number, number] {
    const p = this.player
    if (this.lineOfSight(e.x, e.y, p.x, p.y, false)) {
      const d = Math.hypot(p.x - e.x, p.y - e.y) || 1
      return [(p.x - e.x) / d, (p.y - e.y) / d]
    }
    const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE)
    let best = this.flow[ty * ROOM_W + tx] ?? 9999, bx = 0, by = 0
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      if (!ox && !oy) continue
      const nx = tx + ox, ny = ty + oy
      if (nx < 0 || ny < 0 || nx >= ROOM_W || ny >= ROOM_H) continue
      if (ox && oy && (this.blocked(tx + ox, ty) || this.blocked(tx, ty + oy))) continue
      const v = this.flow[ny * ROOM_W + nx]
      if (v >= 0 && v < best) { best = v; bx = ox; by = oy }
    }
    if (!bx && !by) return [0, 0]
    const gx = (tx + bx + 0.5) * TILE - e.x, gy = (ty + by + 0.5) * TILE - e.y
    const d = Math.hypot(gx, gy) || 1
    return [gx / d, gy / d]
  }

  private blocked(x: number, y: number) { return SOLID_WALK.has(tileAt(this.room, x, y)) || tileAt(this.room, x, y) === DOOR }

  private computeFlow() {
    this.flow.fill(-1)
    const p = this.player
    const sx = clamp(Math.floor(p.x / TILE), 0, ROOM_W - 1), sy = clamp(Math.floor(p.y / TILE), 0, ROOM_H - 1)
    const queue = [sy * ROOM_W + sx]
    this.flow[queue[0]] = 0
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i], cx = cur % ROOM_W, cy = Math.floor(cur / ROOM_W)
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + ox, ny = cy + oy
        if (nx < 0 || ny < 0 || nx >= ROOM_W || ny >= ROOM_H || this.blocked(nx, ny)) continue
        const k = ny * ROOM_W + nx
        if (this.flow[k] !== -1) continue
        this.flow[k] = this.flow[cur] + 1
        queue.push(k)
      }
    }
  }

  private separateEnemies() {
    const list = this.enemies
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j]
      if (a.z > 8 || b.z > 8) continue
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r
      if (d >= min || d === 0) continue
      const push = (min - d) / 2, nx = dx / d, ny = dy / d
      if (!a.boss) this.moveActor(a, -nx * push, -ny * push, a.flying)
      if (!b.boss) this.moveActor(b, nx * push, ny * push, b.flying)
    }
  }

  damageEnemy(e: Enemy, amount: number, nx: number, ny: number, crit: boolean, knockback: number) {
    if (e.spawn > 0 || e.z > 8 || e.hp <= 0) return
    e.hp -= amount
    e.flash = 1
    e.squash = crit ? 0.62 : 0.78
    if (!e.boss && e.state !== 'charge' && e.kind !== 'totem') {
      // 击退有上限，避免高射速武器把怪物压在墙角无法靠近
      e.kx += nx * knockback * 1.3; e.ky += ny * knockback * 1.3
      const kv = Math.hypot(e.kx, e.ky)
      if (kv > 170) { e.kx *= 170 / kv; e.ky *= 170 / kv }
    }
    const heavy = amount >= 5 || crit
    if (heavy) this.hitStop = Math.max(this.hitStop, crit ? 0.045 : 0.03)
    this.kickX += nx * (heavy ? 1.6 : 0.6); this.kickY += ny * (heavy ? 1.6 : 0.6)
    this.shake = Math.max(this.shake, heavy ? 2.4 : 0.9)
    this.particles.push({ x: e.x - nx * e.r * 0.6, y: e.y - ny * e.r * 0.6, vx: 0, vy: 0, life: 0.12, max: 0.12, color: '#fff', size: heavy ? 22 : 14, kind: 'impact', angle: Math.random() * 6 })
    // 连续命中的伤害数字合并显示，避免刷屏
    const recent = this.particles.find(p => p.owner === e.id && p.life > p.max - 0.3)
    if (recent && !crit) { recent.sum! += amount; recent.text = String(Math.round(recent.sum!)); recent.life = recent.max; recent.x = e.x; recent.y = e.y - e.r - 4 }
    else this.particles.push({ x: e.x + (Math.random() - 0.5) * 10, y: e.y - e.r - 4, vx: 0, vy: -40, life: 0.6, max: 0.6, color: crit ? '#ffe066' : '#ffffff', size: crit ? 15 : 10, kind: 'text', text: String(Math.round(amount)), owner: crit ? undefined : e.id, sum: amount })
    for (let i = 0; i < 3; i++) this.spark(e.x - nx * e.r * 0.5, e.y - ny * e.r * 0.5, Math.atan2(-ny, -nx) + (Math.random() - 0.5) * 1.6, ENEMIES[e.kind as EnemyKind]?.color ?? BOSSES[e.kind as BossKind].color)
    this.onSound('hit')
    if (e.hp <= 0) this.killEnemy(e)
  }

  private killEnemy(e: Enemy) {
    e.hp = 0
    this.enemies = this.enemies.filter(x => x !== e)
    const color = e.boss ? BOSSES[e.kind as BossKind].color : ENEMIES[e.kind as EnemyKind].color
    this.burst(e.x, e.y, color, e.boss ? 60 : 22)
    this.corpses.push({ kind: e.kind, x: e.x, y: e.y, t: 0, flip: this.player.x < e.x, scale: e.boss ? 1 : e.r / ENEMIES[e.kind as EnemyKind].radius })
    this.shake = Math.max(this.shake, e.boss ? 10 : 3.5)
    this.kills++
    this.onSound('kill')
    if (e.kind === 'pumpkin') this.explode(e.x, e.y, 54, 10, true)
    if (e.boss) {
      this.bossesKilled++
      this.score += 1000 * this.level
      this.hitStop = 0.25
      this.shake = 10
      this.ring(e.x, e.y, color, 140)
      this.enemies = []
      this.bullets = this.bullets.filter(b => !b.enemy)
      this.drop(this.room, { kind: 'item', x: WORLD_W / 2, y: WORLD_H / 2 - TILE * 1.6, item: this.randomItem() })
      this.drop(this.room, { kind: 'stairs', x: WORLD_W / 2, y: WORLD_H / 2 + TILE * 1.6 })
      this.drop(this.room, { kind: 'heart', x: WORLD_W / 2 + TILE * 2, y: WORLD_H / 2 })
      this.banner = { title: '首领已击败', text: '拾取宝物，然后走进阶梯', life: 2.4, color: '#ffd166' }
      return
    }
    this.hitStop = Math.max(this.hitStop, e.elite ? 0.09 : 0.06)
    this.score += ENEMIES[e.kind as EnemyKind].score * this.level * (e.elite ? 2 : 1)
    const orbs = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < orbs; i++) this.drop(this.room, { kind: 'energy', x: e.x, y: e.y, vx: (Math.random() - 0.5) * 160, vy: (Math.random() - 0.5) * 160 })
    if (this.player.stats.vamp && Math.random() < this.player.stats.vamp && this.player.hp < this.player.maxHp) {
      this.player.hp++
      this.float(this.player.x, this.player.y - 18, '+1', '#ff6b8b')
    }
  }

  private explode(x: number, y: number, radius: number, damage: number, hurtsPlayer: boolean) {
    this.shake = Math.max(this.shake, 5)
    this.ring(x, y, '#ffb347', radius)
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.55, max: 0.55, color: '#ffb347', size: radius * 2.3, kind: 'explosion' })
    this.hitStop = Math.max(this.hitStop, 0.06)
    this.kickX += (Math.random() - 0.5) * 6; this.kickY += (Math.random() - 0.5) * 6
    for (let i = 0; i < 22; i++) this.spark(x, y, Math.random() * Math.PI * 2, i % 2 ? '#ffd166' : '#ff6b3d', 260)
    this.onSound('explode')
    for (const e of [...this.enemies]) {
      const d = dist(e, { x, y })
      if (d < radius + e.r) this.damageEnemy(e, damage, (e.x - x) / (d || 1), (e.y - y) / (d || 1), false, 200)
    }
    if (hurtsPlayer && dist(this.player, { x, y }) < radius + this.player.r - 4) this.hurtPlayer(1)
  }

  // —— 子弹与近战 ——

  private updateBullets(dt: number) {
    const p = this.player
    const keep: Bullet[] = []
    for (const b of this.bullets) {
      b.life -= dt
      const steps = Math.ceil((Math.hypot(b.vx, b.vy) * dt) / 6)
      let alive = b.life > 0
      for (let s = 0; s < steps && alive; s++) {
        const ox = b.x, oy = b.y
        b.x += (b.vx * dt) / steps; b.y += (b.vy * dt) / steps
        const tile = tileAt(this.room, Math.floor(b.x / TILE), Math.floor(b.y / TILE))
        if (tile === WALL || tile === ROCK || tile === DOOR) {
          if (b.bounce > 0) {
            b.bounce--
            const hx = tileAt(this.room, Math.floor(b.x / TILE), Math.floor(oy / TILE))
            if (hx === WALL || hx === ROCK || hx === DOOR) b.vx = -b.vx; else b.vy = -b.vy
            b.x = ox; b.y = oy
          } else {
            alive = false
            if (b.explode) this.explode(b.x, b.y, b.explode, b.damage, false)
            for (let i = 0; i < 4; i++) this.spark(b.x, b.y, Math.atan2(-b.vy, -b.vx) + (Math.random() - 0.5) * 2, b.color, 120)
          }
          continue
        }
        if (b.enemy) {
          if (this.player.stats.orbit) for (const o of this.orbits()) if (Math.hypot(o.x - b.x, o.y - b.y) < b.r + 6) { alive = false; this.spark(b.x, b.y, 0, '#c3f0ff', 80) }
          if (alive && Math.hypot(p.x - b.x, p.y - b.y) < b.r + p.r - 3 && p.dashTime <= 0 && p.invuln <= 0) {
            this.hurtPlayer(b.damage)
            alive = false
          }
        } else {
          for (const e of this.enemies) {
            if (b.hit.has(e.id) || e.spawn > 0 || e.z > 8) continue
            if (Math.hypot(e.x - b.x, e.y - b.y) < e.r + b.r) {
              b.hit.add(e.id)
              const sp = Math.hypot(b.vx, b.vy) || 1
              if (b.slow) e.slow = 1.6
              if (b.explode) { this.explode(b.x, b.y, b.explode, b.damage, false); alive = false; break }
              this.damageEnemy(e, b.damage, b.vx / sp, b.vy / sp, b.crit, WEAPONS[this.player.weapons[this.player.current]].knockback)
              if (b.pierce > 0) b.pierce--
              else { alive = false; break }
            }
          }
        }
      }
      if (alive) keep.push(b)
    }
    this.bullets = keep
  }

  orbits() {
    const p = this.player, n = this.player.stats.orbit
    return Array.from({ length: n }, (_, i) => {
      const a = this.time * 3 + (i / n) * Math.PI * 2
      return { x: p.x + Math.cos(a) * 26, y: p.y + Math.sin(a) * 26 }
    })
  }

  private updateSwings(dt: number) {
    for (const s of this.swings) {
      s.life -= dt
      s.x = this.player.x; s.y = this.player.y
      for (const e of this.enemies) {
        if (s.hit.has(e.id)) continue
        const d = Math.hypot(e.x - s.x, e.y - s.y)
        const ang = Math.abs(angleDiff(Math.atan2(e.y - s.y, e.x - s.x), s.angle))
        if (d < s.range + e.r && ang < 1.2) {
          s.hit.add(e.id)
          this.damageEnemy(e, s.damage, (e.x - s.x) / (d || 1), (e.y - s.y) / (d || 1), false, WEAPONS.saber.knockback)
        }
      }
      // 光剑可以把敌方子弹反弹回去
      for (const b of this.bullets) {
        if (!b.enemy) continue
        const d = Math.hypot(b.x - s.x, b.y - s.y)
        if (d < s.range + 6 && Math.abs(angleDiff(Math.atan2(b.y - s.y, b.x - s.x), s.angle)) < 1.3) {
          b.enemy = false
          const sp = Math.hypot(b.vx, b.vy) * 1.6
          b.vx = Math.cos(s.angle) * sp; b.vy = Math.sin(s.angle) * sp
          b.damage = 4 * this.player.stats.damage; b.color = '#7cffb2'; b.life = 1.2
          this.spark(b.x, b.y, s.angle, '#7cffb2', 150)
        }
      }
    }
    this.swings = this.swings.filter(s => s.life > 0)
  }

  // —— 掉落物 ——

  private updatePickups(dt: number, input: Input) {
    const p = this.player
    const list = this.roomPickups
    this.prompt = ''
    for (const item of list) {
      if (item.used) continue
      item.t += dt
      const d = dist(item, p)
      if (item.kind === 'energy') {
        item.vx *= 0.9; item.vy *= 0.9
        if (d < 90 && item.t > 0.3) { item.vx += ((p.x - item.x) / d) * 900 * dt; item.vy += ((p.y - item.y) / d) * 900 * dt }
        item.x += item.vx * dt; item.y += item.vy * dt
        if (d < p.r + 6) { item.used = true; p.energy = Math.min(p.maxEnergy, p.energy + 9) }
        continue
      }
      if (item.kind === 'heart' && d < p.r + 10) {
        if (p.hp < p.maxHp) { item.used = true; p.hp = Math.min(p.maxHp, p.hp + 2); this.float(p.x, p.y - 18, '+2', '#ff6b8b'); this.onSound('heal') }
      } else if (item.kind === 'item' && d < p.r + 14) {
        item.used = true
        this.applyItem(item.item!)
      } else if (item.kind === 'chest' && d < p.r + 16) {
        item.used = true
        this.burst(item.x, item.y, '#ffd166', 14)
        this.drop(this.room, { kind: 'weapon', x: item.x, y: item.y + 6, weapon: pick(WEAPON_POOL.filter(w => !p.weapons.includes(w))) })
        this.onSound('pickup')
      } else if (item.kind === 'weapon' && d < p.r + 18) {
        this.prompt = `拾取 ${WEAPONS[item.weapon!].name}`
        if (input.interact) {
          if (p.weapons.length < 2) { p.weapons.push(item.weapon!); p.current = p.weapons.length - 1; item.used = true }
          else { const old = p.weapons[p.current]; p.weapons[p.current] = item.weapon!; item.weapon = old; item.t = 0 }
          this.onSound('pickup')
          this.banner = { title: WEAPONS[p.weapons[p.current]].name, text: WEAPONS[p.weapons[p.current]].cost ? `每发消耗 ${WEAPONS[p.weapons[p.current]].cost} 能量` : '不消耗能量', life: 1.4, color: WEAPONS[p.weapons[p.current]].color }
        }
      } else if (item.kind === 'fountain' && d < p.r + 22) {
        this.prompt = '饮用泉水'
        if (input.interact) {
          item.used = true
          p.hp = p.maxHp; p.energy = p.maxEnergy
          this.ring(item.x, item.y, '#5ee7ff', 60)
          this.float(p.x, p.y - 20, '生命与能量已回满', '#5ee7ff')
          this.onSound('heal')
        }
      } else if (item.kind === 'stairs' && d < 18) {
        this.score += 300 * (this.level + 1)
        this.onSound('stairs')
        this.state = 'transition'; this.transition = 0.18
        this.enterFloor(this.level + 1)
        return
      }
    }
    if (list.some(i => i.used)) this.pickups.set(this.room, list.filter(i => !i.used || (i.kind === 'fountain')))
  }

  private applyItem(item: ItemDef) {
    const p = this.player, s = p.stats
    p.items.push(item)
    switch (item.id) {
      case 'power': s.damage *= 1.25; break
      case 'boots': s.speed *= 1.15; break
      case 'spring': s.rate *= 1.18; break
      case 'heart': p.maxHp += 2; p.hp = p.maxHp; break
      case 'split': s.multishot++; break
      case 'pierce': s.pierce++; break
      case 'rubber': s.bounce++; break
      case 'fang': s.vamp = 0.06; break
      case 'shield': p.maxArmor++; p.armor++; break
      case 'core': p.maxEnergy += 80; p.energy += 80; s.regen += 2; break
      case 'lens': s.crit += 0.15; break
      case 'orbit': s.orbit++; break
      case 'dash': s.dash *= 0.6; break
      case 'giant': s.size *= 1.5; s.damage *= 1.15; break
    }
    this.banner = { title: item.name, text: item.text, life: 2.2, color: item.color }
    this.ring(p.x, p.y, item.color, 50)
    this.onSound('pickup')
  }

  // —— 房间状态 ——

  private checkClear() {
    if (this.room.cleared || this.enemies.length) return
    this.room.cleared = true
    this.score += 50 * this.level
    this.onSound('door')
    const p = this.player
    const spots = spawnTiles(this.room)
    const near = spots.sort((a, b) => Math.hypot((a[0] + 0.5) * TILE - WORLD_W / 2, (a[1] + 0.5) * TILE - WORLD_H / 2) - Math.hypot((b[0] + 0.5) * TILE - WORLD_W / 2, (b[1] + 0.5) * TILE - WORLD_H / 2))
    const spot = near[0] ?? [9, 5]
    const roll = Math.random()
    if (this.room.type === 'normal') {
      if (roll < 0.17) this.drop(this.room, { kind: 'chest', x: (spot[0] + 0.5) * TILE, y: (spot[1] + 0.5) * TILE })
      else if (roll < 0.45 && p.hp < p.maxHp) this.drop(this.room, { kind: 'heart', x: (spot[0] + 0.5) * TILE, y: (spot[1] + 0.5) * TILE })
    }
  }

  private checkDoors() {
    if (!this.room.cleared) return
    const p = this.player
    let dir: Dir | null = null
    if (p.y < TILE * 0.9 && this.room.doors.n) dir = 'n'
    else if (p.y > WORLD_H - TILE * 0.9 && this.room.doors.s) dir = 's'
    else if (p.x < TILE * 0.9 && this.room.doors.w) dir = 'w'
    else if (p.x > WORLD_W - TILE * 0.9 && this.room.doors.e) dir = 'e'
    if (!dir) return
    this.state = 'transition'
    this.transition = 0
    this.pendingDoor = dir
  }

  // —— 物理 ——

  solidFor(tile: number, flying: boolean) {
    if (tile === DOOR) return !this.room.cleared
    if (tile === PIT) return !flying
    return tile === WALL || tile === ROCK
  }

  /** 移动圆形角色并与墙体碰撞，返回是否撞墙。 */
  moveActor(a: { x: number; y: number; r: number }, dx: number, dy: number, flying: boolean) {
    a.x += dx; a.y += dy
    let hit = false
    for (let iter = 0; iter < 2; iter++) {
      const minX = Math.floor((a.x - a.r) / TILE), maxX = Math.floor((a.x + a.r) / TILE)
      const minY = Math.floor((a.y - a.r) / TILE), maxY = Math.floor((a.y + a.r) / TILE)
      for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
        let tile = tileAt(this.room, tx, ty)
        // 开着的门只允许从门洞中间通过
        if (tile === DOOR && this.room.cleared) continue
        if (tile === FLOOR) continue
        if (!this.solidFor(tile, flying)) continue
        if (tile === DOOR) tile = WALL
        const nx = clamp(a.x, tx * TILE, (tx + 1) * TILE), ny = clamp(a.y, ty * TILE, (ty + 1) * TILE)
        let ox = a.x - nx, oy = a.y - ny
        const d = Math.hypot(ox, oy)
        if (d >= a.r) continue
        hit = true
        if (d === 0) {
          // 圆心在格子内：沿最短方向推出
          const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE
          ox = a.x - cx; oy = a.y - cy
          if (Math.abs(ox) > Math.abs(oy)) a.x = ox > 0 ? (tx + 1) * TILE + a.r : tx * TILE - a.r
          else a.y = oy > 0 ? (ty + 1) * TILE + a.r : ty * TILE - a.r
          continue
        }
        a.x += (ox / d) * (a.r - d); a.y += (oy / d) * (a.r - d)
      }
    }
    return hit
  }

  private clampToRoom(e: Enemy) {
    e.x = clamp(e.x, TILE + e.r, WORLD_W - TILE - e.r)
    e.y = clamp(e.y, TILE + e.r, WORLD_H - TILE - e.r)
  }

  /** 视线检测：walk=true 时只被墙和岩石挡住（子弹能飞过深坑）。 */
  lineOfSight(x0: number, y0: number, x1: number, y1: number, bullets: boolean) {
    const d = Math.hypot(x1 - x0, y1 - y0)
    const steps = Math.ceil(d / 10)
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      const tile = tileAt(this.room, Math.floor((x0 + (x1 - x0) * t) / TILE), Math.floor((y0 + (y1 - y0) * t) / TILE))
      if (tile === WALL || tile === ROCK || (!bullets && tile === PIT)) return false
    }
    return true
  }

  // —— 特效 ——

  private updateParticles(dt: number) {
    for (const p of this.particles) {
      p.life -= dt
      p.x += p.vx * dt; p.y += p.vy * dt
      if (p.kind === 'spark' || p.kind === 'dust') { p.vx *= 0.9; p.vy *= 0.9 }
      if (p.kind === 'text') p.vy *= 0.92
      if (p.kind === 'shell') { if (p.life > p.max - 0.28) p.vy += 700 * dt; else { p.vx *= 0.7; p.vy = 0 } p.angle! += dt * 20 * (p.life > p.max - 0.28 ? 1 : 0) }
    }
    this.particles = this.particles.filter(p => p.life > 0)
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600)
  }

  spark(x: number, y: number, angle: number, color: string, speed = 180) {
    const s = speed * (0.4 + Math.random() * 0.8)
    this.particles.push({ x, y, vx: Math.cos(angle) * s, vy: Math.sin(angle) * s, life: 0.35, max: 0.35, color, size: 2 + Math.random() * 2, kind: 'spark' })
  }

  burst(x: number, y: number, color: string, n: number) {
    for (let i = 0; i < n; i++) this.spark(x, y, Math.random() * Math.PI * 2, color, 160 + n * 3)
  }

  private dust(x: number, y: number) {
    this.particles.push({ x: x + (Math.random() - 0.5) * 8, y, vx: (Math.random() - 0.5) * 30, vy: -10 - Math.random() * 20, life: 0.5, max: 0.5, color: 'rgba(200,190,170,.5)', size: 4 + Math.random() * 3, kind: 'dust' })
  }

  private dustRing(x: number, y: number) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      this.particles.push({ x, y, vx: Math.cos(a) * 120, vy: Math.sin(a) * 60, life: 0.6, max: 0.6, color: 'rgba(200,190,170,.5)', size: 6, kind: 'dust' })
    }
  }

  ring(x: number, y: number, color: string, size: number) {
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.4, max: 0.4, color, size, kind: 'ring' })
  }

  float(x: number, y: number, text: string, color: string) {
    this.particles.push({ x, y, vx: (Math.random() - 0.5) * 20, vy: -60, life: 0.7, max: 0.7, color, size: 10, kind: 'text', text })
  }
}

// —— 工具 ——

export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b))
export function pick<T>(list: T[]): T { return list[Math.floor(Math.random() * list.length)] }
function shuffle<T>(list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]] }
  return list
}
