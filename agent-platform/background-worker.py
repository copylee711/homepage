"""Container-only background supervisor and localhost preview reader."""
import base64
import http.client
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

if len(sys.argv) > 1 and sys.argv[1] == '--fetch':
    value = json.load(sys.stdin)
    path = value['path']
    if not isinstance(path, str) or not path.startswith('/') or path.startswith('//') or any(ord(c) < 32 for c in path): raise ValueError('预览路径无效')
    connection = http.client.HTTPConnection('127.0.0.1', int(value['port']), timeout=8)
    connection.request('GET', path, headers={'Host': 'localhost:' + str(value['port']), 'Accept-Encoding': 'identity'})
    response = connection.getresponse(); data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024: raise ValueError('预览文件超过 2 MiB')
    print(json.dumps({'status': response.status, 'contentType': response.getheader('Content-Type', 'application/octet-stream'), 'location': response.getheader('Location', ''), 'data': base64.b64encode(data).decode()}))
else:
    value = json.loads(sys.argv[1]); cwd = Path(value['cwd']).resolve(strict=True)
    if not cwd.is_relative_to('/workspace') or not cwd.is_dir(): raise ValueError('后台任务目录无效')
    os.environ['PATH'] = str(cwd / '.venv/bin') + ':' + str(cwd / '.tools/bin') + ':' + str(cwd / 'node_modules/.bin') + ':/workspace/.tools/bin:/workspace/.tools/node_modules/.bin:' + os.environ.get('PATH', '')
    os.environ.update({'NODE_USE_ENV_PROXY':'1','http_proxy':os.environ.get('HTTP_PROXY',''),'https_proxy':os.environ.get('HTTPS_PROXY',''),'NO_PROXY':'localhost,127.0.0.1','no_proxy':'localhost,127.0.0.1','COREPACK_HOME':str(cwd / '.cache/corepack'),'PNPM_HOME':str(cwd / '.tools/bin'),'npm_config_prefix':str(cwd / '.tools'),'npm_config_https_proxy':os.environ.get('HTTPS_PROXY',''),'npm_config_proxy':os.environ.get('HTTP_PROXY',''),'npm_config_update_notifier':'false'})
    scratch=cwd / '.cache/tmp';scratch.mkdir(parents=True,exist_ok=True)
    os.environ.update({'TMPDIR':str(scratch),'npm_config_cache':str(cwd / '.cache/npm'),'PIP_CACHE_DIR':str(cwd / '.cache/pip')})
    proc = subprocess.Popen(['/bin/sh', '-lc', value['command']], cwd=cwd, start_new_session=True)
    def stop(*_):
        try: os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError: pass
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    sys.exit(proc.wait())
