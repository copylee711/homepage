"""Workspace-local tool management; never installs into the read-only OS image."""
import json
from pathlib import Path
import re
import shlex
import shutil

CATALOG = json.loads(Path(__file__).with_name('toolchains.json').read_text(encoding='utf-8'))

def manage(value, root, bash, inside):
    tool_id = value.get('id')
    catalog = {item['id']: item for item in CATALOG}
    managed = root / '.tools' / 'managed'
    bins = root / '.tools' / 'bin'
    if value.get('op') == 'toolchain-list':
        installed = []
        for item in CATALOG:
            marker = managed / item['id'] / '.installed.json'
            try:
                inside(marker)
                if marker.stat().st_size <= 2048:
                    state = json.loads(marker.read_text())
                    installed.append({'id': item['id'], 'version': str(state.get('version', ''))[:40]})
            except (OSError, ValueError): pass
        return {'catalog': CATALOG, 'installed': installed}
    if tool_id not in catalog or value.get('action') not in {'install', 'remove'}:
        raise ValueError('工具链操作无效')
    version = value.get('version', '')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:[a-zA-Z0-9.-]*)?', version): raise ValueError('需要固定版本号')
    tool = catalog[tool_id]
    folder = managed / tool_id
    # Reject symlink roots before any mkdir/delete; own fixed paths only.
    for path in [root / '.tools', managed, bins, folder]:
        if path.is_symlink(): raise ValueError('工具目录不能是符号链接')
        inside(path, must_exist=False)
    if value['action'] == 'remove':
        for name in tool['bins']:
            path = bins / name
            if path.is_symlink(): path.unlink()
        if folder.exists(): shutil.rmtree(folder)
        return {'ok': True, 'output': '已移除 ' + tool_id}
    folder.mkdir(parents=True, exist_ok=True); bins.mkdir(parents=True, exist_ok=True)
    q = shlex.quote
    if tool['manager'] == 'npm':
        command = 'npm install --prefix ' + q(str(folder)) + ' --ignore-scripts --save-exact --no-audit --no-fund ' + q(tool_id + '@' + version)
        binary_root = folder / 'node_modules' / '.bin'
    else:
        command = 'python3 -m venv ' + q(str(folder)) + ' && ' + q(str(folder / 'bin' / 'python')) + ' -m pip install --no-cache-dir --only-binary=:all: ' + q(tool_id + '==' + version)
        binary_root = folder / 'bin'
    result = bash({'command': command, 'timeout': value.get('_timeout_limit', 180), '_timeout_limit': value.get('_timeout_limit', 180)})
    if result['exitCode'] != 0:
        raise ValueError('安装失败：' + result['output'][-1500:])
    for name in tool['bins']:
        source = binary_root / name
        if not source.exists(): continue
        target = bins / name
        if target.exists() or target.is_symlink(): target.unlink()
        target.symlink_to(source)
    (folder / '.installed.json').write_text(json.dumps({'version': version}))
    return {'ok': True, 'output': result['output'][-4000:]}
