/** 合成大西瓜的圆形刚体模拟：只处理圆与圆、圆与墙，足够轻量。 */

export const WIDTH = 400
export const HEIGHT = 600
export const LINE_Y = 110
export const RADII = [15, 21, 28, 34, 42, 50, 58, 68, 80, 92, 108]
export const MAX_LEVEL = RADII.length - 1
// 合成得分：合成出的等级越高，奖励越多
export const MERGE_POINTS = [0, 2, 4, 7, 11, 16, 22, 30, 40, 55, 100]

const GRAVITY = 1500
const STEP = 1 / 120
const ITERATIONS = 6
const RESTITUTION = 0.15
const FRICTION = 0.08

export interface Fruit {
  id: number
  level: number
  x: number; y: number
  vx: number; vy: number
  r: number
  angle: number
  age: number
  /** 合成动画进度，0 → 1 */
  pop: number
}

export interface MergeEvent { level: number; x: number; y: number; points: number }

export class World {
  fruits: Fruit[] = []
  private nextId = 1
  private carry = 0

  add(level: number, x: number, y: number, vy = 0): Fruit {
    const r = RADII[level]
    const fruit: Fruit = { id: this.nextId++, level, x: clamp(x, r, WIDTH - r), y, vx: 0, vy, r, angle: 0, age: 0, pop: 1 }
    this.fruits.push(fruit)
    return fruit
  }

  /** 推进 dt 秒，返回本次发生的合成。 */
  update(dt: number): MergeEvent[] {
    const events: MergeEvent[] = []
    this.carry = Math.min(this.carry + dt, 0.1)
    while (this.carry >= STEP) {
      this.carry -= STEP
      this.step(events)
    }
    return events
  }

  private step(events: MergeEvent[]) {
    for (const f of this.fruits) {
      f.vy += GRAVITY * STEP
      f.x += f.vx * STEP
      f.y += f.vy * STEP
      f.age += STEP
      f.pop = Math.min(1, f.pop + STEP * 6)
    }
    const merged = new Set<Fruit>()
    for (let k = 0; k < ITERATIONS; k++) {
      const list = this.fruits
      for (let i = 0; i < list.length; i++) {
        const a = list[i]
        if (merged.has(a)) continue
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j]
          if (merged.has(b)) continue
          const dx = b.x - a.x, dy = b.y - a.y
          const min = a.r + b.r
          const d2 = dx * dx + dy * dy
          if (d2 >= min * min) continue
          if (a.level === b.level && a.level < MAX_LEVEL) {
            merged.add(a); merged.add(b)
            events.push(this.merge(a, b))
            break
          }
          this.resolve(a, b, dx, dy, Math.sqrt(d2) || 0.001, min)
        }
      }
      if (merged.size) {
        this.fruits = this.fruits.filter(f => !merged.has(f))
        merged.clear()
      }
      for (const f of this.fruits) this.walls(f)
    }
    for (const f of this.fruits) {
      // 滚动：按水平速度近似转动，看起来更自然
      f.angle += (f.vx / f.r) * STEP
      f.vx *= 0.998
    }
  }

  private merge(a: Fruit, b: Fruit): MergeEvent {
    const level = a.level + 1
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2
    const fruit = this.add(level, x, y)
    fruit.vx = (a.vx + b.vx) / 2
    fruit.vy = Math.min(a.vy, b.vy, 0) - 120
    fruit.age = Math.max(a.age, b.age)
    fruit.pop = 0.4
    return { level, x, y, points: MERGE_POINTS[level] }
  }

  private resolve(a: Fruit, b: Fruit, dx: number, dy: number, dist: number, min: number) {
    const nx = dx / dist, ny = dy / dist
    const ma = a.r * a.r, mb = b.r * b.r
    const ia = mb / (ma + mb), ib = ma / (ma + mb)
    const overlap = min - dist
    a.x -= nx * overlap * ia; a.y -= ny * overlap * ia
    b.x += nx * overlap * ib; b.y += ny * overlap * ib
    const rvx = b.vx - a.vx, rvy = b.vy - a.vy
    const vn = rvx * nx + rvy * ny
    if (vn >= 0) return
    const j = -(1 + RESTITUTION) * vn
    a.vx -= j * nx * ia; a.vy -= j * ny * ia
    b.vx += j * nx * ib; b.vy += j * ny * ib
    // 切向摩擦，避免水果像冰块一样无限滑动
    const tx = -ny, ty = nx
    const vt = rvx * tx + rvy * ty
    a.vx += vt * tx * FRICTION * ia; a.vy += vt * ty * FRICTION * ia
    b.vx -= vt * tx * FRICTION * ib; b.vy -= vt * ty * FRICTION * ib
  }

  private walls(f: Fruit) {
    if (f.x < f.r) { f.x = f.r; if (f.vx < 0) f.vx *= -RESTITUTION }
    if (f.x > WIDTH - f.r) { f.x = WIDTH - f.r; if (f.vx > 0) f.vx *= -RESTITUTION }
    if (f.y > HEIGHT - f.r) {
      f.y = HEIGHT - f.r
      if (f.vy > 0) f.vy *= -RESTITUTION
      f.vx *= 0.97
    }
  }

  /** 已稳定的水果越过警戒线即危险。 */
  overLine() {
    return this.fruits.some(f => f.age > 1.2 && f.y - f.r < LINE_Y && Math.abs(f.vy) < 60)
  }
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
