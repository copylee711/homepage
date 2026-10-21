/** 深渊骑士的数值与配置：武器、道具、怪物。 */

export const TILE = 32
export const ROOM_W = 19
export const ROOM_H = 11
export const WORLD_W = ROOM_W * TILE
export const WORLD_H = ROOM_H * TILE

export interface WeaponDef {
  id: string
  name: string
  color: string
  cooldown: number
  cost: number
  damage: number
  speed: number
  spread: number
  count: number
  life: number
  size: number
  pierce?: number
  bounce?: number
  explode?: number
  slow?: boolean
  melee?: boolean
  knockback: number
  shake: number
}

export const WEAPONS: Record<string, WeaponDef> = {
  pistol: { id: 'pistol', name: '旧手枪', color: '#ffd166', cooldown: 0.26, cost: 0, damage: 3, speed: 420, spread: 0.04, count: 1, life: 0.9, size: 3.5, knockback: 70, shake: 0.6 },
  smg: { id: 'smg', name: '冲锋枪', color: '#ffb347', cooldown: 0.085, cost: 1, damage: 1.8, speed: 470, spread: 0.13, count: 1, life: 0.8, size: 3, knockback: 30, shake: 0.4 },
  shotgun: { id: 'shotgun', name: '霰弹枪', color: '#ff7b54', cooldown: 0.62, cost: 4, damage: 2.4, speed: 400, spread: 0.42, count: 6, life: 0.38, size: 3, knockback: 90, shake: 2.2 },
  laser: { id: 'laser', name: '激光步枪', color: '#5ee7ff', cooldown: 0.42, cost: 5, damage: 6, speed: 900, spread: 0, count: 1, life: 0.5, size: 3, pierce: 99, knockback: 40, shake: 1.2 },
  rocket: { id: 'rocket', name: '火箭筒', color: '#ff5d5d', cooldown: 0.95, cost: 8, damage: 9, speed: 300, spread: 0, count: 1, life: 1.4, size: 5, explode: 56, knockback: 160, shake: 3 },
  bouncer: { id: 'bouncer', name: '弹弹枪', color: '#b388ff', cooldown: 0.3, cost: 2, damage: 2.6, speed: 360, spread: 0.06, count: 1, life: 1.6, size: 4, bounce: 3, knockback: 50, shake: 0.6 },
  frost: { id: 'frost', name: '冰霜法杖', color: '#9be7ff', cooldown: 0.32, cost: 3, damage: 3, speed: 380, spread: 0.05, count: 2, life: 0.9, size: 4, slow: true, knockback: 30, shake: 0.6 },
  saber: { id: 'saber', name: '光剑', color: '#7cffb2', cooldown: 0.38, cost: 0, damage: 7, speed: 0, spread: 0, count: 1, life: 0.16, size: 52, melee: true, knockback: 180, shake: 1.5 },
}

/** 掉落池：手枪是初始武器，不会掉落。 */
export const WEAPON_POOL = ['smg', 'shotgun', 'laser', 'rocket', 'bouncer', 'frost', 'saber']

export interface ItemDef { id: string; name: string; text: string; color: string; glyph: string }

export const ITEMS: ItemDef[] = [
  { id: 'power', name: '力量药水', text: '伤害 +25%', color: '#ff5d5d', glyph: 'potion' },
  { id: 'boots', name: '迅捷之靴', text: '移速 +15%', color: '#ffd166', glyph: 'boot' },
  { id: 'spring', name: '扳机弹簧', text: '射速 +18%', color: '#ffb347', glyph: 'spring' },
  { id: 'heart', name: '心之容器', text: '生命上限 +2 并回满', color: '#ff6b8b', glyph: 'heart' },
  { id: 'split', name: '分裂弹', text: '每次多射一发子弹', color: '#b388ff', glyph: 'split' },
  { id: 'pierce', name: '穿甲弹头', text: '子弹多穿透一个敌人', color: '#5ee7ff', glyph: 'arrow' },
  { id: 'rubber', name: '橡胶子弹', text: '子弹可反弹一次', color: '#7cffb2', glyph: 'ball' },
  { id: 'fang', name: '吸血獠牙', text: '击杀有 6% 概率回复 1 点生命', color: '#d64550', glyph: 'fang' },
  { id: 'shield', name: '护盾发生器', text: '护甲 +1，脱战后自动恢复', color: '#8ab4ff', glyph: 'shield' },
  { id: 'core', name: '能量核心', text: '能量上限 +80，缓慢回复能量', color: '#4dd2ff', glyph: 'core' },
  { id: 'lens', name: '暴击透镜', text: '15% 概率造成双倍伤害', color: '#ffe066', glyph: 'eye' },
  { id: 'orbit', name: '守护卫星', text: '环绕的卫星会挡下子弹', color: '#c3f0ff', glyph: 'orbit' },
  { id: 'dash', name: '冲刺护符', text: '翻滚冷却 -40%，翻滚撞伤敌人', color: '#9cff6b', glyph: 'wind' },
  { id: 'giant', name: '巨型弹药', text: '子弹变大，伤害 +15%', color: '#ff9f43', glyph: 'big' },
]

export type EnemyKind = 'slime' | 'bat' | 'archer' | 'totem' | 'boar' | 'pumpkin' | 'mage'
export type BossKind = 'kingSlime' | 'golem' | 'necro'

export interface EnemyDef { hp: number; speed: number; radius: number; touch: number; color: string; score: number; flying?: boolean }

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  slime: { hp: 11, speed: 52, radius: 11, touch: 1, color: '#5fd068', score: 10 },
  bat: { hp: 6, speed: 95, radius: 9, touch: 1, color: '#9b6bff', score: 10, flying: true },
  archer: { hp: 12, speed: 55, radius: 11, touch: 1, color: '#e6dcc8', score: 15 },
  totem: { hp: 22, speed: 0, radius: 13, touch: 1, color: '#c98b4a', score: 15 },
  boar: { hp: 24, speed: 60, radius: 13, touch: 1, color: '#b0725a', score: 20 },
  pumpkin: { hp: 9, speed: 85, radius: 11, touch: 1, color: '#ff9a1f', score: 15 },
  mage: { hp: 15, speed: 40, radius: 11, touch: 1, color: '#6c5ce7', score: 20 },
}

export const BOSSES: Record<BossKind, { name: string; hp: number; radius: number; color: string }> = {
  kingSlime: { name: '史莱姆王', hp: 320, radius: 30, color: '#4fc35a' },
  golem: { name: '石像巨人', hp: 440, radius: 30, color: '#8d8f99' },
  necro: { name: '亡灵法师', hp: 400, radius: 22, color: '#7d5fff' },
}

export const BOSS_ORDER: BossKind[] = ['kingSlime', 'golem', 'necro']

/** 每层可能出现的怪物。 */
export function enemyPool(floor: number): EnemyKind[] {
  const pool: EnemyKind[] = ['slime', 'slime', 'bat', 'archer']
  if (floor >= 2) pool.push('totem', 'boar', 'archer')
  if (floor >= 3) pool.push('pumpkin', 'mage', 'bat')
  return pool
}

/** 难度随层数递增：血量与数量。 */
export const hpScale = (floor: number) => 1 + (floor - 1) * 0.28
