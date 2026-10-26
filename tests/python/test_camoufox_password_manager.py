"""Behavioural tests for the saved-login step in camoufox_entry.py.

Runs with a plain CPython 3 interpreter and no third-party package: the identity
generator is injected and nothing here imports camoufox, starts a browser or uses
the network. The entry point file is loaded by path (``python -I <file>``) and the
suite is driven from tests/unit/plugin-password-manager.test.ts.

Usage:
  python -I tests/python/test_camoufox_password_manager.py [--entry <camoufox_entry.py>]
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import traceback

DEFAULT_ENTRY = (
    pathlib.Path(__file__).resolve().parent.parent.parent / 'plugins' / 'camoufox' / 'camoufox_entry.py'
)

PASSWORD_PREFS = {
    'signon.rememberSignons': True,
    'signon.autofillForms': True,
    'signon.autofillForms.http': False,
}


def load_entry(path):
    spec = importlib.util.spec_from_file_location('camoufox_entry_password_under_test', path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'cannot load {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fingerprint(os_name=None):
    return {
        'os': 'Windows',
        'navigator': {
            'userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0',
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
        env = {'CLAUDE_PLUGIN_DATA': os.path.join(root, 'data')}
        env.update(values)
        return {key: value for key, value in env.items() if value is not None}

    def profile(self, root, name='profiles/camoufox/default'):
        path = os.path.join(root, name)
        os.makedirs(path, exist_ok=True)
        return path

    def identity(self, env, generate=None):
        return self.entry.apply_identity(
            env=env,
            generate=generate or (lambda os_name: fingerprint(os_name)),
            log=lambda _message: None,
        )

    def passwords(self, env):
        logs = []
        status = self.entry.apply_password_manager(env=env, log=logs.append)
        return status, logs

    def config(self, env):
        assert 'CAMOUFOX_MCP_CONFIG' in env, env
        return json.loads(pathlib.Path(env['CAMOUFOX_MCP_CONFIG']).read_text(encoding='utf-8'))

    # --- off is inert ------------------------------------------------------
    def test_off_leaves_the_environment_and_disk_alone(self):
        for value in (None, '', 'false', '0', 'no', 'off', ' FALSE '):
            with tempfile.TemporaryDirectory() as root:
                profile = self.profile(root)
                env = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile, STEALTH_PASSWORD_MANAGER_STATE=value)
                before = dict(env)
                status, logs = self.passwords(env)
                assert status == {'applied': False, 'reason': 'off'}, (value, status)
                assert env == before, 'off must not touch the environment'
                assert logs == [], logs
                assert not os.path.exists(os.path.join(root, 'data')), 'off must not create the data directory'

    def test_state_must_be_the_launcher_spellings(self):
        for value, expected in [
            ('overlay', True),
            (' OVERLAY ', True),
            ('prefs', True),
            (' PREFS ', True),
            ('applied', False),
            ('blocked-by-overlay', False),
            ('true', False),
            ('', False),
            (None, False),
        ]:
            assert self.entry.password_manager_enabled({'STEALTH_PASSWORD_MANAGER_STATE': value}) is expected, value

    # --- the main path -----------------------------------------------------
    def test_overlay_state_with_identity_writes_one_document(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(
                root,
                PLAYWRIGHT_MCP_USER_DATA_DIR=profile,
                STEALTH_PASSWORD_MANAGER_STATE='overlay',
            )
            identity = self.identity(env)
            assert identity['applied'] is True, identity
            identity_file = env['CAMOUFOX_MCP_CONFIG']
            status, logs = self.passwords(env)
            assert status['applied'] is True, status
            assert status['state'] == 'overlay', status
            assert env['CAMOUFOX_MCP_CONFIG'] == identity_file, 'one merged file, not a second one'
            config = self.config(env)
            options = config['browser']['camoufoxOptions']
            assert options['firefox_user_prefs'] == PASSWORD_PREFS, options
            assert 'toolkit.policies.perUserDir' not in options['firefox_user_prefs']
            assert 'fingerprint' in options and options['os'] == self.entry.host_os()
            assert any('merged the saved-login prefs' in line for line in logs), logs
            # The identity file itself is untouched by this step.
            stored = json.loads(
                pathlib.Path(os.path.join(profile, '.camoufox-identity.json')).read_text(encoding='utf-8')
            )
            assert stored['fingerprint'] == options['fingerprint']

    def test_prefs_state_merges_the_same_three_prefs(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(
                root,
                PLAYWRIGHT_MCP_USER_DATA_DIR=profile,
                STEALTH_IDENTITY_MODE='random',
                STEALTH_PASSWORD_MANAGER_STATE='prefs',
            )
            assert self.identity(env) == {'mode': 'random', 'applied': False, 'reason': 'mode'}
            status, _logs = self.passwords(env)
            assert status['applied'] is True, status
            assert status['state'] == 'prefs', status
            options = self.config(env)['browser']['camoufoxOptions']
            assert options['firefox_user_prefs'] == PASSWORD_PREFS
            assert 'fingerprint' not in options and 'os' not in options

    def test_isolated_start_keys_the_document_on_the_working_directory(self):
        with tempfile.TemporaryDirectory() as root:
            env = self.env(root, PLAYWRIGHT_MCP_ISOLATED='true', STEALTH_PASSWORD_MANAGER_STATE='overlay')
            status, _logs = self.passwords(env)
            assert status['applied'] is True, status
            assert env['CAMOUFOX_MCP_CONFIG'] == self.entry.launch_config_path(os.getcwd(), env)
            options = self.config(env)['browser']['camoufoxOptions']
            assert options['firefox_user_prefs'] == PASSWORD_PREFS

    # --- the executable override ------------------------------------------
    def test_user_executable_path_is_stripped_from_the_copy_only(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'user.json')
            original = {
                'browser': {
                    'camoufoxOptions': {
                        'executable_path': 'C:/somewhere/else/camoufox.exe',
                        'humanize': True,
                    }
                }
            }
            pathlib.Path(theirs).write_text(json.dumps(original, indent=2), encoding='utf-8')
            before = pathlib.Path(theirs).read_bytes()
            env = self.env(
                root,
                PLAYWRIGHT_MCP_USER_DATA_DIR=profile,
                CAMOUFOX_MCP_CONFIG=theirs,
                STEALTH_PASSWORD_MANAGER_STATE='overlay',
            )
            status, logs = self.passwords(env)
            assert status['applied'] is True, status
            assert status['executablePathRemoved'] is True, status
            options = self.config(env)['browser']['camoufoxOptions']
            assert 'executable_path' not in options, options
            assert options['humanize'] is True
            assert pathlib.Path(theirs).read_bytes() == before, 'the user file must never be edited'
            assert any('executable_path' in line for line in logs), logs

    def test_prefs_state_keeps_a_user_executable_path(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'user.json')
            original = {'browser': {'camoufoxOptions': {'executable_path': 'C:/elsewhere/camoufox.exe'}}}
            pathlib.Path(theirs).write_text(json.dumps(original), encoding='utf-8')
            env = self.env(
                root,
                PLAYWRIGHT_MCP_USER_DATA_DIR=profile,
                CAMOUFOX_MCP_CONFIG=theirs,
                STEALTH_PASSWORD_MANAGER_STATE='prefs',
            )
            status, _logs = self.passwords(env)
            assert status['applied'] is True, status
            assert status['executablePathRemoved'] is False, status
            options = self.config(env)['browser']['camoufoxOptions']
            assert options['executable_path'] == 'C:/elsewhere/camoufox.exe', options
            assert json.loads(pathlib.Path(theirs).read_text(encoding='utf-8')) == original

    # --- the user's own wrapper config -------------------------------------
    def test_user_json_config_is_merged_and_never_edited(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'user.json')
            original = {
                'browser': {
                    'camoufoxOptions': {
                        'headless': False,
                        'humanize': True,
                        'firefox_user_prefs': {'browser.startup.homepage': 'about:blank'},
                    },
                    'userDataDir': 'x',
                },
                'server': {'port': 0},
            }
            pathlib.Path(theirs).write_text(json.dumps(original, indent=4), encoding='utf-8')
            before = pathlib.Path(theirs).read_bytes()
            env = self.env(
                root,
                PLAYWRIGHT_MCP_USER_DATA_DIR=profile,
                CAMOUFOX_MCP_CONFIG=theirs,
                STEALTH_PASSWORD_MANAGER_STATE='overlay',
            )
            status, _logs = self.passwords(env)
            assert status['applied'] is True, status
            assert pathlib.Path(theirs).read_bytes() == before, 'the user file must never be edited'
            assert env['CAMOUFOX_MCP_CONFIG'] != theirs
            merged = self.config(env)
            options = merged['browser']['camoufoxOptions']
            assert options['headless'] is False and options['humanize'] is True
            assert merged['browser']['userDataDir'] == 'x'
            assert merged['server'] == {'port': 0}
            assert options['firefox_user_prefs']['browser.startup.homepage'] == 'about:blank'
            for name, value in PASSWORD_PREFS.items():
                assert options['firefox_user_prefs'][name] == value, name

    def test_user_values_for_our_prefs_are_overridden_in_the_copy_only(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'user.json')
            original = {
                'browser': {
                    'camoufoxOptions': {
                        'firefox_user_prefs': {
                            'signon.rememberSignons': False,
                            'signon.autofillForms.http': True,
                        }
                    }
                }
            }
            pathlib.Path(theirs).write_text(json.dumps(original), encoding='utf-8')
            env = self.env(
                root,
                PLAYWRIGHT_MCP_USER_DATA_DIR=profile,
                CAMOUFOX_MCP_CONFIG=theirs,
                STEALTH_PASSWORD_MANAGER_STATE='overlay',
            )
            status, logs = self.passwords(env)
            assert status['applied'] is True, status
            prefs = self.config(env)['browser']['camoufoxOptions']['firefox_user_prefs']
            assert prefs['signon.rememberSignons'] is True
            assert prefs['signon.autofillForms.http'] is False, 'plain-HTTP autofill stays off'
            assert json.loads(pathlib.Path(theirs).read_text(encoding='utf-8')) == original
            assert any('already sets' in line for line in logs), logs

    def test_ini_config_is_left_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'user.ini')
            pathlib.Path(theirs).write_text('browser = camoufox\n', encoding='utf-8')
            env = self.env(
                root,
                PLAYWRIGHT_MCP_USER_DATA_DIR=profile,
                CAMOUFOX_MCP_CONFIG=theirs,
                STEALTH_PASSWORD_MANAGER_STATE='overlay',
            )
            status, logs = self.passwords(env)
            assert status['applied'] is False and status['reason'] == 'config', status
            assert env['CAMOUFOX_MCP_CONFIG'] == theirs
            assert not os.path.exists(os.path.join(profile, '.camoufox-identity.json'))
            assert any('leaving it untouched' in line for line in logs), logs

    def test_non_object_prefs_are_refused(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            theirs = os.path.join(root, 'bad-prefs.json')
            pathlib.Path(theirs).write_text(
                json.dumps({'browser': {'camoufoxOptions': {'firefox_user_prefs': []}}}), encoding='utf-8'
            )
            env = self.env(
                root,
                PLAYWRIGHT_MCP_USER_DATA_DIR=profile,
                CAMOUFOX_MCP_CONFIG=theirs,
                STEALTH_PASSWORD_MANAGER_STATE='overlay',
            )
            status, logs = self.passwords(env)
            assert status['applied'] is False and status['reason'] == 'config', status
            assert env['CAMOUFOX_MCP_CONFIG'] == theirs
            assert any('firefox_user_prefs' in line for line in logs), logs

    def test_write_failure_is_soft(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(
                root,
                PLAYWRIGHT_MCP_USER_DATA_DIR=profile,
                STEALTH_PASSWORD_MANAGER_STATE='overlay',
            )
            original = self.entry._write_config_file

            def deny(*_args, **_kwargs):
                raise OSError(13, 'permission denied')

            self.entry._write_config_file = deny
            try:
                status, logs = self.passwords(env)
            finally:
                self.entry._write_config_file = original
            assert status['applied'] is False and status['reason'] == 'config', status
            assert 'CAMOUFOX_MCP_CONFIG' not in env
            assert any('cannot write the launch config' in line for line in logs), logs

    def test_off_after_on_leaves_the_generated_document_alone(self):
        with tempfile.TemporaryDirectory() as root:
            profile = self.profile(root)
            env = self.env(
                root,
                PLAYWRIGHT_MCP_USER_DATA_DIR=profile,
                STEALTH_PASSWORD_MANAGER_STATE='overlay',
            )
            assert self.passwords(env)[0]['applied'] is True
            path = env['CAMOUFOX_MCP_CONFIG']
            before = pathlib.Path(path).read_bytes()
            env2 = self.env(root, PLAYWRIGHT_MCP_USER_DATA_DIR=profile)
            status, _logs = self.passwords(env2)
            assert status == {'applied': False, 'reason': 'off'}, status
            assert 'CAMOUFOX_MCP_CONFIG' not in env2
            assert pathlib.Path(path).read_bytes() == before


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
