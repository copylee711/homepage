#!/usr/bin/env bash
# 安装 Copy Lee 私有云的品牌文件、备案信息与落地页。需 root，在本目录的副本中执行。
# 只写入 SFTPGo 静态目录下的 branding/、env.d/branding.env 和 /var/www/sftpgo-landing，
# 不修改 sftpgo.json；软件包升级不会删除这些文件。
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
static=/usr/share/sftpgo/static/branding
install -d -m 0755 "$static" /var/www/sftpgo-landing
install -m 0644 "$here"/branding/{logo.svg,favicon.svg,copylee.css} "$static"/
install -m 0644 "$here"/landing/{cloud.html,dav.html} /var/www/sftpgo-landing/
install -m 0644 "$here"/branding.env /etc/sftpgo/env.d/branding.env
systemctl restart sftpgo
for i in $(seq 1 20); do curl -fs -o /dev/null http://127.0.0.1:8080/web/client/login && break; sleep 1; done
curl -fs http://127.0.0.1:8080/web/client/login | grep -q 'beian.miit.gov.cn' && echo "SFTPGo 品牌已生效"
