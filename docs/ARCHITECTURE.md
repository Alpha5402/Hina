# Hina 架构与当前实现

开发纪律和产品方向以根目录 `AGENTS.md` 为基线。本文区分本轮已经实现的协议与后续里程碑，不把 Hook 当作已完成的 Decision、模型服务或插件隔离系统。

## 当前范围

本轮实现 M0 的 Mock Channel 输入输出子集：文本事件归一化、输入去重、有限短期上下文、可注销 Hook、统一输出检查、Channel 生命周期，以及源码和构建产物的运行路径。

本轮不实现 Decision、Model、持久角色、长期记忆、可恢复 Execution、持久审批、动态插件加载或真实平台接入。因此这不是原版 M0 全部验收项完成的声明。`plugin-sdk` 等尚无实际职责的包保持未创建。

## 模块职责

| 位置 | 当前职责 |
| --- | --- |
| `packages/core` | 单一来源的 Event、Action、Channel 与 Hook 契约，以及外部输入校验；只使用 TypeScript 标准库和标准 Web 类型 |
| `apps/runtime/src/runtime.ts` | 组装单个 Channel、调度会话、执行 Hook 和输出检查、管理停止与回滚 |
| `apps/runtime/src/context.ts` | 会话键、去重键和有限短期上下文管理 |
| `apps/runtime/src/operations.ts` | 可取消操作与超时清理 |
| `apps/runtime/src/channels/mock-channel.ts` | Mock 输入归一化、内存输出和可注入输出 Sink |
| `apps/runtime/src/demo-hooks.ts` | 独立的演示回声行为和 Mock 输出授权规则 |
| `apps/runtime/src/index.ts` | Bun 宿主入口、演示输入、JSONL stdin/stdout 和进程信号处理 |

`core` 不导入 Bun、Node 或平台 SDK；类型检查显式不注入 Bun 环境类型。内部 workspace 以源码连接，Runtime 构建时打包依赖；这不确定未来外部插件的产物格式。

## 协议与输入边界

- `RuntimeEvent` 包含原始事件 ID、`origin.channelId/accountId`、时间、参与者、会话和类型明确的文本内容。
- 接收时间字符串必须包含时区，进入领域层后统一转为 UTC ISO 格式。标识符长度为 1–256，文本最多 16384 个 UTF-16 字符。
- `MockChannel.receive(unknown)` 接收 `id`、`actorId`、`conversationId`、`text` 和可选 `timestamp`，归一化后交给 Runtime。未提供时间时使用当前时间。
- Runtime 再次验证事件及来源，防止 Channel 冒用未注册的身份。输入在校验后复制并冻结，不把可变原始对象放入上下文。
- `handle` 返回 `ActionProposal`，当前只支持 `message.send`。Runtime 校验提案、确认目标 Channel 已注册，并分配与事件相关联的 `SendAction.id/eventId`。
- 当前一个 Runtime 实例管理一个 Channel 和账号；多个会话可以并发处理。跨渠道路由和多角色调度尚未实现。

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
- 一个活动事件默认有 5 秒处理期限；生命周期操作和错误 Hook 同样有界。期限或停止信号会中断 Runtime 的等待，后续发送不会继续。
- 不自动重试处理或发送。失败事件在去重窗口内仍被记住，避免发送状态不确定时重复输出。
- `PipelineError` 包含阶段、事件 ID、已确认发送数与原始原因。`afterSend` 失败时已确认发送数仍保留；`send` 失败可能存在未确认副作用，不能由计数推断没有发送。

## 生命周期与资源所有权

- `Runtime.start()` 执行 Channel 的 `setup(context)`、`start()`；成功后才接受输入。Channel 必须等待启动完成后再提交事件。
- `setup` 返回清理函数后，资源所有权交给 Runtime。若 `setup` 自身失败，它必须回滚尚未移交的资源；Runtime 不停止自己尚未取得所有权的 Channel。
- `stop()` 先拒绝新输入、取消正在处理和排队中的工作，再调用 Channel `stop` 和 setup 清理函数，最后清除 Hook、上下文与去重状态。
- 初始化失败也执行已取得资源的清理；某一步清理失败仍尝试其余步骤，并聚合上报错误。
- 重复调用 `stop()` 共享同一停止结果。实例停止后不可重新启动，需要创建新 Runtime。
- Channel 应在 setup context 的生命周期信号取消时停止异步初始化，不得在超时后继续创建未移交的资源。
- CLI 处理 SIGINT、SIGTERM 和 stdin EOF，关闭输入并等待 Runtime 清理，不遗留自己的监听器和计时器。

## 验证边界

`bun run test` 覆盖协议、Hook、有界上下文、去重、会话调度、授权否决、错误与清理。`bun run smoke` 先构建，再用实际构建产物验证 JSONL、演示模式和错误退出。

本轮验证不代表真实 QQ、模型调用、插件分发、持久化恢复或桌面安装验收。
