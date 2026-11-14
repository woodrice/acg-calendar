"""Adversarial requests against an isolated loopback instance; no source-site access."""
from http.server import ThreadingHTTPServer
import json
import contextlib
import io
import socket
import threading

from app import Application, handler_for
from test_calendar import TempStoreTest


class HttpBoundaryTests(TempStoreTest):
    def serve(self, session=None, quiet=True):
        application = Application(self.directory, auto_sync=False, desktop=False)
        handler = handler_for(application, session=session)
        if quiet:
            handler.log_message = lambda *args: None
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.errors = []
        server.handle_error = lambda *args: self.errors.append("uncaught handler error")
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return application, server

    def raw(self, server, head, body=b""):
        with socket.create_connection(server.server_address, timeout=3) as conn:
            conn.sendall(head + b"\r\n\r\n" + body)
            conn.shutdown(socket.SHUT_WR)
            response = b""
            while chunk := conn.recv(65536):
                response += chunk
        self.assertTrue(response.startswith(b"HTTP/"), "request crashed instead of returning an HTTP response")
        self.assertEqual(self.errors, [])
        return int(response.split(b" ", 2)[1]), response

    def write(self, app, server, *, extra=b"", length=b"2", body=b"{}", token=None):
        return self.raw(server, b"POST /api/settings HTTP/1.0\r\nHost: 127.0.0.1:" + str(server.server_port).encode()
                        + b"\r\nX-Calendar-Token: " + (token if token is not None else app.csrf.encode())
                        + b"\r\nContent-Length: " + length + extra, body)[0]

    def test_non_ascii_csrf_and_session_are_rejected_without_traceback(self):
        app, server = self.serve()
        self.assertEqual(self.write(app, server, token=b"\xe9"), 403)
        _, embedded = self.serve("test-session")
        status, _ = self.raw(embedded, b'GET /api/state HTTP/1.0\r\nHost: localhost\r\nCookie: playtime_session="\xe9"')
        self.assertEqual(status, 403)

    def test_ambiguous_framing_and_truncated_body_are_rejected(self):
        app, server = self.serve()
        for extra, length, body in [(b"\r\nContent-Length: 99", b"2", b"{}"),
                                    (b"\r\nTransfer-Encoding: chunked", b"2", b"{}"),
                                    (b"", b"12", b"{}")]:
            with self.subTest(extra=extra, length=length):
                self.assertEqual(self.write(app, server, extra=extra, length=length, body=body), 400)

    def test_deep_json_and_nonstandard_constants_return_400(self):
        app, server = self.serve()
        deep = b"[" * 1200 + b"0" + b"]" * 1200
        self.assertEqual(self.write(app, server, length=str(len(deep)).encode(), body=deep), 400)
        for constant in (b"NaN", b"Infinity", b"-Infinity"):
            head = b"POST /api/notifications/read HTTP/1.0\r\nHost: localhost\r\nX-Calendar-Token: " + app.csrf.encode()
            body = b'{"value":' + constant + b"}"
            self.assertEqual(self.raw(server, head + b"\r\nContent-Length: " + str(len(body)).encode(), body)[0], 400)

    def test_malformed_url_cross_origin_and_private_paths(self):
        app, server = self.serve()
        self.assertEqual(self.raw(server, b"GET http://[ HTTP/1.0\r\nHost: localhost")[0], 400)
        for headers in (b"Host: localhost\r\nHost: 127.0.0.1", b"Host: localhost:1", b"Host: localhost/invalid", b"Host: example.com"):
            self.assertEqual(self.raw(server, b"GET /api/state HTTP/1.0\r\n" + headers)[0], 403)
        for headers in (b"Origin: http://localhost\r\nOrigin: http://localhost", b"Sec-Fetch-Site: cross-site"):
            self.assertEqual(self.raw(server, b"GET /api/state HTTP/1.0\r\nHost: localhost\r\n" + headers)[0], 403)
        for path in (b"/api/state", b"/api/export", b"/api/backups"):
            self.assertEqual(self.raw(server, b"GET " + path + b" HTTP/1.0\r\nHost: localhost\r\nOrigin: https://example.com")[0], 403)
        for path in (b"/app.py", b"/.git/config", b"/data/calendar.sqlite3", b"/../app.py", b"/api/backups/..%2Fcalendar.sqlite3"):
            self.assertIn(self.raw(server, b"GET " + path + b" HTTP/1.0\r\nHost: localhost")[0], (400, 404))
        status, response = self.raw(server, b"GET /api/state HTTP/1.0\r\nHost: localhost")
        self.assertEqual(status, 200)
        self.assertIn(b"Content-Security-Policy:", response)
        self.assertNotIn(b"Access-Control-Allow-Origin:", response)
        self.assertNotIn(b"Set-Cookie:", response)
        self.assertEqual(self.write(app, server, extra=b"\r\nOrigin: https://example.com"), 403)
        self.assertEqual(self.write(app, server), 200)

    def test_socket_has_a_finite_read_timeout(self):
        app, server = self.serve()
        observed = []
        original = server.RequestHandlerClass.do_GET
        def get(handler):
            observed.append(handler.connection.gettimeout())
            original(handler)
        server.RequestHandlerClass.do_GET = get
        self.raw(server, b"GET /api/health HTTP/1.0\r\nHost: localhost")
        self.assertTrue(observed and 0 < observed[0] <= 15)

    def test_logs_omit_url_queries_and_headers(self):
        _, server = self.serve(quiet=False)
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            self.raw(server, b"GET /not-a-page?token=do-not-log HTTP/1.0\r\nHost: localhost\r\nCookie: private=cookie-secret")
            self.raw(server, b"GET /api/health HTTP/1.0\r\nHost: localhost")
        log = captured.getvalue()
        self.assertIn("GET /not-a-page 404", log)
        self.assertNotIn("do-not-log", log)
        self.assertNotIn("cookie-secret", log)
        self.assertNotIn("health", log)
