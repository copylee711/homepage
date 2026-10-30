---
version: alpha
name: Copy Lee
description: 以主页的蓝色网格、字标与克制动效统一个人网站。
colors:
  primary: "#3b6ef5"
  background: "#fcfcfd"
  surface: "#ffffff"
  text: "#111114"
  muted: "#6b7280"
  dark-background: "#0c0d10"
  dark-primary: "#6d93ff"
typography:
  sans:
    fontFamily: "Outfit Variable, Microsoft YaHei, sans-serif"
  mono:
    fontFamily: "ui-monospace, Cascadia Code, Consolas, monospace"
rounded:
  DEFAULT: "16px"
  sm: "12px"
spacing:
  page-max: "1120px"
  gutter: "24px"
components:
  heading: {}
  navigation: {}
  card: {}
  select: {}
---

# Copy Lee Design System

## TwinFile 产品页

`public/twinfile/` 是 TwinFile 仓库 `website/` 的静态部署镜像，维护源在 `D:/Projects/twinfile`。`assets/site-tokens.css` 原样镜像本项目 `src/styles/tokens.css`，使用相同的颜色、字体、间距和滚动条变量。版式消费变量，采用近白背景、蓝色网格、黑色主按钮、灰色细线链接及语义化导航；不改变主站 Vue 应用的行为。截图仅保留应用区域。网站包含无需脚本即可访问的介绍页、隐私政策与服务条款。更新时同步维护源与部署镜像，并验证下载资源及 OAuth 开放状态文案。

## Overview

以既有主页为视觉基准。读者浏览个人项目、文章及华南理工大学通知；英文栏目名与中文内容沿用现有网站语气。首页与文章属于内容网站，SCUT 提供本地索引筛选。此次覆盖公开页面，管理后台的表单流程不在此次重设计范围内。

标志性元素是浅蓝渐变上的细网格与蓝色方形节点。导航、留白、字标与入场节奏跨页面一致；通知筛选和文章阅读保持安静、清晰，不引入装饰性仪表盘。

## Colors

`src/styles/tokens.css` 是既有规范值的唯一运行时来源。本文件说明意图并镜像值，不生成另一套颜色。阅读页面经后端 Vite manifest 加载同一份构建 CSS，`reading.css` 只适配布局。

| Role | Canonical CSS | Consumers |
| --- | --- | --- |
| 品牌与焦点 | --accent / --accent-soft | 链接、选择器、网格节点 |
| 背景与表面 | --bg / --bg-tint / --surface | 页面标题、卡片、弹层 |
| 文本层级 | --text / --text-2 / --muted / --faint | 标题、正文、元数据 |
| 边界 | --line / --line-strong | 卡片、列表、焦点反馈 |
| 滚动条 | --scrollbar-thumb / --scrollbar-track / --scrollbar-hover / --scrollbar-active | 全局滚动区域 |

深色主题复用同名变量。强制颜色模式将滚动条交回系统。避免凭颜色单独表达选中和未读。

## Typography

Outfit 是拉丁标题与导航字体；中文使用既有系统回退栈。主标题 800 字重，紧凑字距；正文保留适合中文阅读的行距。日期和技术元数据使用 --font-mono。文章正文宽度 860px，避免为与主页对齐而拉长阅读行。

## Layout

公共页面宽度 --content=1120px、侧边距 --gutter=24px、固定导航高 --header-h=64px。SCUT 和文章列表复用 page-heading；移动端返回主页链接回到文档流，筛选切为两列。正文维持独立阅读宽度。全局稳定滚动槽避免打开弹层引起水平跳动。

## Elevation & Depth

淡蓝网格只用于标题背景和卡片悬停反馈。表面以细边框区分；菜单使用阴影和 Portal，层级低于固定导航，碰撞时预留导航高度并自动改变位置。导航滚动后使用透明背景与模糊。

## Shapes

卡片和筛选框使用 --radius-sm；弹层使用同一半径与边框。选项内部圆角为 8px。蓝色方形节点呼应 CL 字标与主页几何图。

## Components

- 公共导航：Vue SiteHeader 与后端 base.html 的阅读适配使用相同字标、栏目、活动下划线、滚动反馈和移动断点。
- 首页应用导航在 ≤760px 时通过菜单按钮展开，分组在面板内纵向展开；面板受视口宽高约束并可内部滚动。点击外部、选择入口或按 Escape 收起，Escape 将焦点返回菜单按钮。
- 页面标题：PageHeading.vue 与后端 page-heading 标记共用 base.css 样式；逐层渐入，减少动效模式下直接显示。
- 选择器：AnimatedSelect.vue 是公开页面的 authored 选择器，底层 Reka UI 负责焦点、键盘、类型搜索、Portal 和碰撞。外部空字符串筛选值映射内部 __all__，不改变数据语义。弹层宽度等于触发器，最大高度受可用视口约束。选择菜单不锁定 body 滚动，不隐藏页面滚动条或增加右侧补偿；保留全局稳定滚动槽，防止开关时布局抖动。页面滚动时菜单自动收起；选项列表内部滚动保留展开状态。
- 搜索：中文标签、清除按钮、焦点恢复和无结果提示；本地计算不增加网络请求或输入延迟。此次保留原有会话内筛选语义，不改变链接或导航数据行为。
- 列表：细分隔线、日期元数据、悬停箭头与同组淡出。通知保留已读切换和 20 条分页。
- 空状态：说明当前情况并提供相关入口；加载和失败沿用可重试状态，不伪造数据。
- 文章阅读：标题区复用 page-heading 网格；导航底边显示阅读进度；宽屏（≥1180px）右侧粘性目录随滚动高亮；标题悬停显示锚点；代码块带语言标签与复制按钮；正文结尾以蓝色节点收束，下方为相邻文章卡片。交互由 `backend/app/static/reading.js` 提供，无 JS 时内容照常可读。
- 卡片光效：学校友链、文章列表、相邻文章与 404 入口共用跟随指针的网格高光（`--mx/--my`）。
- 404：Caddy 未命中的路径交给后端渲染，与文章不存在共用模板；`404` 逐字入场，中间的 0 使用强调色。
- 页脚：备案号与公安备案链接在 Vue 与后端页脚同时显示，后台修改后阅读页实时同步。
- 主题：共享 theme 存储键，跟随系统；支持时从点击位置圆形扩散；减少动效时直接切换。

## Motion

沿用 --ease。页面大标题逐字上浮（每字 45ms 错峰），网格引导线生长、节点弹出后呼吸，与首屏字标同节奏。标题和卡片使用约 0.8 秒的渐入，悬停约 0.3–0.4 秒，菜单展开 0.3 秒、收起 0.18 秒。基础样式统一禁用 prefers-reduced-motion 下的动画和过渡。

网站主标题使用 TwinFile。中文正文与标题使用站内 Noto Sans SC 可变字体（OFL 许可），与 Outfit 拉丁字体组合；Noto 字形由 TwinFile 的 scripts/subset-website-font.py 按页面文本生成子集，修改中文后须重新生成。首屏渐变在文档范围内渲染并向下淡出，避免内容容器边缘与分区截断。标题逐字入场、网格引导线与节点、截图浮动、滚动分区出现和按钮悬停遵循主站节奏；减少动态效果模式禁用动画，脚本不可用时正文仍可阅读。
