import importlib.util
import pathlib
import unittest
from unittest.mock import patch
import io
import json
import tarfile
import gzip
import hashlib
import base64
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
web = load('web-access')
packages = load('package-reader')
quota_module = load('sandbox-quotas')

def records(addresses):
    return [(2, 1, 6, '', (address, 443)) for address in addresses]

class AccessTests(unittest.TestCase):
    def test_non_public_and_mixed_dns_are_denied(self):
        for ip in ['127.0.0.1', '10.0.0.1', '192.168.84.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1']:
            with patch.object(web.socket, 'getaddrinfo', return_value=records(['1.1.1.1', ip])):
                with self.assertRaises(ValueError): web.resolve_url('https://example.com')
    def test_protocol_credentials_port_and_control_characters(self):
        for url in ['file:///etc/passwd', 'http://user:pass@example.com', 'https://example.com:7890', 'https://example.com\r\nx', 'http://[::1]']:
            with self.assertRaises(ValueError): web.resolve_url(url)
    def test_dns_is_pinned_and_redirect_rechecked(self):
        class Response:
            status = 302
            def getheader(self, key, default=None): return 'http://127.0.0.1/secret' if key == 'Location' else default
        class Connection:
            hosts = []
            def __init__(self, host, port, **kw): self.hosts.append(host)
            def connect(self): pass
            def request(self, *args, **kwargs): pass
            def getresponse(self): return Response()
            def close(self): pass
        def dns(host, *args): return records(['127.0.0.1'] if host == '127.0.0.1' else ['1.1.1.1'])
        with patch.object(web.socket, 'getaddrinfo', side_effect=dns), patch.object(web.http.client, 'HTTPConnection', Connection), patch.dict(web.os.environ, {'SANDBOX_WEB_PROXY': ''}):
            with self.assertRaises(ValueError): web.fetch_public('http://example.com')
        self.assertEqual(Connection.hosts, ['1.1.1.1'])
    def test_html_is_text_with_links_and_no_script(self):
        parser = web.TextHTML(); parser.feed('<script>secret()</script><p>Hello<a href="https://example.com">source</a></p>')
        self.assertIn('https://example.com', ''.join(parser.parts)); self.assertNotIn('secret', ''.join(parser.parts))

class PackageTests(unittest.TestCase):
    def fixture(self):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for path, text in [('package/skills/test/SKILL.md', '---\nname: test\ndescription: fixture\n---\nHelpful text.'), ('package/extensions/evil.js', 'throw new Error("must not run")'), ('package/../../escape.md', 'escape')]:
                item = tarfile.TarInfo(path); data = text.encode(); item.size = len(data); archive.addfile(item, io.BytesIO(data))
        data = gzip.compress(stream.getvalue())
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
        return data, integrity
    def test_only_declared_text_is_returned_without_code_execution(self):
        data, integrity = self.fixture()
        metadata = json.dumps({'dist': {'tarball': 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', 'integrity': integrity}, 'pi': {'skills': ['skills'], 'extensions': ['extensions']}}).encode()
        with patch.object(packages, 'registry_read', side_effect=[metadata, data]):
            result = packages.read_package({'name': 'example', 'version': '1.0.0'})
        self.assertEqual(len(result['resources']), 1)
        self.assertEqual(result['resources'][0]['kind'], 'skill')
        self.assertTrue(result['extensionsDisabled'])
    def test_integrity_and_fixed_versions(self):
        with self.assertRaises(ValueError): packages.read_package({'name': 'example', 'version': 'latest'})
        data, _ = self.fixture()
        metadata = json.dumps({'dist': {'tarball': 'https://registry.npmjs.org/example.tgz', 'integrity': 'sha512-invalid'}}).encode()
        with patch.object(packages, 'registry_read', side_effect=[metadata, data]):
            with self.assertRaises(ValueError): packages.read_package({'name': 'example', 'version': '1.0.0'})
        with self.assertRaises(ValueError): packages.registry_read('https://127.0.0.1/archive.tgz', 1024)

class QuotaTests(unittest.TestCase):
    def test_admin_policy_persists_and_rejects_invalid_or_overallocated_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            quotas = quota_module.Quotas(directory)
            value = {**quota_module.DEFAULT, 'disk_mib': 512, 'memory_mib': 1024, 'cpus': 2}
            quotas.save('a' * 64, value)
            self.assertEqual(quota_module.Quotas(directory).get('a' * 64), value)
            self.assertEqual(quotas.get('b' * 64), quota_module.DEFAULT)
            for change in [{'disk_mib': 1}, {'memory_mib': True}, {'timeout': 99999}, {'cpus': float('nan')}]:
                with self.assertRaises(ValueError): quotas.save('a' * 64, {**value, **change})
            with patch.dict(quota_module.os.environ, {'SANDBOX_TOTAL_DISK_MIB': '600'}):
                with self.assertRaises(ValueError): quotas.save('b' * 64, value)

unittest.main()
