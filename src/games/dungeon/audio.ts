/**
 * 深渊骑士的音效与配乐：全部在浏览器里离线合成（OfflineAudioContext），不加载任何音频文件。
 * 音效在开局时一次性渲染成 AudioBuffer；配乐按场景懒渲染成可无缝循环的片段。
 */
import { ref } from 'vue'
import { muted } from '../sound'
import type { Sound } from './game'

const MUSIC_KEY = 'copylee-dungeon-music'
export const musicOn = ref(readMusic())
function readMusic() { try { return localStorage.getItem(MUSIC_KEY) !== '0' } catch { return true } }
export function toggleMusic() {
  musicOn.value = !musicOn.value
  try { localStorage.setItem(MUSIC_KEY, musicOn.value ? '1' : '0') } catch { /* 忽略 */ }
  if (!musicOn.value) stopMusic()
  else if (wanted) playMusic(wanted)
}

const RATE = 44100

// —— 合成工具 ——

type Filter = { type: BiquadFilterType; f: number; f2?: number; q?: number }

class Synth {
  readonly out: GainNode
  private white: AudioBuffer
  constructor(readonly ctx: OfflineAudioContext, dest?: AudioNode) {
    this.out = ctx.createGain()
    this.out.connect(dest ?? ctx.destination)
    this.white = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const d = this.white.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }

  /** 起音 attack 秒后到达 gain，在 t + dur 指数衰减到静音 */
  private env(t: number, dur: number, gain: number, attack = 0.002) {
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(gain, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, attack + 0.005))
    return g
  }

  private filter(t: number, dur: number, f: Filter) {
    const node = this.ctx.createBiquadFilter()
    node.type = f.type
    node.frequency.setValueAtTime(f.f, t)
    if (f.f2) node.frequency.exponentialRampToValueAtTime(f.f2, t + dur)
    node.Q.value = f.q ?? 0.8
    return node
  }

  noise(t: number, dur: number, gain: number, f?: Filter, attack = 0.002, dest: AudioNode = this.out) {
    const src = this.ctx.createBufferSource()
    src.buffer = this.white
    src.loop = true
    src.playbackRate.value = 0.8 + Math.random() * 0.4
    const env = this.env(t, dur, gain, attack)
    if (f) src.connect(this.filter(t, dur, f)).connect(env); else src.connect(env)
    env.connect(dest)
    src.start(t, Math.random()); src.stop(t + dur + 0.02)
    return env
  }

  tone(t: number, dur: number, type: OscillatorType, freq: number, gain: number, opts: { to?: number; attack?: number; filter?: Filter; detune?: number; vibrato?: number; dest?: AudioNode } = {}) {
    const osc = this.ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t)
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + dur)
    if (opts.detune) osc.detune.value = opts.detune
    if (opts.vibrato) {
      const lfo = this.ctx.createOscillator(), depth = this.ctx.createGain()
      lfo.frequency.value = 6; depth.gain.value = freq * opts.vibrato
      lfo.connect(depth).connect(osc.frequency)
      lfo.start(t); lfo.stop(t + dur + 0.02)
    }
    const env = this.env(t, dur, gain, opts.attack)
    if (opts.filter) osc.connect(this.filter(t, dur, opts.filter)).connect(env); else osc.connect(env)
    env.connect(opts.dest ?? this.out)
    osc.start(t); osc.stop(t + dur + 0.02)
    return env
  }

  /** 金属感的不和谐泛音（盾牌、陶罐、地刺） */
  metal(t: number, dur: number, base: number, gain: number, ratios = [1, 1.47, 2.09, 2.76], dest?: AudioNode) {
    ratios.forEach((r, i) => this.tone(t, dur * (1 - i * 0.15), 'sine', base * r, gain / (i + 1.4), { dest }))
  }

  /** 效果链：饱和失真（drive）后输出，并按 wet 比例送入 room 秒长的房间混响 */
  chain(drive: number, room: number, wet: number) {
    const input = this.ctx.createGain()
    let node: AudioNode = input
    if (drive) {
      const shaper = this.ctx.createWaveShaper(), curve = new Float32Array(1024), norm = Math.tanh(drive)
      for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / 511.5) - 1) * drive) / norm
      shaper.curve = curve; shaper.oversample = '2x'
      input.connect(shaper); node = shaper
    }
    node.connect(this.out)
    if (room && wet) {
      const conv = this.ctx.createConvolver(), send = this.ctx.createGain(), rate = this.ctx.sampleRate
      const ir = this.ctx.createBuffer(1, Math.ceil(rate * room), rate), d = ir.getChannelData(0)
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 4
      conv.buffer = ir; send.gain.value = wet
      node.connect(send).connect(conv).connect(this.out)
    }
    return input
  }

  /** 简易回声：把一段声音送进反馈延迟 */
  echo(time: number, feedback: number, damp = 2500) {
    const delay = this.ctx.createDelay(1), fb = this.ctx.createGain(), lp = this.ctx.createBiquadFilter()
    delay.delayTime.value = time; fb.gain.value = feedback; lp.type = 'lowpass'; lp.frequency.value = damp
    delay.connect(lp).connect(fb).connect(delay)
    lp.connect(this.out)
    return delay
  }
}

const note = (n: number) => 440 * 2 ** ((n - 69) / 12)

// —— 音效配方 ——

interface Recipe { len: number; vol: number; variants?: number; make: (s: Synth) => void }

const rand = (a: number, b: number) => a + Math.random() * (b - a)

/**
 * 枪声分层：极短的爆裂瞬态 + 低通扫频的枪口气浪 + 下沉的低频冲击 + 机械余响，
 * 一起送进饱和失真和短房间混响，听感更厚、更有冲击力。
 */
function gunshot(s: Synth, o: { blast: number; punch: number; crack?: number; drive?: number; room?: number; wet?: number; tone?: number; mech?: number; gain?: number }) {
  const bus = s.chain(o.drive ?? 4, o.room ?? 0.4, o.wet ?? 0.2)
  const g = o.gain ?? 1, tone = (o.tone ?? 1) * rand(0.92, 1.08)
  // 瞬态：几毫秒的高频爆裂与咔哒
  s.noise(0, 0.006, 1 * g, { type: 'highpass', f: (o.crack ?? 2600) * tone }, 0.0005, bus)
  s.tone(0, 0.012, 'square', 1800 * tone, 0.35 * g, { dest: bus, attack: 0.0005 })
  // 枪口气浪：明亮到沉闷
  s.noise(0, o.blast, 0.95 * g, { type: 'lowpass', f: 7500 * tone, f2: 450 * tone, q: 0.9 }, 0.001, bus)
  s.noise(0, o.blast * 0.6, 0.5 * g, { type: 'bandpass', f: 1300 * tone, f2: 500 * tone, q: 1.2 }, 0.001, bus)
  // 低频冲击
  s.tone(0, o.punch, 'sine', 150 * tone, 1.1 * g, { to: 45, dest: bus, attack: 0.001 })
  s.tone(0, o.punch * 0.6, 'triangle', 90 * tone, 0.6 * g, { to: 38, dest: bus, attack: 0.001 })
  // 机械：枪机回位的金属声
  if (o.mech) s.noise(o.mech, 0.02, 0.28 * g, { type: 'bandpass', f: rand(3200, 4200), q: 7 }, 0.001, bus)
  return bus
}

/** 挥砍的风声：带通噪声扫过一段频率 */
function whoosh(s: Synth, t: number, dur: number, from: number, to: number, gain: number, dest?: AudioNode) {
  s.noise(t, dur, gain, { type: 'bandpass', f: from, f2: to, q: 1.6 }, dur * 0.45, dest)
  s.noise(t, dur * 0.8, gain * 0.5, { type: 'bandpass', f: from * 1.9, f2: to * 1.9, q: 2.5 }, dur * 0.4, dest)
}

/** 打在肉上的闷响：冲击 + 湿润的中频 + 一点碎响 */
function impact(s: Synth, heavy: number, dest?: AudioNode) {
  const bus = dest ?? s.chain(3, 0.25, 0.12)
  const k = rand(0.9, 1.12)
  s.tone(0, 0.09 * heavy, 'sine', 210 * k, 1, { to: 55, dest: bus, attack: 0.001 })
  s.noise(0, 0.07 * heavy, 0.85, { type: 'bandpass', f: 1100 * k, f2: 280, q: 1.3 }, 0.001, bus)
  s.noise(0, 0.012, 0.6, { type: 'highpass', f: 3000 }, 0.0005, bus)
  s.noise(0.008, 0.05, 0.35, { type: 'lowpass', f: 700 }, 0.002, bus)
  return bus
}

const RECIPES: Record<Sound, Recipe> = {
  shoot: { len: 0.45, vol: 0.34, variants: 3, make: s => gunshot(s, { blast: 0.13, punch: 0.12, mech: 0.05, room: 0.4, wet: 0.2 }) },
  smg: { len: 0.3, vol: 0.28, variants: 4, make: s => gunshot(s, { blast: 0.07, punch: 0.06, tone: 1.15, crack: 3200, drive: 3, room: 0.3, wet: 0.14 }) },
  gatling: { len: 0.25, vol: 0.26, variants: 4, make: s => {
    gunshot(s, { blast: 0.06, punch: 0.05, tone: 1.25, crack: 3600, drive: 3, room: 0.25, wet: 0.12, gain: 0.9 })
    s.tone(0, 0.08, 'sawtooth', 240, 0.12, { filter: { type: 'lowpass', f: 900 } })
  } },
  shotgun: { len: 0.9, vol: 0.52, variants: 2, make: s => {
    const bus = gunshot(s, { blast: 0.3, punch: 0.26, tone: 0.8, crack: 1800, drive: 6, room: 0.7, wet: 0.28, gain: 1.2 })
    s.noise(0.004, 0.012, 0.8, { type: 'highpass', f: 2200 }, 0.0005, bus)
    // 上膛：两声“咔—嚓”
    s.noise(0.36, 0.03, 0.5, { type: 'bandpass', f: 2300, q: 5 }, 0.001)
    s.tone(0.36, 0.05, 'sine', 300, 0.3, { to: 160 })
    s.noise(0.46, 0.04, 0.55, { type: 'bandpass', f: 1500, q: 5 }, 0.001)
    s.tone(0.46, 0.06, 'sine', 220, 0.35, { to: 120 })
  } },
  sniper: { len: 1.6, vol: 0.56, make: s => {
    const bus = gunshot(s, { blast: 0.45, punch: 0.4, tone: 0.75, crack: 1500, drive: 7, room: 1.4, wet: 0.38, gain: 1.3 })
    s.noise(0, 0.02, 1, { type: 'highpass', f: 4000 }, 0.0005, bus)
    const tail = s.echo(0.21, 0.32, 1400)
    s.noise(0, 0.06, 0.6, { type: 'bandpass', f: 1200, q: 0.8 }, 0.001, tail)
  } },
  pistol: { len: 0.45, vol: 0.34, variants: 3, make: s => gunshot(s, { blast: 0.13, punch: 0.12, mech: 0.05 }) },
  bouncer: { len: 0.4, vol: 0.3, variants: 3, make: s => {
    const bus = s.chain(2, 0.3, 0.15), k = rand(0.92, 1.1)
    s.tone(0, 0.16, 'sine', 180 * k, 0.9, { to: 520 * k, dest: bus, attack: 0.002 })
    s.tone(0.02, 0.12, 'triangle', 420 * k, 0.4, { to: 260 * k, vibrato: 0.08, dest: bus })
    s.noise(0, 0.05, 0.5, { type: 'lowpass', f: 900 }, 0.001, bus)
  } },
  laser: { len: 0.5, vol: 0.32, variants: 3, make: s => {
    const bus = s.chain(2.5, 0.45, 0.22), k = rand(0.94, 1.08)
    for (const d of [-9, 9]) s.tone(0, 0.24, 'sawtooth', 2100 * k, 0.4, { to: 230, detune: d, dest: bus, filter: { type: 'lowpass', f: 7000, f2: 700 } })
    s.tone(0, 0.2, 'sine', 900 * k, 0.6, { to: 120, dest: bus })
    s.tone(0, 0.08, 'sine', 160, 0.7, { to: 60, dest: bus })
    s.noise(0, 0.03, 0.4, { type: 'highpass', f: 5000 }, 0.001, bus)
  } },
  frost: { len: 0.6, vol: 0.28, variants: 3, make: s => {
    const bus = s.chain(0, 0.6, 0.3)
    s.noise(0, 0.25, 0.6, { type: 'highpass', f: 6000, f2: 2500 }, 0.01, bus)
    for (let i = 0; i < 5; i++) s.tone(rand(0, 0.08), 0.22, 'sine', rand(2400, 4800), 0.22, { dest: bus })
    s.tone(0, 0.14, 'triangle', 700, 0.3, { to: 300, dest: bus })
  } },
  rocket: { len: 1, vol: 0.48, variants: 2, make: s => {
    const bus = s.chain(4, 0.6, 0.25)
    s.tone(0, 0.28, 'sine', 95, 1.1, { to: 38, dest: bus })
    s.noise(0, 0.12, 0.9, { type: 'lowpass', f: 1500, f2: 300 }, 0.001, bus)
    // 推进的嘶嘶声
    s.noise(0.04, 0.75, 0.6, { type: 'bandpass', f: 1600, f2: 3200, q: 0.7 }, 0.06, bus)
    s.noise(0.04, 0.6, 0.35, { type: 'lowpass', f: 500 }, 0.05, bus)
  } },
  bow: { len: 0.45, vol: 0.34, variants: 3, make: s => {
    const bus = s.chain(1.5, 0.3, 0.12), k = rand(0.94, 1.06)
    // 弓弦：低频的“嘣”带一点泛音
    s.tone(0, 0.2, 'triangle', 98 * k, 0.9, { to: 88 * k, dest: bus, attack: 0.001 })
    s.tone(0, 0.12, 'sawtooth', 196 * k, 0.3, { to: 176 * k, dest: bus, filter: { type: 'lowpass', f: 1400, f2: 400 } })
    s.noise(0, 0.01, 0.5, { type: 'bandpass', f: 2200, q: 3 }, 0.0005, bus)
    whoosh(s, 0.01, 0.24, 4200, 900, 0.5, bus)
  } },
  crossbow: { len: 0.35, vol: 0.32, variants: 3, make: s => {
    const bus = s.chain(2.5, 0.25, 0.12)
    s.noise(0, 0.018, 0.9, { type: 'bandpass', f: rand(2400, 3000), q: 5 }, 0.0005, bus)
    s.tone(0, 0.06, 'sine', 240, 0.8, { to: 90, dest: bus })
    s.tone(0, 0.08, 'triangle', 140, 0.5, { to: 120, dest: bus })
    whoosh(s, 0.01, 0.16, 3800, 1100, 0.4, bus)
  } },
  flame: { len: 0.4, vol: 0.2, variants: 3, make: s => {
    const bus = s.chain(2, 0, 0)
    s.noise(0, 0.32, 0.7, { type: 'bandpass', f: rand(500, 800), f2: 1300, q: 0.6 }, 0.04, bus)
    s.noise(0, 0.3, 0.5, { type: 'lowpass', f: 260 }, 0.04, bus)
    for (let i = 0; i < 4; i++) s.noise(rand(0.02, 0.25), 0.008, 0.35, { type: 'highpass', f: 3500 }, 0.0005, bus)
  } },
  thunder: { len: 0.8, vol: 0.4, variants: 3, make: s => {
    const bus = s.chain(5, 0.7, 0.3)
    for (let i = 0; i < 12; i++) s.noise(i * 0.025 + rand(0, 0.015), 0.03, rand(0.4, 1), { type: 'highpass', f: rand(1500, 4500) }, 0.0005, bus)
    s.tone(0, 0.4, 'sawtooth', 110, 0.4, { dest: bus, filter: { type: 'lowpass', f: 1600, f2: 300 } })
    s.tone(0, 0.25, 'sine', 140, 0.9, { to: 40, dest: bus })
  } },
  boomerang: { len: 0.5, vol: 0.26, make: s => {
    for (let i = 0; i < 4; i++) whoosh(s, i * 0.1, 0.12, 600, 1600, 0.5)
  } },
  swing: { len: 0.5, vol: 0.36, variants: 3, make: s => {
    const bus = s.chain(2, 0.35, 0.15), k = rand(0.94, 1.08)
    // 光剑：两把略微失谐的锯齿波嗡鸣，配合风声
    for (const d of [-12, 12]) s.tone(0, 0.32, 'sawtooth', 110 * k, 0.4, { to: 160 * k, detune: d, attack: 0.03, dest: bus, filter: { type: 'lowpass', f: 600, f2: 2400 } })
    whoosh(s, 0, 0.26, 600, 3000, 0.8, bus)
  } },
  axe: { len: 0.5, vol: 0.42, variants: 3, make: s => {
    const bus = s.chain(2.5, 0.3, 0.12)
    whoosh(s, 0, 0.3, 260, 1200, 1, bus)
    s.tone(0.12, 0.16, 'sine', 120, 0.5, { to: 50, dest: bus })
  } },
  hit: { len: 0.25, vol: 0.32, variants: 4, make: s => { impact(s, 1) } },
  crit: { len: 0.5, vol: 0.4, variants: 2, make: s => {
    const bus = impact(s, 1.4)
    s.metal(0.004, 0.3, rand(1500, 1900), 0.5, undefined, bus)
    s.noise(0, 0.02, 0.6, { type: 'highpass', f: 5000 }, 0.0005, bus)
  } },
  kill: { len: 0.5, vol: 0.4, variants: 3, make: s => {
    const bus = s.chain(3.5, 0.35, 0.15)
    impact(s, 1.6, bus)
    s.noise(0.01, 0.28, 0.75, { type: 'lowpass', f: 2200, f2: 180 }, 0.002, bus)
    for (let i = 0; i < 3; i++) s.noise(rand(0.02, 0.12), 0.03, 0.35, { type: 'bandpass', f: rand(500, 900), q: 3 }, 0.001, bus)
  } },
  hurt: { len: 0.5, vol: 0.5, variants: 2, make: s => {
    const bus = s.chain(3, 0.3, 0.15)
    s.metal(0, 0.28, 760, 0.5, undefined, bus)
    impact(s, 1.3, bus)
    s.tone(0, 0.22, 'square', 300, 0.3, { to: 110, dest: bus, filter: { type: 'lowpass', f: 1200 } })
  } },
  explode: { len: 1.8, vol: 0.62, variants: 2, make: s => {
    const bus = s.chain(5, 1.2, 0.3)
    s.noise(0, 0.03, 1, { type: 'highpass', f: 1500 }, 0.0005, bus)
    s.noise(0, 1.3, 1, { type: 'lowpass', f: 2200, f2: 90 }, 0.003, bus)
    s.tone(0, 0.8, 'sine', 75, 1.2, { to: 26, dest: bus })
    for (let i = 0; i < 8; i++) s.noise(rand(0.15, 0.9), 0.03, 0.18, { type: 'bandpass', f: rand(1500, 3500), q: 3 })
  } },
  pickup: { len: 0.25, vol: 0.25, make: s => { s.tone(0, 0.09, 'triangle', note(81), 0.6); s.tone(0.06, 0.14, 'triangle', note(88), 0.6) } },
  weapon: { len: 0.35, vol: 0.32, make: s => {
    s.noise(0, 0.02, 0.7, { type: 'highpass', f: 3000 }); s.tone(0, 0.05, 'sine', 300, 0.4, { to: 150 })
    s.noise(0.12, 0.03, 0.8, { type: 'bandpass', f: 2400, q: 4 }); s.noise(0.17, 0.04, 0.6, { type: 'bandpass', f: 1700, q: 4 })
    s.tone(0.17, 0.08, 'sine', 220, 0.4, { to: 120 })
  } },
  item: { len: 1, vol: 0.3, make: s => {
    [72, 76, 79, 84].forEach((n, i) => { s.tone(i * 0.07, 0.5, 'triangle', note(n), 0.45); s.tone(i * 0.07, 0.6, 'sine', note(n + 12), 0.18, { detune: 6 }) })
    s.noise(0.25, 0.5, 0.12, { type: 'highpass', f: 6000 }, 0.2)
  } },
  coin: { len: 0.35, vol: 0.2, make: s => {
    s.tone(0, 0.08, 'square', note(91), 0.25, { filter: { type: 'lowpass', f: 5000 } }); s.tone(0, 0.08, 'sine', note(91), 0.5)
    s.tone(0.06, 0.28, 'sine', note(96), 0.6); s.tone(0.06, 0.22, 'square', note(96), 0.15, { filter: { type: 'lowpass', f: 5000 } })
  } },
  key: { len: 0.4, vol: 0.28, make: s => { for (let i = 0; i < 4; i++) s.metal(i * 0.06, 0.15, 2400 + Math.random() * 1200, 0.35, [1, 1.6, 2.3]) } },
  buy: { len: 0.6, vol: 0.32, make: s => {
    s.noise(0, 0.08, 0.5, { type: 'highpass', f: 4000 })
    for (let i = 0; i < 5; i++) s.metal(0.03 + i * 0.03, 0.12, 2800 + Math.random() * 1500, 0.2, [1, 1.5])
    s.tone(0.15, 0.4, 'sine', note(84), 0.5); s.tone(0.25, 0.35, 'sine', note(91), 0.5)
  } },
  deny: { len: 0.35, vol: 0.28, make: s => {
    s.tone(0, 0.11, 'square', 196, 0.4, { filter: { type: 'lowpass', f: 1200 } })
    s.tone(0.13, 0.16, 'square', 147, 0.4, { filter: { type: 'lowpass', f: 1000 } })
  } },
  chest: { len: 1, vol: 0.32, make: s => {
    s.tone(0, 0.35, 'sawtooth', 110, 0.3, { to: 165, vibrato: 0.04, filter: { type: 'lowpass', f: 700 } })
    s.tone(0.32, 0.08, 'sine', 120, 0.5, { to: 70 })
    ;[79, 83, 86, 91].forEach((n, i) => s.tone(0.38 + i * 0.06, 0.45, 'sine', note(n), 0.35))
  } },
  door: { len: 0.6, vol: 0.35, make: s => {
    s.tone(0, 0.3, 'sine', 90, 0.8, { to: 55 })
    s.noise(0, 0.35, 0.5, { type: 'lowpass', f: 700, f2: 200 })
    for (let i = 0; i < 4; i++) s.noise(0.12 + i * 0.07, 0.03, 0.25, { type: 'bandpass', f: 1800, q: 5 })
  } },
  dash: { len: 0.25, vol: 0.25, make: s => s.noise(0, 0.2, 0.7, { type: 'bandpass', f: 1600, f2: 450, q: 1 }, 0.03) },
  boss: { len: 2.2, vol: 0.5, make: s => {
    for (const t of [0, 0.45]) { s.tone(t, 0.6, 'sine', 70, 1, { to: 38 }); s.noise(t, 0.3, 0.4, { type: 'lowpass', f: 400 }) }
    for (const n of [45, 52, 57]) s.tone(0.5, 1.6, 'sawtooth', note(n), 0.18, { attack: 0.25, filter: { type: 'lowpass', f: 500, f2: 1400 } })
  } },
  bossDown: { len: 2.6, vol: 0.6, make: s => {
    s.noise(0, 1.8, 1, { type: 'lowpass', f: 1400, f2: 90 }, 0.01)
    s.tone(0, 1.2, 'sine', 60, 1, { to: 25 })
    ;[60, 64, 67, 72].forEach(n => s.tone(1, 1.5, 'triangle', note(n), 0.22, { attack: 0.08 }))
  } },
  stairs: { len: 1.4, vol: 0.32, make: s => {
    for (let i = 0; i < 4; i++) { s.noise(i * 0.16, 0.06, 0.4 - i * 0.07, { type: 'lowpass', f: 900 }); s.tone(i * 0.16, 0.06, 'sine', 120, 0.3 - i * 0.05, { to: 70 }) }
    s.noise(0.2, 1, 0.12, { type: 'bandpass', f: 400, q: 0.5 }, 0.3)
    ;[67, 71, 74, 79].forEach((n, i) => s.tone(0.6 + i * 0.09, 0.6, 'triangle', note(n), 0.3))
  } },
  empty: { len: 0.12, vol: 0.25, make: s => { s.noise(0, 0.015, 0.8, { type: 'bandpass', f: 2200, q: 4 }); s.tone(0.02, 0.05, 'square', 140, 0.2, { filter: { type: 'lowpass', f: 800 } }) } },
  enemyShoot: { len: 0.14, vol: 0.12, make: s => { s.tone(0, 0.1, 'sine', 760, 0.6, { to: 330 }); s.noise(0, 0.05, 0.2, { type: 'bandpass', f: 1500, q: 1.5 }) } },
  enemyFire: { len: 0.45, vol: 0.28, make: s => { s.noise(0, 0.4, 0.8, { type: 'bandpass', f: 500, f2: 1200, q: 0.7 }, 0.06); s.tone(0, 0.3, 'sine', 80, 0.3, { to: 50 }) } },
  heal: { len: 0.7, vol: 0.28, make: s => [72, 76, 79, 84].forEach((n, i) => s.tone(i * 0.08, 0.45, 'sine', note(n), 0.45, { attack: 0.02 })) },
  block: { len: 0.35, vol: 0.32, make: s => { s.metal(0, 0.3, 1150, 0.6); s.noise(0, 0.03, 0.6, { type: 'highpass', f: 2500 }) } },
  skillKnight: { len: 0.6, vol: 0.45, make: s => {
    s.metal(0, 0.35, 680, 0.6)
    s.noise(0.04, 0.45, 0.7, { type: 'bandpass', f: 350, f2: 1300, q: 0.8 }, 0.08)
    s.tone(0, 0.3, 'sine', 100, 0.7, { to: 50 })
  } },
  skillRanger: { len: 0.6, vol: 0.38, make: s => {
    s.noise(0, 0.45, 0.7, { type: 'bandpass', f: 900, f2: 4200, q: 1 }, 0.05)
    s.tone(0.05, 0.4, 'sine', note(88), 0.35); s.tone(0.12, 0.4, 'sine', note(93), 0.3)
  } },
  skillMage: { len: 0.9, vol: 0.42, make: s => {
    s.noise(0, 0.6, 0.6, { type: 'highpass', f: 5000, f2: 1800 }, 0.03)
    for (let i = 0; i < 14; i++) s.tone(Math.random() * 0.5, 0.25, 'sine', 2000 + Math.random() * 3500, 0.12)
    s.tone(0, 0.5, 'sine', 180, 0.5, { to: 70 })
  } },
  crate: { len: 0.35, vol: 0.38, make: s => {
    for (let i = 0; i < 4; i++) s.noise(i * 0.03 + Math.random() * 0.02, 0.08, 0.7, { type: 'bandpass', f: 500 + Math.random() * 900, q: 2 })
    s.tone(0, 0.12, 'sine', 160, 0.6, { to: 90 })
  } },
  pot: { len: 0.4, vol: 0.32, make: s => {
    s.metal(0, 0.2, 1300, 0.5, [1, 1.62, 2.6])
    for (let i = 0; i < 5; i++) s.noise(0.02 + Math.random() * 0.2, 0.03, 0.4, { type: 'highpass', f: 3000 })
  } },
  spike: { len: 0.25, vol: 0.2, make: s => { s.noise(0, 0.05, 0.7, { type: 'highpass', f: 3000 }); s.metal(0, 0.12, 1500, 0.3, [1, 1.9]) } },
  vent: { len: 0.8, vol: 0.25, make: s => s.noise(0, 0.75, 0.8, { type: 'bandpass', f: 400, f2: 900, q: 0.6 }, 0.08) },
  bless: { len: 1.4, vol: 0.3, make: s => {
    ;[60, 64, 67, 72, 76].forEach(n => s.tone(0, 1.3, 'sine', note(n), 0.25, { attack: 0.3 }))
    s.noise(0.2, 1, 0.08, { type: 'highpass', f: 7000 }, 0.4)
  } },
  curse: { len: 1.3, vol: 0.32, make: s => {
    s.tone(0, 1.2, 'sawtooth', 98, 0.35, { attack: 0.15, filter: { type: 'lowpass', f: 600 } })
    s.tone(0, 1.2, 'sawtooth', 103.8, 0.35, { attack: 0.15, filter: { type: 'lowpass', f: 600 } })
    s.tone(0, 1.1, 'sine', 55, 0.5, { to: 40 })
  } },
  secret: { len: 1.4, vol: 0.38, make: s => {
    s.noise(0, 0.7, 0.6, { type: 'lowpass', f: 700, f2: 150 })
    ;[67, 71, 74, 79, 83].forEach((n, i) => s.tone(0.3 + i * 0.08, 0.5, 'triangle', note(n), 0.3))
  } },
  revive: { len: 1.6, vol: 0.4, make: s => {
    s.tone(0, 1.2, 'sine', 300, 0.5, { to: 1200, attack: 0.1 })
    ;[72, 76, 79].forEach(n => s.tone(0.7, 0.8, 'triangle', note(n), 0.25, { attack: 0.05 }))
  } },
  spore: { len: 0.5, vol: 0.25, make: s => { s.noise(0, 0.45, 0.6, { type: 'bandpass', f: 1300, f2: 600, q: 0.8 }, 0.06); s.tone(0, 0.1, 'sine', 200, 0.3, { to: 100 }) } },
  roots: { len: 0.7, vol: 0.38, make: s => {
    for (let i = 0; i < 6; i++) s.noise(0.05 + i * 0.05, 0.06, 0.6, { type: 'bandpass', f: 300 + Math.random() * 600, q: 2.5 })
    s.noise(0, 0.6, 0.5, { type: 'lowpass', f: 300 }, 0.05)
  } },
  beam: { len: 1, vol: 0.32, make: s => {
    for (const f of [220, 331, 440]) s.tone(0, 0.9, 'sawtooth', f, 0.16, { vibrato: 0.02, attack: 0.05, filter: { type: 'lowpass', f: 2400 } })
    s.noise(0, 0.9, 0.15, { type: 'highpass', f: 5000 }, 0.1)
  } },
  emerge: { len: 0.7, vol: 0.38, make: s => {
    s.noise(0, 0.6, 0.8, { type: 'lowpass', f: 380 }, 0.05)
    s.noise(0.1, 0.45, 0.35, { type: 'highpass', f: 3000 }, 0.05)
    s.tone(0.05, 0.4, 'sawtooth', 70, 0.3, { to: 55, filter: { type: 'lowpass', f: 400 } })
  } },
  ghost: { len: 0.8, vol: 0.22, make: s => {
    s.tone(0, 0.7, 'sine', 520, 0.5, { to: 260, vibrato: 0.03, attack: 0.1 })
    s.noise(0, 0.6, 0.2, { type: 'bandpass', f: 1200, q: 1 }, 0.15)
  } },
  quake: { len: 0.8, vol: 0.5, make: s => { s.tone(0, 0.6, 'sine', 55, 1, { to: 28 }); s.noise(0, 0.6, 0.7, { type: 'lowpass', f: 300, f2: 80 }) } },
}

/** 同一音效的最短间隔（毫秒），防止高射速武器刷屏 */
const GAP: Partial<Record<Sound, number>> = { hit: 45, crit: 60, shoot: 30, pistol: 30, smg: 40, bouncer: 40, frost: 50, gatling: 40, flame: 90, enemyShoot: 60, coin: 35, enemyFire: 200, spike: 200, dash: 60 }

// —— 播放 ——

let ctx: AudioContext | undefined
let sfxBus: GainNode | undefined
let musicBus: GainNode | undefined
const buffers = new Map<Sound, AudioBuffer[]>()
const lastPlayed = new Map<Sound, number>()
let rendering: Promise<void> | undefined

function context() {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new AC()
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -12; comp.ratio.value = 4
    comp.connect(ctx.destination)
    sfxBus = ctx.createGain(); sfxBus.connect(comp)
    musicBus = ctx.createGain(); musicBus.gain.value = 0.55; musicBus.connect(comp)
  }
  return ctx
}

async function renderSound(name: Sound) {
  const r = RECIPES[name]
  const list: AudioBuffer[] = []
  for (let v = 0; v < (r.variants ?? 1); v++) {
    const off = new OfflineAudioContext(1, Math.ceil(r.len * RATE), RATE)
    r.make(new Synth(off))
    const buffer = await off.startRendering()
    // 统一峰值，再按配方音量播放
    const data = buffer.getChannelData(0)
    let peak = 0
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
    if (peak > 0) for (let i = 0; i < data.length; i++) data[i] = (data[i] / peak) * r.vol
    list.push(buffer)
    buffers.set(name, list)
  }
}

const FIRST: Sound[] = ['pistol', 'bow', 'hit', 'kill', 'hurt', 'coin', 'door', 'enemyShoot', 'frost', 'smg']

/** 在用户点击时调用：解锁音频并开始渲染全部音效 */
export function unlockAudio() {
  try {
    const c = context()
    if (c.state === 'suspended') c.resume()
    rendering ??= (async () => {
      // 先渲染最常用的，其余在空闲时依次完成
      const order = (Object.keys(RECIPES) as Sound[]).sort((a, b) => Number(!FIRST.includes(a)) - Number(!FIRST.includes(b)))
      for (const name of order) await renderSound(name).catch(() => {})
    })()
  } catch { /* 不支持 WebAudio 时静默 */ }
}

export function playSound(name: Sound) {
  if (muted.value || !ctx || !sfxBus) return
  const list = buffers.get(name)
  if (!list?.length) return
  const buffer = list[Math.floor(Math.random() * list.length)]
  const now = performance.now(), gap = GAP[name] ?? 0
  if (gap && now - (lastPlayed.get(name) ?? 0) < gap) return
  lastPlayed.set(name, now)
  if (ctx.state === 'suspended') ctx.resume()
  const src = ctx.createBufferSource()
  src.buffer = buffer
  // 每次音高略有不同，连续播放时更自然
  src.playbackRate.value = 0.96 + Math.random() * 0.08
  src.connect(sfxBus)
  src.start()
}

// —— 配乐 ——

export type Track = 'menu' | 'stone' | 'moss' | 'lava' | 'sand' | 'boss' | 'shop'

interface Song {
  bpm: number
  /** 每小节的和弦根音（MIDI）与音阶 */
  chords: number[]
  scale: number[]
  /** 鼓点密度 0–2；琶音音色；主旋律概率 */
  drums: number
  lead: OscillatorType
  pluck: OscillatorType
  pad: number
  melody: number
  seed: number
}

const MINOR = [0, 2, 3, 5, 7, 8, 10], DORIAN = [0, 2, 3, 5, 7, 9, 10], PHRYGIAN = [0, 1, 3, 5, 7, 8, 10]
const HIJAZ = [0, 1, 4, 5, 7, 8, 10], MAJOR = [0, 2, 4, 5, 7, 9, 11]
const SONGS: Record<Track, Song> = {
  menu: { bpm: 84, chords: [45, 41, 43, 40, 45, 41, 38, 40], scale: MINOR, drums: 0, lead: 'triangle', pluck: 'triangle', pad: 0.5, melody: 0.35, seed: 3 },
  stone: { bpm: 116, chords: [50, 46, 48, 45, 50, 46, 43, 45], scale: MINOR, drums: 1, lead: 'square', pluck: 'triangle', pad: 0.35, melody: 0.5, seed: 11 },
  moss: { bpm: 108, chords: [52, 50, 48, 50, 52, 55, 50, 47], scale: DORIAN, drums: 1, lead: 'triangle', pluck: 'sine', pad: 0.4, melody: 0.45, seed: 23 },
  lava: { bpm: 128, chords: [48, 49, 48, 46, 48, 49, 51, 49], scale: PHRYGIAN, drums: 2, lead: 'sawtooth', pluck: 'square', pad: 0.3, melody: 0.5, seed: 37 },
  sand: { bpm: 114, chords: [50, 51, 50, 48, 50, 51, 53, 51], scale: HIJAZ, drums: 1, lead: 'triangle', pluck: 'triangle', pad: 0.35, melody: 0.55, seed: 41 },
  boss: { bpm: 144, chords: [45, 45, 41, 43, 45, 45, 48, 44], scale: MINOR, drums: 2, lead: 'sawtooth', pluck: 'square', pad: 0.4, melody: 0.6, seed: 59 },
  shop: { bpm: 102, chords: [53, 50, 46, 48, 53, 50, 46, 48], scale: MAJOR, drums: 1, lead: 'triangle', pluck: 'triangle', pad: 0.3, melody: 0.5, seed: 71 },
}

function seeded(seed: number) {
  return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
}

/** 生成一段 8 小节、可无缝循环的配乐 */
async function renderSong(song: Song) {
  const beat = 60 / song.bpm, bar = beat * 4, length = bar * song.chords.length
  const rate = 32000
  const off = new OfflineAudioContext(2, Math.ceil((length + 2.5) * rate), rate)
  const master = off.createGain(); master.gain.value = 0.9; master.connect(off.destination)
  // 混响：衰减的立体声噪声冲激
  const verb = off.createConvolver()
  const ir = off.createBuffer(2, rate * 2, rate)
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3 }
  verb.buffer = ir
  const wet = off.createGain(); wet.gain.value = 0.3
  wet.connect(verb).connect(master)
  const dry = off.createGain(); dry.connect(master)
  const s = new Synth(off, dry)
  const send = (node: GainNode) => node.connect(wet)
  const random = seeded(song.seed)
  const degree = (root: number, step: number) => {
    const n = song.scale.length, oct = Math.floor(step / n), i = ((step % n) + n) % n
    return root + song.scale[i] + oct * 12
  }

  song.chords.forEach((root, b) => {
    const t0 = b * bar
    // 低音：每拍一个，带八分音符的推动
    for (let i = 0; i < 8; i++) {
      if (song.drums === 0 && i % 2) continue
      const n = root - 12 + (i % 4 === 3 ? 7 : 0)
      s.tone(t0 + i * beat / 2, beat / 2 * 0.9, 'sawtooth', note(n), song.drums === 0 ? 0.18 : 0.22, { filter: { type: 'lowpass', f: 600, f2: 200 }, attack: 0.005 })
    }
    // 和声垫底：小三和弦或大三和弦（依音阶）
    for (const step of [0, 2, 4]) {
      const env = s.tone(t0, bar * 1.02, 'sawtooth', note(degree(root, step) + 12), 0.05 * song.pad, { attack: bar * 0.25, detune: (random() - 0.5) * 14, filter: { type: 'lowpass', f: 1400 } })
      send(env)
    }
    // 琶音
    for (let i = 0; i < 8; i++) {
      const step = [0, 2, 4, 7, 4, 2, 4, 9][i]
      const env = s.tone(t0 + i * beat / 2, beat * 0.9, song.pluck, note(degree(root, step) + 12), 0.08, { filter: { type: 'lowpass', f: 3200, f2: 700 } })
      send(env)
    }
    // 主旋律：随机但落在音阶上，每两小节重复一次形成乐句
    const phrase = seeded(song.seed * 7 + (b % 2) * 13 + (b >= 4 ? 101 : 0))
    for (let i = 0; i < 8; i++) {
      if (phrase() > song.melody) continue
      const step = Math.floor(phrase() * 6) + (phrase() < 0.3 ? 7 : 0)
      const len = beat / 2 * (phrase() < 0.3 ? 2 : 1)
      const env = s.tone(t0 + i * beat / 2, len, song.lead, note(degree(root, step) + 24), 0.06, { vibrato: 0.006, attack: 0.01, filter: { type: 'lowpass', f: 2600 } })
      send(env)
    }
    // 鼓
    if (song.drums) for (let i = 0; i < 16; i++) {
      const t = t0 + i * beat / 4
      if (i % 8 === 0 || (song.drums > 1 && i % 8 === 6)) { s.tone(t, 0.3, 'sine', 140, 0.7, { to: 42 }); s.noise(t, 0.02, 0.2, { type: 'lowpass', f: 1200 }) }
      if (i % 8 === 4) { s.noise(t, 0.16, 0.35, { type: 'bandpass', f: 1800, q: 0.8 }); s.tone(t, 0.08, 'triangle', 190, 0.25, { to: 140 }) }
      if (i % 2 === 0 || song.drums > 1) s.noise(t, i % 4 === 2 ? 0.08 : 0.035, i % 4 === 2 ? 0.1 : 0.06, { type: 'highpass', f: 7000 })
    }
  })
  const rendered = await off.startRendering()
  // 把超出循环长度的混响尾巴叠回开头，循环时不会断
  const n = Math.round(length * rate)
  const loop = off.createBuffer(2, n, rate)
  for (let ch = 0; ch < 2; ch++) {
    const src = rendered.getChannelData(ch), dst = loop.getChannelData(ch)
    for (let i = 0; i < n; i++) dst[i] = src[i] + (i + n < src.length ? src[i + n] : 0)
  }
  return loop
}

const songs = new Map<Track, Promise<AudioBuffer>>()
let current: { track: Track; src: AudioBufferSourceNode; gain: GainNode } | undefined
let wanted: Track | undefined

export function playMusic(track: Track) {
  wanted = track
  if (!musicOn.value || muted.value || !ctx || !musicBus) return
  if (current?.track === track) return
  let job = songs.get(track)
  if (!job) { job = renderSong(SONGS[track]); songs.set(track, job) }
  job.then(buffer => {
    if (wanted !== track || current?.track === track || !ctx || !musicBus || !musicOn.value || muted.value) return
    fadeOut()
    const src = ctx.createBufferSource(), gain = ctx.createGain()
    src.buffer = buffer; src.loop = true
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 1.2)
    src.connect(gain).connect(musicBus)
    src.start()
    current = { track, src, gain }
  }).catch(() => {})
}

function fadeOut() {
  if (!current || !ctx) return
  const { src, gain } = current
  gain.gain.cancelScheduledValues(ctx.currentTime)
  gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8)
  src.stop(ctx.currentTime + 0.85)
  current = undefined
}

export function stopMusic() { fadeOut() }

/** 暂停时把音乐压低 */
export function duckMusic(on: boolean) {
  if (!ctx || !musicBus) return
  musicBus.gain.setTargetAtTime(on ? 0.18 : 0.55, ctx.currentTime, 0.2)
}

/** 全部音效渲染完成（调试与测试用） */
export const audioReady = () => rendering ?? Promise.resolve()
