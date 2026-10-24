# 图床

[项目首页](../README.md) · [开发指南](development.md) · [内容与接口](content.md) · [登录与安全](security.md) · [备份与恢复](maintenance.md) · [部署指南](../deploy/README.md)

`image.copylee.cn` 是本站的图床。管理员不受配额限制。访客账户默认不能使用，需要在后台「用户与邮件」里逐个开启并设置配额。图床不复用 SFTPGo 的账户和 WebDAV/SFTP 协议：上传走 HTTP 接口，用户用自己生成的令牌鉴权，开关、配额和撤销都在本站后台管理。

## 存储与地址

- 文件保存在 `/var/lib/copylee/images/<年>/<月>/<12 位随机 id>.<扩展名>`，公开地址是 `https://image.copylee.cn/<同一路径>`。地址里不含用户信息。
- 静态文件由 Caddy 直接提供，响应头为一年 `immutable` 缓存、`nosniff` 和 `Access-Control-Allow-Origin: *`；只有 `/api/upload` 转发到后端。
- 支持 JPEG、PNG、WebP、GIF，按文件内容识别格式，不信任扩展名。文件按原样保存、不重新编码。像素总数上限为 2000 万。
- 同一用户重复上传相同内容时返回原有地址，不重复占用空间。
- 删除图片会删除文件和记录，地址立即失效（CDN 缓存另见下文）。删除账户时，该用户的图片、令牌和配额一并删除。

## 鉴权与配额

| 来源 | 鉴权 | 限制 |
| --- | --- | --- |
| PicList / Typora 等客户端，`POST /api/upload` | `Authorization: Bearer cpl_…` 令牌 | 用户配额，单张上限（最高 20 MiB） |
| `/account` 页「图床」标签 | 登录 Cookie + CSRF | 同上 |
| 后台编辑器「上传图片」、后台「图床」标签 | 管理员会话（SSH 隧道） | 单张 20 MiB，不限总量 |

- 令牌只保存 SHA-256 哈希，明文仅在创建时显示一次。每个账户最多 10 个令牌，建议每台设备单独创建一个。
- 令牌验证失败按 IP 计数：15 分钟内失败 20 次后暂停验证。
- 关闭某用户的图床会同时撤销该用户全部令牌，已上传的图片保留；停用账户后，其令牌也立即失效。

## PicList 配置

在 PicList 中选择「自定义 Web 图床」（advancedplist）：

| 项目 | 值 |
| --- | --- |
| API 地址 | `https://image.copylee.cn/api/upload` |
| 请求方法 | `POST` |
| 文件字段名 | `file` |
| 请求头 | `{"Authorization": "Bearer 你的令牌"}` |
| 返回 URL 路径 | `url` |

上传接口也接受直接把图片作为请求体发送，不使用 multipart。上传成功后返回 `{"id", "url", "size", "width", "height", "created_at"}`。

在 Typora 中，打开「偏好设置 → 图像 → 上传服务」，选择 PicList，再点「验证图片上传选项」测试。

## 导出与备份

- 用户可以在 `/account` 导出自己的全部图片：zip 内的目录结构与图片地址一致，并附带 `manifest.json`（id、路径、地址、大小、SHA-256、上传时间）。每 15 分钟可导出一次。导出后可以自行放进 GitHub 仓库，第一版不做自动同步。
- 服务器备份（`python -m app.cli backup`）会复制图床中的全部图片，恢复后地址照常可用，见 [备份与恢复](maintenance.md)。

## 迁移旧的 /media 图片

此前文章和手写笔记引用的 `/media/<48 位十六进制>.<扩展名>` 图片可以一次性导入图床，并改写成图床地址：

```bash
cd /opt/copylee-backend/current
set -a; . /etc/copylee/backend.env; set +a
runuser -u copylee -- .venv/bin/python -m app.cli images-migrate          # 只统计，不修改
runuser -u copylee -- .venv/bin/python -m app.cli backup
runuser -u copylee -- .venv/bin/python -m app.cli images-migrate --apply
```

- 迁移范围是文章的草稿和公开版本（含封面），以及后台手写的笔记。
- GitHub 同步的笔记不迁移：下次同步会用仓库内容覆盖，图片继续存放在 `media/notes`。
- 引用了但文件已不存在的图片会被列出并跳过。
- 重复执行不会产生变化。旧 `/media` 文件不会删除，旧地址仍然可以访问。

## 部署

1. 在 `/etc/copylee/backend.env` 加入 `COPYLEE_IMAGE_URL=https://image.copylee.cn`，然后重新部署后端（会执行 `0008` 迁移，并安装新依赖 `python-multipart`）。
2. 把 `deploy/Caddyfile*.example` 中的 `image.copylee.cn` 站点块加入 `/etc/caddy/Caddyfile`，然后执行 `systemctl reload caddy`。HTTPS 配置还需要创建 `/var/log/caddy/image.log` 所需的目录权限，与其他站点相同。
3. 确认 `/var/lib/copylee/images` 归属 `copylee` 用户，Caddy 对其有读权限（后端启动时会自动创建这个目录，权限 755）。

### 经 ESA 加速

图片是不可变的静态文件，适合放在 ESA 后面：边缘提供 HTTPS 证书，令牌在客户端到边缘这一段是加密传输的。需要注意：

- **缓存规则**：`image.copylee.cn/api/*` 设为不缓存。其余路径遵循源站的 `Cache-Control`。
- **回源**：源站仍然是 HTTP 阶段时，ESA 用 HTTP 回源即可。`COPYLEE_IMAGE_URL` 始终填写 `https://` 地址。
- **删除后的缓存**：删除图片后，边缘节点上可能仍有缓存。如需立即失效，在 ESA 控制台刷新对应的 URL。
- **上传大小**：确认 ESA 套餐允许的请求体大小不小于 20 MiB。
- **真实 IP**：经过 ESA 后，Caddy 看到的是 ESA 节点的 IP，令牌失败限流会按节点 IP 计数（全站登录限流也是如此）。如需按真实客户端 IP 限流，需要在 Caddy 的 `servers { trusted_proxies … }` 中信任 ESA 的回源网段。
