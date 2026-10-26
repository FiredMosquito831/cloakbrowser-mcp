"""Behavioural tests for the Camoufox identity step in camoufox_entry.py.

Runs with a plain CPython 3 interpreter and no third-party package: the fingerprint
generator is injected, so nothing here imports camoufox, starts a browser or uses
the network. The entry point file is loaded by path (``python -I <file>``) and the
suite is driven from tests/unit/plugin-camoufox-identity.test.ts.

Usage:
  python -I tests/python/test_camoufox_identity.py [--entry <camoufox_entry.py>]
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import re
import sys
import tempfile
import traceback

DEFAULT_ENTRY = (
    pathlib.Path(__file__).resolve().parent.parent.parent / 'plugins' / 'camoufox' / 'camoufox_entry.py'
)
ISO = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')


def load_entry(path):
    spec = importlib.util.spec_from_file_location('camoufox_entry_under_test', path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'cannot load {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fingerprint(os_name=None, tag='a'):
    return {
        'os': 'Windows' if os_name in (None, 'windows') else 'Mac OS X',
        'navigator': {
            'userAgent': f'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.{tag}) Gecko/20100101 Firefox/146.0',
            'platform': 'Win32',
            'hardwareConcurrency': 8,
            'oscpu': 'Windows NT 10.0; Win64; x64',
            'language': 'en-US',
        },
        'screen': {'width': 1920, 'height': 1080, 'colorDepth': 24},
        'webgl': {'vendor': 'Google Inc. (NVIDIA)', 'renderer': 'ANGLE (NVIDIA)'},
    }


class Cases:
    def __init__(self, entry):
        self.entry = entry
        self.failures = []

    def check(self, name, fn):
        try:
            fn()
        except Exception:
            self.failures.append((name, traceback.format_exc()))
            print(f'FAIL {name}')
        else:
            print(f'PASS {name}')

    # --- helpers -----------------------------------------------------------
    def env(self, root, **values):
        env = {
            'CLAUDE_PLUGIN_DATA': os.path.join(root, 'data'),
            'CAMOUFOX_BROWSER_BUILD': 'v156.0.1-beta.39',
        }
        env.update(values)
        return {key: value for key, value in env.items() if value is not None}

    def profile(self, root, name='profiles/camoufox/default'):
        path = os.path.join(root, name)
        os.makedirs(path, exist_ok=True)
        return path

    def applying(self, env, generate=None):
        logs = []
        status = self.entry.apply_identity(env=env, generate=generate or (lambda os_name: fingerprint(os_name)), log=logs.append)
        return status, logs

    # --- mode and host -----------------------------------------------------
    def test_mode_resolution(self):
        cases = [
            ({}, ('profile', None)),
            ({'STEALTH_IDENTITY_MODE': ''}, ('profile', None)),
            ({'STEALTH_IDENTITY_MODE': '${user_config.identity_mode}'}, ('profile', None)),
            ({'STEALTH_IDENTITY_MODE': 'random'}, ('random', None)),
            ({'STEALTH_IDENTITY_MODE': ' PROFILE '}, ('profile', None)),
            ({'STEALTH_IDENTITY_MODE': 'surprise'}, ('profile', 'unknown')),
        ]
        for env, (mode, warning) in cases:
            resolved, warned = self.entry.identity_mode(env)
            assert resolved == mode, (env, resolved, mode)
            assert (warned is not None) == (warning is not None), (env, warned)
            if warning is not None:
                assert warning in warned

    def test_host_os(self):
        assert self.entry.host_os('win32') == 'windows'
        assert self.entry.host_os('darwin') == 'macos'
        assert self.entry.host_os('linux') == 'linux'
        assert self.entry.host_os('linux2') == 'linux'
        assert self.entry.host_os('freebsd13') is None

    # --- file lifecycle ----------------------------------------------------
    def test_create_then_reuse(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            calls = []

            def generate(os_name):
                calls.append(os_name)
                return fingerprint(os_name, tag='one')

            status, logs = self.applying(env, generate)
            assert status['applied'] is True, status
            path = os.path.join(profile, '.camoufox-identity.json')
            assert os.path.isfile(path)
            first = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
            assert first['version'] == 1
            assert first['engine'] == 'camoufox'
            assert ISO.match(first['createdAt']), first['createdAt']
            assert first['build'] == 'v156.0.1-beta.39'
            assert first['os'] == self.entry.host_os(), first['os']
            assert first['os'] is not None
            assert first['fingerprint']['navigator']['userAgent'].endswith('146.one) Gecko/20100101 Firefox/146.0')
            assert 'regeneratedAt' not in first
            assert calls == ['windows']
            assert env['CAMOUFOX_MCP_CONFIG'] == self.entry.launch_config_path(profile, env)
            config = json.loads(pathlib.Path(env['CAMOUFOX_MCP_CONFIG']).read_text(encoding='utf-8'))
            assert config['browser']['camoufoxOptions']['fingerprint'] == first['fingerprint']
            assert config['browser']['camoufoxOptions']['os'] == self.entry.host_os()

            status2, logs2 = self.applying(
                self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile),
                lambda os_name: (_ for _ in ()).throw(AssertionError('must not draw')),
            )
            assert status2['applied'] is True, status2
            second = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
            assert second == first, 'reuse must not rewrite the identity file'
            assert logs, 'creating an identity logs one line'
            assert logs2 == [], 'reuse is silent'

    def test_corrupt_json_regenerates(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            path = os.path.join(profile, '.camoufox-identity.json')
            pathlib.Path(path).write_text('{not json', encoding='utf-8')
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            status, logs = self.applying(env)
            assert status['applied'] is True, status
            data = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
            assert data['fingerprint']['navigator']['platform'] == 'Win32'
            assert ISO.match(data.get('regeneratedAt', '')), data
            assert len([line for line in logs if 'corrupt' in line]) == 1, logs

    def test_corrupt_shape_regenerates(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            path = os.path.join(profile, '.camoufox-identity.json')
            pathlib.Path(path).write_text(json.dumps({'version': 1, 'fingerprint': {'navigator': {}}}), encoding='utf-8')
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            status, _logs = self.applying(env)
            assert status['applied'] is True, status
            data = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
            assert data['fingerprint']['screen']['width'] == 1920

    def test_unreadable_file_never_fails(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            path = os.path.join(profile, '.camoufox-identity.json')
            os.makedirs(path)
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            status, logs = self.applying(env)
            assert status['applied'] is False and status['reason'] == 'identity', status
            assert 'CAMOUFOX_MCP_CONFIG' not in env
            assert any('cannot remove the unreadable identity file' in line for line in logs), logs

    def test_generation_failure_is_soft(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)

            def boom(os_name):
                raise RuntimeError('model unavailable')

            status, logs = self.applying(env, boom)
            assert status['applied'] is False and status['reason'] == 'identity', status
            assert not os.path.exists(os.path.join(profile, '.camoufox-identity.json'))
            assert 'CAMOUFOX_MCP_CONFIG' not in env
            assert any('model unavailable' in line for line in logs), logs

    def test_identity_write_failure_is_soft(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            original_open = self.entry.os.open

            def deny(*_args, **_kwargs):
                raise OSError(13, 'permission denied')

            self.entry.os.open = deny
            try:
                status, logs = self.applying(env)
            finally:
                self.entry.os.open = original_open
            assert status['applied'] is False and status['reason'] == 'identity', status
            assert 'CAMOUFOX_MCP_CONFIG' not in env
            assert any('cannot store the device identity' in line for line in logs), logs

    def test_partial_identity_write_is_removed(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            original_fdopen = self.entry.os.fdopen

            class FailingHandle:
                def __enter__(self):
                    return self

                def __exit__(self, *_exc_info):
                    return False

                def write(self, _payload):
                    raise OSError(28, 'no space left on device')

                def flush(self):
                    return None

                def fileno(self):
                    return 1

            def failing_fdopen(descriptor, *_args, **_kwargs):
                os.close(descriptor)
                return FailingHandle()

            self.entry.os.fdopen = failing_fdopen
            try:
                status, logs = self.applying(env)
            finally:
                self.entry.os.fdopen = original_fdopen
            assert status['applied'] is False and status['reason'] == 'identity', status
            assert not os.path.exists(os.path.join(profile, '.camoufox-identity.json'))
            assert 'CAMOUFOX_MCP_CONFIG' not in env
            assert any('cannot store the device identity' in line for line in logs), logs

    def test_incomplete_draw_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            status, logs = self.applying(env, lambda os_name: {'navigator': {'userAgent': 'x'}})
            assert status['applied'] is False, status
            assert any('incomplete' in line for line in logs), logs

    # --- modes that must not touch anything --------------------------------
    def test_random_leaves_no_file(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile, STEALTH_IDENTITY_MODE='random')
            status, logs = self.applying(env)
            assert status == {'mode': 'random', 'applied': False, 'reason': 'mode'}, status
            assert not os.path.exists(os.path.join(profile, '.camoufox-identity.json'))
            assert not os.path.exists(os.path.join(root, 'data'))
            assert 'CAMOUFOX_MCP_CONFIG' not in env
            assert logs == []

    def test_isolated_leaves_no_file(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(root, PLAYWRIGHT_MCP_ISOLATED='true', PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            status, _logs = self.applying(env)
            assert status['applied'] is False and status['reason'] == 'isolated', status
            assert not os.path.exists(os.path.join(profile, '.camoufox-identity.json'))
            assert 'CAMOUFOX_MCP_CONFIG' not in env

    def test_isolated_true_spelling_only(self):
        for value, expected in [('true', True), ('1', True), ('TRUE', True), ('false', False), ('0', False), ('', False)]:
            assert self.entry.is_isolated({'PLAYWRIGHT_MCP_ISOLATED': value}) is expected, value

    def test_no_profile_dir_is_soft(self):
        with tempfile.TemporaryDirectory() as root:
            env = self.env(root)
            status, logs = self.applying(env)
            assert status['applied'] is False and status['reason'] == 'no-profile', status
            assert 'CAMOUFOX_MCP_CONFIG' not in env
            assert any('no browser profile directory' in line for line in logs), logs

    # --- user config handling ----------------------------------------------
    def test_user_json_config_is_merged_not_edited(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'user.json')
            original = {
                'browser': {'camoufoxOptions': {'headless': False, 'humanize': True}, 'userDataDir': 'x'},
                'server': {'port': 0},
            }
            pathlib.Path(theirs).write_text(json.dumps(original, indent=4), encoding='utf-8')
            before = pathlib.Path(theirs).read_bytes()
            env = self.env(
                root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile, CAMOUFOX_MCP_CONFIG=theirs
            )
            status, _logs = self.applying(env)
            assert status['applied'] is True, status
            assert pathlib.Path(theirs).read_bytes() == before, 'the user file must never be edited'
            assert env['CAMOUFOX_MCP_CONFIG'] != theirs
            merged = json.loads(pathlib.Path(env['CAMOUFOX_MCP_CONFIG']).read_text(encoding='utf-8'))
            assert merged['browser']['camoufoxOptions']['headless'] is False
            assert merged['browser']['camoufoxOptions']['humanize'] is True
            assert merged['browser']['userDataDir'] == 'x'
            assert merged['server'] == {'port': 0}
            assert merged['browser']['camoufoxOptions']['os'] == self.entry.host_os()
            assert 'fingerprint' in merged['browser']['camoufoxOptions']

    def test_user_pinned_fingerprint_is_overridden_in_our_copy_only(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'user.json')
            original = {'browser': {'camoufoxOptions': {'fingerprint': {'navigator': {'userAgent': 'custom'}}}}}
            pathlib.Path(theirs).write_text(json.dumps(original), encoding='utf-8')
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile, CAMOUFOX_MCP_CONFIG=theirs)
            status, logs = self.applying(env)
            assert status['applied'] is True, status
            merged = json.loads(pathlib.Path(env['CAMOUFOX_MCP_CONFIG']).read_text(encoding='utf-8'))
            assert merged['browser']['camoufoxOptions']['fingerprint']['navigator']['platform'] == 'Win32'
            assert json.loads(pathlib.Path(theirs).read_text(encoding='utf-8')) == original
            assert any('already sets a fingerprint' in line for line in logs), logs

    def test_ini_config_is_left_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'user.ini')
            pathlib.Path(theirs).write_text('browser = camoufox\n', encoding='utf-8')
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile, CAMOUFOX_MCP_CONFIG=theirs)
            status, logs = self.applying(env)
            assert status['applied'] is False and status['reason'] == 'config', status
            assert env['CAMOUFOX_MCP_CONFIG'] == theirs
            assert not os.path.exists(os.path.join(profile, '.camoufox-identity.json')), (
                'an INI config must not leave a generated identity behind'
            )
            assert any('leaving it untouched' in line for line in logs), logs

    def test_missing_user_config_is_left_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'absent.json')
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile, CAMOUFOX_MCP_CONFIG=theirs)
            status, _logs = self.applying(env)
            assert status['applied'] is False, status
            assert env['CAMOUFOX_MCP_CONFIG'] == theirs
            assert not os.path.exists(os.path.join(profile, '.camoufox-identity.json'))

    def test_playwright_mcp_config_is_merged_too(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'pw.json')
            pathlib.Path(theirs).write_text(json.dumps({'browser': {'launchOptions': {'args': ['-x']}}}), encoding='utf-8')
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile, PLAYWRIGHT_MCP_CONFIG=theirs)
            status, _logs = self.applying(env)
            assert status['applied'] is True, status
            merged = json.loads(pathlib.Path(env['CAMOUFOX_MCP_CONFIG']).read_text(encoding='utf-8'))
            assert merged['browser']['launchOptions'] == {'args': ['-x']}
            assert 'fingerprint' in merged['browser']['camoufoxOptions']
            assert env['PLAYWRIGHT_MCP_CONFIG'] == theirs

    def test_null_sections_in_user_config_are_filled_in(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'nulls.json')
            original = {'browser': None}
            pathlib.Path(theirs).write_text(json.dumps(original), encoding='utf-8')
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile, CAMOUFOX_MCP_CONFIG=theirs)
            status, _logs = self.applying(env)
            assert status['applied'] is True, status
            merged = json.loads(pathlib.Path(env['CAMOUFOX_MCP_CONFIG']).read_text(encoding='utf-8'))
            assert isinstance(merged['browser'], dict)
            assert 'fingerprint' in merged['browser']['camoufoxOptions']
            assert json.loads(pathlib.Path(theirs).read_text(encoding='utf-8')) == original

    def test_non_object_browser_is_left_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'bad.json')
            pathlib.Path(theirs).write_text(json.dumps({'browser': 'nope'}), encoding='utf-8')
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile, CAMOUFOX_MCP_CONFIG=theirs)
            status, _logs = self.applying(env)
            assert status['applied'] is False, status
            assert not os.path.exists(os.path.join(profile, '.camoufox-identity.json'))

    # --- host OS and continuity --------------------------------------------
    def test_unknown_host_omits_the_os_pin(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            original = self.entry.host_os
            try:
                self.entry.host_os = lambda platform=None: None
                status, _logs = self.applying(env)
            finally:
                self.entry.host_os = original
            assert status['applied'] is True, status
            data = json.loads(pathlib.Path(os.path.join(profile, '.camoufox-identity.json')).read_text(encoding='utf-8'))
            assert data['os'] is None, data['os']
            config = json.loads(pathlib.Path(env['CAMOUFOX_MCP_CONFIG']).read_text(encoding='utf-8'))
            assert 'os' not in config['browser']['camoufoxOptions'], config

    def test_stored_os_wins_on_reuse(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            path = os.path.join(profile, '.camoufox-identity.json')
            stored = {
                'version': 1,
                'engine': 'camoufox',
                'createdAt': '2026-10-26T00:00:00Z',
                'build': 'v1',
                'os': 'macos',
                'fingerprint': fingerprint('macos', tag='stored'),
            }
            pathlib.Path(path).write_text(json.dumps(stored), encoding='utf-8')
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            status, _logs = self.applying(env)
            assert status['applied'] is True, status
            config = json.loads(pathlib.Path(env['CAMOUFOX_MCP_CONFIG']).read_text(encoding='utf-8'))
            assert config['browser']['camoufoxOptions']['os'] == 'macos'
            assert config['browser']['camoufoxOptions']['fingerprint']['navigator']['platform'] == 'Win32'

    def test_config_is_per_profile(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.profile(root, 'profiles/camoufox/one')
            second = self.profile(root, 'profiles/camoufox/ws-abcdef1')
            env_a = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=first)
            env_b = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=second)
            self.applying(env_a)
            self.applying(env_b)
            assert env_a['CAMOUFOX_MCP_CONFIG'] != env_b['CAMOUFOX_MCP_CONFIG']
            assert os.path.isfile(env_a['CAMOUFOX_MCP_CONFIG'])
            assert os.path.isfile(env_b['CAMOUFOX_MCP_CONFIG'])

    def test_identity_is_reused_across_copies(self):
        """A profile copy carries the file; the same fingerprint is presented."""
        import shutil

        with tempfile.TemporaryDirectory() as root:
            base = self.profile(root, 'profiles/camoufox/base')
            env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=base)
            self.applying(env)
            copy = os.path.join(root, 'profiles/camoufox/base-copy')
            shutil.copytree(base, copy)
            env2 = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=copy)
            status, logs = self.applying(env2)
            assert status['applied'] is True, status
            original = json.loads(pathlib.Path(os.path.join(base, '.camoufox-identity.json')).read_text(encoding='utf-8'))
            copied = json.loads(pathlib.Path(os.path.join(copy, '.camoufox-identity.json')).read_text(encoding='utf-8'))
            assert copied == original
            assert logs == [], 'a copy reuses its identity silently'

    def test_plugin_data_fallback_is_under_home(self):
        path = self.entry.launch_config_path('/tmp/profile', {})
        assert path.endswith(os.path.join('config', 'camoufox', pathlib.Path(path).name))
        assert path.startswith(os.path.expanduser('~')), path


def main(argv):
    entry_path = DEFAULT_ENTRY
    if '--entry' in argv:
        entry_path = pathlib.Path(argv[argv.index('--entry') + 1]).resolve()
    module = load_entry(entry_path)
    cases = Cases(module)
    names = [name for name in dir(cases) if name.startswith('test_')]
    for name in sorted(names):
        cases.check(name, getattr(cases, name))
    print(f'RESULT {len(names) - len(cases.failures)} passed, {len(cases.failures)} failed')
    if cases.failures:
        for name, detail in cases.failures:
            print(f'--- {name} ---')
            print(detail)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
