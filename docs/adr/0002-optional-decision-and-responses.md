# ADR 0002：可选决策与 Responses 通路

状态：已采用。日期：2026-11-03。替代 ADR 0001 中的 Chat Completions 协议选择，保留其凭据存储与副作用边界。

## 选择与原因

将响应模型与决策模型分开配置，共用现有加密 API/Token。决策模型留空时走明确的规则直通路径；配置后优先调用 OpenAI `/decisions`，用命名 predicate 返回的“值得回复”概率与阈值严格比较（`probability > threshold`），通过才调用 `/responses`。阈值默认 0.7，是可调整的初始设置，不代表经过真实数据校准。

Decision 返回概率或拒绝，通用领域契约位于 core，HTTP 与供应商 Schema 留在 Runtime。决策失败、坏响应、拒绝和低分均阻止生成，不通过 Chat Completions 或响应模型评分作静默降级。不要求模型生成解释文本；日志保存真实概率、当时阈值、结果、耗时及实际用量。

响应请求显式设置 `store:false`，自行传入有界历史，不使用供应商会话或恢复 ID。响应文本可来自多个 output message，忽略 reasoning 内容，拒绝工具调用；未返回文本时不伪造成功。配置修改取消在途决策/响应，发送前再次核对版本、结果和目标，所有输出继续通过 Action/Policy。

## 兼容与边界

已发布的加密配置保留密钥与 Token，通过已知旧字段迁移地址及群聊范围，新决策字段默认未配置；不允许缺失未知字段的损坏配置静默降级。日志复用 v2 JSON 列增加可选决策记录及处理中状态，旧条目仍可读取，Dashboard 与 Runtime 必须一起升级。新配置不保证旧二进制可回读。

QQ 群消息不再以 @ 作为本地门槛；SDK 处理普通群事件已通过协议测试。实际全量入站还依赖 QQ 平台“接收所有消息”，本地不能授权、补录或捏造平台未推送的记录。用户已取消号码/OpenID 白名单要求，本增量不实现该名单。

## 验证

回归覆盖缺省直通、严格阈值（含相等）、拒绝、坏响应、失败关闭、配置切换取消、低分上下文保留、旧加密配置迁移、日志重开/中断及官方 SDK 普通群事件。真实 Decision 与 Responses 连接测试通过，真实私聊完成决策、响应和 QQ 确认发送。用户调整 QQ 侧设置后，未 @ 群消息实际入站：低分保留不回复，84% > 70% 的消息生成并发送；与 SDK 协议测试分开记录。

参考：[Decisions](https://developers.openai.com/api/docs/guides/decisions)、[Text generation](https://developers.openai.com/api/docs/guides/text)、[QQ 全量群事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)。
