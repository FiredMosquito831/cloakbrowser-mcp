"""Ensure and locate the pinned Camoufox browser build.

Run by ``launch-camoufox.mjs`` with the vendored venv interpreter:

    <venv>/.../python -I camoufox_bootstrap.py ensure-build v156.0.1-beta.39
    <venv>/.../python -I camoufox_bootstrap.py binary-path v156.0.1-beta.39

``ensure-build`` installs the exact build when it is absent, using Camoufox's own
version index and fetcher; it never installs a different build and never installs
Python. ``binary-path`` prints the launch executable for that build on stdout and
nothing else; every log line goes to stderr so the MCP stdout stays pure JSON-RPC.

The helper deliberately does not activate a build. Camoufox's installer activates
the build it installs, but the launched build is pinned by the caller through
``CAMOUFOX_EXECUTABLE_PATH`` regardless of which build is active. Camoufox reads
the spoofed version from the ``version.json`` beside the executable, not from the
active build.
"""

from __future__ import annotations

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


def main(argv: list[str]) -> int:
    # Camoufox prints download progress to stdout. Keep fd 1 for the path only by
    # pointing Python's stdout at stderr before anything imports camoufox.
    protocol_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        if len(argv) != 3 or argv[1] not in ('ensure-build', 'binary-path'):
            print(
                'usage: camoufox_bootstrap.py ensure-build <version> | binary-path <version>',
                file=sys.stderr,
            )
            return USAGE_EXIT_STATUS
        version = normalize_version(argv[2])
        if argv[1] == 'ensure-build':
            return ensure_build(version)
        path = binary_path(version)
        protocol_stdout.write(f'{path}\n')
        protocol_stdout.flush()
        return 0
    except Exception as exc:  # noqa: BLE001 - one actionable line, never a traceback
        print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
