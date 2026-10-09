// 站点内容都在这里改，改完重新构建即可。

export type IconName = 'cloud' | 'note' | 'github'

export interface Portal {
  title: string
  description: string
  href: string
  icon: IconName
  /** 显示在卡片底部的地址提示 */
  hint: string
}

export interface RepoGroup {
  title: string
  description: string
  prefix: string
}

export const site = {
  name: 'Copy Lee',
  greeting: "Hi, I'm",
  roles: ['Student', 'Developer', 'Builder'],
  intro: 'A personal space for notes, projects, and cloud services.',
  github: 'copylee711',
  cloud: 'https://cloud.copylee.cn',
  // 笔记放在 Notion 上，已发布为公开站点
  notes: 'https://cedar-tomato-027.notion.site/Notes-3f477fc5d27680a6b492d9d24a87e714',

  portals: [
    {
      title: 'Cloud',
      description: '私有云盘，用于文件同步与临时协作。',
      href: 'https://cloud.copylee.cn',
      icon: 'cloud',
      hint: 'cloud.copylee.cn',
    },
    {
      title: 'Notes',
      description: '学习过程中留下的记录。',
      href: 'https://cedar-tomato-027.notion.site/Notes-3f477fc5d27680a6b492d9d24a87e714',
      icon: 'note',
      hint: 'Notion',
    },
    {
      title: 'GitHub',
      description: '开源项目与日常代码。',
      href: 'https://github.com/copylee711',
      icon: 'github',
      hint: 'github.com/copylee711',
    },
  ] satisfies Portal[],

  // 仓库分组：名称以 prefix 开头的仓库归入该组，按顺序显示在项目区顶部；其余归入"其他项目"
  repoGroups: [
    {
      title: 'DSH Plugins',
      description: 'DeepSeek Harness 插件',
      prefix: 'dsh-',
    },
  ] satisfies RepoGroup[],
  // 不想展示的仓库
  hiddenRepos: ['homepage'] as string[],

  // 备案信息：留空则页脚不显示
  icp: '',
  police: { text: '', code: '' },
}
