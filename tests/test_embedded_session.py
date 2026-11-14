from http.server import ThreadingHTTPServer
import json
import threading
import urllib.error
import urllib.request

from app import Application, handler_for
from test_calendar import TempStoreTest


class EmbeddedSessionTests(TempStoreTest):
    """The Android host starts the server with a per-launch session; without it nothing is served."""

    def serve(self, session):
        app = Application(self.directory, auto_sync=False, desktop=False)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(app, session=session))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return app, "http://127.0.0.1:" + str(server.server_port)

    def call(self, url, cookie=None, method="GET", body=None, token=None):
        headers = {"Cookie": cookie} if cookie else {}
        if token:
            headers.update({"X-Calendar-Token": token, "Content-Type": "application/json"})
        request = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def test_reads_and_writes_need_the_session_cookie(self):
        app, base = self.serve("s3cret-session")
        for cookie in (None, "playtime_session=wrong", "other=s3cret-session", "playtime_session=s3cret-session-extra", 'bad"cookie'):
            self.assertEqual(self.call(base + "/api/state", cookie)[0], 403, cookie)
            self.assertEqual(self.call(base + "/", cookie)[0], 403, cookie)
            self.assertEqual(self.call(base + "/api/settings", cookie, "POST", {"hide_completed": True}, app.csrf)[0], 403, cookie)
        self.assertFalse(app.store.settings()["hide_completed"])
        status, body = self.call(base + "/api/state", "theme=x; playtime_session=s3cret-session")
        self.assertEqual(status, 200)
        self.assertIn("events", json.loads(body))
        self.assertEqual(self.call(base + "/api/settings", "playtime_session=s3cret-session", "POST", {"hide_completed": True}, app.csrf)[0], 200)
        self.assertTrue(app.store.settings()["hide_completed"])
        # The session does not replace the write token.
        self.assertEqual(self.call(base + "/api/settings", "playtime_session=s3cret-session", "POST", {"hide_completed": False}, "wrong")[0], 403)

    def test_without_a_session_the_server_behaves_as_before(self):
        _, base = self.serve(None)
        self.assertEqual(self.call(base + "/api/state")[0], 200)
