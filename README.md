# homepage

[copylee.cn](https://copylee.cn) 的个人主页：纯静态站点，Vue 3 + Vite + TypeScript。

## 开发

```bash
npm install
npm run dev
```

## 修改内容

所有文案和链接都在 [src/site.config.ts](src/site.config.ts)：

- `portals`：入口卡片（Cloud / 笔记 / GitHub）
- `repoGroups`：按仓库名前缀分组（如 `dsh-` → "DSH 插件"），其余仓库归入"其他项目"
- `hiddenRepos`：不展示的仓库
- `notes`：笔记站点地址（Notion 公开页面），顶栏、首屏按钮都指向它
- `icp` / `police`：备案号，留空则页脚不显示

## 仓库数据

`npm run build` 前会自动执行 `scripts/fetch-repos.mjs`，从 GitHub API 拉取公开仓库写入 `src/data/repos.json`。
拉取失败时沿用已提交的 `repos.json`，不影响构建。如遇限流可设置环境变量 `GITHUB_TOKEN`。

也可以单独刷新：

```bash
npm run fetch:repos
```

## 构建与部署

```bash
npm run build
```

产物在 `dist/`，上传到服务器（如 `/var/www/homepage`）后由 Caddy 托管。
Caddy 配置示例见 [deploy/Caddyfile.example](deploy/Caddyfile.example)，其中同时包含 `cloud.copylee.cn` 到 Nextcloud 的反向代理。

### GitHub Actions

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) 会构建并用 rsync 把 `dist/` 同步到服务器，目前只能在 Actions 页面手动触发（Run workflow）。

使用前在仓库 Settings → Secrets and variables → Actions 里添加：

| Secret | 说明 |
|---|---|
| `DEPLOY_HOST` | 服务器 IP 或域名 |
| `DEPLOY_USER` | SSH 用户，建议建一个只对部署目录有写权限的专用用户 |
| `DEPLOY_SSH_KEY` | 该用户的 SSH 私钥（公钥放进服务器的 `~/.ssh/authorized_keys`） |
| `DEPLOY_KNOWN_HOSTS` | 服务器主机指纹，`ssh-keyscan -H <服务器地址>` 的输出 |
| `DEPLOY_PATH` | 可选，部署目录，默认 `/var/www/homepage` |
| `DEPLOY_PORT` | 可选，SSH 端口，默认 `22` |

服务器上需要装有 `rsync`，并在防火墙放行 SSH 端口。
