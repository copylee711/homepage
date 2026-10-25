/** 深渊骑士的数值与配置：英雄、武器、道具、怪物。 */

export const TILE = 32
export const ROOM_W = 19
export const ROOM_H = 11
export const WORLD_W = ROOM_W * TILE
export const WORLD_H = ROOM_H * TILE

// —— 英雄 ——

export type HeroId = 'knight' | 'ranger' | 'mage'

export interface HeroDef {
  id: HeroId
  name: string
  title: string
  color: string
  text: string
  skill: string
  skillText: string
  /** 技能冷却（秒） */
  cooldown: number
  hp: number
  armor: number
  energy: number
  regen: number
  speed: number
  crit: number
  weapon: string
}

export const HEROES: Record<HeroId, HeroDef> = {
  knight: {
    id: 'knight', name: '骑士', title: 'KNIGHT', color: '#8ab4ff', text: '生命更多，自带 1 点会恢复的护甲。',
    skill: '盾墙冲锋', skillText: '举盾冲锋：撞飞并重创沿途敌人，挡下迎面的子弹。', cooldown: 7,
    hp: 8, armor: 1, energy: 160, regen: 0, speed: 1, crit: 0, weapon: 'pistol',
  },
  ranger: {
    id: 'ranger', name: '游侠', title: 'RANGER', color: '#7cdb6b', text: '移动更快，暴击率 +10%，带着长弓出发。',
    skill: '疾风步', skillText: '向前疾冲，之后 4 秒射速与移速大幅提升。', cooldown: 6,
    hp: 6, armor: 0, energy: 160, regen: 0, speed: 1.12, crit: 0.1, weapon: 'bow',
  },
  mage: {
    id: 'mage', name: '元素法师', title: 'MAGE', color: '#7fd1ff', text: '能量上限更高并持续回复，带着冰霜法杖出发。',
    skill: '冰霜新星', skillText: '冻结身边的敌人，并清除附近的子弹。', cooldown: 8,
    hp: 6, armor: 0, energy: 240, regen: 4, speed: 1, crit: 0, weapon: 'frost',
  },
}

export const HERO_ORDER: HeroId[] = ['knight', 'ranger', 'mage']

// —— 武器 ——

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
  /** 近战能否弹开子弹 */
  deflect?: boolean
  /** 命中后点燃的概率 */
  burn?: number
  /** 连锁闪电：直接命中并弹射到附近的敌人 */
  chain?: number
  /** 回旋飞行，飞回手中 */
  returns?: boolean
  /** 弹丸外形 */
  shape?: 'arrow' | 'flame' | 'boomerang'
  /** 需要转动预热（加特林） */
  spin?: boolean
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
  saber: { id: 'saber', name: '光剑', color: '#7cffb2', cooldown: 0.38, cost: 0, damage: 7, speed: 0, spread: 0, count: 1, life: 0.16, size: 52, melee: true, deflect: true, knockback: 180, shake: 1.5 },
  bow: { id: 'bow', name: '猎人长弓', color: '#c8e6a0', cooldown: 0.42, cost: 0, damage: 4.6, speed: 560, spread: 0.02, count: 1, life: 0.8, size: 3.5, pierce: 1, shape: 'arrow', knockback: 80, shake: 0.7 },
  crossbow: { id: 'crossbow', name: '连发弩', color: '#e0c68a', cooldown: 0.15, cost: 1, damage: 2.4, speed: 600, spread: 0.07, count: 1, life: 0.7, size: 3, shape: 'arrow', knockback: 45, shake: 0.5 },
  flamer: { id: 'flamer', name: '喷火器', color: '#ff9f43', cooldown: 0.05, cost: 1, damage: 1.1, speed: 250, spread: 0.26, count: 1, life: 0.42, size: 6, pierce: 99, burn: 0.35, shape: 'flame', knockback: 6, shake: 0.25 },
  thunder: { id: 'thunder', name: '雷霆法杖', color: '#ffe066', cooldown: 0.5, cost: 4, damage: 7, speed: 0, spread: 0, count: 1, life: 0, size: 0, chain: 3, knockback: 60, shake: 1.4 },
  boomerang: { id: 'boomerang', name: '回旋镖', color: '#ffb067', cooldown: 0.5, cost: 0, damage: 4, speed: 360, spread: 0, count: 1, life: 1.2, size: 8, pierce: 99, returns: true, shape: 'boomerang', knockback: 70, shake: 0.6 },
  gatling: { id: 'gatling', name: '加特林', color: '#ffcf5c', cooldown: 0.045, cost: 1, damage: 1.7, speed: 520, spread: 0.17, count: 1, life: 0.75, size: 3, spin: true, knockback: 22, shake: 0.5 },
  sniper: { id: 'sniper', name: '狙击枪', color: '#ff8fab', cooldown: 1.05, cost: 6, damage: 24, speed: 1500, spread: 0, count: 1, life: 0.5, size: 3.5, pierce: 3, knockback: 240, shake: 3.2 },
  axe: { id: 'axe', name: '双刃战斧', color: '#d8e2f0', cooldown: 0.62, cost: 0, damage: 13, speed: 0, spread: 0, count: 1, life: 0.22, size: 50, melee: true, knockback: 280, shake: 2.6 },
}

/** 掉落池：初始武器之外都可能掉落。 */
export const WEAPON_POOL = ['smg', 'shotgun', 'laser', 'rocket', 'bouncer', 'frost', 'saber', 'bow', 'crossbow', 'flamer', 'thunder', 'boomerang', 'gatling', 'sniper', 'axe']

/** 武器所在的雪碧图与序号 */
export const WEAPON_ART: Record<string, ['weapons' | 'weapons2', number]> = Object.fromEntries([
  ...['pistol', 'smg', 'shotgun', 'laser', 'rocket', 'bouncer', 'frost', 'saber'].map((id, i) => [id, ['weapons', i]]),
  ...['bow', 'crossbow', 'flamer', 'thunder', 'boomerang', 'gatling', 'sniper', 'axe'].map((id, i) => [id, ['weapons2', i]]),
])

// —— 道具 ——

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
  // 第二批
  { id: 'thunder', name: '雷霆护符', text: '命中时 12% 概率引发连锁闪电', color: '#ffe066', glyph: 'core' },
  { id: 'burn', name: '燃烧弹头', text: '命中时 20% 概率点燃敌人', color: '#ff7b3d', glyph: 'arrow' },
  { id: 'venom', name: '毒液瓶', text: '命中时 25% 概率让敌人中毒减速', color: '#7bed6f', glyph: 'potion' },
  { id: 'iceheart', name: '寒冰之心', text: '命中时 10% 概率冻结敌人', color: '#9be7ff', glyph: 'heart' },
  { id: 'magnet', name: '磁石', text: '远处的金币与能量也会被吸过来', color: '#ff6b6b', glyph: 'ball' },
  { id: 'clover', name: '幸运四叶草', text: '掉落更多，暴击率 +5%', color: '#7cdb6b', glyph: 'eye' },
  { id: 'goldbag', name: '金币袋', text: '立即获得 25 金币，之后金币掉落 +50%', color: '#ffd166', glyph: 'big' },
  { id: 'cross', name: '复活十字', text: '倒下时复活一次，恢复一半生命', color: '#fff4d6', glyph: 'shield' },
  { id: 'trigger', name: '双重扳机', text: '射速 +30%', color: '#ffb347', glyph: 'spring' },
  { id: 'mask', name: '狂战士面具', text: '生命不超过一半时伤害 +40%', color: '#ff4d4d', glyph: 'fang' },
  { id: 'thorns', name: '荆棘护甲', text: '受伤时对身边的敌人造成大量伤害', color: '#c0c6d4', glyph: 'shield' },
  { id: 'rune', name: '回旋符文', text: '英雄技能冷却 -30%', color: '#7fb8ff', glyph: 'orbit' },
  { id: 'seeker', name: '追踪之眼', text: '子弹会微微追踪敌人', color: '#8fd3ff', glyph: 'eye' },
  { id: 'battery', name: '能量电池', text: '能量上限 +60，能量球效果翻倍', color: '#4dd2ff', glyph: 'core' },
  { id: 'hourglass', name: '时之沙漏', text: '敌人的子弹变慢 15%', color: '#ffd98a', glyph: 'spring' },
  { id: 'map', name: '魔法地图', text: '显示本层与之后每层的全部房间', color: '#e8d3a2', glyph: 'big' },
]

/** 可重复获得的道具 */
export const STACKABLE = new Set(['power', 'spring', 'heart', 'split', 'trigger'])

/** 道具图标位置：前 14 个在第一批图标表 */
export const itemArt = (id: string): ['items' | 'items2', number] => {
  const i = ITEMS.findIndex(item => item.id === id)
  return i < 14 ? ['items', i] : ['items2', i - 14]
}

// —— 怪物 ——

export type EnemyKind = 'slime' | 'bat' | 'archer' | 'totem' | 'boar' | 'pumpkin' | 'mage' | 'mushroom' | 'ghost' | 'lizard' | 'shield' | 'mummy' | 'worm'
export type BossKind = 'kingSlime' | 'golem' | 'necro' | 'treant' | 'dragon' | 'pharaoh'

export interface EnemyDef { hp: number; speed: number; radius: number; touch: number; color: string; score: number; flying?: boolean }

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  slime: { hp: 11, speed: 52, radius: 11, touch: 1, color: '#5fd068', score: 10 },
  bat: { hp: 6, speed: 95, radius: 9, touch: 1, color: '#9b6bff', score: 10, flying: true },
  archer: { hp: 12, speed: 55, radius: 11, touch: 1, color: '#e6dcc8', score: 15 },
  totem: { hp: 22, speed: 0, radius: 13, touch: 1, color: '#c98b4a', score: 15 },
  boar: { hp: 24, speed: 60, radius: 13, touch: 1, color: '#b0725a', score: 20 },
  pumpkin: { hp: 9, speed: 85, radius: 11, touch: 1, color: '#ff9a1f', score: 15 },
  mage: { hp: 15, speed: 40, radius: 11, touch: 1, color: '#6c5ce7', score: 20 },
  mushroom: { hp: 18, speed: 38, radius: 11, touch: 1, color: '#b06bd6', score: 18 },
  ghost: { hp: 13, speed: 55, radius: 10, touch: 1, color: '#9fd8ff', score: 18, flying: true },
  lizard: { hp: 22, speed: 50, radius: 12, touch: 1, color: '#ff7a3d', score: 20 },
  shield: { hp: 26, speed: 46, radius: 12, touch: 1, color: '#c9c2b0', score: 25 },
  mummy: { hp: 20, speed: 34, radius: 11, touch: 1, color: '#e0d2b0', score: 22 },
  worm: { hp: 30, speed: 70, radius: 13, touch: 1, color: '#d4a85a', score: 25 },
}

export const BOSSES: Record<BossKind, { name: string; hp: number; radius: number; color: string; flying?: boolean }> = {
  kingSlime: { name: '史莱姆王', hp: 320, radius: 30, color: '#4fc35a' },
  golem: { name: '石像巨人', hp: 440, radius: 30, color: '#8d8f99' },
  necro: { name: '亡灵法师', hp: 400, radius: 22, color: '#7d5fff', flying: true },
  treant: { name: '腐化树精', hp: 460, radius: 30, color: '#8a6a3d' },
  dragon: { name: '熔岩幼龙', hp: 500, radius: 28, color: '#ff6b2d' },
  pharaoh: { name: '沙之法老', hp: 460, radius: 22, color: '#ffcf5c', flying: true },
}

/** 每层首领：前四层与地形主题对应，之后轮换 */
export const BOSS_ORDER: BossKind[] = ['kingSlime', 'treant', 'dragon', 'pharaoh', 'golem', 'necro']

/** 地形主题：0 灰石、1 苔藓、2 熔岩、3 砂岩 */
export const themeOf = (level: number) => (level - 1) % 4

const THEME_POOL: EnemyKind[][] = [[], ['mushroom', 'mushroom', 'ghost'], ['lizard', 'lizard', 'shield'], ['mummy', 'mummy', 'worm', 'shield']]

/** 每层可能出现的怪物：基础怪物随层数增加，再加上本层主题的专属怪物。 */
export function enemyPool(floor: number): EnemyKind[] {
  const pool: EnemyKind[] = ['slime', 'slime', 'bat', 'archer']
  if (floor >= 2) pool.push('totem', 'boar', 'archer')
  if (floor >= 3) pool.push('pumpkin', 'mage', 'bat')
  pool.push(...THEME_POOL[themeOf(floor)])
  if (floor >= 5) pool.push('ghost', 'lizard', 'mummy', 'shield', 'worm')
  return pool
}

/** 难度随层数递增：血量与数量。 */
export const hpScale = (floor: number) => 1 + (floor - 1) * 0.28
