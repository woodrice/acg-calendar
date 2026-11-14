"""Startup must not depend on the encoding of a redirected Windows terminal."""
import os
import http.client
import socket
import subprocess
import sys
import time

from test_calendar import TempStoreTest


class CliEncodingTests(TempStoreTest):
    def test_ascii_output_does_not_abort_server_start(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        bootstrap = "import faulthandler,runpy; faulthandler.dump_traceback_later(15, repeat=True); runpy.run_path('app.py',run_name='__main__')"
        process = subprocess.Popen(
            [sys.executable, "-c", bootstrap, "--port", str(port), "--data-dir", str(self.directory), "--no-sync", "--no-desktop"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={**os.environ, "PYTHONIOENCODING": "ascii:strict"},
        )
        try:
            ready = False
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    break
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=.5)
                try:
                    connection.request("GET", "/api/health")
                    response = connection.getresponse()
                    ready = response.status == 200
                    response.read()
                    if ready:
                        break
                except (OSError, http.client.HTTPException):
                    time.sleep(.1)
                finally:
                    connection.close()
        finally:
            if process.poll() is None:
                process.terminate()
            stdout, stderr = process.communicate(timeout=10)
        self.assertTrue(ready, f"Server failed with ASCII output; exit={process.returncode}; stdout={stdout.decode('ascii', 'backslashreplace')[-1000:]}; stderr={stderr.decode('ascii', 'backslashreplace')[-6000:]}")
        self.assertIn(b"Local: http://127.0.0.1:", stdout)
        self.assertNotIn(b"UnicodeEncodeError", stderr)
