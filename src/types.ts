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
  notes: string
  portals: { title: string; description: string; href: string; icon: 'cloud' | 'note' | 'github'; hint: string; visible: boolean }[]
  repoGroups: { title: string; description: string; prefix: string }[]
  hiddenRepos: string[]
  icp: string
  police: { text: string; code: string }
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
