"""Entry point for camoufox-playwright-mcp that is safe on Windows.

The wrapper's stdio server starts an anyio signal watchdog unconditionally
(``camoufox_playwright_mcp.mcp.server._run_with_watchdog``). anyio's
``open_signal_receiver`` is not implemented on Windows: asyncio's
``add_signal_handler`` raises ``NotImplementedError`` and the server exits before
answering ``initialize``. The pinned wrapper 0.1.5 has no switch for it.

The broker owns shutdown on every platform: stdin EOF, then ``taskkill /T`` on
Windows. The watchdog therefore adds nothing there, and this entry point replaces
only that one receiver with an empty one, then runs the unmodified wrapper. On
POSIX the shim is not installed and the wrapper runs exactly as shipped.

A second Windows-only adjustment runs in the same branch: a guarded warm-up
import of ``camoufox.async_api``. The wrapper loads that module lazily inside
its first browser tool handler, and on Windows the numpy/orjson extension load
blocks while the MCP stdio reader has a ``readline()`` outstanding, freezing the
whole event loop until the client sends another line. Importing it here, before
the wrapper starts serving stdio, removes that concurrency.

A third step gives a persistent Camoufox profile one stable device identity
(plugin 2.14.0). Camoufox draws a new fingerprint on every launch unless the
caller pins one, and its own code names the changing-fonts-under-identical-
cookies pattern as a spoof tell (daijro/camoufox#442, #765, #378). With
``identity_mode=profile`` (the default) the first launch of a profile draws a
fingerprint for the host OS, stores it under ``<profile>/.camoufox-identity.json``
and passes it to the wrapper through a per-profile ``CAMOUFOX_MCP_CONFIG`` file
under the plugin data directory. ``identity_mode=random`` leaves the wrapper's
environment exactly as before. An isolated start has no profile, so it always
draws a new identity. Nothing here may ever stop the server from starting.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time

IDENTITY_MODE_ENV = 'STEALTH_IDENTITY_MODE'
IDENTITY_MODES = ('profile', 'random')
IDENTITY_MODE_DEFAULT = 'profile'
IDENTITY_FILE_NAME = '.camoufox-identity.json'
IDENTITY_VERSION = 1
IDENTITY_ENGINE = 'camoufox'
USER_DATA_ENV = 'PLAYWRIGHT_MCP_USER_DATA_DIR'
ISOLATED_ENV = 'PLAYWRIGHT_MCP_ISOLATED'
BUILD_ENV = 'CAMOUFOX_BROWSER_BUILD'
PLUGIN_DATA_ENV = 'CLAUDE_PLUGIN_DATA'
CONFIG_ENV_NAMES = ('CAMOUFOX_MCP_CONFIG', 'PLAYWRIGHT_MCP_CONFIG')
PLUGIN_DATA_FALLBACK = '.camoufox-mcp-plugin'
CONFIG_DIR_PARTS = ('config', 'camoufox')
LOG_PREFIX = 'camoufox identity:'


def _log(message: str) -> None:
    print(f'{LOG_PREFIX} {message}', file=sys.stderr, flush=True)


def identity_mode(env=None):
    """The resolved identity mode and one warning when the value was unusable."""
    source = os.environ if env is None else env
    raw = source.get(IDENTITY_MODE_ENV)
    value = raw.strip() if isinstance(raw, str) else ''
    if value == '' or value.startswith('${'):
        # Unset is the default; an unsubstituted placeholder means the client
        # did not fill the setting, which is the default too.
        return IDENTITY_MODE_DEFAULT, None
    folded = value.lower()
    if folded in IDENTITY_MODES:
        return folded, None
    return IDENTITY_MODE_DEFAULT, f'ignoring unknown identity_mode "{value}"; using "{IDENTITY_MODE_DEFAULT}"'


def host_os(platform=None):
    """The Camoufox name for this host OS, or None when it is not one it knows."""
    name = sys.platform if platform is None else platform
    if name == 'win32' or name.startswith('win'):
        return 'windows'
    if name == 'darwin':
        return 'macos'
    if name.startswith('linux'):
        return 'linux'
    return None


def is_isolated(env=None) -> bool:
    source = os.environ if env is None else env
    value = source.get(ISOLATED_ENV)
    return isinstance(value, str) and value.strip().lower() in ('true', '1')


def identity_path(profile_dir: str) -> str:
    return os.path.join(profile_dir, IDENTITY_FILE_NAME)


def _timestamp() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _valid_fingerprint(value) -> bool:
    """The minimum shape a stored fpgen fingerprint must have to be usable.

    A complete fpgen record carries far more, but these are the fields Camoufox's
    coherence pass and the identity seed need; a file without them is corrupt.
    """
    if not isinstance(value, dict):
        return False
    navigator = value.get('navigator')
    screen = value.get('screen')
    if not isinstance(navigator, dict) or not isinstance(screen, dict):
        return False
    user_agent = navigator.get('userAgent')
    if not isinstance(user_agent, str) or user_agent.strip() == '':
        return False
    width = screen.get('width')
    height = screen.get('height')
    return (
        isinstance(width, (int, float)) and not isinstance(width, bool) and width > 0
        and isinstance(height, (int, float)) and not isinstance(height, bool) and height > 0
    )


def valid_identity(value) -> bool:
    return isinstance(value, dict) and _valid_fingerprint(value.get('fingerprint'))


def read_identity(path: str):
    """('missing'|'present'|'corrupt', data or None). Never raises."""
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            text = handle.read()
    except FileNotFoundError:
        return 'missing', None
    except (OSError, UnicodeError):
        return 'corrupt', None
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return 'corrupt', None
    if not valid_identity(data):
        return 'corrupt', None
    return 'present', data


def _default_generate(os_name):
    from camoufox.fingerprints import generate_fingerprint

    if os_name is None:
        return generate_fingerprint()
    return generate_fingerprint(os=os_name)


def _write_new_identity(path: str, data) -> bool:
    """Create the file exclusively; False when another process won the race."""
    payload = f'{json.dumps(data, indent=2, ensure_ascii=False)}\n'.encode('utf-8')
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError:
        # A torn file would read as corrupt on the next launch; remove our own
        # half-written file rather than leave it.
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    return True


def ensure_identity(path, os_name, build, generate=None, log=_log):
    """Read or create the stored identity.

    Returns (fingerprint, stored_os, createdAt) or None when the identity cannot
    be read or created; the caller then starts without a pinned identity.
    """
    draw = _default_generate if generate is None else generate
    state, data = read_identity(path)
    if state == 'present':
        created = data.get('createdAt')
        stored_os = data.get('os')
        return (
            data['fingerprint'],
            stored_os if isinstance(stored_os, str) and stored_os.strip() != '' else os_name,
            created if isinstance(created, str) and created.strip() != '' else None,
        )
    regenerated_from = None
    if state == 'corrupt':
        try:
            os.remove(path)
        except OSError as exc:
            # Unreadable and not removable: never fail the start over an
            # identity, and never pass a file the wrapper cannot use.
            log(f'cannot remove the unreadable identity file {path}: {exc}; this start draws a new identity')
            return None
        regenerated_from = _timestamp()
        log(f'the identity file {path} was corrupt; removed it and drawing a new identity')
    try:
        fingerprint = draw(os_name)
    except Exception as exc:  # noqa: BLE001 - identity generation must never stop the server
        log(f'cannot generate a device identity for {path}: {exc}; this start keeps a random one')
        return None
    if not _valid_fingerprint(fingerprint):
        log(f'the generated identity for {path} is incomplete; this start keeps a random one')
        return None
    created = _timestamp()
    record = {
        'version': IDENTITY_VERSION,
        'engine': IDENTITY_ENGINE,
        'createdAt': created,
        'build': build if isinstance(build, str) and build.strip() != '' else None,
        'os': os_name,
        'fingerprint': fingerprint,
    }
    if regenerated_from is not None:
        record['regeneratedAt'] = regenerated_from
    try:
        created_here = _write_new_identity(path, record)
    except OSError as exc:
        log(f'cannot store the device identity in {path}: {exc}; this start keeps a random one')
        return None
    if not created_here:
        # Another process created the file between our read and our write.
        # Use its identity, never ours, so the profile keeps one device.
        state, data = read_identity(path)
        if state != 'present':
            log(f'the identity file {path} appeared but is unreadable; this start keeps a random one')
            return None
        created = data.get('createdAt')
        stored_os = data.get('os')
        return (
            data['fingerprint'],
            stored_os if isinstance(stored_os, str) and stored_os.strip() != '' else os_name,
            created if isinstance(created, str) and created.strip() != '' else None,
        )
    log(f'stored a new device identity in {path} (generated for {os_name or "any OS"})')
    return fingerprint, os_name, created


def plugin_data_dir(env=None) -> str:
    source = os.environ if env is None else env
    value = source.get(PLUGIN_DATA_ENV)
    if isinstance(value, str) and value.strip() != '':
        return value.strip()
    return os.path.join(os.path.expanduser('~'), PLUGIN_DATA_FALLBACK)


def launch_config_path(profile_dir: str, env=None) -> str:
    """A per-profile config file, so two profiles never share one document."""
    key = os.path.normcase(os.path.abspath(profile_dir)).encode('utf-8')
    digest = hashlib.sha256(key).hexdigest()[:16]
    return os.path.join(plugin_data_dir(env), *CONFIG_DIR_PARTS, f'identity-{digest}.json')


def user_config_path(env=None):
    source = os.environ if env is None else env
    for name in CONFIG_ENV_NAMES:
        value = source.get(name)
        if isinstance(value, str) and value.strip() != '':
            return os.path.abspath(value.strip())
    return None


def usable_json_config(path):
    """(config, None) for a usable JSON object, else (None, reason)."""
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            text = handle.read()
    except FileNotFoundError:
        return None, 'does not exist'
    except (OSError, UnicodeError) as exc:
        return None, f'cannot be read ({exc})'
    try:
        config = json.loads(text.lstrip('﻿'))
    except (json.JSONDecodeError, ValueError):
        return None, 'is not JSON (an INI config or malformed)'
    if not isinstance(config, dict):
        return None, 'is not a JSON object'
    browser = config.get('browser')
    if browser is not None and not isinstance(browser, dict):
        return None, 'has a "browser" value that is not an object'
    options = browser.get('camoufoxOptions') if isinstance(browser, dict) else None
    if options is not None and not isinstance(options, dict):
        return None, 'has a "browser.camoufoxOptions" value that is not an object'
    return config, None


def _write_config_file(path: str, config) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f'{path}.tmp-{os.getpid()}'
    try:
        with open(temporary, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(json.dumps(config, indent=2, ensure_ascii=False))
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.remove(temporary)
        except OSError:
            pass


def launch_config(profile_dir, fingerprint, os_name, user_config, user_path, env=None, log=_log):
    """Write the config file the wrapper will read; set CAMOUFOX_MCP_CONFIG.

    Returns the path, or None when the file cannot be written. A user's JSON
    config (already parsed by the caller) is copied into the plugin data
    directory with our identity merged in; every other key of theirs is kept.
    Our identity keys win in the copy: the setting is what pins a generated
    identity, and the user's own file is never edited.
    """
    source = os.environ if env is None else env
    if user_config is not None:
        config = user_config
        browser = config.setdefault('browser', {})
        options = browser.setdefault('camoufoxOptions', {})
        if any(name in options for name in ('fingerprint', 'fingerprint_preset', 'os')):
            log(
                f'the config file {user_path} already sets a fingerprint; this session uses the profile identity instead '
                '(your file is unchanged)',
            )
        options['fingerprint'] = fingerprint
        if os_name is not None:
            options['os'] = os_name
        else:
            options.pop('os', None)
    else:
        config = {'browser': {'camoufoxOptions': {'fingerprint': fingerprint}}}
        if os_name is not None:
            config['browser']['camoufoxOptions']['os'] = os_name
    target = launch_config_path(profile_dir, source)
    try:
        _write_config_file(target, config)
    except OSError as exc:
        log(f'cannot write the launch config {target}: {exc}; this start keeps a random identity')
        return None
    return target


def apply_identity(env=None, generate=None, log=_log):
    """Pin the stored device identity for this launch when the mode asks for it.

    Sets CAMOUFOX_MCP_CONFIG in ``env`` (``os.environ`` by default) so the
    wrapper, imported after this call, reads the generated config. Returns a
    small status dict; it never raises for a normal failure path, and it never
    starts a browser or touches the user's own config file.
    """
    source = os.environ if env is None else env
    mode, warning = identity_mode(source)
    if warning is not None:
        log(warning)
    if mode == 'random':
        return {'mode': mode, 'applied': False, 'reason': 'mode'}
    if is_isolated(source):
        return {'mode': mode, 'applied': False, 'reason': 'isolated'}
    raw_profile = source.get(USER_DATA_ENV)
    profile_dir = raw_profile.strip() if isinstance(raw_profile, str) else ''
    if profile_dir == '':
        log('no browser profile directory is set, so this start keeps a random device identity')
        return {'mode': mode, 'applied': False, 'reason': 'no-profile'}
    profile_dir = os.path.abspath(profile_dir)
    # The user's own config decides whether an identity can be applied at all:
    # an INI or unreadable file is left untouched and today's behaviour kept, so
    # no identity file is generated for a pin that would never reach the browser.
    theirs = user_config_path(source)
    user_config = None
    if theirs is not None:
        user_config, reason = usable_json_config(theirs)
        if user_config is None:
            log(f'the config file {theirs} {reason}; leaving it untouched and starting without a pinned identity')
            return {'mode': mode, 'applied': False, 'reason': 'config'}
    path = identity_path(profile_dir)
    build = source.get(BUILD_ENV)
    result = ensure_identity(path, host_os(), build, generate=generate, log=log)
    if result is None:
        return {'mode': mode, 'applied': False, 'reason': 'identity'}
    fingerprint, stored_os, _created = result
    config = launch_config(profile_dir, fingerprint, stored_os, user_config, theirs, env=source, log=log)
    if config is None:
        return {'mode': mode, 'applied': False, 'reason': 'config'}
    source['CAMOUFOX_MCP_CONFIG'] = config
    return {'mode': mode, 'applied': True, 'identityFile': path, 'configFile': config}


def _apply_identity_safely() -> None:
    try:
        apply_identity()
    except Exception as exc:  # noqa: BLE001 - an identity must never stop the server from starting
        _log(f'identity setup failed: {exc}; this start keeps a random device identity')


def _install_windows_signal_receiver() -> None:
    import anyio

    class _NoSignals:
        """An async iterator that yields no signals."""

        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    class _EmptyReceiver:
        """The sync context manager anyio.open_signal_receiver returns."""

        def __enter__(self):
            return _NoSignals()

        def __exit__(self, *_exc_info):
            return False

    anyio.open_signal_receiver = lambda *_args, **_kwargs: _EmptyReceiver()


def main() -> None:
    if sys.platform == 'win32':
        _install_windows_signal_receiver()
        # The wrapper imports camoufox.async_api lazily inside its first browser
        # tool handler. On Windows that extension load (numpy, orjson) blocks
        # while the MCP stdio reader has a readline() outstanding, freezing the
        # event loop until the client sends another line. Warm it here, before
        # stdio starts reading, so the first browser tool call stays responsive.
        try:
            import camoufox.async_api  # noqa: F401 - imported for its side effects
        except Exception as exc:  # noqa: BLE001 - a warm-up must never stop the server from starting
            print(f'camoufox warm-up import failed: {exc}', file=sys.stderr, flush=True)
    _apply_identity_safely()
    from camoufox_playwright_mcp.cli import main as wrapper_main

    wrapper_main()


if __name__ == '__main__':
    main()
