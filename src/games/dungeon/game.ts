/** 深渊骑士核心逻辑：英雄、怪物、子弹、机关、房间切换与计分。渲染与输入在其他模块。 */
import {
  BOSSES, BOSS_ORDER, ENEMIES, HEROES, ITEMS, ROOM_H, ROOM_W, STACKABLE, TILE, WEAPONS, WEAPON_POOL, WORLD_H, WORLD_W,
  enemyPool, hpScale,
} from './data'
import type { BossKind, EnemyKind, HeroId, ItemDef, WeaponDef } from './data'
import { DIRS, DOOR, DOOR_TILE, FLOOR, OPPOSITE, PIT, ROCK, WALL, generateFloor, revealDoor, spawnTiles, tileAt } from './map'
import type { Dir, Floor, Room } from './map'

export const SOUNDS = [
  'shoot', 'pistol', 'smg', 'bouncer', 'frost', 'shotgun', 'laser', 'rocket', 'swing', 'axe', 'bow', 'crossbow', 'flame', 'thunder', 'boomerang', 'gatling', 'sniper',
  'hit', 'crit', 'kill', 'hurt', 'explode', 'pickup', 'weapon', 'item', 'coin', 'key', 'buy', 'deny', 'chest', 'door', 'dash', 'boss', 'bossDown',
  'stairs', 'empty', 'enemyShoot', 'enemyFire', 'heal', 'block', 'skillKnight', 'skillRanger', 'skillMage', 'crate', 'pot',
  'spike', 'vent', 'bless', 'curse', 'secret', 'revive', 'spore', 'roots', 'beam', 'emerge', 'ghost', 'quake',
] as const
export type Sound = typeof SOUNDS[number]

export interface Input {
  moveX: number; moveY: number
  /** 瞄准方向；null 表示自动瞄准最近的敌人 */
  aim: number | null
  fire: boolean
  dash: boolean
  skill: boolean
  swap: boolean
  interact: boolean
}

export interface Stats {
  damage: number; speed: number; rate: number; multishot: number; pierce: number; bounce: number; crit: number
  vamp: number; orbit: number; dash: number; size: number; regen: number
  burn: number; venom: number; ice: number; thunder: number; magnet: number; luck: number; greed: number
  revive: number; berserk: boolean; thorns: boolean; skill: number; homing: boolean; orb: number; bulletSpeed: number
}

export interface Player {
  hero: HeroId
  x: number; y: number; vx: number; vy: number; r: number
  hp: number; maxHp: number
  armor: number; maxArmor: number; calm: number
  energy: number; maxEnergy: number
  coins: number; keys: number
  weapons: string[]; current: number
  cooldown: number
  dashTime: number; dashCd: number; dashX: number; dashY: number
  /** 技能：冷却、持续时间与方向；游侠技能后的加速时间 */
  skillCd: number; skillTime: number; skillX: number; skillY: number; haste: number
  /** 加特林预热 0–1 */
  spin: number
  invuln: number
  aim: number
  walk: number
  recoil: number
  items: ItemDef[]
  stats: Stats
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
  /** 状态效果剩余时间 */
  burn: number; poison: number; freeze: number
  /** 木乃伊已复活过；沙虫在地下；幽灵隐身 */
  revived: boolean
  trapCd: number
}

export interface Bullet {
  x: number; y: number; vx: number; vy: number; r: number
  damage: number
  enemy: boolean
  life: number
  max: number
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
  shape?: 'arrow' | 'flame' | 'boomerang'
  burn?: number
  knock: number
  returning?: boolean
}

export interface Swing { x: number; y: number; angle: number; range: number; arc: number; life: number; max: number; damage: number; hit: Set<number>; color: string; deflect: boolean; knock: number }

export type PickupKind = 'heart' | 'energy' | 'coin' | 'key' | 'weapon' | 'item' | 'stairs' | 'chest' | 'locked' | 'fountain' | 'merchant' | 'ware' | 'altar'
export interface Pickup {
  kind: PickupKind; x: number; y: number; vx: number; vy: number; t: number
  weapon?: string; item?: ItemDef; used?: boolean
  /** 商品：种类与价格 */
  ware?: 'heart' | 'key' | 'weapon' | 'item'; price?: number
  altar?: 'bless' | 'curse'
}

export interface Prop { kind: 'crate' | 'pot' | 'barrel'; x: number; y: number; r: number; hp: number; broken: boolean; t: number; flip: boolean }
export interface Trap { kind: 'spike' | 'vent'; x: number; y: number; offset: number }
export interface Hazard {
  kind: 'spore' | 'fire' | 'root' | 'beam'
  x: number; y: number; r: number
  /** 预警剩余时间；为 0 后才造成伤害 */
  warn: number; life: number; max: number
  angle?: number; len?: number
}

export interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; kind: 'spark' | 'dust' | 'ring' | 'text' | 'ghost' | 'flash' | 'explosion' | 'impact' | 'shell' | 'bolt' | 'leaf' | 'frost'; text?: string; angle?: number; owner?: number; sum?: number; pts?: number[] }

export interface Corpse { kind: EnemyKind | BossKind; x: number; y: number; t: number; flip: boolean; scale: number }

export interface Banner { title: string; text: string; life: number; color: string }

const STEP = 1 / 60
/** 武器与敌方子弹颜色对应的 fx 帧 */
const PLAYER_FX: Record<string, number> = { pistol: 0, smg: 1, laser: 2, rocket: 3, bouncer: 4, frost: 5, gatling: 1, sniper: 2, flamer: 9 }
const ENEMY_FX: Record<string, number> = { '#ff6b6b': 8, '#ffa94d': 9, '#ffc078': 9, '#ff9f43': 9, '#b388ff': 10, '#ff8fab': 10, '#7bed9f': 11, '#c8c3b9': 12, '#d9b26f': 12, '#ffd166': 0 }
const WEAPON_SOUND: Record<string, Sound> = {
  pistol: 'pistol', smg: 'smg', shotgun: 'shotgun', laser: 'laser', rocket: 'rocket', bouncer: 'bouncer', frost: 'frost',
  bow: 'bow', crossbow: 'crossbow', flamer: 'flame', boomerang: 'boomerang', gatling: 'gatling', sniper: 'sniper',
}
const SOLID_WALK = new Set([WALL, ROCK, PIT])
const SPIKE_PERIOD = 2.6, VENT_PERIOD = 3.4
export const COIN_COLOR = '#ffd166'

let nextId = 1

/** 地刺状态：0 收起、1 半伸出、2 完全伸出（伤人） */
export function spikeState(time: number, offset: number) {
  const t = (time + offset) % SPIKE_PERIOD
  return t < 1.5 ? 0 : t < 1.65 ? 1 : t < 2.45 ? 2 : 1
}
/** 火焰喷口：0 关闭、1 预警、2 喷火（伤人） */
export function ventState(time: number, offset: number) {
  const t = (time + offset) % VENT_PERIOD
  return t < 2.2 ? 0 : t < 2.65 ? 1 : 2
}

export class Game {
  floor!: Floor
  room!: Room
  level = 1
  player: Player
  enemies: Enemy[] = []
  bullets: Bullet[] = []
  swings: Swing[] = []
  pickups = new Map<Room, Pickup[]>()
  props = new Map<Room, Prop[]>()
  traps = new Map<Room, Trap[]>()
  hazards: Hazard[] = []
  particles: Particle[] = []
  corpses: Corpse[] = []
  /** 正在行动的怪物：它发射子弹时记为一次攻击动作 */
  private acting?: Enemy
  /** 骑士冲锋已撞到的敌人 */
  private skillHits = new Set<number>()
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
  /** 拾取了魔法地图：显示全部房间 */
  mapped = false
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

  constructor(heroId: HeroId = 'knight') {
    const hero = HEROES[heroId]
    this.player = {
      hero: heroId,
      x: WORLD_W / 2, y: WORLD_H / 2, vx: 0, vy: 0, r: 10,
      hp: hero.hp, maxHp: hero.hp, armor: hero.armor, maxArmor: hero.armor, calm: 0,
      energy: hero.energy, maxEnergy: hero.energy, coins: 0, keys: 0,
      weapons: [hero.weapon], current: 0, cooldown: 0,
      dashTime: 0, dashCd: 0, dashX: 1, dashY: 0,
      skillCd: 0, skillTime: 0, skillX: 1, skillY: 0, haste: 0, spin: 0,
      invuln: 0, aim: 0, walk: 0, recoil: 0,
      items: [],
      stats: {
        damage: 1, speed: hero.speed, rate: 1, multishot: 0, pierce: 0, bounce: 0, crit: hero.crit, vamp: 0, orbit: 0, dash: 1, size: 1, regen: hero.regen,
        burn: 0, venom: 0, ice: 0, thunder: 0, magnet: 1, luck: 0, greed: 1, revive: 0, berserk: false, thorns: false, skill: 1, homing: false, orb: 1, bulletSpeed: 1,
      },
    }
    this.enterFloor(1)
  }

  get weapon(): WeaponDef { return WEAPONS[this.player.weapons[this.player.current]] }
  get boss() { return this.enemies.find(e => e.boss) }
  get roomPickups() { return this.pickups.get(this.room) ?? [] }
  get roomProps() { return this.props.get(this.room) ?? [] }
  get roomTraps() { return this.traps.get(this.room) ?? [] }
  get skillReady() { return this.player.skillCd <= 0 }

  // —— 楼层与房间 ——

  enterFloor(level: number) {
    this.level = level
    this.floor = generateFloor(level)
    this.pickups = new Map(); this.props = new Map(); this.traps = new Map()
    this.room = this.floor.start
    this.player.x = WORLD_W / 2; this.player.y = WORLD_H / 2 + TILE
    this.player.energy = this.player.maxEnergy
    this.enemies = []; this.bullets = []; this.swings = []; this.hazards = []; this.corpses = []
    if (level === 1) {
      const starter = pick(['smg', 'shotgun', 'bouncer', 'crossbow', 'boomerang'].filter(w => w !== this.player.weapons[0]))
      this.drop(this.room, { kind: 'weapon', x: WORLD_W / 2 + 70, y: WORLD_H / 2 - 20, weapon: starter })
    }
    this.banner = { title: `第 ${level} 层`, text: level === 1 ? '找到并击败本层首领' : '更深处，怪物更凶猛了', life: 2.6, color: '#ffd166' }
    this.computeFlow()
  }

  private drop(room: Room, p: Omit<Pickup, 'vx' | 'vy' | 't'> & Partial<Pick<Pickup, 'vx' | 'vy'>>) {
    const list = this.pickups.get(room) ?? []
    list.push({ vx: 0, vy: 0, t: 0, ...p })
    this.pickups.set(room, list)
  }

  private dropCoins(x: number, y: number, n: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 110
      this.drop(this.room, { kind: 'coin', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s })
    }
  }

  private enterRoom(room: Room, from: Dir) {
    this.room = room
    const [tx, ty] = DOOR_TILE[OPPOSITE[from]]
    const [dx, dy] = DIRS[from]
    this.player.x = (tx + 0.5) * TILE + dx * TILE * 1.3
    this.player.y = (ty + 0.5) * TILE + dy * TILE * 1.3
    this.bullets = []; this.swings = []; this.hazards = []
    this.enemies = []; this.corpses = []
    if (!room.visited) {
      room.visited = true
      const cx = WORLD_W / 2, cy = WORLD_H / 2
      switch (room.type) {
        case 'normal':
          this.furnish(room)
          this.spawnWave(room)
          break
        case 'boss': this.spawnBoss(); break
        case 'treasure': this.drop(room, { kind: 'item', x: cx, y: cy, item: this.randomItem() }); break
        case 'heal': this.drop(room, { kind: 'fountain', x: cx, y: cy }); break
        case 'shop': {
          this.drop(room, { kind: 'merchant', x: cx, y: cy - 34 })
          const wares: Pickup['ware'][] = ['heart', 'key', 'weapon', 'item']
          wares.forEach((ware, i) => {
            const price = ware === 'heart' ? 12 : ware === 'key' ? 10 : ware === 'weapon' ? 26 + this.level * 3 : 38 + this.level * 5
            this.drop(room, {
              kind: 'ware', ware, price, x: cx + (i - 1.5) * 64, y: cy + 38,
              item: ware === 'item' ? this.randomItem() : undefined,
              weapon: ware === 'weapon' ? pick(WEAPON_POOL.filter(w => !this.player.weapons.includes(w))) : undefined,
            })
          })
          this.banner = { title: '地精商人', text: '用金币买点东西吧', life: 1.8, color: COIN_COLOR }
          break
        }
        case 'altar':
          this.drop(room, { kind: 'altar', altar: 'bless', x: cx - 70, y: cy })
          this.drop(room, { kind: 'altar', altar: 'curse', x: cx + 70, y: cy })
          this.banner = { title: '祭坛', text: '金色祭坛赐福，紫色祭坛以生命换宝物', life: 2.2, color: '#e8d3a2' }
          break
        case 'secret':
          this.drop(room, { kind: 'item', x: cx, y: cy - 10, item: this.randomItem() })
          this.dropCoins(cx, cy + 30, 10 + Math.floor(Math.random() * 6))
          if (Math.random() < 0.5) this.drop(room, { kind: 'heart', x: cx + 60, y: cy + 20 })
          this.banner = { title: '隐藏房间', text: '发现了一处密室', life: 2, color: '#e8d3a2' }
          this.onSound('secret')
          break
      }
    }
    this.computeFlow()
  }

  /** 普通房间的木箱、陶罐、爆炸桶与机关。 */
  private furnish(room: Room) {
    const free = shuffle(spawnTiles(room))
    const props: Prop[] = []
    const n = 1 + Math.floor(Math.random() * 4)
    for (let i = 0; i < n && free.length; i++) {
      const [x, y] = free.pop()!
      const r = Math.random()
      const kind: Prop['kind'] = r < 0.45 ? 'crate' : r < 0.78 || this.level < 2 ? 'pot' : 'barrel'
      props.push({ kind, x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, r: kind === 'pot' ? 9 : 11, hp: kind === 'crate' ? 3 : kind === 'pot' ? 1 : 4, broken: false, t: 0, flip: Math.random() < 0.5 })
    }
    this.props.set(room, props)
    if (this.level < 2 || Math.random() > 0.45) return
    const traps: Trap[] = []
    if (Math.random() < 0.6) {
      // 一排地刺，相位错开形成波浪
      const row = 3 + Math.floor(Math.random() * (ROOM_H - 6)), start = 3 + Math.floor(Math.random() * 6), len = 3 + Math.floor(Math.random() * 4)
      for (let x = start; x < start + len; x++) {
        if (tileAt(room, x, row) !== FLOOR || props.some(p => Math.abs(p.x - (x + 0.5) * TILE) < TILE && Math.abs(p.y - (row + 0.5) * TILE) < TILE)) continue
        traps.push({ kind: 'spike', x: (x + 0.5) * TILE, y: (row + 0.5) * TILE, offset: (x - start) * 0.18 })
      }
    } else {
      for (let i = 0; i < 2 + Math.floor(Math.random() * 2) && free.length; i++) {
        const [x, y] = free.pop()!
        traps.push({ kind: 'vent', x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, offset: i * 1.1 })
      }
    }
    this.traps.set(room, traps)
  }

  private randomItem(): ItemDef {
    const owned = new Set(this.player.items.map(i => i.id))
    const pool = ITEMS.filter(i => !owned.has(i.id) || STACKABLE.has(i.id))
    return pick(pool.length ? pool : ITEMS)
  }

  private spawnWave(room: Room) {
    const blocked = (x: number, y: number) => [...this.roomProps, ...this.roomTraps].some(p => Math.floor(p.x / TILE) === x && Math.floor(p.y / TILE) === y)
    const tiles = shuffle(spawnTiles(room).filter(([x, y]) => !blocked(x, y)))
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
      state: kind === 'worm' ? 'under' : 'idle', timer: Math.random() * 1.2, cd: 1 + Math.random() * 1.5, flash: 0, slow: 0, spawn: delay,
      elite, angle: Math.random() * Math.PI * 2, tx: x, ty: y, phase: Math.random() * 10, z: 0, flying: !!def.flying, anim: Math.random() * 10, pose: 9, kx: 0, ky: 0, squash: 1,
      burn: 0, poison: 0, freeze: 0, revived: false, trapCd: 0,
    }
    if (kind === 'shield') e.angle = Math.atan2(this.player.y - y, this.player.x - x)
    if (kind === 'worm') e.timer = 1.5 + Math.random()
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
      elite: false, angle: 0, tx: 0, ty: 0, phase: 0, z: 0, flying: !!def.flying, anim: 0, pose: 9, kx: 0, ky: 0, squash: 1,
      burn: 0, poison: 0, freeze: 0, revived: false, trapCd: 0,
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
      input.swap = false; input.interact = false; input.dash = false; input.skill = false
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
    for (const p of this.roomProps) if (p.broken) p.t += dt
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
    this.updateHazards(dt)
    this.updateTraps(dt)
    this.updatePickups(dt, input)
    this.checkClear()
    this.checkDoors()
  }

  // —— 玩家 ——

  private updatePlayer(dt: number, input: Input) {
    const p = this.player, s = p.stats
    p.invuln = Math.max(0, p.invuln - dt)
    p.dashCd = Math.max(0, p.dashCd - dt)
    p.skillCd = Math.max(0, p.skillCd - dt)
    p.haste = Math.max(0, p.haste - dt)
    p.cooldown = Math.max(0, p.cooldown - dt)
    p.recoil = Math.max(0, p.recoil - dt * 10)
    p.calm += dt
    if (p.maxArmor && p.armor < p.maxArmor && p.calm > 4) { p.armor++; p.calm = 2.5 }
    if (s.regen) p.energy = Math.min(p.maxEnergy, p.energy + s.regen * dt)
    const w = this.weapon
    p.spin = w.spin && input.fire ? Math.min(1, p.spin + dt * 1.6) : Math.max(0, p.spin - dt * 2)

    let mx = input.moveX, my = input.moveY
    const len = Math.hypot(mx, my)
    if (len > 1) { mx /= len; my /= len }
    const dirOf = (): [number, number] => len > 0.1 ? [mx / Math.max(len, 1e-6), my / Math.max(len, 1e-6)] : [Math.cos(p.aim), Math.sin(p.aim)]

    if (input.skill && p.skillCd <= 0 && p.skillTime <= 0 && p.dashTime <= 0) this.useSkill(dirOf())
    if (input.dash && p.dashCd <= 0 && p.dashTime <= 0 && p.skillTime <= 0) {
      const [dx, dy] = dirOf()
      p.dashX = dx; p.dashY = dy
      p.dashTime = 0.18
      p.dashCd = 0.85 * s.dash
      this.onSound('dash')
    }
    const speed = 130 * s.speed * (p.haste > 0 ? 1.3 : 1) * (1 - p.spin * 0.35)
    if (p.skillTime > 0) {
      this.updateSkill(dt, speed)
    } else if (p.dashTime > 0) {
      p.dashTime -= dt
      p.vx = p.dashX * speed * 3.4; p.vy = p.dashY * speed * 3.4
      if (Math.random() < 0.7) this.particles.push({ x: p.x, y: p.y, vx: 0, vy: 0, life: 0.22, max: 0.22, color: p.hero === 'ranger' ? '#9cff6b' : p.hero === 'mage' ? '#9be7ff' : '#8ab4ff', size: p.r, kind: 'ghost', angle: p.aim })
      if (s.dash < 1) for (const e of this.enemies) if (this.targetable(e) && dist(e, p) < e.r + p.r + 4) this.damageEnemy(e, 4 * s.damage, p.dashX, p.dashY, false, 60)
    } else {
      p.vx += (mx * speed - p.vx) * Math.min(1, dt * 14)
      p.vy += (my * speed - p.vy) * Math.min(1, dt * 14)
    }
    if (p.haste > 0 && Math.random() < 0.25) this.particles.push({ x: p.x + (Math.random() - 0.5) * 12, y: p.y + 6, vx: -p.vx * 0.2, vy: -20, life: 0.5, max: 0.5, color: '#9cff6b', size: 3, kind: 'leaf', angle: Math.random() * 6 })
    if (len > 0.1) p.walk += dt * 10
    this.alignToDoor(mx, my, dt)
    this.moveActor(p, p.vx * dt, p.vy * dt, false)
    this.pushFromProps(p)

    // 瞄准：优先手动方向，否则锁定最近可见的敌人
    const target = this.nearestEnemy()
    if (input.aim !== null) p.aim = input.aim
    else if (target) p.aim = Math.atan2(target.y - p.y, target.x - p.x)
    else if (len > 0.1) p.aim = Math.atan2(my, mx)

    if (input.swap && p.weapons.length > 1) { p.current = (p.current + 1) % p.weapons.length; p.cooldown = Math.max(p.cooldown, 0.15); p.spin = 0; this.onSound('weapon') }
    const busy = p.dashTime > 0 || (p.skillTime > 0 && p.hero !== 'mage')
    if (input.fire && p.cooldown <= 0 && !busy) this.fire()
  }

  /** 释放英雄技能。 */
  private useSkill([dx, dy]: [number, number]) {
    const p = this.player
    p.skillCd = HEROES[p.hero].cooldown * p.stats.skill
    p.skillX = dx; p.skillY = dy
    this.skillHits.clear()
    if (p.hero === 'knight') {
      p.skillTime = 0.42
      this.shake = Math.max(this.shake, 2)
      this.onSound('skillKnight')
    } else if (p.hero === 'ranger') {
      p.skillTime = 0.24
      p.haste = 4
      this.ring(p.x, p.y, '#9cff6b', 40)
      this.onSound('skillRanger')
    } else {
      p.skillTime = 0.45
      this.frostNova()
      this.onSound('skillMage')
    }
  }

  private updateSkill(dt: number, speed: number) {
    const p = this.player
    p.skillTime -= dt
    if (p.hero === 'mage') {
      p.vx *= 0.8; p.vy *= 0.8
      return
    }
    const boost = p.hero === 'knight' ? 3.1 : 4.2
    p.vx = p.skillX * speed * boost; p.vy = p.skillY * speed * boost
    if (p.hero === 'ranger') {
      if (Math.random() < 0.9) this.particles.push({ x: p.x, y: p.y, vx: 0, vy: 0, life: 0.3, max: 0.3, color: '#9cff6b', size: p.r * 1.1, kind: 'ghost', angle: p.aim })
      return
    }
    // 盾墙冲锋：撞开敌人，挡下前方的子弹
    if (Math.random() < 0.6) this.dust(p.x, p.y + 8)
    const fx = p.x + p.skillX * 10, fy = p.y + p.skillY * 10
    for (const e of this.enemies) {
      if (!this.targetable(e) || this.skillHits.has(e.id) || dist(e, { x: fx, y: fy }) > e.r + p.r + 8) continue
      this.skillHits.add(e.id)
      this.damageEnemy(e, 10 * this.damageMul(), p.skillX, p.skillY, true, e.boss ? 0 : 300)
      this.hitStop = Math.max(this.hitStop, 0.06)
    }
    for (const b of this.bullets) {
      if (b.enemy && Math.hypot(b.x - fx, b.y - fy) < b.r + p.r + 12) { b.life = 0; this.spark(b.x, b.y, Math.atan2(p.skillY, p.skillX), '#ffd98a', 140) }
    }
    if (p.skillTime <= 0) { this.ring(p.x + p.skillX * 16, p.y + p.skillY * 16, '#ffd98a', 50); this.shake = Math.max(this.shake, 3) }
  }

  private frostNova() {
    const p = this.player
    this.ring(p.x, p.y, '#9be7ff', 150)
    this.ring(p.x, p.y, '#e6f9ff', 100)
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2
      this.particles.push({ x: p.x, y: p.y, vx: Math.cos(a) * 260, vy: Math.sin(a) * 260, life: 0.5, max: 0.5, color: '#bff0ff', size: 4, kind: 'frost', angle: a })
    }
    this.shake = Math.max(this.shake, 3)
    for (const e of [...this.enemies]) {
      const d = dist(e, p)
      if (d > 140 + e.r || !this.targetable(e)) continue
      e.freeze = e.boss ? 0.9 : 2.4
      this.damageEnemy(e, 8 * this.damageMul(), (e.x - p.x) / (d || 1), (e.y - p.y) / (d || 1), false, 120)
    }
    for (const b of this.bullets) if (b.enemy && dist(b, p) < 170) { b.life = 0; this.spark(b.x, b.y, Math.random() * 6, '#bff0ff', 60) }
  }

  /** 朝门走时把玩家轻轻推向门洞中线，避免卡在门框。 */
  private alignToDoor(mx: number, my: number, dt: number) {
    if (!this.room.cleared) return
    const p = this.player, k = Math.min(1, dt * 12)
    for (const dir of this.openDoors()) {
      const [tx, ty] = DOOR_TILE[dir]
      const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE
      if (dir === 'e' && mx > 0.3 && p.x > WORLD_W - TILE * 2.4 && Math.abs(p.y - cy) < 26) p.y += (cy - p.y) * k
      if (dir === 'w' && mx < -0.3 && p.x < TILE * 2.4 && Math.abs(p.y - cy) < 26) p.y += (cy - p.y) * k
      if (dir === 's' && my > 0.3 && p.y > WORLD_H - TILE * 2.4 && Math.abs(p.x - cx) < 26) p.x += (cx - p.x) * k
      if (dir === 'n' && my < -0.3 && p.y < TILE * 2.4 && Math.abs(p.x - cx) < 26) p.x += (cx - p.x) * k
    }
  }

  openDoors() { return (Object.keys(this.room.doors) as Dir[]).filter(d => this.room.hidden[d] === undefined) }

  /** 能被子弹打中、被自动瞄准的敌人 */
  targetable(e: Enemy) {
    return e.spawn <= 0 && e.z <= 8 && e.hp > 0 && !(e.kind === 'worm' && e.state === 'under') && !(e.kind === 'ghost' && e.state === 'fade')
  }

  nearestEnemy() {
    let best: Enemy | undefined, bestD = Infinity
    for (const e of this.enemies) {
      if (!this.targetable(e)) continue
      const d = dist(e, this.player)
      if (d < bestD && this.lineOfSight(this.player.x, this.player.y, e.x, e.y, true)) { best = e; bestD = d }
    }
    return best
  }

  private damageMul() {
    const p = this.player, s = p.stats
    return s.damage * (s.berserk && p.hp <= p.maxHp / 2 ? 1.4 : 1)
  }

  private fire() {
    const p = this.player, w = this.weapon, s = p.stats
    if (p.energy < w.cost) {
      if (this.lowEnergyHint <= 0) { this.float(p.x, p.y - 20, '能量不足', '#4dd2ff'); this.lowEnergyHint = 1.2; this.onSound('empty') }
      p.cooldown = 0.25
      return
    }
    // 喷火器与加特林每两发消耗一点能量
    p.energy -= w.id === 'flamer' || w.id === 'gatling' ? (Math.random() < 0.5 ? w.cost : 0) : w.cost
    const rate = s.rate * (p.haste > 0 ? 1.6 : 1)
    p.cooldown = w.cooldown / rate / (w.spin ? 0.25 + p.spin * 0.75 : 1)
    p.recoil = 1
    this.kickX -= Math.cos(p.aim) * w.shake * 1.1; this.kickY -= Math.sin(p.aim) * w.shake * 1.1
    if (w.id === 'shotgun' || w.id === 'rocket' || w.id === 'sniper') { p.vx -= Math.cos(p.aim) * 90; p.vy -= Math.sin(p.aim) * 90 }
    if (['pistol', 'smg', 'shotgun', 'gatling', 'sniper'].includes(w.id)) {
      const side = p.aim + (Math.cos(p.aim) >= 0 ? -Math.PI / 2 : Math.PI / 2)
      this.particles.push({ x: p.x + Math.cos(p.aim) * 8, y: p.y, vx: Math.cos(side) * 70 + (Math.random() - 0.5) * 30, vy: -90 - Math.random() * 40, life: 0.55, max: 0.55, color: '#e0b04a', size: 2.2, kind: 'shell', angle: Math.random() * 6 })
    }
    this.shake = Math.max(this.shake, w.shake)
    const dmg = w.damage * this.damageMul()
    if (w.melee) {
      const crit = Math.random() < s.crit
      this.swings.push({ x: p.x, y: p.y, angle: p.aim, range: w.size * (0.9 + s.size * 0.1), arc: w.id === 'axe' ? 1.45 : 1.2, life: w.life, max: w.life, damage: dmg * (crit ? 2 : 1), hit: new Set(), color: w.color, deflect: !!w.deflect, knock: w.knockback })
      this.onSound(w.id === 'axe' ? 'axe' : 'swing')
      return
    }
    if (w.chain) { this.castLightning(dmg); return }
    const count = w.count + s.multishot
    for (let i = 0; i < count; i++) {
      const offset = count > 1 ? (i / (count - 1) - 0.5) * Math.max(w.spread, 0.12 * (count - 1)) : 0
      const angle = p.aim + offset + (Math.random() - 0.5) * w.spread * (w.count > 1 ? 0.5 : 1)
      const speed = w.speed * (w.count > 1 || w.shape === 'flame' ? 0.85 + Math.random() * 0.3 : 1)
      const crit = Math.random() < s.crit
      this.bullets.push({
        x: p.x + Math.cos(p.aim) * 16, y: p.y + Math.sin(p.aim) * 16,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        r: w.size * s.size, damage: dmg * (crit ? 2 : 1), enemy: false, life: w.life, max: w.life,
        pierce: (w.pierce ?? 0) + s.pierce, bounce: (w.bounce ?? 0) + s.bounce, explode: w.explode ?? 0,
        color: crit ? '#fff1a8' : w.color, slow: !!w.slow, crit, hit: new Set(),
        trail: w.id === 'laser' ? 26 : w.id === 'sniper' ? 44 : w.id === 'rocket' ? 14 : w.shape ? 0 : 8,
        sprite: w.shape ? undefined : PLAYER_FX[w.id] ?? 0, shape: w.shape, burn: w.burn, knock: w.knockback,
      })
    }
    if (w.shape !== 'flame' && w.shape !== 'boomerang') this.particles.push({ x: p.x + Math.cos(p.aim) * 20, y: p.y + Math.sin(p.aim) * 20, vx: 0, vy: 0, life: 0.06, max: 0.06, color: w.color, size: w.id === 'sniper' ? 16 : 9, kind: 'flash', angle: p.aim })
    this.onSound(WEAPON_SOUND[w.id] ?? 'shoot')
  }

  /** 雷霆法杖：击中准星方向最近的敌人并连锁弹射。 */
  private castLightning(damage: number) {
    const p = this.player
    const sx = p.x + Math.cos(p.aim) * 18, sy = p.y + Math.sin(p.aim) * 18
    let target: Enemy | undefined, best = Infinity
    for (const e of this.enemies) {
      if (!this.targetable(e)) continue
      const d = dist(e, p), off = Math.abs(angleDiff(Math.atan2(e.y - p.y, e.x - p.x), p.aim))
      if (d < 260 && off < 0.7 && d * (1 + off) < best && this.lineOfSight(p.x, p.y, e.x, e.y, true)) { best = d * (1 + off); target = e }
    }
    this.onSound('thunder')
    if (!target) {
      const pts = [sx, sy]
      let x = sx, y = sy
      for (let i = 0; i < 5; i++) { x += Math.cos(p.aim) * 26 + (Math.random() - 0.5) * 16; y += Math.sin(p.aim) * 26 + (Math.random() - 0.5) * 16; pts.push(x, y) }
      this.particles.push({ x: sx, y: sy, vx: 0, vy: 0, life: 0.14, max: 0.14, color: '#ffe066', size: 2, kind: 'bolt', pts })
      return
    }
    this.chain(sx, sy, target, damage, 3)
  }

  private chain(x: number, y: number, first: Enemy, damage: number, jumps: number) {
    const hit = new Set<number>()
    const pts = [x, y]
    let cur: Enemy | undefined = first, amount = damage
    for (let i = 0; i <= jumps && cur; i++) {
      hit.add(cur.id)
      pts.push(cur.x, cur.y - 6)
      const from: Enemy = cur
      this.damageEnemy(from, amount, (from.x - x) / (dist(from, { x, y }) || 1), (from.y - y) / (dist(from, { x, y }) || 1), false, 60, false)
      amount *= 0.8
      cur = this.enemies.filter(e => this.targetable(e) && !hit.has(e.id) && dist(e, from) < 130).sort((a, b) => dist(a, from) - dist(b, from))[0]
    }
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.18, max: 0.18, color: '#ffe066', size: 2, kind: 'bolt', pts })
  }

  hurtPlayer(amount = 1, from?: { x: number; y: number }) {
    const p = this.player
    if (p.invuln > 0 || p.dashTime > 0 || this.state !== 'play') return
    if (p.skillTime > 0 && p.hero !== 'mage') return
    p.calm = 0
    if (p.armor > 0) { p.armor--; amount-- }
    if (amount > 0) p.hp -= amount
    p.invuln = 1
    this.shake = Math.max(this.shake, 5)
    this.hurtFlash = 1
    this.hitStop = 0.05
    this.burst(p.x, p.y, '#ff5d5d', 10)
    this.onSound('hurt')
    if (from) { const d = dist(from, p) || 1; this.kickX += (p.x - from.x) / d * 3; this.kickY += (p.y - from.y) / d * 3 }
    if (p.stats.thorns) {
      this.ring(p.x, p.y, '#c0c6d4', 90)
      for (const e of [...this.enemies]) {
        const d = dist(e, p)
        if (d < 90 + e.r && this.targetable(e)) this.damageEnemy(e, 12 * this.damageMul(), (e.x - p.x) / (d || 1), (e.y - p.y) / (d || 1), false, 200)
      }
    }
    if (p.hp <= 0) {
      if (p.stats.revive > 0) {
        p.stats.revive--
        p.hp = Math.ceil(p.maxHp / 2)
        p.invuln = 2.2
        this.ring(p.x, p.y, '#fff4d6', 120)
        this.burst(p.x, p.y, '#fff4d6', 30)
        this.banner = { title: '复活', text: '复活十字碎裂了', life: 1.8, color: '#fff4d6' }
        this.onSound('revive')
        return
      }
      p.hp = 0
      this.state = 'dead'
      this.burst(p.x, p.y, '#8ab4ff', 30)
      this.onOver()
    }
  }

  // —— 怪物 ——

  private updateEnemy(e: Enemy, dt: number) {
    if (e.hp <= 0 && e.state !== 'down') return
    this.acting = e
    e.flash = Math.max(0, e.flash - dt * 12)
    e.pose += dt
    e.squash += (1 - e.squash) * Math.min(1, dt * 14)
    e.trapCd = Math.max(0, e.trapCd - dt)
    if (e.kx || e.ky) {
      this.moveActor(e, e.kx * dt, e.ky * dt, e.flying)
      e.kx *= 0.82; e.ky *= 0.82
      if (Math.abs(e.kx) + Math.abs(e.ky) < 4) e.kx = e.ky = 0
    }
    if (e.spawn > 0) { e.anim += dt; e.spawn -= dt; return }
    // 状态效果：燃烧与中毒持续掉血，冰冻时完全停住
    if (e.burn > 0) {
      e.burn -= dt
      this.dot(e, (2.2 + this.level * 0.5) * dt, '#ff9f43')
      if (Math.random() < 0.3) this.particles.push({ x: e.x + (Math.random() - 0.5) * e.r, y: e.y - e.r * 0.5, vx: 0, vy: -40, life: 0.4, max: 0.4, color: '#ff9f43', size: 3, kind: 'spark' })
      if (e.hp <= 0) return
    }
    if (e.poison > 0) {
      e.poison -= dt
      this.dot(e, (1.6 + this.level * 0.35) * dt, '#7bed6f')
      if (Math.random() < 0.15) this.particles.push({ x: e.x + (Math.random() - 0.5) * e.r, y: e.y - e.r * 0.3, vx: 0, vy: -24, life: 0.6, max: 0.6, color: '#7bed6f', size: 2.5, kind: 'dust' })
      if (e.hp <= 0) return
    }
    if (e.freeze > 0) { e.freeze -= dt; return }
    e.anim += dt
    e.slow = Math.max(0, e.slow - dt)
    const slow = (e.slow > 0 ? 0.5 : 1) * (e.poison > 0 ? 0.7 : 1)
    const p = this.player
    const dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy) || 1
    const sees = this.lineOfSight(e.x, e.y, p.x, p.y, true)
    e.cd -= dt * slow
    e.timer -= dt * slow

    if (e.boss) this.updateBoss(e, dt, slow, d, dx, dy)
    else this.updateMinion(e, dt, slow, d, dx, dy, sees)
    if (e.hp <= 0 && e.state !== 'down') return

    const harmless = e.boss || e.state === 'vanish' || e.state === 'down' || e.state === 'rise' || e.state === 'fade' || e.state === 'under' || e.z >= 8
    if (!harmless && dist(e, p) < e.r + p.r - 2) {
      this.hurtPlayer(ENEMIES[e.kind as EnemyKind].touch, e)
      if (e.kind === 'bat') { e.state = 'retreat'; e.timer = 0.6 }
    }
  }

  private updateMinion(e: Enemy, dt: number, slow: number, d: number, dx: number, dy: number, sees: boolean) {
    const p = this.player
    const walk = (k = 1) => { const [cx, cy] = this.chaseDir(e); this.moveActor(e, cx * e.speed * k * dt * slow, cy * e.speed * k * dt * slow, false); this.pushFromProps(e) }
    switch (e.kind) {
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
        this.pushFromProps(e)
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
          const prop = this.roomProps.find(o => !o.broken && dist(o, e) < o.r + e.r)
          if (prop) this.breakProp(prop)
          if (Math.random() < 0.5) this.dust(e.x, e.y + e.r * 0.6)
          if (hit || e.timer <= 0) {
            e.state = 'stun'; e.timer = hit ? 0.9 : 0.4
            if (hit) { this.shake = Math.max(this.shake, 2.5); this.burst(e.x, e.y, '#b9a48c', 6) }
          }
        } else if (e.state === 'stun') {
          if (e.timer <= 0) { e.state = 'idle'; e.cd = 1.2 + Math.random() }
        } else {
          walk()
          if (e.cd <= 0 && sees && d < 240) { e.state = 'windup'; e.timer = 0.6; e.angle = Math.atan2(dy, dx) }
        }
        break
      }
      case 'pumpkin': {
        if (e.state === 'fuse') {
          if (e.timer <= 0) { this.killEnemy(e); return }
          break
        }
        walk()
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
      case 'mushroom': {
        // 鼓起身体，朝前方喷出一串停留片刻的孢子云
        if (e.state === 'puff') {
          if (e.timer <= 0) {
            e.state = 'spray'; e.timer = 0.35; e.pose = 0
            for (let i = 0; i < 3; i++) this.hazards.push({ kind: 'spore', x: e.x + Math.cos(e.angle) * (28 + i * 26), y: e.y + Math.sin(e.angle) * (28 + i * 26), r: 18 + i * 3, warn: 0.15 + i * 0.08, life: 2.4, max: 2.4 })
            this.onSound('spore')
          }
        } else if (e.state === 'spray') {
          if (e.timer <= 0) { e.state = 'idle'; e.cd = 3 + Math.random() }
        } else {
          walk()
          if (e.cd <= 0 && sees && d < 130) { e.state = 'puff'; e.timer = 0.55; e.angle = Math.atan2(dy, dx) }
        }
        break
      }
      case 'ghost': {
        // 慢慢飘近；隐身后在玩家身边现形并扑过来
        e.phase += dt * 3
        if (e.state === 'fade') {
          if (e.timer <= 0) {
            const a = Math.random() * Math.PI * 2
            e.x = clamp(p.x + Math.cos(a) * 90, TILE * 1.5, WORLD_W - TILE * 1.5); e.y = clamp(p.y + Math.sin(a) * 90, TILE * 1.5, WORLD_H - TILE * 1.5)
            e.state = 'lunge'; e.timer = 0.7; e.angle = Math.atan2(p.y - e.y, p.x - e.x)
            this.onSound('ghost')
          }
        } else if (e.state === 'lunge') {
          if (e.timer > 0.45) break
          this.moveActor(e, Math.cos(e.angle) * 190 * dt * slow, Math.sin(e.angle) * 190 * dt * slow, true)
          if (e.timer <= 0) { e.state = 'idle'; e.cd = 3.5 + Math.random() }
        } else {
          const ang = Math.atan2(dy, dx) + Math.sin(e.phase) * 0.6
          e.x += Math.cos(ang) * e.speed * dt * slow; e.y += Math.sin(ang) * e.speed * dt * slow
          this.clampToRoom(e)
          if (e.cd <= 0) { e.state = 'fade'; e.timer = 1.1 }
        }
        break
      }
      case 'lizard': {
        if (e.state === 'wind') {
          if (e.timer <= 0) { e.state = 'breath'; e.timer = 0.75 }
        } else if (e.state === 'breath') {
          e.cd -= dt
          if (e.cd <= 0) {
            e.cd = 0.06
            this.enemyShot(e.x + Math.cos(e.angle) * 12, e.y, e.angle + (Math.random() - 0.5) * 0.45, 150, 5, '#ff9f43', false, 0.65)
          }
          if (e.timer <= 0) { e.state = 'idle'; e.cd = 2.6 + Math.random() }
        } else {
          walk()
          if (e.cd <= 0 && sees && d < 125) { e.state = 'wind'; e.timer = 0.5; e.angle = Math.atan2(dy, dx); this.onSound('enemyFire') }
        }
        break
      }
      case 'shield': {
        // 盾牌缓慢转向玩家，只能从侧面、背后或趁它挥剑时打伤它
        const want = Math.atan2(dy, dx)
        if (e.state !== 'slash') e.angle += clamp(angleDiff(want, e.angle), -2.2 * dt, 2.2 * dt)
        if (e.state === 'wind') {
          if (e.timer <= 0) {
            e.state = 'slash'; e.timer = 0.35; e.pose = 0
            if (d < 52 && Math.abs(angleDiff(want, e.angle)) < 1.2) this.hurtPlayer(1, e)
            this.onSound('swing')
          }
        } else if (e.state === 'slash') {
          if (e.timer <= 0) { e.state = 'idle'; e.cd = 1.3 }
        } else {
          walk()
          if (e.cd <= 0 && d < 46) { e.state = 'wind'; e.timer = 0.32 }
        }
        break
      }
      case 'mummy': {
        if (e.state === 'down') {
          if (e.timer <= 0) { e.state = 'rise'; e.timer = 0.6 }
        } else if (e.state === 'rise') {
          if (e.timer <= 0) { e.state = 'idle'; e.hp = e.maxHp * 0.6; e.revived = true }
        } else walk()
        break
      }
      case 'worm': {
        // 在沙下潜行接近，破土时撞伤玩家并向四周喷沙
        if (e.state === 'under') {
          const [cx, cy] = this.chaseDir(e)
          this.moveActor(e, cx * e.speed * dt * slow, cy * e.speed * dt * slow, false)
          if (Math.random() < 0.35) this.dust(e.x, e.y + 4)
          if (e.timer <= 0 && (d < 44 || e.timer < -2.5)) { e.state = 'emerge'; e.timer = 0.4; this.onSound('emerge') }
        } else if (e.state === 'emerge') {
          if (e.timer <= 0) {
            e.state = 'up'; e.timer = 1.5; e.cd = 0.55
            if (dist(e, p) < e.r + p.r + 10) this.hurtPlayer(1, e)
            for (let i = 0; i < 8; i++) this.enemyShot(e.x, e.y, (i / 8) * Math.PI * 2 + e.phase, 120, 5, '#d9b26f')
            this.dustRing(e.x, e.y + 6)
            this.shake = Math.max(this.shake, 2)
          }
        } else if (e.state === 'up') {
          if (e.cd <= 0 && e.cd > -1) {
            e.cd = -9
            for (const s of [-0.2, 0, 0.2]) this.enemyShot(e.x, e.y, Math.atan2(dy, dx) + s, 160, 5, '#d9b26f')
          }
          if (e.timer <= 0) { e.state = 'dive'; e.timer = 0.35 }
        } else if (e.state === 'dive') {
          if (e.timer <= 0) { e.state = 'under'; e.timer = 2 + Math.random() }
        }
        break
      }
    }
  }

  private updateBoss(e: Enemy, dt: number, slow: number, d: number, dx: number, dy: number) {
    const p = this.player
    const rage = e.hp < e.maxHp * 0.5
    const fast = 1 + Math.min(0.4, (this.level - 1) * 0.04)
    if (e.state === 'intro') { if (e.timer <= 0) { e.state = 'idle'; e.timer = 0.6 } return }
    if (dist(e, p) < e.r + p.r - 4 && e.z < 8) this.hurtPlayer(1, e)

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
          this.onSound('quake')
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
        this.onSound('quake')
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
            this.onSound('quake')
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
          this.summon(e, pick<EnemyKind>(['archer', 'bat']), 2, 4)
          e.state = 'idle'; e.timer = 1
        }
      } else if (e.state === 'vanish' && e.timer <= 0) {
        this.teleport(e, '#7d5fff')
        e.state = 'idle'; e.timer = 0.5
      }
    } else if (e.kind === 'treant') {
      this.updateTreant(e, dt, slow, rage, fast)
    } else if (e.kind === 'dragon') {
      this.updateDragon(e, dt, slow, rage, fast, dx, dy)
    } else if (e.kind === 'pharaoh') {
      this.updatePharaoh(e, dt, rage, fast, d, dx, dy)
    }
  }

  /** 腐化树精：树根从玩家脚下刺出、喷出孢子风暴、召唤毒蘑菇。 */
  private updateTreant(e: Enemy, dt: number, slow: number, rage: boolean, fast: number) {
    const p = this.player
    if (e.state === 'idle') {
      const [cx, cy] = this.chaseDir(e)
      this.moveActor(e, cx * 26 * fast * dt * slow, cy * 26 * fast * dt * slow, false)
      if (e.timer <= 0) {
        e.phase++
        const moves = rage ? ['roots', 'spores', 'roots', 'summon'] : ['roots', 'spores', 'roots', 'roots']
        e.state = moves[e.phase % moves.length] + 'Wind'
        e.timer = 0.7
      }
    } else if (e.state === 'rootsWind' && e.timer <= 0) {
      e.state = 'roots'; e.timer = 0.8; e.pose = 0
      const n = rage ? 8 : 5
      // 一根落在玩家脚下，其余散布在附近
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = i ? 30 + Math.random() * 80 : 0
        this.hazards.push({ kind: 'root', x: clamp(p.x + Math.cos(a) * r, TILE * 1.4, WORLD_W - TILE * 1.4), y: clamp(p.y + Math.sin(a) * r, TILE * 1.4, WORLD_H - TILE * 1.4), r: 17, warn: 0.75 + i * 0.05, life: 0.55, max: 0.55 })
      }
      this.onSound('roots')
    } else if (e.state === 'roots' && e.timer <= 0) {
      e.state = 'idle'; e.timer = rage ? 0.9 : 1.3
    } else if (e.state === 'sporesWind' && e.timer <= 0) {
      e.state = 'spores'; e.timer = 0.9; e.pose = 0
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.random() * 0.4
        this.hazards.push({ kind: 'spore', x: clamp(e.x + Math.cos(a) * 70, TILE * 1.5, WORLD_W - TILE * 1.5), y: clamp(e.y + Math.sin(a) * 60, TILE * 1.5, WORLD_H - TILE * 1.5), r: 24, warn: 0.3, life: 3, max: 3 })
      }
      const n = rage ? 20 : 14
      for (let i = 0; i < n; i++) this.enemyShot(e.x, e.y - 10, (i / n) * Math.PI * 2, 95 * fast, 6, '#7bed9f')
      this.onSound('spore')
    } else if (e.state === 'spores' && e.timer <= 0) {
      e.state = 'idle'; e.timer = 1.2
    } else if (e.state === 'summonWind' && e.timer <= 0) {
      this.summon(e, 'mushroom', 2, 3)
      e.state = 'idle'; e.timer = 1
    }
  }

  /** 熔岩幼龙：扫射火焰吐息、飞起后砸落、狂暴时吐出会留下火海的火球。 */
  private updateDragon(e: Enemy, dt: number, slow: number, rage: boolean, fast: number, dx: number, dy: number) {
    const p = this.player
    if (e.state === 'idle') {
      const [cx, cy] = this.chaseDir(e)
      this.moveActor(e, cx * 40 * fast * dt * slow, cy * 40 * fast * dt * slow, false)
      if (e.timer <= 0) {
        e.phase++
        const moves = rage ? ['breath', 'fly', 'balls', 'breath'] : ['breath', 'breath', 'fly']
        e.state = moves[e.phase % moves.length] + 'Wind'
        e.timer = 0.65
        e.angle = Math.atan2(dy, dx)
      }
    } else if (e.state === 'breathWind' && e.timer <= 0) {
      e.state = 'breath'; e.timer = 1.4; e.cd = 0; e.tx = Math.atan2(dy, dx) - 0.7
      this.onSound('enemyFire')
    } else if (e.state === 'breath') {
      // 从一侧扫向另一侧
      const t = 1 - e.timer / 1.4
      if (e.cd <= 0) {
        e.cd = 0.035
        const a = e.tx + t * 1.4
        this.enemyShot(e.x + Math.cos(a) * 20, e.y - 6, a + (Math.random() - 0.5) * 0.12, 175 * fast, 6, '#ff9f43', false, 1.4)
      }
      if (e.timer <= 0) { e.state = 'idle'; e.timer = 1 }
    } else if (e.state === 'flyWind' && e.timer <= 0) {
      e.state = 'fly'; e.timer = 1.6; e.tx = p.x; e.ty = p.y
    } else if (e.state === 'fly') {
      const t = 1 - e.timer / 1.6
      e.z = Math.sin(Math.min(1, t * 1.25) * Math.PI) * 110
      if (t > 0.3 && t < 0.8) { e.tx += (p.x - e.tx) * dt * 3; e.ty += (p.y - e.ty) * dt * 3 }
      e.x += (e.tx - e.x) * Math.min(1, dt * 3); e.y += (e.ty - e.y) * Math.min(1, dt * 3)
      this.clampToRoom(e)
      if (e.timer <= 0) {
        e.z = 0; e.pose = 0
        const n = rage ? 22 : 16
        for (let i = 0; i < n; i++) this.enemyShot(e.x, e.y, (i / n) * Math.PI * 2, 130 * fast, 6, '#ff9f43')
        for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; this.hazards.push({ kind: 'fire', x: e.x + Math.cos(a) * 54, y: e.y + Math.sin(a) * 40, r: 18, warn: 0, life: 2.2, max: 2.2 }) }
        this.shake = 8; this.ring(e.x, e.y, '#ff9f43', 100); this.dustRing(e.x, e.y + e.r * 0.6)
        this.onSound('quake')
        e.state = 'idle'; e.timer = 1.1
      }
    } else if (e.state === 'ballsWind' && e.timer <= 0) {
      for (let i = -2; i <= 2; i++) {
        this.enemyShot(e.x, e.y, Math.atan2(dy, dx) + i * 0.3, 140 * fast, 9, '#ffa94d', true, 1.6)
        this.bullets[this.bullets.length - 1].explode = 1
      }
      e.state = 'idle'; e.timer = 1.1; e.pose = 0
    }
  }

  /** 沙之法老：诅咒光束、沙暴旋涡、召唤木乃伊、瞬移。 */
  private updatePharaoh(e: Enemy, dt: number, rage: boolean, fast: number, d: number, dx: number, dy: number) {
    const p = this.player
    e.phase += dt
    const want = d < 130 ? -1 : d > 230 ? 1 : 0
    e.vx += ((dx / d) * 50 * want + Math.cos(e.phase * 0.8) * 26 - e.vx) * dt * 2
    e.vy += ((dy / d) * 50 * want + Math.sin(e.phase * 1.1) * 26 - e.vy) * dt * 2
    if (e.state !== 'beam' && e.state !== 'storm') this.moveActor(e, e.vx * dt, e.vy * dt, true)
    if (e.state === 'idle' && e.timer <= 0) {
      e.tx++
      const moves = rage ? ['beam', 'storm', 'beam', 'summon', 'vanish'] : ['beam', 'storm', 'beam', 'vanish']
      e.state = moves[e.tx % moves.length] + (moves[e.tx % moves.length] === 'vanish' ? '' : 'Wind')
      e.timer = e.state === 'vanish' ? 0.4 : 0.5
      e.cd = 0
    } else if (e.state === 'beamWind' && e.timer <= 0) {
      e.state = 'beam'; e.timer = 1.1; e.pose = 0
      const base = Math.atan2(p.y - e.y, p.x - e.x)
      for (const off of rage ? [-0.5, 0, 0.5] : [0]) this.hazards.push({ kind: 'beam', x: e.x, y: e.y - 10, r: 9, angle: base + off, len: 520, warn: 0.6, life: 0.35, max: 0.35 })
      this.onSound('beam')
    } else if (e.state === 'beam' && e.timer <= 0) {
      e.state = 'idle'; e.timer = 0.8
    } else if (e.state === 'stormWind' && e.timer <= 0) {
      e.state = 'storm'; e.timer = 2.6; e.cd = 0; e.pose = 0
    } else if (e.state === 'storm') {
      if (e.cd <= 0) {
        e.cd = rage ? 0.12 : 0.16
        e.angle += 0.37
        for (let i = 0; i < 3; i++) this.enemyShot(e.x, e.y, e.angle + (i / 3) * Math.PI * 2, 115 * fast, 5, '#d9b26f')
        if (Math.random() < 0.3) this.dust(e.x + (Math.random() - 0.5) * 60, e.y + (Math.random() - 0.5) * 40)
      }
      if (e.timer <= 0) { e.state = 'idle'; e.timer = 0.8 }
    } else if (e.state === 'summonWind' && e.timer <= 0) {
      this.summon(e, 'mummy', 2, 4)
      e.state = 'idle'; e.timer = 0.8
    } else if (e.state === 'vanish' && e.timer <= 0) {
      this.teleport(e, '#ffcf5c')
      e.state = 'idle'; e.timer = 0.5
    }
  }

  private summon(e: Enemy, kind: EnemyKind, n: number, cap: number) {
    const alive = this.enemies.filter(x => !x.boss).length
    for (let i = 0; i < Math.min(n, cap - alive); i++) {
      const a = Math.random() * Math.PI * 2
      const sx = clamp(e.x + Math.cos(a) * 60, TILE * 2, WORLD_W - TILE * 2), sy = clamp(e.y + Math.sin(a) * 60, TILE * 2, WORLD_H - TILE * 2)
      if (!SOLID_WALK.has(tileAt(this.room, Math.floor(sx / TILE), Math.floor(sy / TILE)))) this.spawnEnemy(kind, sx, sy, false, 0.6)
    }
    this.ring(e.x, e.y, BOSSES[e.kind as BossKind].color, 60)
  }

  private teleport(e: Enemy, color: string) {
    const p = this.player
    const spots = spawnTiles(this.room).filter(([x, y]) => Math.hypot((x + 0.5) * TILE - p.x, (y + 0.5) * TILE - p.y) > 150)
    if (spots.length) { const [x, y] = pick(spots); this.burst(e.x, e.y, color, 12); e.x = (x + 0.5) * TILE; e.y = (y + 0.5) * TILE; this.burst(e.x, e.y, color, 12) }
  }

  private enemyShot(x: number, y: number, angle: number, speed: number, r: number, color: string, big = false, life = 5) {
    if (this.acting) this.acting.pose = 0
    speed *= this.player.stats.bulletSpeed
    this.bullets.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r, damage: big ? 2 : 1, enemy: true, life, max: life, pierce: 0, bounce: 0, explode: 0, color, slow: false, crit: false, hit: new Set(), trail: 0, big, sprite: ENEMY_FX[color], knock: 0 })
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
      if (a.z > 8 || b.z > 8 || a.state === 'under' || b.state === 'under') continue
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.r + b.r
      if (d >= min || d === 0) continue
      const push = (min - d) / 2, nx = dx / d, ny = dy / d
      if (!a.boss) this.moveActor(a, -nx * push, -ny * push, a.flying)
      if (!b.boss) this.moveActor(b, nx * push, ny * push, b.flying)
    }
  }

  /** 持续伤害：不击退、不顿帧，伤害数字合并显示 */
  private dot(e: Enemy, amount: number, color: string) {
    e.hp -= amount
    const recent = this.particles.find(p => p.owner === -e.id && p.life > p.max - 0.5)
    if (recent) { recent.sum! += amount; recent.text = String(Math.round(recent.sum!)); recent.x = e.x; recent.y = e.y - e.r - 10 }
    else if (amount > 0) this.particles.push({ x: e.x, y: e.y - e.r - 10, vx: 0, vy: -20, life: 0.8, max: 0.8, color, size: 9, kind: 'text', text: '', owner: -e.id, sum: amount })
    if (e.hp <= 0) this.killEnemy(e)
  }

  /** 命中附带的状态效果与连锁闪电 */
  private applyEffects(e: Enemy, burnChance = 0, chainOk = true) {
    const s = this.player.stats
    if (e.hp <= 0) return
    if (Math.random() < burnChance + s.burn) e.burn = 3
    if (s.venom && Math.random() < s.venom) e.poison = 4
    if (s.ice && Math.random() < s.ice) { e.freeze = e.boss ? 0.35 : 1.3; this.ring(e.x, e.y, '#9be7ff', e.r + 8) }
    if (chainOk && s.thunder && Math.random() < s.thunder) this.chain(e.x, e.y - 6, e, 4 * this.damageMul(), 2)
  }

  damageEnemy(e: Enemy, amount: number, nx: number, ny: number, crit: boolean, knockback: number, effects = true, burn = 0) {
    if (!this.targetable(e) && e.state !== 'down') return
    e.hp -= amount
    e.flash = 1
    e.squash = crit ? 0.62 : 0.78
    if (!e.boss && e.state !== 'charge' && e.kind !== 'totem' && e.state !== 'down') {
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
    this.onSound(crit ? 'crit' : 'hit')
    if (effects) this.applyEffects(e, burn)
    if (e.hp <= 0) this.killEnemy(e)
  }

  private killEnemy(e: Enemy) {
    // 木乃伊第一次倒下会重新站起，除非正在燃烧或被补刀
    if (e.kind === 'mummy' && !e.revived && e.state !== 'down' && e.burn <= 0) {
      e.state = 'down'; e.timer = 3; e.hp = Math.max(4, e.maxHp * 0.25); e.kx = e.ky = 0; e.pose = 0
      e.burn = e.poison = 0
      this.dustRing(e.x, e.y + e.r * 0.6)
      this.float(e.x, e.y - 20, '还会站起来！', '#e0d2b0')
      return
    }
    e.hp = 0
    e.state = 'dead'
    this.enemies = this.enemies.filter(x => x !== e)
    const color = e.boss ? BOSSES[e.kind as BossKind].color : ENEMIES[e.kind as EnemyKind].color
    this.burst(e.x, e.y, color, e.boss ? 60 : 22)
    this.corpses.push({ kind: e.kind, x: e.x, y: e.y, t: 0, flip: this.player.x < e.x, scale: e.boss ? 1 : e.r / ENEMIES[e.kind as EnemyKind].radius })
    this.shake = Math.max(this.shake, e.boss ? 10 : 3.5)
    this.kills++
    this.onSound(e.boss ? 'bossDown' : 'kill')
    if (e.kind === 'pumpkin') this.explode(e.x, e.y, 54, 10, true)
    const s = this.player.stats
    if (e.boss) {
      this.bossesKilled++
      this.score += 1000 * this.level
      this.hitStop = 0.25
      this.shake = 10
      this.ring(e.x, e.y, color, 140)
      this.enemies = []
      this.bullets = this.bullets.filter(b => !b.enemy)
      this.hazards = []
      this.drop(this.room, { kind: 'item', x: WORLD_W / 2, y: WORLD_H / 2 - TILE * 1.6, item: this.randomItem() })
      this.drop(this.room, { kind: 'stairs', x: WORLD_W / 2, y: WORLD_H / 2 + TILE * 1.6 })
      this.drop(this.room, { kind: 'heart', x: WORLD_W / 2 + TILE * 2, y: WORLD_H / 2 })
      this.dropCoins(e.x, e.y, Math.round(12 * s.greed))
      this.banner = { title: '首领已击败', text: '拾取宝物，然后走进阶梯', life: 2.4, color: '#ffd166' }
      return
    }
    this.hitStop = Math.max(this.hitStop, e.elite ? 0.09 : 0.06)
    this.score += ENEMIES[e.kind as EnemyKind].score * this.level * (e.elite ? 2 : 1)
    const orbs = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < orbs; i++) this.drop(this.room, { kind: 'energy', x: e.x, y: e.y, vx: (Math.random() - 0.5) * 160, vy: (Math.random() - 0.5) * 160 })
    const coins = (Math.random() < 0.65 + s.luck ? 1 + Math.floor(Math.random() * 2) : 0) + (e.elite ? 3 : 0)
    this.dropCoins(e.x, e.y, Math.round(coins * s.greed))
    if (e.elite && Math.random() < 0.35 + s.luck) this.drop(this.room, { kind: 'key', x: e.x, y: e.y })
    if (s.vamp && Math.random() < s.vamp && this.player.hp < this.player.maxHp) {
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
      if (d < radius + e.r) this.damageEnemy(e, damage, (e.x - x) / (d || 1), (e.y - y) / (d || 1), false, 200, false, 0.5)
    }
    for (const p of this.roomProps) if (!p.broken && dist(p, { x, y }) < radius + p.r) this.breakProp(p)
    // 爆炸能炸开附近的裂缝墙
    for (const dir of Object.keys(this.room.hidden) as Dir[]) {
      const [tx, ty] = DOOR_TILE[dir]
      if (Math.hypot((tx + 0.5) * TILE - x, (ty + 0.5) * TILE - y) < radius + 26) this.openSecret(dir)
    }
    if (hurtsPlayer && dist(this.player, { x, y }) < radius + this.player.r - 4) this.hurtPlayer(1, { x, y })
  }

  private openSecret(dir: Dir) {
    revealDoor(this.room, dir)
    const [tx, ty] = DOOR_TILE[dir]
    const x = (tx + 0.5) * TILE, y = (ty + 0.5) * TILE
    this.burst(x, y, '#b9a48c', 26)
    this.dustRing(x, y)
    this.shake = Math.max(this.shake, 5)
    this.float(x + (dir === 'w' ? 40 : dir === 'e' ? -40 : 0), y + (dir === 'n' ? 30 : dir === 's' ? -30 : 0), '发现密道！', '#e8d3a2')
    this.onSound('secret')
    this.computeFlow()
  }

  // —— 可破坏物与机关 ——

  /** 把角色推出未破坏的木箱、陶罐与木桶。 */
  private pushFromProps(a: { x: number; y: number; r: number }) {
    for (const p of this.roomProps) {
      if (p.broken) continue
      const dx = a.x - p.x, dy = a.y - p.y, d = Math.hypot(dx, dy), min = a.r + p.r
      if (d >= min || d === 0) continue
      a.x += (dx / d) * (min - d); a.y += (dy / d) * (min - d)
    }
  }

  private breakProp(p: Prop) {
    if (p.broken) return
    p.broken = true; p.t = 0
    const s = this.player.stats
    this.burst(p.x, p.y, p.kind === 'pot' ? '#d8b98a' : '#a8713a', 12)
    if (p.kind === 'barrel') { this.explode(p.x, p.y, 62, 12, true); return }
    this.onSound(p.kind === 'pot' ? 'pot' : 'crate')
    const r = Math.random()
    if (r < 0.45 + s.luck) this.dropCoins(p.x, p.y, Math.round((1 + Math.floor(Math.random() * 3)) * s.greed))
    else if (r < 0.62) this.drop(this.room, { kind: 'energy', x: p.x, y: p.y, vx: 40, vy: -30 })
    else if (r < 0.69) this.drop(this.room, { kind: 'heart', x: p.x, y: p.y })
    else if (r < 0.72) this.drop(this.room, { kind: 'key', x: p.x, y: p.y })
  }

  private updateTraps(dt: number) {
    const p = this.player
    for (const t of this.roomTraps) {
      if (t.kind === 'spike') {
        if (spikeState(this.time, t.offset) !== 2) continue
        if (Math.abs(p.x - t.x) < 14 && Math.abs(p.y + 6 - t.y) < 14) this.hurtPlayer(1, t)
        for (const e of this.enemies) if (!e.flying && !e.boss && e.trapCd <= 0 && e.state !== 'under' && Math.abs(e.x - t.x) < 14 && Math.abs(e.y - t.y) < 14) { e.trapCd = 0.6; this.damageEnemy(e, 5, 0, -1, false, 0, false) }
      } else {
        const state = ventState(this.time, t.offset)
        if (state === 1 && Math.random() < 0.2) this.particles.push({ x: t.x + (Math.random() - 0.5) * 8, y: t.y - 6, vx: 0, vy: -30, life: 0.5, max: 0.5, color: 'rgba(90,90,90,.6)', size: 4, kind: 'dust' })
        if (state !== 2) continue
        if (Math.random() < 0.5) this.particles.push({ x: t.x + (Math.random() - 0.5) * 10, y: t.y - 10, vx: 0, vy: -90, life: 0.35, max: 0.35, color: '#ff9f43', size: 3, kind: 'spark' })
        if (Math.abs(p.x - t.x) < 14 && p.y > t.y - 34 && p.y < t.y + 12) this.hurtPlayer(1, t)
        for (const e of this.enemies) if (!e.boss && e.trapCd <= 0 && Math.abs(e.x - t.x) < 14 && e.y > t.y - 34 && e.y < t.y + 12) { e.trapCd = 0.6; e.burn = 2; this.damageEnemy(e, 4, 0, -1, false, 0, false) }
      }
    }
    void dt
  }

  private updateHazards(dt: number) {
    const p = this.player
    for (const h of this.hazards) {
      if (h.warn > 0) { h.warn -= dt; if (h.warn <= 0 && h.kind === 'root') { this.shake = Math.max(this.shake, 2); this.dust(h.x, h.y) } continue }
      h.life -= dt
      let hit = false
      if (h.kind === 'beam') {
        const ex = Math.cos(h.angle!), ey = Math.sin(h.angle!)
        const t = clamp((p.x - h.x) * ex + (p.y - h.y) * ey, 0, h.len!)
        hit = Math.hypot(h.x + ex * t - p.x, h.y + ey * t - p.y) < h.r + p.r - 2
      } else hit = dist(h, p) < h.r + p.r * 0.6
      if (hit) this.hurtPlayer(1, h)
    }
    this.hazards = this.hazards.filter(h => h.life > 0)
  }

  // —— 子弹与近战 ——

  private updateBullets(dt: number) {
    const p = this.player, s = p.stats
    const keep: Bullet[] = []
    for (const b of this.bullets) {
      b.life -= dt
      let alive = b.life > 0
      if (!b.enemy && b.shape === 'boomerang') {
        // 飞出一段后折返，回到手中
        if (!b.returning && b.life < b.max * 0.5) { b.returning = true; b.hit.clear() }
        if (b.returning) {
          const d = dist(b, p) || 1, sp = Math.hypot(b.vx, b.vy)
          b.vx += ((p.x - b.x) / d * sp - b.vx) * Math.min(1, dt * 8); b.vy += ((p.y - b.y) / d * sp - b.vy) * Math.min(1, dt * 8)
          if (d < 16) alive = false
          b.life = Math.max(b.life, 0.05)
        }
      }
      if (!b.enemy && s.homing && !b.shape) {
        const target = this.enemies.filter(e => this.targetable(e) && dist(e, b) < 170).sort((a, c) => dist(a, b) - dist(c, b))[0]
        if (target) {
          const want = Math.atan2(target.y - b.y, target.x - b.x), cur = Math.atan2(b.vy, b.vx), sp = Math.hypot(b.vx, b.vy)
          if (Math.abs(angleDiff(want, cur)) < 1.4) { const a = cur + clamp(angleDiff(want, cur), -3.5 * dt, 3.5 * dt); b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp }
        }
      }
      if (b.shape === 'flame') { b.r += dt * 18; b.vx *= 0.97; b.vy *= 0.97 }
      const steps = Math.ceil((Math.hypot(b.vx, b.vy) * dt) / 6)
      for (let st = 0; st < steps && alive; st++) {
        const ox = b.x, oy = b.y
        b.x += (b.vx * dt) / steps; b.y += (b.vy * dt) / steps
        const tx = Math.floor(b.x / TILE), ty = Math.floor(b.y / TILE)
        const tile = tileAt(this.room, tx, ty)
        if (tile === WALL || tile === ROCK || tile === DOOR) {
          if (!b.enemy) this.hitCrack(tx, ty, b.damage)
          if (b.shape === 'boomerang') { b.x = ox; b.y = oy; b.returning = true; b.vx = -b.vx; b.vy = -b.vy; continue }
          if (b.bounce > 0) {
            b.bounce--
            const hx = tileAt(this.room, Math.floor(b.x / TILE), Math.floor(oy / TILE))
            if (hx === WALL || hx === ROCK || hx === DOOR) b.vx = -b.vx; else b.vy = -b.vy
            b.x = ox; b.y = oy
          } else {
            alive = false
            if (b.explode) b.enemy ? this.enemyBlast(b) : this.explode(b.x, b.y, b.explode, b.damage, false)
            if (b.shape !== 'flame') for (let i = 0; i < 4; i++) this.spark(b.x, b.y, Math.atan2(-b.vy, -b.vx) + (Math.random() - 0.5) * 2, b.color, 120)
          }
          continue
        }
        // 木箱等会挡住子弹
        const prop = this.roomProps.find(o => !o.broken && Math.hypot(o.x - b.x, o.y - b.y) < o.r + b.r)
        if (prop && !b.hit.has(-1 - this.roomProps.indexOf(prop))) {
          if (b.enemy) { alive = false; continue }
          b.hit.add(-1 - this.roomProps.indexOf(prop))
          prop.hp -= b.damage
          this.spark(b.x, b.y, Math.atan2(-b.vy, -b.vx), '#c9a46a', 100)
          if (prop.hp <= 0) this.breakProp(prop)
          if (b.explode) { this.explode(b.x, b.y, b.explode, b.damage, false); alive = false; continue }
          if (b.pierce > 0 && b.shape) continue
          alive = false; continue
        }
        if (b.enemy) {
          if (s.orbit) for (const o of this.orbits()) if (Math.hypot(o.x - b.x, o.y - b.y) < b.r + 6) { alive = false; this.spark(b.x, b.y, 0, '#c3f0ff', 80) }
          if (alive && Math.hypot(p.x - b.x, p.y - b.y) < b.r + p.r - 3 && p.dashTime <= 0 && p.invuln <= 0) {
            this.hurtPlayer(b.damage, { x: b.x - b.vx, y: b.y - b.vy })
            alive = false
          }
        } else {
          for (const e of this.enemies) {
            if (b.hit.has(e.id) || !(this.targetable(e) || e.state === 'down')) continue
            if (Math.hypot(e.x - b.x, e.y - b.y) >= e.r + b.r) continue
            b.hit.add(e.id)
            const sp = Math.hypot(b.vx, b.vy) || 1
            if (e.kind === 'shield' && !b.explode && this.blocks(e, b)) {
              e.pose = 0
              this.spark(b.x, b.y, Math.atan2(-b.vy, -b.vx), '#ffe9a8', 160)
              this.float(e.x, e.y - e.r - 8, '格挡', '#ffe9a8')
              this.onSound('block')
              if (b.shape !== 'boomerang') { alive = false; break }
              continue
            }
            if (b.slow) e.slow = 1.6
            if (b.explode) { this.explode(b.x, b.y, b.explode, b.damage, false); alive = false; break }
            this.damageEnemy(e, b.damage, b.vx / sp, b.vy / sp, b.crit, b.knock, true, b.burn ?? 0)
            if (b.pierce > 0) b.pierce--
            else { alive = false; break }
          }
        }
      }
      if (alive) keep.push(b)
    }
    this.bullets = keep
  }

  /** 盾牌骷髅：正面来的子弹被挡下，挥剑时盾牌放下 */
  private blocks(e: Enemy, b: Bullet) {
    if (e.state === 'slash' || e.state === 'wind' || e.freeze > 0) return false
    return Math.abs(angleDiff(Math.atan2(-b.vy, -b.vx), e.angle)) < 1.15
  }

  /** 敌方火球落地：留下一片火海。 */
  private enemyBlast(b: Bullet) {
    this.hazards.push({ kind: 'fire', x: b.x, y: b.y, r: 20, warn: 0, life: 2.4, max: 2.4 })
    this.ring(b.x, b.y, '#ff9f43', 30)
  }

  /** 子弹打在裂缝墙上会慢慢把它打碎。 */
  private hitCrack(tx: number, ty: number, damage: number) {
    for (const dir of Object.keys(this.room.hidden) as Dir[]) {
      const [x, y] = DOOR_TILE[dir]
      if (x !== tx || y !== ty) continue
      this.room.hidden[dir]! -= damage
      this.dust((tx + 0.5) * TILE, (ty + 0.5) * TILE)
      if (this.room.hidden[dir]! <= 0) this.openSecret(dir)
    }
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
        if (s.hit.has(e.id) || !(this.targetable(e) || e.state === 'down')) continue
        const d = Math.hypot(e.x - s.x, e.y - s.y)
        const ang = Math.abs(angleDiff(Math.atan2(e.y - s.y, e.x - s.x), s.angle))
        if (d < s.range + e.r && ang < s.arc) {
          s.hit.add(e.id)
          this.damageEnemy(e, s.damage, (e.x - s.x) / (d || 1), (e.y - s.y) / (d || 1), s.knock > 250, s.knock)
          if (s.knock > 250) this.hitStop = Math.max(this.hitStop, 0.07)
        }
      }
      for (const prop of this.roomProps) {
        if (prop.broken || Math.hypot(prop.x - s.x, prop.y - s.y) > s.range + prop.r) continue
        if (Math.abs(angleDiff(Math.atan2(prop.y - s.y, prop.x - s.x), s.angle)) < s.arc) this.breakProp(prop)
      }
      if (!s.deflect) continue
      // 光剑可以把敌方子弹反弹回去
      for (const b of this.bullets) {
        if (!b.enemy) continue
        const d = Math.hypot(b.x - s.x, b.y - s.y)
        if (d < s.range + 6 && Math.abs(angleDiff(Math.atan2(b.y - s.y, b.x - s.x), s.angle)) < 1.3) {
          b.enemy = false
          const sp = Math.hypot(b.vx, b.vy) * 1.6
          b.vx = Math.cos(s.angle) * sp; b.vy = Math.sin(s.angle) * sp
          b.damage = 4 * this.player.stats.damage; b.color = '#7cffb2'; b.life = 1.2; b.knock = 60
          this.spark(b.x, b.y, s.angle, '#7cffb2', 150)
        }
      }
    }
    this.swings = this.swings.filter(s => s.life > 0)
  }

  // —— 掉落物 ——

  private updatePickups(dt: number, input: Input) {
    const p = this.player, s = p.stats
    const list = this.roomPickups
    this.prompt = ''
    let interact = input.interact
    for (const item of list) {
      if (item.used) continue
      item.t += dt
      const d = dist(item, p)
      if (item.kind === 'energy' || item.kind === 'coin') {
        item.vx *= 0.9; item.vy *= 0.9
        const reach = (item.kind === 'coin' ? 70 : 90) * s.magnet
        if (d < reach && item.t > 0.35) { item.vx += ((p.x - item.x) / d) * 900 * dt; item.vy += ((p.y - item.y) / d) * 900 * dt }
        item.x += item.vx * dt; item.y += item.vy * dt
        item.x = clamp(item.x, TILE + 4, WORLD_W - TILE - 4); item.y = clamp(item.y, TILE + 4, WORLD_H - TILE - 4)
        if (d < p.r + 6 && item.t > 0.2) {
          item.used = true
          if (item.kind === 'energy') p.energy = Math.min(p.maxEnergy, p.energy + 9 * s.orb)
          else { p.coins++; this.onSound('coin') }
        }
        continue
      }
      if (item.kind === 'heart' && d < p.r + 10) {
        if (p.hp < p.maxHp) { item.used = true; p.hp = Math.min(p.maxHp, p.hp + 2); this.float(p.x, p.y - 18, '+2', '#ff6b8b'); this.onSound('heal') }
      } else if (item.kind === 'key' && d < p.r + 10) {
        item.used = true; p.keys++; this.float(p.x, p.y - 18, '钥匙 +1', COIN_COLOR); this.onSound('key')
      } else if (item.kind === 'item' && d < p.r + 14) {
        item.used = true
        this.applyItem(item.item!)
      } else if (item.kind === 'chest' && d < p.r + 16) {
        item.used = true
        this.burst(item.x, item.y, '#ffd166', 14)
        this.drop(this.room, { kind: 'weapon', x: item.x, y: item.y + 6, weapon: pick(WEAPON_POOL.filter(w => !p.weapons.includes(w))) })
        this.onSound('chest')
      } else if (item.kind === 'locked' && d < p.r + 20) {
        this.prompt = p.keys ? '用钥匙打开宝箱' : '需要一把钥匙'
        if (interact) {
          interact = false
          if (!p.keys) { this.onSound('deny'); this.float(item.x, item.y - 22, '没有钥匙', '#ff8a8a'); continue }
          p.keys--
          item.used = true
          this.burst(item.x, item.y, '#ffd166', 20)
          this.ring(item.x, item.y, '#ffd166', 40)
          this.drop(this.room, { kind: 'item', x: item.x, y: item.y + 26, item: this.randomItem() })
          this.dropCoins(item.x, item.y, 4)
          this.onSound('chest')
        }
      } else if (item.kind === 'weapon' && d < p.r + 18) {
        this.prompt = `拾取 ${WEAPONS[item.weapon!].name}`
        if (interact) {
          interact = false
          if (p.weapons.length < 2) { p.weapons.push(item.weapon!); p.current = p.weapons.length - 1; item.used = true }
          else { const old = p.weapons[p.current]; p.weapons[p.current] = item.weapon!; item.weapon = old; item.t = 0 }
          p.spin = 0
          this.onSound('weapon')
          this.banner = { title: WEAPONS[p.weapons[p.current]].name, text: WEAPONS[p.weapons[p.current]].cost ? `每发消耗 ${WEAPONS[p.weapons[p.current]].cost} 能量` : '不消耗能量', life: 1.4, color: WEAPONS[p.weapons[p.current]].color }
        }
      } else if (item.kind === 'ware' && d < p.r + 18) {
        const name = item.ware === 'heart' ? '回复 2 点生命' : item.ware === 'key' ? '钥匙' : item.ware === 'weapon' ? WEAPONS[item.weapon!].name : item.item!.name
        this.prompt = `购买 ${name} · ${item.price} 金币`
        if (interact) {
          interact = false
          if (p.coins < item.price!) { this.onSound('deny'); this.float(item.x, item.y - 24, '金币不足', '#ff8a8a'); continue }
          if (item.ware === 'heart' && p.hp >= p.maxHp) { this.onSound('deny'); this.float(item.x, item.y - 24, '生命已满', '#ff8a8a'); continue }
          p.coins -= item.price!
          item.used = true
          this.onSound('buy')
          this.burst(item.x, item.y, COIN_COLOR, 12)
          if (item.ware === 'heart') { p.hp = Math.min(p.maxHp, p.hp + 2); this.float(p.x, p.y - 18, '+2', '#ff6b8b') }
          else if (item.ware === 'key') p.keys++
          else if (item.ware === 'weapon') this.drop(this.room, { kind: 'weapon', x: item.x, y: item.y, weapon: item.weapon })
          else this.applyItem(item.item!)
        }
      } else if (item.kind === 'altar' && d < p.r + 22) {
        this.prompt = item.altar === 'bless' ? '献上 15 金币祈求祝福' : '以 1 颗心的生命上限换取宝物'
        if (interact) {
          interact = false
          if (item.altar === 'bless') {
            if (p.coins < 15) { this.onSound('deny'); this.float(item.x, item.y - 26, '金币不足', '#ff8a8a'); continue }
            p.coins -= 15
            item.used = true
            this.bless()
            this.ring(item.x, item.y, '#ffd166', 60)
          } else {
            if (p.maxHp <= 2) { this.onSound('deny'); this.float(item.x, item.y - 26, '生命太少了', '#ff8a8a'); continue }
            item.used = true
            p.maxHp -= 2; p.hp = Math.min(p.hp, p.maxHp)
            this.ring(item.x, item.y, '#b06bff', 60)
            this.burst(item.x, item.y, '#b06bff', 20)
            this.onSound('curse')
            this.drop(this.room, { kind: 'item', x: item.x, y: item.y + 34, item: this.randomItem() })
          }
        }
      } else if (item.kind === 'fountain' && d < p.r + 22) {
        this.prompt = '饮用泉水'
        if (interact) {
          interact = false
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
    // 泉水、祭坛与商人在使用后仍留在原地
    if (list.some(i => i.used)) this.pickups.set(this.room, list.filter(i => !i.used || i.kind === 'fountain' || i.kind === 'altar'))
  }

  /** 祝福祭坛：随机强化一项属性。 */
  private bless() {
    const p = this.player, s = p.stats
    const options: [string, () => void][] = [
      ['力量祝福 · 伤害 +15%', () => { s.damage *= 1.15 }],
      ['迅捷祝福 · 射速 +15%', () => { s.rate *= 1.15 }],
      ['生命祝福 · 生命上限 +2', () => { p.maxHp += 2; p.hp += 2 }],
      ['守护祝福 · 护甲 +1', () => { p.maxArmor++; p.armor++ }],
      ['能量祝福 · 能量上限 +50', () => { p.maxEnergy += 50; p.energy = p.maxEnergy }],
    ]
    const [text, apply] = pick(options)
    apply()
    this.banner = { title: '祝福', text, life: 2.2, color: '#ffd166' }
    this.onSound('bless')
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
      case 'thunder': s.thunder = 0.12; break
      case 'burn': s.burn = 0.2; break
      case 'venom': s.venom = 0.25; break
      case 'iceheart': s.ice = 0.1; break
      case 'magnet': s.magnet = 2.6; break
      case 'clover': s.luck = 0.15; s.crit += 0.05; break
      case 'goldbag': p.coins += 25; s.greed = 1.5; break
      case 'cross': s.revive++; break
      case 'trigger': s.rate *= 1.3; break
      case 'mask': s.berserk = true; break
      case 'thorns': s.thorns = true; break
      case 'rune': s.skill *= 0.7; break
      case 'seeker': s.homing = true; break
      case 'battery': p.maxEnergy += 60; p.energy += 60; s.orb = 2; break
      case 'hourglass': s.bulletSpeed = 0.85; break
      case 'map': this.mapped = true; break
    }
    this.banner = { title: item.name, text: item.text, life: 2.2, color: item.color }
    this.ring(p.x, p.y, item.color, 50)
    this.onSound('item')
  }

  // —— 房间状态 ——

  private checkClear() {
    if (this.room.cleared || this.enemies.length) return
    this.room.cleared = true
    this.score += 50 * this.level
    this.onSound('door')
    const p = this.player
    const spots = spawnTiles(this.room).filter(([x, y]) => !this.roomProps.some(o => !o.broken && Math.floor(o.x / TILE) === x && Math.floor(o.y / TILE) === y))
    const near = spots.sort((a, b) => Math.hypot((a[0] + 0.5) * TILE - WORLD_W / 2, (a[1] + 0.5) * TILE - WORLD_H / 2) - Math.hypot((b[0] + 0.5) * TILE - WORLD_W / 2, (b[1] + 0.5) * TILE - WORLD_H / 2))
    const spot = near[0] ?? [9, 5]
    const x = (spot[0] + 0.5) * TILE, y = (spot[1] + 0.5) * TILE
    const roll = Math.random()
    if (this.room.type === 'normal') {
      if (roll < 0.15) this.drop(this.room, { kind: 'chest', x, y })
      else if (roll < 0.23) this.drop(this.room, { kind: 'locked', x, y })
      else if (roll < 0.5 && p.hp < p.maxHp) this.drop(this.room, { kind: 'heart', x, y })
    }
  }

  private checkDoors() {
    if (!this.room.cleared) return
    const p = this.player, open = this.openDoors()
    let dir: Dir | null = null
    if (p.y < TILE * 0.9 && open.includes('n')) dir = 'n'
    else if (p.y > WORLD_H - TILE * 0.9 && open.includes('s')) dir = 's'
    else if (p.x < TILE * 0.9 && open.includes('w')) dir = 'w'
    else if (p.x > WORLD_W - TILE * 0.9 && open.includes('e')) dir = 'e'
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
      if (p.kind === 'spark' || p.kind === 'dust' || p.kind === 'frost') { p.vx *= 0.9; p.vy *= 0.9 }
      if (p.kind === 'leaf') { p.vx *= 0.94; p.angle! += dt * 6 }
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
