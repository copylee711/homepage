"""Install-shaped background tasks stop on abort; preview servers do not."""
import importlib.util
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('background_tasks', root / 'background-tasks.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

installs = [
    'pip install -r requirements.txt',
    'python3 -m pip install numpy',
    'npm ci --no-audit',
    'cd /workspace/app && npm install',
    'FOO=bar npm run build',
    'cargo build --release',
    'go mod download',
    'gradle build',
]
foreground = ['npm test', 'npm run dev -- --port 5173', 'echo npm install', 'python3 -m http.server 5173', 'ls']
for command in installs:
    assert mod.is_install_command(command), command
for command in foreground:
    assert not mod.is_install_command(command), command
assert mod.task_purpose('npm install', 'server') == 'install'
assert mod.task_purpose('npm run dev', None) == 'server'
try:
    mod.task_purpose('ls', 'root')
    raise SystemExit('invalid purpose must be rejected')
except ValueError:
    pass

class Fake(mod.BackgroundTasks):
    def __init__(self):
        self.tasks = {}
        self.lock = mod.threading.RLock()
        self.calls = []
    def docker(self, *args, timeout=15):
        self.calls.append(args)
        class Result:
            returncode = 0
            stdout = b''
            stderr = b''
        return Result()

user = 'a' * 64
tasks = Fake()
def add(task_id, purpose):
    tasks.tasks[task_id] = {
        'id': task_id, 'user': user, 'state': 'running', 'purpose': purpose,
        'container': 'c-' + task_id, 'port': None, 'title': task_id, 'command': task_id,
        'cwd': '/workspace/app', 'startedAt': 0, 'expiresAt': 0, 'exitCode': None,
    }
add('install', 'install')
add('preview', 'server')
tasks.stop_installs(user)
assert tasks.tasks['install']['state'] == 'stopped'
assert tasks.tasks['preview']['state'] == 'running'
assert any(call[:2] == ('rm', '-f') and call[2] == 'c-install' for call in tasks.calls)
assert all(call[2] != 'c-preview' for call in tasks.calls if call[:2] == ('rm', '-f'))

broker = (root / 'sandbox-broker.py').read_text()
assert 'stopInstalls' in broker and 'stop_installs' in broker
print('PASS: install purpose is classified and abort stops only install tasks')
