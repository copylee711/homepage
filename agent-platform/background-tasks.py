"""Host-owned, bounded task registry. No published ports or Docker socket in tools."""
import base64
import json
import os
import re
import secrets
import subprocess
import threading
import time

class BackgroundTasks:
    def __init__(self, workspace, quotas, policy, image, network, active_memory):
        self.workspace = workspace; self.quotas = quotas; self.policy = policy; self.image = image; self.network = network; self.active_memory = active_memory
        self.tasks = {}; self.lock = threading.RLock()
    def docker(self, *args, timeout=15):
        return subprocess.run(['docker', *args], capture_output=True, timeout=timeout)
    def memory_used(self):
        with self.lock: return sum(t['memory'] for t in self.tasks.values() if t['state'] == 'running')
    def public(self, task):
        return {**{key: task[key] for key in ['id', 'title', 'command', 'cwd', 'port', 'startedAt', 'expiresAt', 'state', 'exitCode']}, 'previewPath': '/preview/' + task['id'] + '/' if task['port'] else None}
    def refresh(self, task):
        if task['state'] != 'running': return
        result = self.docker('inspect', '--format', '{{json .State}}', task['container'])
        try:
            state = json.loads(result.stdout)
            if not state.get('Running'): task['state'] = 'exited'; task['exitCode'] = state.get('ExitCode')
        except ValueError: task['state'] = 'stopped'
    def list(self, user):
        with self.lock:
            for t in self.tasks.values():
                if t['user'] == user: self.refresh(t)
            return {'tasks': [self.public(t) for t in self.tasks.values() if t['user'] == user]}
    def owned(self, user, task_id):
        task = self.tasks.get(task_id)
        if not task or task['user'] != user: raise ValueError('后台任务不存在')
        return task
    def start(self, user, value, rules):
        command = value.get('command'); cwd = value.get('cwd')
        if not isinstance(command, str) or not command.strip() or len(command) > 8000 or '\x00' in command: raise ValueError('后台命令无效')
        if not isinstance(cwd, str) or not cwd.startswith('/workspace/') or any(c in cwd for c in ['\x00', '\n', '\r']) or '..' in cwd.split('/'): raise ValueError('后台目录必须位于项目内')
        port = value.get('port')
        if port is not None and (type(port) is not int or not 1024 <= port <= 65535): raise ValueError('预览端口需为 1024–65535')
        with self.lock:
            for task in self.tasks.values(): self.refresh(task)
            running = [t for t in self.tasks.values() if t['state'] == 'running']
            if len(running) >= 4 or sum(t['user'] == user for t in running) >= 2: raise ValueError('后台任务已达上限（每用户 2 个，全局 4 个）')
            quota = self.quotas.get(user)
            if self.memory_used() + sum(self.active_memory.values()) + quota['memory_mib'] > int(os.environ.get('SANDBOX_ACTIVE_MEMORY_MIB', '4096')): raise ValueError('运行内存预算已满，请先停止其他任务')
            root = self.workspace(user); task_id = secrets.token_urlsafe(32); name = 'cl-background-' + task_id[:20].lower().replace('_', 'x')
            task = {'id': task_id, 'user': user, 'container': name, 'memory': quota['memory_mib'], 'title': str(value.get('title') or '后台任务')[:100], 'command': command, 'cwd': cwd, 'port': port, 'startedAt': int(time.time()*1000), 'expiresAt': int((time.time()+3600)*1000), 'state': 'running', 'exitCode': None}
            task['previewBase'] = value.get('previewBase') is True
            args = ['run', '-d', '--name', name, '--label', 'copylee.background=1', '--network', self.network, '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--memory', str(quota['memory_mib'])+'m', '--memory-swap', str(quota['memory_mib'])+'m', '--cpus', str(quota['cpus']), '--pids-limit', str(quota['pids']), '--ulimit', 'nofile=1024:1024', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--shm-size', '8m', '--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1', *self.policy.mount_arguments(root, rules), '--env', 'HOME=/tmp', '--env', 'HTTP_PROXY=http://192.168.85.2:3128', '--env', 'HTTPS_PROXY=http://192.168.85.2:3128', '--entrypoint', 'python3', self.image, '/background-worker.py', json.dumps({'command': command, 'cwd': cwd})]
            args[args.index('--entrypoint'):args.index('--entrypoint')] = ['--env', 'IRIS_PREVIEW_BASE=/preview/' + task_id + '/']
            result = self.docker(*args)
            if result.returncode: self.docker('rm', '-f', name); raise ValueError('后台容器启动失败')
            self.tasks[task_id] = task
            # Keep bounded stopped history; logs disappear when a task is stopped.
            history = [t for t in self.tasks.values() if t['user'] == user and t['state'] != 'running']
            for old in history[:-8]: self.docker('rm', '-f', old['container']); self.tasks.pop(old['id'], None)
            return self.public(task)
    def logs(self, user, task_id):
        with self.lock:
            task = self.owned(user, task_id); self.refresh(task)
            if task['state'] == 'stopped': return {**self.public(task), 'logs': task.get('logsTail', '')}
            result = self.docker('logs', '--tail', '200', task['container'])
            data = result.stdout + result.stderr
            return {**self.public(task), 'logs': data[-65536:].decode('utf8', errors='replace')}
    def stop(self, user, task_id):
        with self.lock:
            task = self.owned(user, task_id)
            result = self.docker('logs', '--tail', '200', task['container'])
            task['logsTail'] = (result.stdout + result.stderr)[-65536:].decode('utf8', errors='replace')
            self.docker('rm', '-f', task['container']); task['state'] = 'stopped'
            return {'ok': True}
    def stop_user(self, user):
        with self.lock:
            for task in list(self.tasks.values()):
                if task['user'] == user and task['state'] == 'running': self.stop(user, task['id'])
    def preview(self, token, path):
        with self.lock:
            task = self.tasks.get(token)
            if not task or task['state'] != 'running' or not task['port'] or task['expiresAt'] <= time.time()*1000: raise ValueError('预览已停止或链接已失效')
            container, port = task['container'], task['port']
            if task.get('previewBase'): path = '/preview/' + token + path
        result = subprocess.run(['docker', 'exec', '-i', container, 'python3', '/background-worker.py', '--fetch'], input=json.dumps({'path': path, 'port': port}).encode(), capture_output=True, timeout=12)
        if result.returncode: raise ValueError('预览服务器尚未就绪或已退出，请查看后台日志')
        return json.loads(result.stdout)
    def sweep(self):
        with self.lock:
            for task in self.tasks.values():
                if task['state'] == 'running' and task['expiresAt'] <= time.time()*1000: self.stop(task['user'], task['id'])
