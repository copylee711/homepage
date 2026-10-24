/** 键鼠与触屏输入：电脑 WASD + 鼠标/方向键射击，手机左摇杆 + 右侧按钮。 */
import type { Input } from './game'

export interface TouchState {
  active: boolean
  stick: { x: number; y: number } | null
  moveX: number; moveY: number
  firing: boolean
  aim: number | null
  /** 射击键拖动幅度 0–1，用于按钮偏移与指示强度 */
  drag: number
}

interface Circle { x: number; y: number; r: number }

/** 触屏按钮布局（CSS 像素），渲染与命中检测共用。 */
export function touchLayout(width: number, height: number) {
  const unit = Math.min(height * 0.12, width * 0.075, 60)
  const fire: Circle = { x: width - unit * 1.9, y: height - unit * 1.9, r: unit }
  return {
    stick: { x: unit * 2.1, y: height - unit * 2, r: unit * 1.1 },
    fire,
    dash: { x: fire.x - unit * 2.05, y: fire.y + unit * 0.45, r: unit * 0.62 },
    swap: { x: fire.x + unit * 0.2, y: fire.y - unit * 1.85, r: unit * 0.5 },
    interact: { x: fire.x - unit * 1.75, y: fire.y - unit * 1.35, r: unit * 0.58 },
  }
}

const inside = (c: Circle, x: number, y: number, pad = 1.25) => Math.hypot(x - c.x, y - c.y) < c.r * pad

export class Controls {
  keys = new Set<string>()
  touch: TouchState = { active: false, stick: null, moveX: 0, moveY: 0, firing: false, aim: null, drag: 0 }
  private mouse = { x: 0, y: 0, down: false, last: -1e9 }
  private stickId: number | null = null
  private fireId: number | null = null
  private fireStart = { x: 0, y: 0 }
  private queued = { dash: false, swap: false, interact: false }
  private el?: HTMLElement
  /** 把屏幕坐标（CSS 像素，相对画布）转换为世界坐标 */
  toWorld: (x: number, y: number) => { x: number; y: number } = (x, y) => ({ x, y })
  playerPos: () => { x: number; y: number } = () => ({ x: 0, y: 0 })
  onPause: () => void = () => {}

  attach(el: HTMLElement) {
    this.el = el
    window.addEventListener('keydown', this.keydown)
    window.addEventListener('keyup', this.keyup)
    window.addEventListener('blur', this.blur)
    el.addEventListener('pointerdown', this.down)
    el.addEventListener('pointermove', this.move)
    el.addEventListener('pointerup', this.up)
    el.addEventListener('pointercancel', this.up)
    el.addEventListener('contextmenu', this.prevent)
  }

  detach() {
    window.removeEventListener('keydown', this.keydown)
    window.removeEventListener('keyup', this.keyup)
    window.removeEventListener('blur', this.blur)
    const el = this.el
    if (!el) return
    el.removeEventListener('pointerdown', this.down)
    el.removeEventListener('pointermove', this.move)
    el.removeEventListener('pointerup', this.up)
    el.removeEventListener('pointercancel', this.up)
    el.removeEventListener('contextmenu', this.prevent)
  }

  private prevent = (e: Event) => e.preventDefault()

  private blur = () => { this.keys.clear(); this.mouse.down = false; this.releaseTouch() }

  private releaseTouch() {
    this.stickId = this.fireId = null
    Object.assign(this.touch, { stick: null, moveX: 0, moveY: 0, firing: false, aim: null, drag: 0 })
  }

  private keydown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return
    const k = e.key.toLowerCase()
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'w', 'a', 's', 'd', 'shift', 'q', 'e', 'escape', 'p', 'f'].includes(k)) e.preventDefault()
    if (e.repeat) return
    this.keys.add(k)
    this.touch.active = false
    if (k === ' ' || k === 'shift') this.queued.dash = true
    if (k === 'q') this.queued.swap = true
    if (k === 'e' || k === 'f') this.queued.interact = true
    if (k === 'escape' || k === 'p') this.onPause()
  }

  private keyup = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()) }

  /** 画面被旋转 90° 显示时为 true，触点坐标需要换算回画面坐标 */
  rotated = false

  private local(e: PointerEvent) {
    const el = this.el!, rect = el.getBoundingClientRect()
    if (this.rotated) return { x: e.clientY - rect.top, y: rect.right - e.clientX, w: el.clientWidth, h: el.clientHeight }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height }
  }

  private down = (e: PointerEvent) => {
    const { x, y, w, h } = this.local(e)
    if (e.pointerType !== 'touch') {
      this.touch.active = false
      this.mouse = { x, y, down: e.button === 0, last: performance.now() }
      if (e.button === 2) this.queued.dash = true
      return
    }
    e.preventDefault()
    this.touch.active = true
    this.el!.setPointerCapture?.(e.pointerId)
    const L = touchLayout(w, h)
    if (inside(L.dash, x, y)) { this.queued.dash = true; return }
    if (inside(L.swap, x, y)) { this.queued.swap = true; return }
    if (inside(L.interact, x, y, 1.1)) { this.queued.interact = true; return }
    if (x > w * 0.5) {
      if (this.fireId === null) {
        this.fireId = e.pointerId
        this.fireStart = inside(L.fire, x, y, 1.6) ? { x: L.fire.x, y: L.fire.y } : { x, y }
        this.touch.firing = true
        this.touch.aim = null
        this.touch.drag = 0
        navigator.vibrate?.(8)
      }
      return
    }
    if (this.stickId === null) {
      this.stickId = e.pointerId
      this.touch.stick = { x, y }
      this.touch.moveX = this.touch.moveY = 0
    }
  }

  private move = (e: PointerEvent) => {
    const { x, y, w, h } = this.local(e)
    if (e.pointerType !== 'touch') {
      this.mouse.x = x; this.mouse.y = y; this.mouse.last = performance.now()
      return
    }
    const L = touchLayout(w, h)
    if (e.pointerId === this.stickId && this.touch.stick) {
      let dx = (x - this.touch.stick.x) / L.stick.r, dy = (y - this.touch.stick.y) / L.stick.r
      const len = Math.hypot(dx, dy)
      if (len > 1) {
        // 手指拖出范围时让摇杆底座跟随
        this.touch.stick.x += (dx / len) * (len - 1) * L.stick.r
        this.touch.stick.y += (dy / len) * (len - 1) * L.stick.r
        dx /= len; dy /= len
      }
      this.touch.moveX = dx; this.touch.moveY = dy
    } else if (e.pointerId === this.fireId) {
      const dx = x - this.fireStart.x, dy = y - this.fireStart.y
      const len = Math.hypot(dx, dy)
      const manual = len > L.fire.r * 0.35
      // 从自动瞄准切到手动瞄准时轻震一下
      if (manual && this.touch.aim === null) navigator.vibrate?.(6)
      this.touch.aim = manual ? Math.atan2(dy, dx) : null
      this.touch.drag = Math.min(1, len / L.fire.r)
    }
  }

  private up = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') { if (e.button === 0) this.mouse.down = false; return }
    if (e.pointerId === this.stickId) { this.stickId = null; Object.assign(this.touch, { stick: null, moveX: 0, moveY: 0 }) }
    if (e.pointerId === this.fireId) { this.fireId = null; this.touch.firing = false; this.touch.aim = null; this.touch.drag = 0 }
  }

  /** 游戏实际处理过输入后再清除单次按键。 */
  consume() { this.queued = { dash: false, swap: false, interact: false } }

  read(): Input {
    const k = this.keys
    const input: Input = { moveX: 0, moveY: 0, aim: null, fire: false, ...this.queued }
    if (this.touch.active) {
      input.moveX = this.touch.moveX; input.moveY = this.touch.moveY
      input.fire = this.touch.firing
      input.aim = this.touch.aim
      return input
    }
    input.moveX = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0)
    input.moveY = (k.has('s') ? 1 : 0) - (k.has('w') ? 1 : 0)
    // 方向键射击（以撒式），优先于鼠标
    const ax = (k.has('arrowright') ? 1 : 0) - (k.has('arrowleft') ? 1 : 0)
    const ay = (k.has('arrowdown') ? 1 : 0) - (k.has('arrowup') ? 1 : 0)
    if (ax || ay) { input.aim = Math.atan2(ay, ax); input.fire = true; return input }
    if (this.mouse.down || performance.now() - this.mouse.last < 2500) {
      const target = this.toWorld(this.mouse.x, this.mouse.y), p = this.playerPos()
      input.aim = Math.atan2(target.y - p.y, target.x - p.x)
    }
    input.fire = this.mouse.down || k.has('j')
    return input
  }
}
