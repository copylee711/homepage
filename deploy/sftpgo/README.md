# SFTPGo 部署

`cloud.copylee.cn` 背后的文件服务：网页文件管理、WebDAV、SFTP，本地硬盘存日常文件，大文件目录落在 OSS。

## 启动

在服务器上（已安装 Docker）：

```bash
mkdir -p /opt/sftpgo && cd /opt/sftpgo
# 把本目录的 docker-compose.yml 和 .env.example 放进来
cp .env.example .env && nano .env        # 改掉管理员密码
mkdir -p data home && sudo chown -R 1000:1000 data home   # 容器以 UID 1000 运行
docker compose up -d
```

然后：

1. 轻量服务器防火墙放行 **TCP 2022**（SFTP）。80 / 443 等备案通过后再放行。
2. Caddy 按 [../Caddyfile.example](../Caddyfile.example) 配好 `cloud.copylee.cn`。
3. 打开 `https://cloud.copylee.cn/web/admin` 用 `.env` 里的账号登录，建议立即在个人设置里开启两步验证。

备案通过前域名和 HTTPS 不可用，网页和 WebDAV 暂时用不了，但 SFTP 可以直接用服务器 IP 加 2022 端口连接。
这段时间要进管理后台，可以用 SSH 端口转发：

```bash
ssh -L 8080:127.0.0.1:8080 <服务器用户>@<服务器IP>
```

之后在本机浏览器打开 `http://localhost:8080/web/admin`。

## 用户与目录

在管理后台创建：

- **自己的账号**：主目录用本地存储（默认即可，落在 `data/<用户名>`）。可以上传 SSH 公钥，SFTP 就不用输密码。
- **`large` 虚拟文件夹**：存储选 S3 兼容，指向 OSS（见下），映射到账号的 `/large`。
- **`share` 虚拟文件夹**：本地存储，映射到自己账号的 `/share`；给协作者建的账号只挂这一个文件夹。

临时分享在网页文件管理里选中文件或文件夹后创建分享链接，可设密码、过期时间和次数。

## 接入 OSS

1. 新建一个**私有**存储桶（与服务器同在广州），不要和别的用途混用。
2. 新建一个 RAM 子账号，只授予这个桶的读写权限，生成 AccessKey。
3. 在 SFTPGo 的虚拟文件夹里填：

   | 项 | 值 |
   |---|---|
   | 存储 | S3 (Compatible) |
   | Bucket | 桶名 |
   | Region | `cn-guangzhou` |
   | Endpoint | `https://oss-cn-guangzhou-internal.aliyuncs.com` |
   | Access Key / Secret | 子账号的密钥 |
   | Use path-style addressing | **不勾**（OSS 只支持虚拟主机风格） |

   用内网地址（`-internal`）时服务器与 OSS 之间的流量不计费。

落在 OSS 的目录有几个限制：重命名或移动非空文件夹很慢或不支持，上传中断不能续传，文件修改时间默认不保留。

## 客户端

**Windows 映射成磁盘**（rclone + [WinFsp](https://winfsp.dev/)）：

```bash
rclone config create cloud sftp host=cloud.copylee.cn port=2022 user=<用户名> key_file=C:\Users\<你>\.ssh\id_ed25519
rclone mount cloud:/ X: --vfs-cache-mode writes --no-console
```

备案通过前把 `host` 换成服务器 IP。写入的文件会先缓存在本地再上传，拷完大文件后等后台传完再关机。

**手机（MT 管理器等）**：添加 SFTP，地址同上、端口 2022；或添加 WebDAV，地址 `https://cloud.copylee.cn/dav/`。

**网页**：`https://cloud.copylee.cn/`。

## 备份与升级

- 需要备份的只有 `home/`（数据库和主机密钥）和 `data/`（本地文件）。
- 升级：改 `docker-compose.yml` 里的镜像版本后 `docker compose pull && docker compose up -d`。
