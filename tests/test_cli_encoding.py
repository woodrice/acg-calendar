"""Startup must not depend on the encoding of a redirected Windows terminal."""
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

from test_calendar import TempStoreTest


class CliEncodingTests(TempStoreTest):
    def test_ascii_output_does_not_abort_server_start(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, "app.py", "--port", str(port), "--data-dir", str(self.directory), "--no-sync", "--no-desktop"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={**os.environ, "PYTHONIOENCODING": "ascii:strict"},
        )
        try:
            ready = False
            for _ in range(60):
                if process.poll() is not None:
                    break
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=.3) as response:
                        ready = response.status == 200
                    if ready:
                        break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(.1)
            self.assertTrue(ready, "Server failed to start with ASCII redirected output")
        finally:
            if process.poll() is None:
                process.terminate()
            stdout, stderr = process.communicate(timeout=10)
        self.assertIn(b"Local: http://127.0.0.1:", stdout)
        self.assertNotIn(b"UnicodeEncodeError", stderr)
