# Windows 自带环境便携版

完整解压 `Playtime-V0.2.7-standalone-windows-x64.zip`，进入 `Playtime` 文件夹，双击绿色图标的 `Playtime.exe`。面向 Windows 10/11 x64，内置 Python、IANA 时区数据及 .NET 桌面运行时，无需另外安装依赖、执行 pip 或使用 PowerShell 启动。完整网页工作台从桌面快捷栏打开。

这是 EXE 加资源目录的便携软件。保留整个文件夹；可以创建 EXE 的桌面快捷方式。首次启动 .NET 单文件会解包内部运行时，耗时可能略长。没有新增开机启动、安装器、卸载器或系统日历面板接入。

数据继续存放在软件目录的 `data/`，插件接口和已有数据格式不变。请解压到有写入权限的目录，例如自己的软件目录。升级前退出旧进程并离线备份整个 `data/`，新版解压到新目录后迁移旧数据，合并所需公开插件，保留自定义配置。卸载便携软件前先备份数据，再删除其整个目录。

下载与升级步骤见 [V0.2.7 发布说明](releases/v0.2.7.md)。

## 可重复构建

依赖版本、官方下载地址和 SHA256 固定在 `scripts/windows-runtime.json`。构建下载不走游戏采集器；运行后的游戏同步继续遵守既有限流。

```powershell
$env:DOTNET_CLI_HOME = Join-Path $PWD '.dotnet'
$env:NUGET_PACKAGES = Join-Path $PWD 'logs/standalone-deps/nuget'
dotnet publish desktop/Playtime.Desktop.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o logs/standalone-deps/publish
python scripts/package-standalone.py --publish-dir logs/standalone-deps/publish --nuget-dir logs/standalone-deps/nuget --work-dir logs/standalone-0.2.7 --fetch
```

构建使用 Git 跟踪的源码路径和打包脚本的明确允许列表，包含尚未提交的源码修改，并在 `BUILD-INFO.json` 中记录来源提交及各源文件 SHA256；不扫描真实 `data/`，不包含日志和宣传片。脚本拒绝覆盖已有软件包和非空构建目录。再次构建请更换暂存/输出目录或先自行归档旧产物。

Python、tzdata 归档下载后核验官方 SHA256，保持内置 Python 的隔离路径配置，不读取用户 site-packages。桌面检测到随包 Python 后只使用它，损坏时报告错误，不悄悄改用开发机 Python。默认源码运行仍支持原有环境。

Python 采用 [官方嵌入包](https://www.python.org/downloads/release/python-31410/)；.NET 采用 [Microsoft 自包含发布](https://learn.microsoft.com/en-us/dotnet/core/deploying/)；时区库来自 [tzdata](https://pypi.org/project/tzdata/2026.5/)。各自许可与第三方通知保留在包内，游戏素材许可仍见 `NOTICE.md`。
