# 安全、CI 与兼容性审计 · 2026-11-13

执行：Codex。范围为本地组合工作区（基于已发布 V0.2.7），不是一次新版本发布，也不是安全认证。所有产品测试使用隔离数据目录；未读取或改写真实 `data/`，未重复请求游戏源站，未修改系统防火墙、全局凭据或设备设置。

## 结论

项目适合作为信任当前操作系统用户的本地日历继续迭代。审计发现并修复了异常 HTTP 请求处理、Android 中断安装标记、日志增长与发布漏文件检查方面的问题。不能据此宣称无漏洞或已经适合公网部署。

当前发布前的主要待办是：完整计划删除撤销、组合源码正式整合后的干净构建、新工作流远端矩阵验收，以及 Android 正式签名/真机验证。完整列表在 [TODO](../TODO.md)。

## 已复现及修复

| 问题 | 影响与修复 | 验证 |
| --- | --- | --- |
| 非 ASCII 写入 token / 会话 Cookie | `compare_digest(str,str)` 抛出未处理 TypeError；现在返回 403 | 原请求能复现断连，修复后真实 socket 测试通过 |
| 非法 URL 与含糊正文 | 非法 URL 曾在异常处理外解析；重复长度、Transfer-Encoding、截断正文、NaN/Infinity 曾未严格拒绝 | URL 解析纳入校验，校验 framing、精确长度、标准 JSON 与深度；相应用例通过 |
| 请求读取无有限等待 | 不完整请求可能长期占用线程 | socket 设置 10 秒读取超时；测试确认有限 timeout。未声称完整 DoS 防御 |
| API 来源边界 | 普通读接口原先依赖浏览器同源策略；现在额外拒绝不匹配/重复 Origin 和 cross-site 标记 | 覆盖 Host、端口、Origin、Fetch Metadata、无 CORS、私有路径拒绝 |
| Android 解包标记过早 | 原复制顺序可能先写 BUILD_STAMP，后续复制失败却被当成已完整安装 | 独立 Java 类最后写标记；故障注入验证失败无标记、重试完整、相同版本跳过、个人文件保留 |
| Android 数据迁移边界 | 仅 allowBackup=false 不足以清楚表达 Android 12+ 的设备迁移排除 | 增加 cloud-backup/device-transfer 显式排除；双架构构建与 lint 通过，OEM 真机行为未验收 |
| 日志泄漏/无界增长 | HTTP 默认可能记录请求查询；桌面日志一直追加 | HTTP 仅记录转义的方法、无查询路径和错误状态；桌面约 2 MiB 轮转，保留一个旧文件、单行限制。脱敏用例与桌面构建通过 |
| 新模块漏入发布源码 | Git 清单和当前工作区混合打包时，未提交入口依赖可能被遗漏 | 两个发布脚本统一检查 HTML 静态和 app.js 动态入口依赖；缺失/外链/完整清单测试通过 |

新增 `test_http_security.py`、`test_android_bundle.py`、`test_release_sources.py` 和 `e2e-security.cjs`。浏览器安全样本将 HTML 放入插件标题、说明及计划备注，验证只显示文本、无注入 DOM/执行或外部请求。它覆盖指定路径，不能代表穷尽所有 XSS 输入。

## 本机验证结果

| 项目 | 环境 / 结果 |
| --- | --- |
| 后端完整单测 | Windows、Python 3.12.14：334 项通过 |
| 便携运行时兼容 | Windows 内嵌 Python 3.14.10：334 项通过；未启动个人实例 |
| 网页统一回归 | Windows Edge、Playwright 1.62.1：13/13 组通过，包含来源返回、草稿、计划、拖选、无障碍、并发刷新、动效、月历密度、C2 和安卓外壳 |
| JavaScript 语法 | Node 24.22.1：47 个文件通过 |
| WPF | .NET SDK 10.0.401、Release 构建通过，0 警告 / 0 错误；本轮没有重跑物理桌面交互自检 |
| Android | JDK 17.0.20、SDK 35、Gradle 8.9：ARM64 / x86_64 debug 构建、ARM64 lint 通过；lint 0 错误、2 警告 |
| 工作流语法 | actionlint 1.7.12 通过（关闭 shellcheck 检查）；不等于远端实际运行成功 |
| npm 锁定安装及审计 | `npm ci --ignore-scripts` 成功，`npm audit` 当次报告 0 已知漏洞；只涵盖 npm 依赖，未据此认证所有原生运行时 |
| Python 依赖 | `tzdata==2026.6` 锁定 wheel/sdist SHA256，`pip --dry-run --require-hashes` 通过；已有包未重新下载，未据此声称已安装文件逐字节校验。Windows 商店 python 占位程序未使用 |
| 凭据模式检查 | Git 文件及非忽略候选文本中的 222 个文件：未命中私钥 PEM、GitHub PAT、AWS Access Key 模式；未扫描整个系统或个人数据，不保证无所有类型秘密 |

Android 两项 lint 警告分别是 API 33 的返回手势属性在旧系统被忽略，以及 WebView 启用 JavaScript。前者有旧版返回路径，后者是应用界面所需，结合本机会话、导航限制、文本转义和 CSP 审核；没有压制 lint 来制造零警告。

浏览器结果写入 `logs/web-regression-summary.json`，只含测试名、结果和耗时；运行日志/截图均忽略提交。个别沙箱执行因 Edge 启动权限失败，获准在隔离环境重跑后通过；pip dry-run 的临时目录清理警告未影响依赖检查，未删除用户临时目录。

## CI/CD 与供应链

原工作流只检查较少 Python 环境和 WPF。当前增加：

- Python：Linux 3.11/3.14、Windows 3.11/3.12/3.13/3.14、macOS 3.14。
- 浏览器：Windows Edge 与 Linux Chromium，顺序运行有隔离数据的统一回归。
- Windows WPF 构建、Android 双 ABI 构建与 lint、安装中断 Java 用例。
- `contents: read`，checkout 不持久化凭据；所有 Action 固定完整提交 SHA；同分支取消旧任务，设置 job 超时。
- npm lockfile、Python hash pin、Gradle 发行 ZIP SHA256 与 wrapper JAR SHA256；每月 Dependabot 检查。
- 只上传受控摘要与截图，不上传数据库或请求会话。不自动签名、上传或创建 Release，工作流无需发布凭据。

只读查到远端旧提交 `755fc582…` 的 [Actions 42303417169](https://github.com/woodrice/acg-calendar/actions/runs/42303417169) 成功。**它不包含本轮新工作流与未提交源码**。本轮未提交、推送、合并分支或发布；新矩阵仍需在正式整合后执行。Linux/macOS、Linux Chromium、Node 22 并未在这台 Windows 上独立运行，不能把配置支持写成已验证兼容。

源码 Windows 依赖锁为 tzdata 2026.6；既有便携包清单仍固定 tzdata 2026.5、Python 3.14.10、.NET Runtime 10.0.12。两套依赖清单用途不同，本轮没有静默替换已发布包。后续维护须按批次更新运行时、校验 SHA 并重跑测试。

## 接口开放性与环境安全

接口清单见 [本机 API](local-api.md)，信任模型见 [SECURITY](../SECURITY.md)。普通网页与 Windows 模式不要求本机读取认证；本机其他进程可以读取状态、个人计划和备份，以及获取写 token。这是现有单用户架构的边界，不能宣传为本机恶意进程隔离。

服务入口固定回环地址；不开放 CORS、任意路径读取、任意 URL 代理或外部代码插件。Android 额外使用每次启动的 HttpOnly 会话 Cookie；WebView 关闭文件/content 访问，原生桥只接受颜色。系统权限只见联网权限，调试构建仍可被开发工具检查。

本轮未更改用户网络、代理、防火墙或系统账户，没有需要游戏账号/云 API 密钥的新增依赖。Git 忽略 `.env` 与签名密钥文件；这不能替代历史泄漏调查或凭据轮换。备份与数据库为本机明文，使用者仍需保护目录与导出文件。

## 交付限制与下一步

1. 当前组合工作区同时含安卓、共享 C0/C2 与网页续作；独立安卓分支不是组合 APK 的完整源码。发布前应整合为可重现的干净检出，再构建并更新交付哈希。
2. 本轮构建输出在 `android/app/build`，未替换 `dist/android` 的历史测试包；旧交付文档的哈希仍指旧包。尚未进行新的真机安装、键盘或系统栏测试。
3. 安卓计划删除的降级撤销仍通过重新创建恢复，不能保证原 ID、最新备注和失效关联完整保留。完整恢复接口仍是 P1，不能标为已解决。
4. 正式 Android 签名、安装升级与后台/提醒能力，以及 U14 的真实读屏、高 DPI 和触屏验收仍待完成。
5. 没有进行公网渗透、压力测试或全量原生组件 CVE 审计；标准库本地服务不作为公网交付。若改变信任边界，应先重新评估读取鉴权、授权和会话。

## 依据

- [GitHub Actions 安全使用](https://docs.github.com/en/actions/reference/security/secure-use)：最小权限与固定提交。
- [Playwright CI](https://playwright.dev/docs/ci)：浏览器与系统依赖安装。
- [Gradle Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html) 与[发行校验值](https://gradle.org/release-checksums/)：ZIP/JAR 验证。
- [AGP 8.7 兼容要求](https://developer.android.com/build/releases/agp-8-7-0-release-notes)：SDK、Gradle、JDK 与 Build Tools。
- [Android Auto Backup](https://developer.android.com/identity/data/autobackup)：备份与设备迁移排除。
- [Python http.server](https://docs.python.org/3.12/library/http.server.html)：部署边界。
