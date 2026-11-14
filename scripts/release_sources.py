"""Fail packaging when the source allowlist omits a required web bootstrap asset."""
from html.parser import HTMLParser
from pathlib import Path
import posixpath
import re
import subprocess
from urllib.parse import urlsplit


def validate_frontend(files, read_text):
    files = set(files)
    required = {"web/index.html", "web/app.js"}
    if not required <= files:
        raise ValueError("Missing frontend entry points in release sources")

    class Assets(HTMLParser):
        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            link = attrs.get("src") if tag == "script" else attrs.get("href") if tag == "link" and attrs.get("rel") == "stylesheet" else None
            if link:
                parsed = urlsplit(link)
                if parsed.scheme or parsed.netloc:
                    raise ValueError("Release frontend must load its own scripts and styles")
                required.add(posixpath.normpath("web/" + parsed.path.lstrip("/")))

    Assets().feed(read_text("web/index.html"))
    required.update("web/" + name.lstrip("/") for name in re.findall(r"['\"](/[\w./-]+\.(?:js|css))['\"]", read_text("web/app.js")))
    missing = sorted(required - files)
    if missing:
        raise ValueError("Release source manifest is incomplete; include these files in the source commit: " + ", ".join(missing))
    return required


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    files = filter(None, subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0"))
    assets = validate_frontend(files, lambda name: (root / name).read_text(encoding="utf-8"))
    print("Release source manifest includes", len(assets), "required frontend files")
