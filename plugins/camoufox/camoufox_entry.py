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
"""

from __future__ import annotations

import sys


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
    from camoufox_playwright_mcp.cli import main as wrapper_main

    wrapper_main()


if __name__ == '__main__':
    main()
