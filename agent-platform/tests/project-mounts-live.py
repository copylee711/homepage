"""Run on the Linux Docker host against the candidate sandbox image."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import shutil

spec = importlib.util.spec_from_file_location('project_policy', Path(__file__).parents[1] / 'project-policy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(tempfile.mkdtemp(prefix='agent-project-policy-'))
root.chmod(0o755)
image = os.environ.get('TEST_SANDBOX_IMAGE', 'copylee-agent-sandbox:acceptance')

def run(rules, command):
    result = subprocess.run(['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
        '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=8m',
        *module.mount_arguments(root, module.policy(rules)), image],
        input=json.dumps({'op': 'bash', 'command': command, 'cwd': '/workspace/app', 'timeout': 5}),
        capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout)
    assert 'error' not in value, value
    return value

try:
    for name in ['app', 'reference', 'private']:
        directory = root / name
        directory.mkdir()
        os.chown(directory, 1000, 1000)
        (directory / 'value.txt').write_text(name)
        os.chown(directory / 'value.txt', 1000, 1000)
    (root / 'app' / 'escape').symlink_to('/workspace/private/value.txt')
    only = {'project': 'app', 'scope': 'project_only'}
    (root / '.tools' / 'bin').mkdir(parents=True)
    (root / '.tools' / 'bin' / 'qa-shared').write_text('#!/bin/sh\necho SHARED_TOOL_OK\n')
    (root / '.tools' / 'bin' / 'qa-shared').chmod(0o755)
    assert run(only, 'qa-shared')['output'].strip() == 'SHARED_TOOL_OK'
    assert run(only, 'echo changed > /workspace/.tools/bin/qa-shared')['exitCode'] != 0
    assert run(only, 'pwd')['output'].strip() == '/workspace/app'
    assert run(only, 'echo own > own.txt; cat own.txt')['exitCode'] == 0
    for command in ['cat ../private/value.txt', 'cat escape', 'cat /workspace/reference/value.txt',
                    'mkdir /workspace/ungranted']:
        assert run(only, command)['exitCode'] != 0, command
    scoped = {'project': 'app', 'scope': 'scoped', 'extraProjects': {'reference': 'read'}}
    assert run(scoped, 'cat ../reference/value.txt')['output'].strip() == 'reference'
    assert run(scoped, 'echo changed > ../reference/value.txt')['exitCode'] != 0
    assert run(scoped, 'rm ../reference/value.txt')['exitCode'] != 0
    scoped['extraProjects']['reference'] = 'write'
    assert run(scoped, 'echo writable > ../reference/value.txt')['exitCode'] == 0
    assert run({'project': 'app', 'scope': 'full'}, 'cat ../private/value.txt')['output'].strip() == 'private'
    (root / 'linked').symlink_to(root / 'private', target_is_directory=True)
    try:
        module.mount_arguments(root, module.policy({'project': 'linked'}))
        raise AssertionError('Symlink project accepted')
    except ValueError:
        pass
    print('PASS: real bash cwd, shared read-only toolchain, own writes, hidden projects, traversal/symlink escape, read-only/write grants, full scope, symlink project rejection')
finally:
    shutil.rmtree(root)
