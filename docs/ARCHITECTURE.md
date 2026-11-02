# Hina 架构与当前实现

开发纪律和产品方向以根目录 `AGENTS.md` 为基线。本文区分已经实现的协议与后续里程碑，不把进程内 Hook 视为插件隔离系统。

## 当前范围

已实现 M0 的 Mock Channel 输入输出子集、QQ 官方平台文本/图片适配器、本机消息日志，以及可选的 OpenAI 兼容模型通路：事件归一化、输入去重、有限短期上下文、可注销 Hook、统一输出检查、Channel 生命周期，以及源码和构建产物的运行路径。QQ 适配器边界见 [QQ Bot 接入](./QQ_BOT.md)，日志读模型见 [消息日志](./MESSAGE_LOG.md)，模型设置和执行约束见 [模型设置](./LLM.md)。

已增加可选 Decision 扩展点及 OpenAI Decisions 适配器，响应使用 Responses API。尚未实现持久角色、长期记忆、可恢复 Execution、持久审批或动态插件加载。因此这不是原版 M0/M1 全部验收项完成的声明。`plugin-sdk` 等尚无实际职责的包保持未创建；本地协议测试与真实服务验收分别记录。

## 模块职责

| 位置 | 当前职责 |
| --- | --- |
| `packages/core` | 单一来源的 Event、Action、Channel、Hook、Model 与 Decision 契约，以及边界校验；只使用 TypeScript 标准库和标准 Web 类型 |
| `packages/logs` | 日志条目、查询、分页响应及前后端边界校验，不导入宿主或数据库 |
| `packages/settings` | 公共模型设置、变更版本与运行时校验；不依赖宿主或供应商 SDK，不存储 Token |
| `apps/dashboard` | Vue 3 日志、模型设置与连接测试；仅提交用户输入的 Token，不读取已存 Token，不执行 Action |
| `apps/runtime/src/logs/` | MessageLogStore 接口、Bun SQLite 适配器、本机 HTTP 与受限图片读取 |
| `apps/runtime/src/models/` | OpenAI Responses/Decisions HTTP 适配器与处理 Hook；决策门控后生成 Action，发送前复核配置、结果和目标 |
| `apps/runtime/src/settings/` | 加密配置存储、系统主密钥适配器、同源设置与测试 API |
| `apps/runtime/src/runtime.ts` | 组装单个 Channel、调度会话、执行 Hook 和输出检查、管理停止与回滚 |
| `apps/runtime/src/context.ts` | 会话键、去重键和有限短期上下文管理 |
| `apps/runtime/src/operations.ts` | 可取消操作与超时清理 |
| `apps/runtime/src/channels/mock-channel.ts` | Mock 输入归一化、内存输出和可注入输出 Sink |
| `apps/runtime/src/demo-hooks.ts` | 独立的演示回声行为和 Mock 输出授权规则 |
| `apps/runtime/src/index.ts` | Bun 宿主入口、演示输入、JSONL stdin/stdout 和进程信号处理 |
| `apps/runtime/src/qq/` | 官方 QQ SDK 封装、事件与被动回复关联、凭据读取及固定指令测试 Hook |
| `apps/runtime/src/qq.ts`、`qq-login.ts` | QQ 常驻宿主与独立扫码配置入口 |

`core` 不导入 Bun、Node 或平台 SDK；类型检查显式不注入 Bun 环境类型。内部 workspace 以源码连接，Runtime 构建时打包依赖；这不确定未来外部插件的产物格式。

## 协议与输入边界

- `RuntimeEvent` 包含原始事件 ID、`origin.channelId/accountId`、时间、参与者、会话和类型明确的内容。可选 `conversationType` 为 `direct/group/channel`，缺省表示未分类。`directedToCharacter` 保留平台明确寻址信息，QQ 私聊和 `GROUP_AT_MESSAGE_CREATE` 为 true，普通群消息为 false；该字段不再作为群聊调用门槛。旧事件省略该字段仍兼容。
- 文本沿用 `content: {type: "text", text}`；图片或图文使用 `{type: "message", text, images}`，每条含 1–10 个图片附件。附件只含可序列化的 HTTPS URL、媒体类型及可选文件名，不泄露 SDK 类型。文本最多 16384 字符，图片地址最多 4096 字符，文件名最多 256 字符。
- 这是内部 0.0.0 协议的联合类型扩展：旧文本输入兼容，消费者读取图片前需按 `content.type` 缩窄。Action 输出仍仅支持文本，不能把图片事件当作图片发送能力。运行时校验、日志反序列化与前端响应校验均处理新联合类型。
- 接收时间字符串必须包含时区，进入领域层后统一转为 UTC ISO 格式。标识符长度为 1–256，文本最多 16384 个 UTF-16 字符。
- `MockChannel.receive(unknown)` 接收 `id`、`actorId`、`conversationId`、`text` 和可选 `timestamp`，归一化后交给 Runtime。未提供时间时使用当前时间。
- Runtime 再次验证事件及来源，防止 Channel 冒用未注册的身份。输入在校验后复制并冻结，不把可变原始对象放入上下文。
- `handle` 返回 `ActionProposal`，当前只支持 `message.send`。Runtime 校验提案、确认目标 Channel 已注册，并分配与事件相关联的 `SendAction.id/eventId`。
- 当前一个 Runtime 实例管理一个 Channel 和账号；多个会话可以并发处理。跨渠道路由和多角色调度尚未实现。
- `Model.generate` 接收可序列化的 system/user/assistant 消息、可选图片字节编码与输出上限，接受取消信号；返回文本、实际模型、结束原因、耗时和服务端提供的用量。Model 类型在 core 定义一次，日志复用它；HTTP、Authorization、供应商字段和系统凭据 API 只存在于 Runtime 适配层。

## 处理阶段与 Hook

```text
Mock 输入 → 校验归一化 → 来源检查 → 去重 → 按会话排队
→ 追加短期上下文 → onEvent → beforeHandle → handle
→ 校验 Action 提案 → beforeSend → Channel.send → afterSend
                         处理异常 → onError → 向输入方传播失败
```

| Hook | 返回值与语义 |
| --- | --- |
| `onEvent` | 观察已去重事件，收到包含当前事件的只读上下文快照 |
| `beforeHandle` | `observe` 停止响应阶段；`continue` 或无返回值继续处理 |
| `handle` | 返回 Action 提案数组；无返回值不提出动作。多个 Hook 的提案按注册顺序合并 |
| `beforeSend` | 至少一个 `allow` 且没有 `deny` 才能发送；`deny` 立即否决，无返回值不代表授权 |
| `afterSend` | 观察已成功发送的 Action；发生错误时不会回滚已经执行的输出 |
| `onError` | 获得失败阶段、原始异常及确认发送计数；观察 Hook 自身失败也会保留在错误链中 |

- 通过 `runtime.use(hooks)` 注册一组 Hook，返回可重复调用的注销函数。
- 每个事件开始处理时取得 Hook 快照；注册和注销对后续开始处理的事件生效。
- 同阶段按注册顺序等待每个 Hook。抑制响应仍保留短期观察；没有处理 Hook 时默认只观察。
- 演示回声由独立 Hook 提供，Channel 内没有回复逻辑。演示授权仅允许向当前 Mock 会话输出。
- `beforeSend` 是当前真实执行的默认拒绝检查入口。它不是安全沙箱或持久审批系统；真实平台的完整策略和审批尚未接入。
- Hook 是受信的进程内代码，必须遵守只读契约并响应 `AbortSignal`。不得宣称可以通过超时强行终止不合作的代码或撤销已发生的外部副作用。

## 有序性、容量与错误语义

- 去重键包含渠道、账号、会话和原始事件 ID。默认保留最近 1000 个键；处理中与排队中的键独立保护，不因缓存淘汰失去去重能力。
- 去重和上下文都只在内存中。去重窗口以外或进程重启后的输入可能再次处理，不提供端到端恰好一次保证。
- 同一会话串行，失败事件不会使队列永久失败；独立会话可并行。默认最多接受 256 个待完成事件，超出容量直接拒绝，未接收的事件不记为已处理。
- 短期上下文默认每个会话 20 个事件、最多 100 个最近使用的会话，每个事件按本地观察时间保留 5 分钟。过期数据在下一次追加时清理，不启动背景清理计时器；停止时全部清空。
- Mock 输出缓存默认只保留最近 100 条，实际输出也可交给注入的 Sink。
- 一个活动事件默认有 5 秒处理期限；QQ 宿主显式设为 90 秒，覆盖图片下载、决策、响应与 QQ 发送。生命周期操作和错误 Hook 同样有界。期限或停止信号会中断 Runtime 的等待，后续发送不会继续。
- 不自动重试处理或发送。失败事件在去重窗口内仍被记住，避免发送状态不确定时重复输出。
- `PipelineError` 包含阶段、事件 ID、已确认发送数与原始原因。`afterSend` 失败时已确认发送数仍保留；`send` 失败可能存在未确认副作用，不能由计数推断没有发送。

## 生命周期与资源所有权

- `Runtime.start()` 执行 Channel 的 `setup(context)`、`start()`；启动期间提交的事件先排队，启动成功后才处理。Channel 的启动过程不能等待这些事件处理完成，否则将形成互相等待。
- `setup` 返回清理函数后，资源所有权交给 Runtime。若 `setup` 自身失败，它必须回滚尚未移交的资源；Runtime 不停止自己尚未取得所有权的 Channel。
- `stop()` 先拒绝新输入、取消正在处理和排队中的工作，再调用 Channel `stop` 和 setup 清理函数，最后清除 Hook、上下文与去重状态。
- 初始化失败也执行已取得资源的清理；某一步清理失败仍尝试其余步骤，并聚合上报错误。
- 重复调用 `stop()` 共享同一停止结果。实例停止后不可重新启动，需要创建新 Runtime。
- Channel 应在 setup context 的生命周期信号取消时停止异步初始化，不得在超时后继续创建未移交的资源。
- CLI 处理 SIGINT、SIGTERM 和 stdin EOF，关闭输入并等待 Runtime 清理，不遗留自己的监听器和计时器。

## 验证边界

日志属于独立观察读模型：`onEvent` 在规则门控前写入，一条已归一化消息对应一条记录；SQLite 的持久唯一键覆盖渠道、账号、会话与事件 ID。该唯一键只防止保留窗口内的日志重复，不能替代 Runtime 的动作幂等性。日志文件恢复不等于 M2 的角色状态或 Execution 恢复。SQL 与 Bun SQLite 只存在于宿主适配层，核心可不加载日志服务独立运行。

本机日志服务只绑定 IPv4 回环地址，检查 Host、Origin 与 Fetch Metadata，不启用跨域访问。静态文件只允许构建的首页和 JS/CSS 资源，不能访问 `.hina`。图片从已保存事件索引查找，按需读取有限的 QQ 图片域名，不接受客户端提供的任意 URL，不跟随重定向；超时、大小、并发与格式均有界，停止宿主时取消请求。

`MessageLogStore.subscribe` 观察已提交的新记录和处理状态变更，日志服务将其转换为 SSE 变更通知；通知不携带正文、ID 或凭据。客户端自动更新最新列表，历史分页保留快照；暂停、隐藏、取消和宿主停止时清理连接、订阅与心跳。SSE 失败时自动以有超时的查询维持每秒更新。`contentType=media` 合并筛选图片和图文，原有 `text/image/mixed` 查询保持兼容。

日志 Schema v2 在事务中为 v1 增加可空 `processing_json` 和默认 0 的 `processing_version`，保留旧记录，旧条目没有处理状态即表示已接收。处理状态记录门控、生成、发送、拒绝和失败，响应只存归一化结果，不保存请求头或原始错误体。状态版本用于避免详情查询覆盖新状态。宿主取得监听端口后将上次遗留的未完成状态标为中断或发送未确认，不恢复、重试或重放 Action。这是观察数据迁移，不是 Execution 持久化。

## 模型配置与输出边界

模型设置通过 `/settings` 提交到本机 API。Token 和配置一起使用 AES-256-GCM 加密；随机主密钥由宿主 `Bun.secrets` 适配器保存在系统凭据库，文件仅保存密文和密钥引用。读取失败保持接收并关闭模型处理，不退回明文存储。前端只收到公开配置、`hasToken` 和版本，不接收密文、Token 或 Token 后缀。更换 API 地址必须重新提供 Token，防止旧凭据被默默发送到新地址；写入有版本检查和原子替换。关键取舍见 [ADR 0001](./adr/0001-llm-secrets-and-model-boundary.md)。

设置 API 的写请求同时检查回环 Host、Origin、Fetch Metadata、JSON Content-Type 与宿主随机 CSRF nonce；不启用跨域访问或远程管理。连接测试只调用固定短提示，不保存配置、不开启回复、不发送 QQ 消息。模型回复开关默认关闭；开启后仅共享本配置生效后允许处理的消息，清除或更改配置会取消在途模型调用并清空该共享窗口。

模型 Hook 按范围、输入长度、图片数量和预算进行规则门控，最多 2 个并发处理轮次、每分钟 30 轮尝试；一轮最多一次决策和一次响应。配置了决策模型时先用 `Decision.evaluate` 返回类型明确的概率或拒绝，概率严格大于配置阈值才调用 Model。未配置时明确记录跳过并直达响应；已配置但失败、拒绝或未过阈值时不降级生成。低分事件仍可留在同配置的短期上下文。

`Decision`、`DecisionResult` 及实际用量校验在 core 定义，平台和 HTTP 字段不进入核心。响应请求通过 `/responses`、`store:false`、显式输入历史和 `max_output_tokens` 执行，不保留供应商会话 ID；决策通过 `/decisions` 的命名 predicate 读取概率，不伪造自然语言理由。两者共用已保存的 API/Token，可独立配置模型 ID。详情与列表记录决策结果、阈值、拒绝/失败类别及实际指标；日志 Schema v2 无需增加列，旧条目没有决策字段显示未知，新状态消费者需同步升级。

旧加密配置读取时保留原 Token、主密钥及版本，将 Chat Completions 地址归一化到 Responses，原群聊范围迁移为私聊及群聊，决策默认留空。模型回复范围不再按 @ 筛选；QQ 平台若未推送全量群事件，本地无法补录。仅当用户保存时用原加密机制写入新字段，不重新索取 Token；新格式不承诺旧二进制可读取。

Model 仅生成文本，Runtime 为其创建 Action 并在 `beforeSend` 复核配置版本、开关、决策通过状态、账号、当前会话及内容；Channel 不调用模型。失败不自动重试，发送不确定时保留响应并标记未确认。本地取消无法撤回已提交给 QQ 的发送。协议与失败策略见 [ADR 0002](./adr/0002-optional-decision-and-responses.md)。

`bun run test` 覆盖协议、Hook、有界上下文、去重、会话调度、授权否决、错误与清理。`bun run smoke` 先构建，再用实际构建产物验证 JSONL、演示模式和错误退出。

Mock 烟测和 QQ 本地协议测试不代表真实 QQ 消息收发、模型调用、插件分发、持久化恢复或桌面安装验收。真实 QQ 验收需另行记录连接与测试消息证据。
