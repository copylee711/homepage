/** scripts/fetch-repos.mjs 写入 src/data/repos.json 的单条记录 */
export interface Repo {
  name: string
  description: string
  url: string
  homepage: string
  language: string
  stars: number
  pushedAt: string
}

export interface SiteContent {
  name: string
  greeting: string
  roles: string[]
  intro: string
  github: string
  cloud: string
  socials: Social[]
  portals: { title: string; description: string; href: string; icon: 'cloud' | 'note' | 'article' | 'github'; hint: string; visible: boolean }[]
  repoGroups: { title: string; description: string; prefix: string }[]
  hiddenRepos: string[]
  icp: string
  police: { text: string; code: string }
}

export type SocialPlatform = 'github' | 'linkedin' | 'instagram' | 'x' | 'bilibili' | 'zhihu' | 'xiaohongshu' | 'youtube' | 'weibo' | 'email'

export interface Social {
  platform: SocialPlatform
  url: string
  visible: boolean
}

export interface NoteSummary {
  slug: string
  title: string
  summary: string
  category: string
  updated_at: string
}

export interface PostSummary {
  title: string
  slug: string
  summary: string
  cover: string
  published_at: string
  updated_at: string
  public_revision: number
}
