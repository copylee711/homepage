"""Exercise the broker's authenticated workspace routes with task resources occupied."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

os.environ.update(SANDBOX_SECRET='test-secret', SANDBOX_NETWORK='none')
spec = importlib.util.spec_from_file_location('broker', Path(__file__).resolve().parents[1] / 'sandbox-broker.py')
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
USER = 'a' * 64


class Request(broker.Handler):
    def __init__(self, path, payload, token=broker.SECRET):
        data = json.dumps({'user': USER, **payload}).encode()
        self.path = path
        self.client_address = ('192.168.84.2', 0)
        self.headers = {'Content-Length': str(len(data)), 'Authorization': 'Bearer ' + token}
        self.rfile = io.BytesIO(data)
        self.do_POST()

    def reply(self, status, value):
        self.result = status, value


class WorkspaceTest(unittest.TestCase):
    def test_reads_with_task_slots_full(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(broker, 'workspace', return_value=Path(folder)), \
                patch.object(broker, 'slots', None), patch.object(broker, 'active_memory', {'task': 4096}):
            root = Path(folder)
            (root / '文档.txt').write_bytes(b'hello')
            (root / 'link').symlink_to('/etc')
            status, result = Request('/files/operation', {'op': 'list', 'path': ''}).result
            self.assertEqual(status, 200)
            self.assertEqual({entry['name'] for entry in result['entries']}, {'文档.txt', 'link'})
            status, result = Request('/files/operation', {'op': 'file-read', 'path': '/workspace/文档.txt'}).result
            self.assertEqual(status, 200)
            self.assertEqual(base64.b64decode(result['data']), b'hello')
            self.assertEqual(result['revision'], hashlib.sha256(b'hello').hexdigest())
            for path in ('../etc/passwd', '/etc/passwd', 'link/passwd'):
                self.assertGreaterEqual(Request('/files/operation', {'op': 'file-read', 'path': path}).result[0], 400)
            self.assertEqual(Request('/files/operation', {'op': 'list'}, 'task-lease').result[0], 401)

    def test_write_and_terminal_exec_have_independent_container_names_and_slots(self):
        process = Mock()
        process.communicate.return_value = (b'{"ok": true}', b'')
        with patch.dict(broker.locks, {USER: Mock(), USER + ':view': Mock()}), \
                patch.object(broker, 'slots', None), patch.object(broker, 'workspace', return_value=Path('/isolated')), \
                patch.object(broker.subprocess, 'run', return_value=Mock(returncode=0)) as docker, \
                patch.object(broker.subprocess, 'Popen', return_value=process):
            status, _ = Request('/files/operation', {'op': 'file-manage', 'action': 'mkdir', 'path': 'new'}).result
            self.assertEqual(status, 200)
            self.assertIn('cl-files-' + USER, docker.call_args_list[0].args[0])
            status, _ = Request('/pty/exec', {'command': 'pwd'}).result
            self.assertEqual(status, 200)
            self.assertIn('cl-term-exec-' + USER, docker.call_args_list[2].args[0])
            Request('/cancel', {})
            self.assertEqual(docker.call_args.args[0], ['docker', 'rm', '-f', 'cl-sandbox-' + USER])
            for key in (USER, USER + ':view'):
                broker.locks[key].acquire.assert_not_called()

    def test_pty_survives_task_cancel_and_uses_its_own_memory_budget(self):
        with patch.object(broker, 'active_memory', {'task': 4096}), \
                patch.object(broker, 'workspace', return_value=Path('/isolated')), \
                patch.object(broker, 'Terminal') as terminal, patch.object(broker, 'docker') as docker:
            self.assertEqual(Request('/pty/open', {}).result[0], 200)
            try:
                self.assertEqual(Request('/cancel', {}).result[0], 200)
                self.assertEqual(docker.call_args.args[-1], 'cl-sandbox-' + USER)
                terminal.return_value.close.assert_not_called()
                self.assertIn(USER, broker.terminal_memory)
            finally:
                self.assertEqual(Request('/pty/close', {}).result[0], 200)
            self.assertNotIn(USER, broker.terminal_memory)


if __name__ == '__main__':
    unittest.main()
