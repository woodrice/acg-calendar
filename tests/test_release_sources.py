"""A release must contain the new source modules, not just a changed index.html."""
import unittest
from scripts.release_sources import validate_frontend


class ReleaseSourcesTests(unittest.TestCase):
    def fixture(self):
        return {"web/index.html": '<script src="/app.js"></script><script src="/journey.js"></script><link rel="stylesheet" href="/styles.css">',
                "web/app.js": "const scripts=['/shell-source.js','/shell/shell.js'];", "web/journey.js": "", "web/styles.css": "",
                "web/shell-source.js": "", "web/shell/shell.js": ""}

    def test_missing_static_or_dynamic_assets_block_release(self):
        for missing in ("web/journey.js", "web/shell-source.js"):
            fixture = self.fixture()
            del fixture[missing]
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, missing):
                validate_frontend(fixture, fixture.__getitem__)

    def test_complete_sources_pass_and_external_code_is_rejected(self):
        fixture = self.fixture()
        self.assertEqual(validate_frontend(fixture, fixture.__getitem__), set(fixture))
        fixture["web/index.html"] += '<script src="https://example.com/code.js"></script>'
        with self.assertRaisesRegex(ValueError, "own scripts"):
            validate_frontend(fixture, fixture.__getitem__)
