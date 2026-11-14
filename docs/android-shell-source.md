# C0 安卓外壳数据接口

Codex · 2026-11-08。供 M1 联调用的本地接口。宿主加载 `/?shell=android`，网页入口创建 `#pt-shell`，再调用 `PlaytimeShell.start({root, source})`。普通网页无需加载外壳资源。安卓标记只选择布局，会话和写入校验由原本机服务处理。

## 读取与生命周期

| 接口 | 约定 |
| --- | --- |
| `source.status` | `loading`、`ready` 或 `error`。曾成功读到数据后发生断线时保持 `ready`，由 `connectionError` 说明缓存状态 |
| `source.snapshot()` | 首次就绪前返回 `null`。就绪后返回冻结的 JSON 读模型。`revision` 随发布递增，可作为渲染版本号 |
| `source.subscribe(fn)` | 状态应用后通知，首次渲染主动读快照。返回取消订阅的函数，外壳 `stop()` 时调用 |
| `source.reload()` | 重新读取本地数据 |
| `source.event(id)` | 单条只读活动，按 ID 查找，覆盖已完成或因当前筛选隐藏的活动。找不到时返回 `null` |
| `source.now()`、`source.helpers` | `zone` 是当前 IANA 时区。`time(at)`、`date(at)`、`day(at)`、`dayLabel(day)`、`localInput(at)`、`countdown(at)` 共用网页时间解释 |

快照包含 `today`、`games`、`scope`、`filters`、`events`、`upcoming`、`uncertain`、`deadlineDays`、`plans`、`sync`、`appearance` 和 `app`。具体字段由 [适配器](../web/shell-source.js) 定义。

- `scope.mode` 为 `all`、`selected` 或 `single`，`games` 为当前范围内的 ID。游戏记录包含 `id`、`name`、`short`、`mono`、`color`、`icon`、`source`。
- `upcoming` 按显示时区的 `YYYY-MM-DD` 分组，每项带活动和 `at`、`deadlineTitle`、`kind`。阶段关闭可用 `deadlineTitle` 显示具体阶段。`uncertain` 单独提供预计或待定截止。`deadlineDays[day]` 为 `{event_id,at,kind,title}` 节点，月历格按数组长度计算填充。月历沿用网页的基础筛选和截止去重，近期列表沿用网页对日期聚焦的处理。
- 活动详情使用 `artwork` 和 `sourceUrl`。头图为受限的本机相对路径，公告链接为 HTTP(S)，可能为空。`start`、`end` 携带各自时间状态，另提供 `description`、`warnings`、`phases`、`reminderMinutes`。
- `sync` 汇总当前范围。`stage` 是可直接展示的摘要，含站点等待提示。各游戏的详情在 `sync.games[id]`，结果沿用 `result.calendar` 和 `result.images`，外壳可据此展示成功、部分失败及补图信息。站点暂停和冷却信息见 `sync.sites`。从未同步时 `lastSuccess` 为 `null`，仍可展示内置日历。
- `today` 及 `helpers.localInput()` 用于替换原型中固定的月份和计划初始日期。宿主在日期切换或活动开始／结束影响投影时更新快照。纯倒计时动画或逐分钟显示由外壳自行更新文字。

## 写入与错误

`source.act(name, args)` 返回 `Promise<{ok, code?, error?, ...}>`。调用按顺序执行。普通网页已有的轮询和写入保护继续参与，较早读取结果不能覆盖新写入或新范围。外壳根据自身路由和草稿判断是否还应打开、关闭或更新当前页面。

| 操作 | 输入与结果 |
| --- | --- |
| `setScope` | `{mode,games}`，单游戏传一个 ID，组合允许为空。`custom` 暂作为 `selected` 的原型兼容名。切游戏重置搜索与日期窗口，其他筛选按现有规则保留 |
| `setFilters` / `resetFilters` | `types` 为增量布尔映射，可传 `hideCompleted`、`showPending`、`hideFuture`、`sort`。重置恢复类型和状态并清除搜索，保留共享日期聚焦。涉及多个持久化设置时已成功的部分会体现在快照中 |
| `setStarred` / `setCompleted` | `{id,value}`，发生变更时返回 `undo()`。当前标记已改变时撤销返回 `conflict` |
| `createPlan` / `updatePlan` | 使用现有计划字段。创建支持 `request_id`，每次新草稿生成一个 32 位小写十六进制 ID，重试同一草稿时复用。更新另传 `id`。成功返回 `id` |
| `deletePlan` | `{id}` |
| `sync` | `{scope}` 可传 `snapshot.scope` 或游戏 ID、`all`、`selected`，省略时同步当前范围。成功返回 `accepted` 和 `requested` 游戏 ID，表示请求受理。运行和最终结果从快照读取 |
| `markNoticesRead` | 将本地提醒标为已读。未读数量见 `app.unread` |
| `setAppearance` | `{mode?,preset?}`。`mode` 为 `system`、`light`、`dark`，保存在本浏览环境，外壳读取并渲染。`preset` 为主题预设 ID，通过原共享偏好持久化 |

计划表单按 `local_start`、`local_end`、`timezone` 提交，后端负责换算。收到 `ambiguous_time` 时允许补充 `fold_start` 或 `fold_end`，`0` 为较早、`1` 为较晚。`nonexistent_time` 要求修改当地时间。用同一个 `request_id` 重试已创建的计划会返回原 ID，并保留后来编辑的内容。活动详情发起的计划可传 `event_id` 和 `game_id`。

同步区分 `paused`、`busy`、`cooldown`（附 `until`）、`empty_scope`、`conflict` 和 `not_started`。站点级退避可能在受理后出现，由每游戏同步结果说明。手动与自动同步继续走现有限流。

## 后续接入

- M1 可通过 `/?shell=android` 访问现有外壳和真实本地数据，在外壳中读取动态日期、截止名称、图片、同步状态和计划请求结果。安卓宿主负责启用入口及转发返回键。
- 网页返回栈和草稿修复属于 C1，安卓路由与草稿归外壳。
- 联调使用独立目录和 `--no-sync --no-desktop`。`tests/e2e-shell-source.cjs` 使用固定日期和独立服务验证真实接口。

## C2 时间轴挂载接口

`source.mountTimeline(element, {date?, days?, onOpenEvent?, onDay?, onOpenPlan?})` 返回控制器。`date` 是显示时区内的 `YYYY-MM-DD`，默认今天。`days` 可取 7、14 或 28，默认 14。容器应独占，控制器在容器内提供日期导航与时间轴。

`controller.date` 是当前窗口的起始日。外壳收到订阅更新或需要刷新倒计时时调用 `controller.update()`。也可传 `{date, resetScroll}` 切换日期并从左侧重新查看。离开页面调用 `controller.destroy()`，会清除内容和监听。重复调用 `destroy()` 安全。

活动、截止明细和个人计划回调分别收到 `(id, button)`、`(day, button)` 和 `(id, button)`。`button` 是触发控件，可用于返回焦点。未传 `onOpenPlan` 时计划条仅展示。移动端的「日历 → 时间轴」已调用此接口，详情和当日截止使用外壳的返回路径。挂载复用活动条、图片、阶段节点、共享排序和截止规则，日期导航保留在外壳会话内。
