"""Build the Windows portable EXE distribution from an explicit source allowlist."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
import zipfile
from release_sources import validate_frontend

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN = {'data', 'logs', 'dist', 'promo', '.git', '.claude', 'node_modules', '.dotnet'}
EXTRA = ('scripts/package-standalone.py', 'scripts/release_sources.py', 'scripts/windows-runtime.json', 'docs/windows-standalone.md')


def workspace_path(path):
    path = Path(path).resolve()
    if path == ROOT or not path.is_relative_to(ROOT):
        raise ValueError('Build paths must stay inside the workspace')
    return path


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch(item, cache, allow_download):
    url = urllib.parse.urlsplit(item['url'])
    if url.scheme != 'https' or url.hostname not in {'www.python.org', 'files.pythonhosted.org'}:
        raise ValueError('Untrusted runtime download origin')
    target = cache / Path(url.path).name
    if target.exists():
        if digest(target) != item['sha256']:
            raise ValueError('Cached dependency hash mismatch: ' + target.name)
        return target
    if not allow_download:
        raise ValueError('Dependency missing; pass --fetch to download: ' + target.name)
    print('Downloading ' + target.name, flush=True)
    request = urllib.request.Request(item['url'], headers={'User-Agent': 'Playtime-standalone-builder'})
    temporary = None
    try:
        with urllib.request.urlopen(request, timeout=40) as response, tempfile.NamedTemporaryFile(dir=cache, delete=False) as stream:
            temporary = Path(stream.name)
            total = 0
            while block := response.read(1024 * 1024):
                total += len(block)
                if total > 64 * 1024 * 1024:
                    raise ValueError('Runtime download exceeds size limit')
                stream.write(block)
        if digest(temporary) != item['sha256']:
            raise ValueError('Official runtime SHA256 verification failed')
        temporary.rename(target)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    return target


def extract(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as archive:
        for item in archive.infolist():
            if not (destination / item.filename).resolve().is_relative_to(destination):
                raise ValueError('Unsafe archive path')
        archive.extractall(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish-dir', required=True)
    parser.add_argument('--nuget-dir', required=True)
    parser.add_argument('--work-dir', required=True)
    parser.add_argument('--fetch', action='store_true', help='Allow pinned official dependency downloads')
    args = parser.parse_args()
    publish, nuget, work = map(workspace_path, (args.publish_dir, args.nuget_dir, args.work_dir))
    config = json.loads((ROOT / 'scripts/windows-runtime.json').read_text(encoding='utf-8'))
    version = (ROOT / 'VERSION').read_text(encoding='utf-8').strip()
    if not version or any(c not in '0123456789.' for c in version):
        raise ValueError('Invalid version')
    stage = workspace_path(ROOT / f'dist/standalone/Playtime-V{version}-windows-x64')
    verify = work / 'verify'
    for directory in (stage, verify):
        if directory.exists() and any(directory.iterdir()):
            raise ValueError('Refusing to overwrite a nonempty build directory: ' + str(directory))
    work.mkdir(parents=True, exist_ok=True)
    cache = work / 'downloads'
    cache.mkdir(exist_ok=True)
    python_archive = fetch(config['python'], cache, args.fetch)
    timezone_archive = fetch(config['tzdata'], cache, args.fetch)
    # Only tracked paths plus these three authored files. Never enumerate real data/ or promo/.
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    validate_frontend(filter(None, paths), lambda name: (ROOT / name).read_text(encoding='utf-8'))
    sources = {}
    for name in sorted(set(filter(None, paths)) | set(EXTRA)):
        source = ROOT / name
        if name.split('/')[0] in FORBIDDEN or not source.resolve().is_relative_to(ROOT):
            raise ValueError('Non-distributable source: ' + name)
        if source.is_symlink():
            raise ValueError('Symlink source is not supported: ' + name)
        destination = stage / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        sources[name] = digest(destination)
    executable = publish / 'Playtime.exe'
    if not executable.is_file() or executable.stat().st_size < 30 * 1024 * 1024:
        raise ValueError('Expected self-contained single-file desktop publish')
    shutil.copy2(executable, stage / 'Playtime.exe')
    python_root = stage / 'runtime/python'
    extract(python_archive, python_root)
    pth = list(python_root.glob('python*._pth'))
    if len(pth) != 1:
        raise ValueError('Unexpected embedded Python path configuration')
    standard_zip = 'python' + ''.join(config['python']['version'].split('.')[:2]) + '.zip'
    # Keep a trailing separator: Windows Python's path normalizer otherwise
    # resolves a terminal ../.. differently from the intended two parents.
    pth[0].write_text(standard_zip + '\n.\n..\\..\\\nLib\\site-packages\n', encoding='ascii')
    extract(timezone_archive, python_root / 'Lib/site-packages')
    subprocess.run([str(python_root / 'python.exe'), '-B', '-c',
        'import sys,sqlite3,ssl,tzdata,acg_calendar; from pathlib import Path; from zoneinfo import ZoneInfo; '
        'assert sys.flags.isolated and sys.flags.ignore_environment and sys.flags.no_site; '
        'assert Path(acg_calendar.__file__).resolve().parents[1] == Path.cwd(); '
        'assert all(Path(p).resolve().is_relative_to(Path.cwd()) for p in sys.path); '
        'ZoneInfo("Asia/Shanghai"); ZoneInfo("America/New_York"); '
        'print("Verified bundled Python, SQLite, SSL, project imports and timezones", flush=True)'],
        cwd=stage, check=True)
    for plugin in ('nikke-global', 'azurlane-cn', 'zzz-cn'):
        shutil.copytree(stage / 'plugins' / plugin, stage / 'data/plugins' / plugin)
    licenses = stage / 'licenses'
    licenses.mkdir()
    runtime = config['dotnet_runtime']
    for package, names in (
        ('microsoft.netcore.app.runtime.win-x64', ('LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT')),
        ('microsoft.windowsdesktop.app.runtime.win-x64', ('LICENSE',)),
    ):
        for name in names:
            shutil.copy2(nuget / package / runtime / name, licenses / (package + '-' + name))
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    (stage / 'BUILD-INFO.json').write_text(json.dumps({
        'version': version, 'variant': 'standalone', 'source_commit': commit,
        'source_worktree': True, 'source_sha256': sources,
        'runtimes': config, 'self_contained': True, 'desktop_sha256': digest(stage / 'Playtime.exe'),
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    (stage / 'START-HERE.txt').write_text(
        f'游时 Playtime V{version} · Windows 10/11 x64 自带环境便携版\n\n'
        '完整解压后双击本目录 Playtime.exe。无需安装 Python、.NET 或执行 pip。\n'
        '软件图标为绿色小方块。请保留同目录 runtime、web、acg_calendar、samples 等文件。\n'
        '可右键 Playtime.exe → 发送到 → 桌面快捷方式。关闭窗口后仍可在托盘退出。\n'
        '完整网页日历可从桌面快捷栏“完整日历”打开。\n\n'
        '个人数据保存在同目录 data/，升级前先退出并备份整个 data/。\n'
        '新版解压到新目录，再迁移原数据；不要用初始 data/ 覆盖旧数据。\n'
        '初始 data/ 仅预装公开游戏插件，没有个人数据库。\n'
        '开源许可与素材声明见 LICENSE、NOTICE.md；内置运行时许可证见 licenses/、\n'
        'runtime/python/LICENSE.txt 及 runtime/python/Lib/site-packages/tzdata-*.dist-info/licenses/。\n', encoding='utf-8-sig')
    out = ROOT / 'dist/releases'
    out.mkdir(parents=True, exist_ok=True)
    archive = out / f'Playtime-V{version}-standalone-windows-x64.zip'
    if archive.exists():
        raise ValueError('Standalone archive already exists')
    print('Packing ' + archive.name, flush=True)
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for file in sorted(stage.rglob('*')):
            if file.is_file() and '__pycache__' not in file.parts:
                bundle.write(file, (Path('Playtime') / file.relative_to(stage)).as_posix())
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None
        names = set(bundle.namelist())
        assert {'Playtime/Playtime.exe', 'Playtime/runtime/python/python.exe', 'Playtime/START-HERE.txt'} <= names
        assert not any(n.startswith('Playtime/data/') and not n.startswith('Playtime/data/plugins/') for n in names)
        assert not any(set(Path(n).parts) & {'promo', '.git', '.claude', '__pycache__'} for n in names)
    extract(archive, verify)
    checksum = archive.with_suffix(archive.suffix + '.sha256')
    checksum.write_text(digest(archive) + '  ' + archive.name + '\n', encoding='ascii')
    result = {'exe': str(stage / 'Playtime.exe'), 'zip': str(archive), 'checksum': str(checksum), 'bytes': archive.stat().st_size, 'sha256': digest(archive), 'verify_root': str(verify / 'Playtime')}
    (work / 'package-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
