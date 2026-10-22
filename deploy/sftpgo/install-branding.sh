#!/usr/bin/env bash
# 安装 Copy Lee 私有云的品牌文件、备案信息与 dav 说明页。需 root，在本目录的副本中执行。
# 写入 SFTPGo 静态目录下的 branding/、env.d/branding.env、sftpgo.env（日志）和 /var/www/sftpgo-landing，
# 并给登录模板加入公安备案号（见 patch-login.sh）；不修改 sftpgo.json。
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
static=/usr/share/sftpgo/static/branding
install -d -m 0755 "$static" /var/www/sftpgo-landing
install -m 0644 "$here"/branding/{logo.svg,favicon.svg,copylee.css,beian-police.png} "$static"/
install -m 0644 "$here"/landing/dav.html /var/www/sftpgo-landing/
rm -f /var/www/sftpgo-landing/cloud.html
install -m 0644 "$here"/branding.env /etc/sftpgo/env.d/branding.env
# 日志写入 /var/log/sftpgo，保留 190 天
install -d -o sftpgo -g sftpgo -m 0750 /var/log/sftpgo
install -m 0644 "$here"/sftpgo.env /etc/sftpgo/sftpgo.env
# 登录页公安备案号：模板补丁 + 软件包升级后自动重新应用
install -m 0755 "$here"/patch-login.sh /usr/local/sbin/copylee-sftpgo-patch
install -m 0644 "$here"/99copylee-sftpgo /etc/apt/apt.conf.d/99copylee-sftpgo
/usr/local/sbin/copylee-sftpgo-patch
systemctl restart sftpgo
for i in $(seq 1 20); do curl -fs -o /dev/null http://127.0.0.1:8080/web/client/login && break; sleep 1; done
curl -fs http://127.0.0.1:8080/web/client/login | grep -q 'beian.mps.gov.cn' && echo "SFTPGo 品牌与备案号已生效"
