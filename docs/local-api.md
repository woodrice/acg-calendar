# 本机 HTTP API（当前源码）

此接口用于网页、WPF 与内嵌 Android 共享本地数据。插件协议仍为 API 1；HTTP 接口是项目内部契约，没有公开云服务或长期外部 SDK 兼容承诺。核心字段和身份规则见 [架构](architecture.md)，安卓只读快照及 C2 接入见 [外壳接口](android-shell-source.md)。

## 连接与访问

默认 `http://127.0.0.1:8765`，可用 `--port` 修改端口；监听地址不能通过 CLI 改为公网。`Host` 只接受本机 `127.0.0.1` / `localhost` 与实际端口（或省略端口），拒绝重复/非法值。客户端应始终使用实际地址和端口。

- 普通网页/Windows：读取不要求登录；写入前读取 `/api/state.csrf_token`，以 `X-Calendar-Token` 请求头提交。
- 请求若携带 `Origin`，必须精确匹配当前 HTTP Host；API 拒绝 `Sec-Fetch-Site: cross-site`。无 CORS 支持。来自本机程序的无 Origin 请求可以使用。
- Android：额外验证宿主发放的 `playtime_session` Cookie。它由每次启动随机生成，所有读写和静态资源都要求携带。外部集成不能从端口自行领取它。
- token 随进程改变，收到 403 应重新读取状态或重新建立宿主会话；不要把 token 放到 URL 或日志中。

**普通模式的写入 token 是浏览器跨站防护，不是本机身份认证。** 本机程序可以读取状态和备份；这不是多用户权限系统。详见 [安全边界](../SECURITY.md)。

## 读取接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/health` | `{ok, version}`；Android 中也需宿主会话 |
| `GET /api/state` | 当前活动、个人状态、设置、同步信息、投影及写入 token；支持 `ETag` / `If-None-Match`，无变化返回 304 |
| `GET /api/workspace` | 游戏组合、排序、筛选、聚焦、主题、模块布局 |
| `GET /api/timeline?games=<逗号分隔ID>&timezone=<IANA>` | 临时组合的活动、计划及截止投影；不修改偏好。应传实际 IANA 时区，`auto` 在后端回落 UTC |
| `GET /api/plans` | 所有个人计划 |
| `GET /api/network` | 采集策略、站点预算、冷却和暂停状态 |
| `GET /api/plugins` | 插件元数据、加载状态与错误 |
| `GET /api/rules?game=<ID>` | 对应来源规则 |
| `GET /api/export?game=<ID或selected或all>` | 官方活动 JSON，不是个人备份 |
| `GET /api/calendar.ics?game=<ID或selected或all>` | 已确认活动的日历订阅文件，不包括个人计划和所有个人设置 |
| `GET /api/backups` | 本地备份列表与备份目录 |
| `GET /api/backups/<备份名称>` | 下载经过名称校验的个人备份；含敏感个人数据 |
| `GET /api/artwork/<缓存键>` | 已缓存的 PNG/JPEG/WebP；不是任意远程图片代理 |

`/api/state` 不应转发给第三方页面。304 无 JSON 正文，调用端需沿用已有状态；网页轮询和官方来源复查是两套频率，前者不触发网络采集。

## 写入接口

下表是客户端应使用的方法。正文为 JSON 对象，带 `Content-Type: application/json` 与当前写入 token。大多数写入返回完整状态，个别接口返回专用结果；不要假设每个响应都有同样结构。

| 方法与路径 | 用途与特殊返回 |
| --- | --- |
| `PATCH /api/workspace` | 修改 view/layout/theme；按分组提交，避免覆盖其他草稿 |
| `POST /api/settings` | 保存全局设置（提醒、显示等） |
| `PATCH /api/network` | 更新保守采集策略、暂停/恢复；不会绕过来源配额 |
| `POST /api/sync` | `{game: <ID或selected或all>}`，启动后台采集；返回 `sync_request.requested/accepted`。被接受不代表同步已经成功 |
| `POST /api/plans` | 创建个人计划；可传 `request_id` 去重重试，响应含 `saved_plan` ID |
| `PATCH /api/plans/<plan-id>` | 修改个人计划，返回状态及 `saved_plan` |
| `DELETE /api/plans/<plan-id>` | 删除计划；目前无服务端完整撤销契约 |
| `PATCH /api/events/<event-id>` | 收藏、完成、忽略、备注、提醒提前量或手动时间校正；不修改采集源原文 |
| `POST /api/versions/<version-id>/maintenance` | 登记实际开服时间；UTC 或带 timezone/fold 的当地时间，按后端校验 |
| `POST /api/notifications/test` | 测试提醒 |
| `POST /api/notifications/read` | 标记提醒已读 |
| `POST /api/plugins/state` | 启用/停用，重启后生效；附插件报告 |
| `POST /api/plugins/open-directory` | 空对象；仅打开实际插件目录，不接受路径参数 |
| `POST /api/backups` | 空对象；创建备份，返回备份及列表 |
| `POST /api/backups/preview` | 校验并预览恢复，不写个人数据 |
| `POST /api/backups/restore` | 校验、自动安全备份、事务恢复；返回恢复结果和备份列表 |
| `POST /api/games/records/preview` | 预览按游戏清除个人记录的范围 |
| `POST /api/games/records/clear` | 先备份再清除目标游戏个人记录；响应含清除结果 |
| `POST /api/desktop/window-applied` | WPF 确认特定恢复交接 ID；旧确认不能清掉新交接 |

字段详细规则以对应服务的校验器与测试为准；新增第三方调用前应锁定源码版本。当地重复时刻需要明确 `fold`，不存在的夏令时时刻拒绝保存。时间和计划请求的可识别校验错误可能附带 `code`。

## 请求及响应限制

| 项目 | 当前限制 |
| --- | --- |
| 普通写入正文 | 16,000 字节 |
| `/api/workspace` 正文 | 512,000 字节 |
| 备份预览/恢复正文 | 8,000,000 字节（`backup.MAX_BYTES`） |
| 读取超时 | socket 读取超时 10 秒，防止不完整请求无限占用线程 |
| 正文编码 | JSON 对象；拒绝 NaN/Infinity、过深或非法 JSON、非对象顶层 |
| HTTP framing | 不支持 Transfer-Encoding；重复 Content-Length、负数/超限长度、截断正文拒绝 |

成功通常返回 200；304 表示可复用状态；400 表示参数/格式错误；403 表示来源/会话/token 不匹配；404 表示资源或接口不存在；408 表示正文接收超时；413 表示正文过大。不支持的方法由标准库返回错误。不存在统一分页、远程鉴权、外部开放注册或插件执行接口。

响应默认 `Cache-Control: no-store`，已缓存图片有受控私有缓存策略；不写跨域许可头。HTTP 错误日志只记录转义的方法、无查询路径及状态码，不记录正文和认证信息。
