"""Root-owned quota policy and offline, non-destructive ext4 resizing."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading

DEFAULT = {'disk_mib': 1024, 'memory_mib': 512, 'cpus': 1, 'pids': 224, 'timeout': 180}
RANGES = {'disk_mib': (64, 16384), 'memory_mib': (64, 4096), 'cpus': (.1, 4), 'pids': (16, 512), 'timeout': (10, 600)}
DEFAULTS_KEY = '@defaults'
lock = threading.RLock()


def validate(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT): raise ValueError('需要完整配额字段')
    for key, (minimum, maximum) in RANGES.items():
        number = value[key]
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not minimum <= number <= maximum:
            raise ValueError('配额超出允许范围：' + key)
        if key != 'cpus' and int(number) != number: raise ValueError('配额需为整数：' + key)
    return {key: float(number) if key == 'cpus' else int(number) for key, number in value.items()}


class Quotas:
    def __init__(self, root): self.root = Path(root)
    def load(self):
        try: return json.loads((self.root / 'quotas.json').read_text())
        except FileNotFoundError: return {}
    def get(self, user):
        entries = self.load()
        return {**DEFAULT, **entries.get(DEFAULTS_KEY, {}), **entries.get(user, {})}
    def budget(self): return int(os.environ.get('SANDBOX_TOTAL_DISK_MIB', '8192'))
    def defaults(self):
        return {'quota': self.get(DEFAULTS_KEY), 'ranges': RANGES, 'total_disk_budget_mib': self.budget()}
    def write(self, entries):
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.root / 'quotas.json.tmp'
        temporary.write_text(json.dumps(entries)); temporary.chmod(0o600)
        os.replace(temporary, self.root / 'quotas.json')
    def save_defaults(self, value):
        value = validate(value)
        if value['disk_mib'] > self.budget():
            raise ValueError('初始工作区磁盘不能超过主机磁盘总预算')
        with lock:
            entries = self.load()
            previous = {**DEFAULT, **entries.get(DEFAULTS_KEY, {})}
            # Freeze existing workspaces and overrides before changing the initial template.
            for user in self.users(entries):
                entries[user] = {**previous, **entries.get(user, {})}
            entries[DEFAULTS_KEY] = value
            self.write(entries)
            return self.defaults()
    def users(self, entries):
        return {path.stem for path in self.root.glob('*.img')} | (set(entries) - {DEFAULTS_KEY})
    def check_budget(self, user, value, entries):
        default = {**DEFAULT, **entries.get(DEFAULTS_KEY, {})}
        total = value['disk_mib'] + sum(
            entries.get(item, {}).get('disk_mib', default['disk_mib'])
            for item in self.users(entries) - {user}
        )
        if total > self.budget():
            raise ValueError('分配总量超过服务器沙箱磁盘预算，请先回收其他配额或调整主机预算')
    def status(self, user):
        quota = self.get(user)
        mount, image = self.root / user, self.root / (user + '.img')
        used = shutil.disk_usage(mount).used if os.path.ismount(mount) else None
        return {'quota': quota, 'used_bytes': used, 'provisioned_bytes': image.stat().st_size if image.exists() else 0,
                'ranges': RANGES, 'total_disk_budget_mib': self.budget()}
    def save(self, user, value):
        value = validate(value)
        with lock:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            entries = self.load()
            self.check_budget(user, value, entries)
            image, mount = self.root / (user + '.img'), self.root / user
            target = int(value['disk_mib']) * 1024 * 1024
            if image.exists() and image.stat().st_size != target:
                if os.path.ismount(mount):
                    usage = shutil.disk_usage(mount)
                    if usage.used + 32 * 1024 * 1024 > target:
                        raise ValueError('现有文件和文件系统元数据超过目标容量，拒绝缩容')
                    subprocess.run(['umount', str(mount)], check=True, timeout=15)
                check = subprocess.run(['e2fsck', '-fp', str(image)], capture_output=True, timeout=60)
                if check.returncode not in (0, 1): raise ValueError('文件系统检查未通过，配额未更改')
                before = image.stat().st_size
                if target > before:
                    if shutil.disk_usage(self.root).free < target - before + 512 * 1024 * 1024:
                        raise ValueError('宿主机空闲磁盘不足，配额未更改')
                    with image.open('r+b') as stream: stream.truncate(target)
                resized = subprocess.run(['resize2fs', str(image), str(int(value['disk_mib'])) + 'M'], capture_output=True, timeout=90)
                if resized.returncode: raise ValueError('文件系统无法调整到目标容量；未删除文件，请选择更大容量')
                if target < before:
                    with image.open('r+b') as stream: stream.truncate(target)
            entries[user] = value
            self.write(entries)
        return self.status(user)
