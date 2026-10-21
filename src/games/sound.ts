import { ref } from 'vue'

/** 用 WebAudio 合成的简短音效，不加载任何音频文件。 */
const KEY = 'copylee-game-muted'
export const muted = ref(read())
let ctx: AudioContext | undefined

function read() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function toggleMute() {
  muted.value = !muted.value
  try { localStorage.setItem(KEY, muted.value ? '1' : '0') } catch { /* 忽略 */ }
}

function tone(freq: number, duration: number, type: OscillatorType = 'sine', gain = 0.15, slide = 0, delay = 0) {
  if (muted.value) return
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') ctx.resume()
    const start = ctx.currentTime + delay
    const osc = ctx.createOscillator(), amp = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, start)
    if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, start + duration)
    amp.gain.setValueAtTime(gain, start)
    amp.gain.exponentialRampToValueAtTime(0.001, start + duration)
    osc.connect(amp).connect(ctx.destination)
    osc.start(start)
    osc.stop(start + duration)
  } catch { /* 浏览器不支持时静默 */ }
}

export const sfx = {
  drop: () => tone(220, 0.12, 'triangle', 0.12, 0.6),
  tap: () => tone(660, 0.06, 'triangle', 0.08),
  merge: (level: number) => { tone(330 * 2 ** (level / 12), 0.18, 'sine', 0.16, 1.5); tone(495 * 2 ** (level / 12), 0.2, 'triangle', 0.08, 1.2, 0.05) },
  clear: () => { tone(523, 0.1, 'triangle', 0.12); tone(659, 0.1, 'triangle', 0.12, 1, 0.07); tone(784, 0.16, 'triangle', 0.12, 1, 0.14) },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.12, 1, i * 0.1)),
  lose: () => tone(300, 0.5, 'sawtooth', 0.06, 0.4),
}

let noiseBuffer: AudioBuffer | undefined
function noise(duration: number, gain = 0.2, filter = 1200) {
  if (muted.value) return
  try {
    ctx ??= new AudioContext()
    if (!noiseBuffer) {
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
      const data = noiseBuffer.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    }
    const src = ctx.createBufferSource(), amp = ctx.createGain(), lp = ctx.createBiquadFilter()
    src.buffer = noiseBuffer
    lp.type = 'lowpass'; lp.frequency.value = filter
    amp.gain.setValueAtTime(gain, ctx.currentTime)
    amp.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
    src.connect(lp).connect(amp).connect(ctx.destination)
    src.start(); src.stop(ctx.currentTime + duration)
  } catch { /* 忽略 */ }
}

const lastPlayed = new Map<string, number>()
/** 地牢游戏音效；同一音效短时间内不重复播放，避免刺耳。 */
export function dungeonSound(name: string) {
  const now = performance.now()
  const gap = name === 'hit' || name === 'enemyShoot' ? 45 : name === 'shoot' ? 30 : 0
  if (gap && now - (lastPlayed.get(name) ?? 0) < gap) return
  lastPlayed.set(name, now)
  switch (name) {
    case 'shoot': tone(520, 0.06, 'square', 0.04, 0.5); break
    case 'shotgun': noise(0.18, 0.18, 1800); tone(140, 0.12, 'square', 0.05, 0.5); break
    case 'laser': tone(1400, 0.14, 'sawtooth', 0.04, 0.3); break
    case 'rocket': noise(0.3, 0.1, 600); tone(200, 0.25, 'sawtooth', 0.04, 0.4); break
    case 'swing': noise(0.12, 0.08, 3000); tone(700, 0.1, 'sine', 0.05, 2); break
    case 'hit': tone(260, 0.05, 'square', 0.035, 0.6); break
    case 'kill': tone(180, 0.12, 'triangle', 0.08, 0.4); noise(0.08, 0.06, 900); break
    case 'hurt': tone(220, 0.25, 'sawtooth', 0.08, 0.4); noise(0.12, 0.1, 700); break
    case 'explode': noise(0.45, 0.28, 500); tone(90, 0.35, 'sine', 0.15, 0.4); break
    case 'pickup': tone(660, 0.08, 'triangle', 0.08); tone(990, 0.12, 'triangle', 0.08, 1, 0.06); break
    case 'heal': [523, 659, 784].forEach((f, i) => tone(f, 0.15, 'sine', 0.08, 1, i * 0.07)); break
    case 'door': tone(160, 0.25, 'triangle', 0.1, 1.5); noise(0.2, 0.05, 400); break
    case 'dash': noise(0.12, 0.07, 2500); break
    case 'boss': tone(110, 0.8, 'sawtooth', 0.07, 0.7); tone(82, 0.9, 'sine', 0.12, 0.8, 0.1); break
    case 'stairs': [392, 494, 587, 784].forEach((f, i) => tone(f, 0.2, 'triangle', 0.09, 1, i * 0.08)); break
    case 'empty': tone(120, 0.08, 'square', 0.04); break
    case 'enemyShoot': tone(380, 0.07, 'sine', 0.03, 0.7); break
  }
}
