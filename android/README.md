# 游时 Android 测试版

Android 宿主是一个 WebView，内嵌通过 Chaquopy 运行的现有 Python 后端；专用手机外壳复用网页的共享数据接口与时间轴。只用于侧载测试，目前用调试密钥签名。

- 包名 `io.github.zhenyufu039.playtime`，版本号取自仓库 `VERSION`（0.2.7 → versionCode 207）
- Android 7.0（API 24）及以上，targetSdk 35；Python 3.13（Chaquopy 17.2.0）
- 按 ABI 分别出包：`arm64` 风味对应真实手机（arm64-v8a），`x86_64` 风味对应桌面模拟器

## 运行方式

- 首次启动时，把 APK 内的后端、网页和公开数据（`app.py`、`acg_calendar/`、`web/`、`rules/`、`samples/`、`plugins/`、tzdata）复制到应用私有目录 `files/runtime/`；以后只有 `BUILD_STAMP` 变化时才重新复制。
- 运行时完成标记最后写入；复制失败或中断后下次启动重新安装运行时，个人 `files/data/` 不属于这次替换范围。源码已排除系统云备份和设备迁移中的应用数据，手动导出的备份需自行保管。
- 个人数据在私有目录 `files/data/`。随包的三个游戏插件只在第一次复制到 `files/data/plugins/`，之后不会覆盖，用户的启用或停用选择会保留。
- 后端只监听 `127.0.0.1` 的随机端口。每次启动生成一个 32 字节的会话密钥，作为 HttpOnly Cookie 只交给本应用的 WebView；`app.handler_for(..., session=...)` 要求所有读写请求都带上它，所以其他应用即使知道端口也只会得到 403。写入请求仍需原有的 `X-Calendar-Token`。
- 不自动联网同步（`auto_sync=False`），只有点“同步资料”才会访问来源，并沿用现有的限流和缓存。
- 公告等外部链接交给系统浏览器打开；WebView 只停留在本应用页面。

## 构建

需要 JDK 17、Android SDK（platform 35、build-tools 36.0.0），以及一个 `tzdata` 包目录（纯 Python，打进包内供 `zoneinfo` 使用）。AGP 固定 9.5.1，Gradle Wrapper 固定 9.9.1；Chaquopy 17.2.0 支持这组 AGP。Wrapper JAR 与下载 ZIP 都验证官方 SHA256。升级 AGP 时必须同时核对 Gradle、Build Tools 与 Chaquopy 兼容范围，更新 CI 校验值后运行双 ABI 构建和 lint。参考 [AGP 兼容表](https://developer.android.com/build/releases/agp-9-5-0-release-notes)、[Chaquopy 兼容表](https://chaquo.com/chaquopy/doc/current/versions.html)和 [Gradle 校验值](https://gradle.org/release-checksums/)。`android/local.properties`（不提交）：

```properties
sdk.dir=D\:\\Android\\sdk
playtime.tzdata=<python>\\Lib\\site-packages\\tzdata
```

在 `android/` 目录下：

```bash
JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot" GRADLE_USER_HOME=D:/Android/gradle-home ./gradlew assembleArm64Debug assembleX86_64Debug
```

产物在 `app/build/outputs/apk/<arm64|x86_64>/debug/`。不需要 NDK，构建时也不运行 Python（关闭了 pip 和 pyc 编译）。

无本机配置文件的 CI 可用 `PLAYTIME_TZDATA` 指定包目录，先用 `python -m pip install --require-hashes --target <临时目录> -r requirements-build.txt` 安装，再指向 `<临时目录>/tzdata`。验证命令增加 `lintArm64Debug`。本轮本机构建通过不表示旧 `dist/android` 交付包已经更新；当前限制见[审计记录](../docs/security-compatibility-audit-2026-11-13.md)。

## 设备验收

`tools/device-check.cjs` 通过 adb 和 WebView 的 DevTools（仅调试版可用）在真机或模拟器上检查，共五个阶段，依次运行：

- `first`：清空数据后首次启动，五款游戏都有数据、无网络请求、能切换游戏和筛选、能打开详情并收藏、标记完成。
- `restart`：强制停止后重新打开，收藏和完成状态仍在。
- `security`：用另一个 uid（adb shell）访问端口，确认返回 403，且只监听回环地址。
- `link`：确认外部链接由系统浏览器打开。
- `sync`：手动同步一个游戏，只请求一次，不会重试。

```bash
ADB=<adb.exe> SERIAL=<设备> node tools/device-check.cjs first <输出目录>
```
