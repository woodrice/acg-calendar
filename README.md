# 游时 · Playtime

**规划你的游戏时间。** 把多款游戏的限时活动放进同一条时间轴，在本机查看截止密度、安排个人计划并接收提醒。

当前版本：**V0.3.25**。本版整合网页任务往返、月历截止密度、安卓测试外壳及本机安全修复，见 [更新记录](CHANGELOG.md) 和 [发布说明](docs/releases/v0.3.25.md)。

[下载版本](https://github.com/woodrice/acg-calendar/releases) · [待办](TODO.md) · [使用设置](docs/preferences.md) · [插件接口](docs/plugins.md) · [安全说明](SECURITY.md)

## 能做什么

- 自选游戏组合，共用日期轴；头图、完整标题、区服和来源分开显示，支持收藏、排序、筛选、完成及备注。
- 月历用统一主题色填充截止日期格，填充高度表示相对密度，右下角显示数量；点击查看当天截止明细。数量表示截止节点，不表示游玩耗时。
- 创建个人计划，或在电脑时间轴上拖选时段；计划与官方活动时间独立，查看期间可参与的活动。
- 本地换算时区及夏令时；明确、预计和未公布的时间分别处理。资料与图片失败时保留缓存。
- Windows 桌面挂件、透明气泡、托盘常驻和置顶；提醒范围可独立选择，页面筛选不会自动关闭提醒。
- 本地 JSON 日历插件、主题与模块布局、个人数据备份恢复、活动 JSON / ICS 导出。

不需要 AI API、游戏账号或云端数据库。公告解析使用代码与声明式规则；新增网站仍需要适配规则，并非任意网址都能自动识别。

![已发布 V0.2.4 的工作区示意](docs/screenshots/v0.2.4-workspace.png)

## 已支持游戏与来源

| 游戏 | 区服 / 安装 | 主要来源 |
| --- | --- | --- |
| 明日方舟：终末地 | 国服 / 内置 | [官网](https://endfield.hypergryph.com/)更新公告与[版本导览](https://endfield.hypergryph.com/version_briefing/latest?source_from=official) |
| 明日方舟 | 国服 / 内置 | [官网活动预告](https://ak.hypergryph.com/#information)；历史资料保留 [PRTS](https://prts.wiki/w/首页) 来源 |
| 胜利女神：NIKKE | 国际服 / [nikke-global](plugins/nikke-global/README.md) | [GameKee 活动日历及公告](https://www.gamekee.com/nikke/huodong/19)（社区来源） |
| 碧蓝航线 | 国服 / [azurlane-cn](plugins/azurlane-cn/README.md) | [BWIKI 国服公告](https://wiki.biligame.com/blhx/游戏活动表)；[英文 Wiki](https://azurlane.koumakan.jp/wiki/Recent_News) 补图，日期以国服为准 |
| 绝区零 | 国服 / [zzz-cn](plugins/zzz-cn/README.md) | [官网公告和头图](https://zenless.hoyoverse.com/zh-cn/news?category=296)，[BWIKI](https://wiki.biligame.com/zzz/活动一览) 精确匹配补图 |

源码默认启用两款内置日历，其余三个插件在仓库 `plugins/` 中按需安装；Windows 便携包预装这三个插件。完整来源致谢与素材限制见 [开发文档](docs/development.md) 和 [NOTICE](NOTICE.md)。具体活动情况请参考游戏官方时间。

## 安装和启动

### Windows 便携包

从 [Releases](https://github.com/woodrice/acg-calendar/releases) 下载 **Windows x64 自带环境便携包**，完整解压到可写目录后双击 `Playtime.exe`。该类型包内置 Python、时区数据和 .NET；GitHub 自动生成的 Source code ZIP 不包含这些环境。请核对对应发布页的 SHA256。

关闭主窗、保留桌面挂件、收起托盘和退出是不同操作，可在桌面设置调整。**更新前从托盘选择“退出游时”**，仅关闭网页或窗口不会停止旧后台。

升级前在设置中创建个人备份，并另外保留旧 `data/`。把新版解压到新目录后迁移旧数据，避免用新包的初始文件覆盖旧数据。详见 [V0.3.25 下载与升级](docs/releases/v0.3.25.md)。

### 从源码运行网页

需要 **Python 3.11–3.14**。业务代码使用标准库；Windows 安装锁定的 IANA 时区包。前端运行不需要 Node、npm 或构建步骤。

Windows PowerShell，在项目根目录：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --require-hashes -r requirements.txt
.\.venv\Scripts\python.exe app.py --no-desktop
```

macOS / Linux（需系统时区数据库）：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements.txt
.venv/bin/python app.py --no-desktop
```

浏览器打开 [本地日历](http://127.0.0.1:8765/)。Windows 的 `python` 可能是商店占位程序，遇到提示安装时请改用实际解释器路径。

| 参数 | 用途 |
| --- | --- |
| `--port 8766` | 修改本地端口；默认 8765 |
| `--data-dir <目录>` | 使用指定数据目录；默认项目根目录的 `data/` |
| `--no-sync` | 不进行自动联网同步，使用缓存/随包快照；手动同步仍可联网 |
| `--no-desktop` | 不发送原生桌面提醒 |

离线试用或开发测试请使用独立目录：

```powershell
.\.venv\Scripts\python.exe app.py --data-dir .\logs\manual-demo --no-sync --no-desktop
```

`Ctrl+C` 停止网页后台。源码桌面版运行 `Playtime.cmd`，需要 Python 和 .NET 10 Desktop Runtime；首次自动编译还需 .NET 10 SDK。详见 [Windows 桌面版](docs/windows-desktop.md)。

### 添加日历插件

在“游戏管理”点击 **＋ 加载新的日历**，打开实际数据目录下的 `plugins/`；放入已解压的完整插件文件夹，然后退出后台并重启。停用/启用在重启后生效；移出文件夹不会自动清除个人记录。

例如安装源码自带 NIKKE 包：

```powershell
New-Item -ItemType Directory -Path .\data\plugins -Force | Out-Null
Copy-Item -LiteralPath .\plugins\nikke-global -Destination .\data\plugins\nikke-global -Recurse
```

插件 API 1 使用声明式 JSON，不执行插件 Python/JS。采集能力由主程序可信引擎提供；无任意代码插件、在线市场或热加载。详见 [插件约束](docs/plugins.md)。

## 数据、同步与安全边界

个人标记、计划、设置和缓存保存在数据目录，不上传到项目服务器。活动 JSON / ICS 导出不是个人数据备份；请使用“备份与恢复”，其中不包含插件文件本身。

倒计时在本地运行，不会每秒访问网站。自动复查默认间隔 **24 小时 + 0–2 小时随机错峰**，可选 18 小时；首次/过期补查延迟 1–10 分钟。同站请求至少间隔 10 秒并错峰，错误会退避和暂停；手动同步共用限流，不能绕过来源冷却。独立进程之间不共享请求配额。

服务固定监听 `127.0.0.1`，不提供公网登录、CORS 或远程管理。写接口验证本机 Host、来源和会话写入 token；**普通网页/Windows 模式的读取接口不要求用户登录，本机其他进程可能读取日历、备注及备份**。这是一款信任当前操作系统用户的本地软件，不是多用户服务。不要将端口转发或反向代理到公网。

Android 内嵌模式额外要求每次启动的 HttpOnly 会话 Cookie。外部网页由系统浏览器打开；WebView 不开放文件访问，原生桥仅接受两项经过校验的颜色。详细约束和返回码见 [本机 API](docs/local-api.md) 与 [安全说明](SECURITY.md)。

## 开发与验证

后端测试使用隔离目录，不要把真实 `data/` 放入测试或提交。自动化测试不反复请求游戏网站。

```bash
python -m unittest discover -s tests -p "test_*.py"
dotnet build desktop/Playtime.Desktop.csproj -c Release
```

网页回归额外需要 Node.js 22+（CI 使用 24）、npm 和 Edge/Chromium：

```bash
npm ci --ignore-scripts
npm run check:js
npx playwright install msedge
npm run test:web
```

`CALENDAR_PYTHON` 可指定 Python 可执行文件。Linux 先运行 `npx playwright install --with-deps chromium`，再用 `CALENDAR_BROWSER=chromium npm run test:web`。统一入口按顺序启动独立本地服务，输出 `logs/web-regression-summary.json`，不连接已运行的个人实例。个别旧脚本不在统一清单中，运行前应确认其隔离规则。

CI 包含 Python 3.11–3.14 / Windows、Linux、macOS 后端矩阵、Windows Edge / Linux Chromium 网页回归、WPF 构建，以及 Android 双架构构建与 lint。工作流使用只读权限、固定 Action 提交和锁定依赖；**新增工作流须提交后在 GitHub 实际运行，配置存在不代表各平台已经验收**。CI 不自动签名或发布软件。

发布脚本会检查 Git 源码清单包含网页入口依赖。新增模块必须纳入源码提交再打包，不能只复制二进制；不要把个人数据、日志、密钥或构建缓存纳入源码发布。

### Android 状态

目前为侧载测试版：Android 7.0+ / API 24，target 35，JDK 17、Gradle 8.9、Python 3.13 / Chaquopy。提供 ARM64 与 x86_64，以调试密钥签名，未提供正式发布签名和应用商店分发。Android 的导出、后台常驻和系统提醒不能视为与 Windows 相同。

构建见 [Android 说明](android/README.md)，历史测试包见 [交付记录](docs/android-delivery.md)。本次源码及构建验证不会自动替换已交付 APK；真实设备、软键盘、系统栏及低版本 WebView 仍需验收。

## 文档与问题反馈

- [本轮安全与兼容性审计](docs/security-compatibility-audit-2026-11-13.md)：修复、验证证据和未完成项。
- [架构](docs/architecture.md) · [网页任务往返](docs/web-journey.md) · [个人规划](docs/planning.md) · [动效](docs/motion-feedback.md)。
- [更新记录](CHANGELOG.md) · [待办](TODO.md) · [安全问题报告](SECURITY.md)。

提交普通问题请附软件版本、系统/浏览器、同步状态和复现步骤。桌面日志在项目/便携包根目录的 `logs/desktop.log`，约 2 MiB 轮转一次，仅保留一个 `.1` 旧文件；网页后台错误信息输出到启动终端，默认不另建永久访问日志。HTTP 错误日志不记录查询参数、请求体、Cookie 或 token。分享前仍请检查文件路径和异常文本中的个人信息，勿公开数据库、备份或完整个人状态。

源码使用 [MIT](LICENSE)。本项目是独立、非官方、面向个人非商业使用的工具；此用途说明不改变 MIT 对源码的授权。游戏素材、公告和 Wiki 内容分别受原权利人及来源许可约束，不因收录而转为 MIT。日程可能因源站、网络或解析变化不完整，提醒不保证送达，具体时间请以游戏官方为准。详见 [来源致谢与免责声明](docs/development.md)。
