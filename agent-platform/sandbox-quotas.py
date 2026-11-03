"""Root-owned quota policy and offline, non-destructive ext4 resizing."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading

DEFAULT = {'disk_mib': 1024, 'memory_mib': 512, 'cpus': 1, 'pids': 96, 'timeout': 180}
RANGES = {'disk_mib': (64, 16384), 'memory_mib': (64, 4096), 'cpus': (.1, 4), 'pids': (16, 256), 'timeout': (10, 600)}
lock = threading.RLock()

class Quotas:
    def __init__(self, root): self.root = Path(root)
    def load(self):
        try: return json.loads((self.root / 'quotas.json').read_text())
        except FileNotFoundError: return {}
    def get(self, user): return {**DEFAULT, **self.load().get(user, {})}
    def status(self, user):
        quota = self.get(user)
        mount, image = self.root / user, self.root / (user + '.img')
        used = shutil.disk_usage(mount).used if os.path.ismount(mount) else None
        return {'quota': quota, 'used_bytes': used, 'provisioned_bytes': image.stat().st_size if image.exists() else 0,
                'ranges': RANGES, 'total_disk_budget_mib': int(os.environ.get('SANDBOX_TOTAL_DISK_MIB', '8192'))}
    def save(self, user, value):
        if set(value) != set(DEFAULT): raise ValueError('需要完整配额字段')
        for key, (minimum, maximum) in RANGES.items():
            number = value[key]
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not minimum <= number <= maximum:
                raise ValueError('配额超出允许范围：' + key)
            if key != 'cpus' and int(number) != number: raise ValueError('配额需为整数：' + key)
        value = {key: float(number) if key == 'cpus' else int(number) for key, number in value.items()}
        with lock:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            entries = self.load()
            users = {path.stem for path in self.root.glob('*.img')} | set(entries) | {user}
            total = sum(value['disk_mib'] if item == user else self.get(item)['disk_mib'] for item in users)
            if total > int(os.environ.get('SANDBOX_TOTAL_DISK_MIB', '8192')):
                raise ValueError('分配总量超过服务器沙箱磁盘预算，请先回收其他配额或调整主机预算')
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
            temporary = self.root / 'quotas.json.tmp'
            temporary.write_text(json.dumps(entries)); temporary.chmod(0o600)
            os.replace(temporary, self.root / 'quotas.json')
        return self.status(user)
