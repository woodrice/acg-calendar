"""Starts the Playtime backend inside the Android app.

The repository code is unpacked by the Java side to a private runtime directory; personal data
lives in another private directory. The server listens on a loopback port and serves only
requests carrying the per-launch session cookie (see app.handler_for). The port is kept from
launch to launch when it is free: the page's origin, and with it what the page keeps in its own
storage (e.g. the chosen light/dark mode), stays the same.
"""
import os
import shutil
import sys
import threading
from pathlib import Path

_server = None
_lock = threading.Lock()


def start(runtime, data, session, preferred_port=0):
    """Start once per process and return the port; later calls reuse the running server.

    preferred_port is the port of the last launch; when it is taken, any free port is used."""
    global _server
    with _lock:
        if _server is not None:
            return _server.server_address[1]
        runtime, data = Path(runtime), Path(data)
        for path in (runtime / "site-packages", runtime):
            if str(path) not in sys.path:
                sys.path.insert(0, str(path))
        os.environ["ACG_DISABLE_DESKTOP"] = "1"
        # Bundled game plugins are installed on first launch, like the Windows package does.
        # An installed copy is left alone, so the user's enable/disable choices survive.
        plugins = data / "plugins"
        plugins.mkdir(parents=True, exist_ok=True)
        for plugin in sorted((runtime / "plugins").iterdir()):
            if plugin.is_dir() and not (plugins / plugin.name).exists():
                shutil.copytree(plugin, plugins / plugin.name)
        import app
        application = app.Application(data, auto_sync=False, desktop=False)
        handler = app.handler_for(application, session=session)
        server = None
        if preferred_port and 1024 <= int(preferred_port) <= 65535:
            try:
                server = app.ThreadingHTTPServer(("127.0.0.1", int(preferred_port)), handler)
            except OSError:
                server = None  # Taken by another app; a new port only resets page-kept settings.
        if server is None:
            server = app.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.daemon_threads = True
        application.start()
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.3}, name="playtime-http", daemon=True).start()
        _server = server
        print(f"Playtime {app.__version__} on 127.0.0.1:{server.server_address[1]}, data {data}", flush=True)
        return server.server_address[1]
