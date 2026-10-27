"""Ensure and locate the pinned Camoufox browser build.

Run by ``launch-camoufox.mjs`` with the vendored venv interpreter:

    <venv>/.../python -I camoufox_bootstrap.py ensure-build v156.0.1-beta.39
    <venv>/.../python -I camoufox_bootstrap.py binary-path v156.0.1-beta.39
    <venv>/.../python -I camoufox_bootstrap.py overlay-probe <executable>
    <venv>/.../python -I camoufox_bootstrap.py password-path
    <venv>/.../python -I camoufox_bootstrap.py password-probe <executable>

``ensure-build`` installs the exact build when it is absent, using Camoufox's own
version index and fetcher; it never installs a different build and never installs
Python. ``binary-path`` prints the launch executable for that build on stdout and
nothing else; every log line goes to stderr so the MCP stdout stays pure JSON-RPC.

``overlay-probe`` starts one short headless Camoufox from the given executable
(the plugin-owned overlay build) and asks a loopback page for the geolocation
permission state. The caller writes a temporary ``Permissions: Location:
BlockNewRequests`` policy document into the overlay's own
``distribution/policies.json``, so ``denied`` proves that Firefox read the
overlay's install policy; anything else means it did not. No
``toolkit.policies.perUserDir`` is set: with that pref and no readable per-user
file Firefox would apply no policies at all. It prints one JSON line and never
writes a credential or reads a profile.

``password-path`` and ``password-probe`` are the retained 2.15.0 per-user route
(``SHGetKnownFolderPath`` plus a probe that sets ``toolkit.policies.perUserDir``).
No shipped platform reaches them in 2.17.0; they stay so a future build or
platform with a readable per-user directory can use them unchanged.

The helper deliberately does not activate a build. Camoufox's installer activates
the build it installs, but the launched build is pinned by the caller through
``CAMOUFOX_EXECUTABLE_PATH`` regardless of which build is active. Camoufox reads
the spoofed version from the ``version.json`` beside the executable, not from the
active build.
"""

from __future__ import annotations

import json
import sys

USAGE_EXIT_STATUS = 2
LOG_PREFIX = '[camoufox-bootstrap]'


def log(message: str) -> None:
    print(f'{LOG_PREFIX} {message}', file=sys.stderr)


def normalize_version(raw: str) -> str:
    """Strip a leading ``v`` from a release tag (v156.0.1-beta.39 -> 156.0.1-beta.39)."""
    text = raw.strip()
    if text[:1] in ('v', 'V'):
        text = text[1:]
    if text == '':
        raise ValueError('the build version is empty')
    return text


def installed_build(version: str):
    """The installed build for ``version``, or ``None``. Reads the cache only."""
    from camoufox.multiversion import list_installed

    for installed in list_installed():
        if installed.version.full_string == version:
            return installed
    return None


def ensure_build(version: str) -> int:
    """Install exactly ``version`` when absent, through Camoufox's own fetcher."""
    if installed_build(version) is not None:
        log(f'build {version} is already installed')
        return 0

    from camoufox.pkgman import CamoufoxFetcher, list_available_versions

    for candidate in list_available_versions(include_prerelease=True):
        if candidate.version.full_string == version:
            log(f'installing build {version} from the Camoufox release index')
            CamoufoxFetcher(selected_version=candidate).install()
            return 0

    raise LookupError(
        f'Camoufox build {version} is not offered for this platform by the installed '
        'Camoufox release index. Check the network connection, or update the pinned '
        'build in the plugin configuration.'
    )


def binary_path(version: str) -> str:
    """The launch executable for an installed ``version``."""
    installed = installed_build(version)
    if installed is None:
        raise LookupError(f'Camoufox build {version} is not installed.')

    from camoufox.pkgman import launch_path

    return launch_path(browser_path=installed.path)


def local_app_data() -> str:
    """The Windows KnownFolder LocalAppData, independent of %LOCALAPPDATA%.

    ``SHGetKnownFolderPath(FOLDERID_LocalAppData)`` is what Windows itself uses;
    the 2026-10-26 investigation confirmed that setting ``$env:LOCALAPPDATA`` does
    not change the answer. Non-Windows platforms return nothing: the per-user
    Firefox policy path was only ever verified on Windows. Retained for the
    2.15.0 per-user route, which no shipped platform reaches in 2.17.0.
    """
    if sys.platform != 'win32':
        raise LookupError('the per-user Firefox policy path is resolved on Windows only')

    import ctypes
    from ctypes import wintypes

    class GUID(ctypes.Structure):
        _fields_ = [
            ('Data1', wintypes.DWORD),
            ('Data2', wintypes.WORD),
            ('Data3', wintypes.WORD),
            ('Data4', ctypes.c_ubyte * 8),
        ]

    # {F1B32785-6FBA-4FCF-9D55-7B8E7F157091}
    folder_id = GUID(
        0xF1B32785,
        0x6FBA,
        0x4FCF,
        (ctypes.c_ubyte * 8)(0x9D, 0x55, 0x7B, 0x8E, 0x7F, 0x15, 0x70, 0x91),
    )
    shell32 = ctypes.windll.shell32
    ole32 = ctypes.windll.ole32
    shell32.SHGetKnownFolderPath.argtypes = [
        ctypes.POINTER(GUID),
        wintypes.DWORD,
        wintypes.HANDLE,
        ctypes.POINTER(ctypes.c_wchar_p),
    ]
    shell32.SHGetKnownFolderPath.restype = ctypes.c_long
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    ole32.CoTaskMemFree.restype = None
    path_pointer = ctypes.c_wchar_p()
    result = shell32.SHGetKnownFolderPath(ctypes.byref(folder_id), 0, None, ctypes.byref(path_pointer))
    try:
        if result != 0:
            raise OSError(result, 'SHGetKnownFolderPath failed')
        value = path_pointer.value
        if not isinstance(value, str) or value.strip() == '':
            raise OSError('SHGetKnownFolderPath returned an empty path')
        return value
    finally:
        if path_pointer:
            ole32.CoTaskMemFree(path_pointer)


def password_path() -> dict:
    """The KnownFolder value and the per-user policy directory Firefox reads."""
    local = local_app_data()
    import os

    return {
        'platform': sys.platform,
        'knownFolder': 'LocalAppData',
        'localAppData': local,
        'perUserDir': os.path.join(local, 'Camoufox', 'Camoufox'),
    }


def _permission_state(binary: str, firefox_user_prefs=None) -> dict:
    """One short headless start; return the loopback page's geolocation state.

    The caller writes a temporary policy document that adds
    ``Permissions: {Location: {BlockNewRequests: true}}`` to the document under
    test. Firefox maps it to ``permissions.default.geo=2``, so a loopback page's
    ``navigator.permissions.query({name: 'geolocation'})`` reports ``denied`` only
    when that document was read. ``prompt`` (or anything else) means it was not.
    """
    import os
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    if not isinstance(binary, str) or binary.strip() == '' or not os.path.exists(binary):
        return {'state': 'error', 'detail': f'the Camoufox executable {binary!r} does not exist'}

    from camoufox.addons import DefaultAddons
    from camoufox.sync_api import Camoufox

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - the http.server API
            body = b'<!doctype html><meta charset="utf-8"><title>probe</title><p>probe</p>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        launch_kwargs = {
            'headless': True,
            'executable_path': binary,
            'geoip': False,
            'humanize': False,
            'exclude_addons': list(DefaultAddons),
        }
        if isinstance(firefox_user_prefs, dict) and firefox_user_prefs:
            launch_kwargs['firefox_user_prefs'] = firefox_user_prefs
        with Camoufox(**launch_kwargs) as browser:
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{port}/', wait_until='domcontentloaded', timeout=20000)
            state = page.evaluate(
                "() => navigator.permissions.query({name: 'geolocation'}).then((result) => result.state)"
            )
    finally:
        server.shutdown()
        server.server_close()

    if state in ('denied', 'prompt', 'granted'):
        return {'state': state}
    return {'state': 'error', 'detail': f'unexpected permission state {state!r}'}


def overlay_probe(binary: str) -> dict:
    """Is the overlay's own install policy read? (no per-user flag is set)

    With ``toolkit.policies.perUserDir`` and no readable per-user file Firefox
    would apply no policies at all, so the overlay probe must not set it: the
    overlay's ``distribution/policies.json`` is the only policy document in play.
    """
    return _permission_state(binary)


def password_probe(binary: str) -> dict:
    """Is the retained 2.15.0 per-user policy file read? (per-user flag set)

    Kept for the retained per-user route, which no shipped platform reaches in
    2.17.0. The caller writes the temporary geolocation document into the
    per-user file this probe makes Firefox read.
    """
    return _permission_state(binary, firefox_user_prefs={'toolkit.policies.perUserDir': True})


def main(argv: list[str]) -> int:
    # Camoufox prints download progress to stdout. Keep fd 1 for the path only by
    # pointing Python's stdout at stderr before anything imports camoufox.
    protocol_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        if len(argv) == 3 and argv[1] in ('ensure-build', 'binary-path'):
            version = normalize_version(argv[2])
            if argv[1] == 'ensure-build':
                return ensure_build(version)
            path = binary_path(version)
            protocol_stdout.write(f'{path}\n')
            protocol_stdout.flush()
            return 0
        if len(argv) == 2 and argv[1] == 'password-path':
            protocol_stdout.write(f'{json.dumps(password_path())}\n')
            protocol_stdout.flush()
            return 0
        if len(argv) == 3 and argv[1] in ('overlay-probe', 'password-probe'):
            function = overlay_probe if argv[1] == 'overlay-probe' else password_probe
            protocol_stdout.write(f'{json.dumps(function(argv[2]))}\n')
            protocol_stdout.flush()
            return 0
        print(
            'usage: camoufox_bootstrap.py ensure-build <version> | binary-path <version> | '
            'password-path | overlay-probe <executable> | password-probe <executable>',
            file=sys.stderr,
        )
        return USAGE_EXIT_STATUS
    except Exception as exc:  # noqa: BLE001 - one actionable line, never a traceback
        detail = f'{type(exc).__name__}: {exc}'
        if 'overlay-probe' in argv or 'password-probe' in argv or 'password-path' in argv:
            protocol_stdout.write(f'{json.dumps({"state": "error", "detail": detail})}\n')
            protocol_stdout.flush()
        print(detail, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
