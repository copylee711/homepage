#!/usr/bin/env bash
set -euo pipefail
release=${1:?usage: deploy.sh RELEASE_ID}
[[ "$release" =~ ^[0-9]{14}-[a-f0-9]{40}$ ]] || { echo 'Invalid release ID' >&2; exit 2; }
root=/opt/copylee-backend
next="$root/releases/$release"
[[ -d "$next" && ! -L "$next" && -f "$next/uv.lock" ]] || exit 2
exec 9>/run/lock/copylee-deploy.lock
flock -n 9 || { echo 'Another deployment is running' >&2; exit 2; }
previous=$(readlink -f "$root/current" || true)
systemctl stop copylee-backup.timer
systemctl stop copylee-backup.service
trap 'systemctl start copylee-backup.timer' EXIT
chown -R copylee:copylee "$next"
cd "$next"
set -a
source /etc/copylee/backend.env
set +a
# 服务器访问 files.pythonhosted.org 不稳定：按锁文件导出带哈希的依赖，从阿里云镜像安装。
runuser -u copylee -- /usr/local/bin/uv export --frozen --no-dev --no-emit-project -o requirements.lock.txt >/dev/null
runuser -u copylee -- /usr/local/bin/uv venv --python /usr/bin/python3 .venv
runuser -u copylee -- env UV_HTTP_TIMEOUT=60 /usr/local/bin/uv pip install --python .venv/bin/python   --require-hashes --index-url "${COPYLEE_PIP_INDEX:-https://mirrors.aliyun.com/pypi/simple/}" -r requirements.lock.txt
snapshot=$(runuser -u copylee -- "$next/.venv/bin/python" -m app.cli backup)
printf 'Backup created: %s\n' "$snapshot"
# 云盘协议进程（SFTP/WebDAV）与后端共用数据库，迁移期间一起停下。
drive=0
if systemctl is-enabled --quiet copylee-drive 2>/dev/null; then drive=1; fi
systemctl stop copylee-backend
(( drive )) && systemctl stop copylee-drive
if ! runuser -u copylee -- "$next/.venv/bin/python" -m app.cli migrate; then
  systemctl start copylee-backend
  (( drive )) && systemctl start copylee-drive
  echo 'Migration failed; inspect and restore the recorded backup if necessary.' >&2
  exit 1
fi
ln -sfn "$next" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
systemctl start copylee-backend
(( drive )) && systemctl start copylee-drive
for attempt in {1..15}; do
  if curl --fail --silent http://127.0.0.1:8000/api/health >/dev/null; then
    echo 'Backend deployment passed health check.'
    exit 0
  fi
  sleep 1
done
echo "Health check failed. Backup: $snapshot; previous release: $previous" >&2
exit 1
