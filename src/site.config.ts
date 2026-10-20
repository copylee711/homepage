// 仅用于一次性导出初始内容。运行中的网站内容通过 /admin 更新。

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
  socials: [
    { platform: 'github', url: 'https://github.com/copylee711', visible: true },
    { platform: 'linkedin', url: 'https://www.linkedin.com/in/fuzhi-lee-8517b9441', visible: true },
    { platform: 'instagram', url: '', visible: false },
  ],

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
      description: '学习过程中留下的 Markdown 笔记。',
      href: '/notes',
      icon: 'note',
      hint: 'copylee.cn/notes',
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
  icp: '粤ICP备2026159168号-1',
  police: { text: '', code: '' },
}
