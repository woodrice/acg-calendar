"""Fault injection into the actual Java installer without an emulator or Android SDK."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
JAVA = Path(os.environ.get("JAVA_HOME", "")) / "bin"
JAVAC = str(JAVA / ("javac.exe" if os.name == "nt" else "javac")) if (JAVA / ("javac.exe" if os.name == "nt" else "javac")).is_file() else shutil.which("javac")
JAVA_CMD = str(JAVA / ("java.exe" if os.name == "nt" else "java")) if (JAVA / ("java.exe" if os.name == "nt" else "java")).is_file() else shutil.which("java")


@unittest.skipUnless(JAVAC and JAVA_CMD, "JDK is needed for the optional Android installer check")
class AndroidBundleTests(unittest.TestCase):
    def test_interruption_and_upgrade_keep_personal_data(self):
        folder = ROOT / "logs" / "android-bundle-tests"
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=folder) as temporary:
            subprocess.run([JAVAC, "-encoding", "UTF-8", "--release", "8", "-d", temporary,
                            str(ROOT / "android/app/src/main/java/io/github/zhenyufu039/playtime/RuntimeBundle.java"),
                            str(ROOT / "tests/java/RuntimeBundleTest.java")], check=True, capture_output=True, timeout=30)
            result = subprocess.run([JAVA_CMD, "-cp", temporary, "io.github.zhenyufu039.playtime.RuntimeBundleTest", temporary],
                                    check=True, capture_output=True, text=True, timeout=15)
            self.assertIn("PASS: interrupted unpack", result.stdout)
