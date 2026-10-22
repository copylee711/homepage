#!/usr/bin/env bash
# 在 SFTPGo 登录页的 ICP 备案号旁加入公安备案号与隐私政策链接。
# SFTPGo 品牌配置只支持一个声明链接，因此修改软件包模板；软件包升级覆盖模板后，
# 由 /etc/apt/apt.conf.d/99copylee-sftpgo 钩子自动重新执行。已修改过则不做任何事。
set -euo pipefail
POLICE_TEXT="粤公网安备44011302006057号"
POLICE_CODE="44011302006057"
template=/usr/share/sftpgo/templates/common/login.html
[[ -f "$template" ]] || exit 0
grep -q copylee-police "$template" && exit 0
python3 - "$template" "$POLICE_TEXT" "$POLICE_CODE" <<'PY'
import pathlib, re, sys
path, text, code = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
source = path.read_text(encoding="utf-8")
# 声明链接所在的 {{- if}} 块结束处
match = re.search(r'custom\.disclaimer_webclient.*?\{\{- end\}\}', source, re.S)
if not match:
    sys.exit("login.html 结构已变化，未找到备案号链接，请人工检查")
links = (
    f'\n\t\t\t\t\t\t\t\t<a href="https://beian.mps.gov.cn/#/query/webSearch?code={code}" target="_blank" '
    f'rel="noreferrer" class="px-2 copylee-police"><img src="{{{{.StaticURL}}}}/branding/beian-police.png" '
    f'alt="" width="14" height="16">{text}</a>'
    '\n\t\t\t\t\t\t\t\t<a href="https://copylee.cn/privacy" target="_blank" rel="noopener" '
    'class="px-2 copylee-privacy">隐私政策</a>'
)
path.write_text(source[:match.end()] + links + source[match.end():], encoding="utf-8")
PY
systemctl try-restart sftpgo
echo "SFTPGo 登录页已加入公安备案号"
