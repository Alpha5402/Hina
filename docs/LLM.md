# 模型设置与 QQ 回复

响应模型使用 **Responses API**；可选决策模型使用 **Decisions API**。共用已有 API 地址和 Secret Token，生成结果继续通过 Runtime Action/Policy 到达 QQ。未配置决策时跳过该步骤；已配置的决策失败、拒绝或未过阈值时不调用响应模型。

## 配置

1. 构建页面并运行 `bun run qq`，打开 [设置页](http://127.0.0.1:3410/settings)。不要同时运行 `--reply` 固定测试模式。
2. 填写 API 地址、响应模型和 Token。地址可为 Base URL 或完整 Responses 地址，保存时归一化；旧 Chat Completions 地址也会转换到同一前缀下的 Responses 地址。仅允许 HTTPS，回环开发服务可用 HTTP；禁止 URL 内嵌凭据、查询与 fragment。
3. 按需填写决策模型；留空会在新消息日志中明确记录“未配置，跳过决策”。配置时设置回复阈值（0–100%），默认 70%。使用命名 predicate 返回的回复概率，**严格大于**阈值才生成；相等也不回复。初始阈值未经过业务样本校准，可自行调整。
4. “测试响应”发送固定短提示，“测试决策”评估固定示例，不保存配置、不分享用户历史、不发送 QQ。成功后查看实际模型、耗时与用量；决策还显示概率及阈值结果。
5. 开启模型回复，选择仅私聊或私聊及群聊并保存。连接测试不替代保存，保存也不自动开启回复。配置修改取消在途工作，待发送 Action 重新检查版本。
6. 返回日志，新消息与状态自动更新；列表决策列显示概率、跳过、拒绝或失败，详情展示输入、决策、响应、输出四阶段。

当前官方示例：API 地址 `https://api.openai.com/v1`，响应模型 `gpt-6-luna`，决策模型可填 `gpt-6-luna`（[Decisions 官方文档](https://developers.openai.com/api/docs/guides/decisions) 当前只支持此模型）。响应固定使用 `max_output_tokens`；旧 Token 参数选择已移除，不回退到 Chat Completions。第三方服务必须支持相应接口，否则明确失败。

回复范围不按号码、OpenID 或 @ 做名单过滤。接收到的普通群消息会进入相同决策通路，但 QQ 侧必须先开启“接收所有消息”才推送 `GROUP_MESSAGE_CREATE`；本地选择群聊不会获得平台权限。见 [QQ 官方全量消息说明](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)。未推送的消息不会被伪造补录。

## 凭据与迁移

- Token 只在本机页面输入，不发送到聊天、文档或 Git。保存后清空输入；重新打开只显示已设置。API 不返回 Token、后缀或密文，浏览器不将其写入 localStorage。
- `.hina/llm-settings.enc` 使用 AES-256-GCM 加密整个配置，随机主密钥单独通过 `Bun.secrets` 保存在系统凭据库，服务名 `dev.hina.llm`；目录 `0700`、文件 `0600`，均被 Git 与 Biome 忽略。
- 旧加密配置保留 Token、主密钥及版本，响应地址迁移到 Responses，决策默认留空，原“私聊及群内 @”迁移为“私聊及群聊”。本次用户随后在页面保存了决策模型。配置仅在保存时按新字段重写；旧二进制不保证能读新配置。
- 留空 Token 表示保留同一地址的凭据，更换地址必须重新提供。系统凭据库不可用、权限异常、密钥缺失或认证失败时失败关闭，不保存明文或假装已加载。
- 只复制密文不能迁移密钥；系统凭据库也需保有。该方案保护落盘副本，不抵御已控制当前用户、进程或解锁凭据库的攻击者。QQ 平台凭据仍沿用原私有文件格式。
- macOS 系统钥匙串已实测；Linux 需可用 Secret Service，Windows 使用 Credential Manager，跨系统和打包分发尚未验收。

## 调用与输出约束

- 规则先检查开关、范围、输入长度、图片与预算；不回复仍保留消息日志。决策低分事件可进入同配置的短期上下文，配置更换清空共享窗口，不发送此前仅接收的历史记录。
- 同会话使用 Runtime 的 20 条/5 分钟窗口，模型历史文本合计最多 12000 字符；单条超过上限不调用。最多并行处理 2 轮、每分钟 30 轮尝试，一轮最多一次决策和一次响应，不自动重试。
- 每次 API 超时 1–30 秒，响应上限 64–4096 Token，连接测试响应最多 512 Token。QQ 宿主总事件预算 90 秒，QQ 发送最多 10 秒。费用由所选 API 产生，只展示实际用量，不估算价格。
- 图片输入默认关闭；图文会明确告知模型图片未提供，纯图片只记录。启用后当前消息最多 2 张，经 QQ 域名、真实字节签名、8 MiB/张和 10 秒下载限制后传给决策及响应接口；只下载一次，不把 QQ 签名地址传给模型，不重新下载历史图片。
- Decisions 请求发送命名 predicate，严格校验单个匹配答案及 0–1 有限概率，拒绝或畸形结果不会变成默认概率。接口不提供自然语言理由，日志不伪造解释。失败归属到决策阶段。
- Responses 使用 `store:false`、显式有界历史，不使用供应商恢复 ID。聚合多个 message 的文本输出，忽略 reasoning，拒绝工具调用；无文本、拒绝和错误不伪装成功。输出上限截断可保留非空文本并明确标记。
- 发送前复核配置版本、开关、决策通过状态、账号、会话与内容。模型不能自行改目标或发送 QQ。关闭开关不能撤回已经提交给 QQ 的请求。
- 不自动重试发送；结果不确定时标为发送未确认，重启仅标记遗留工作中断，不恢复或重放。不提供恰好一次保证。

## API 与验证

`GET /api/llm/settings` 返回公开配置及 CSRF nonce，`PUT /api/llm/settings` 保存，`POST /api/llm/test` 测试响应，`POST /api/llm/test-decision` 测试决策。写请求要求同源 Origin、JSON Content-Type、nonce 和 `expectedRevision`，最多 32 KiB/5 秒。服务仅绑定 IPv4 回环，禁止跨站写入、任意静态路径和模型重定向，不提供远程或多用户管理。错误只返回白名单类别，不回显远端错误正文、请求头或 Token。

日志复用 SQLite Schema v2 的处理 JSON 列，新增可选决策记录和“deciding”状态，不改动旧消息与条数。旧条目缺少决策字段显示未知；新条目可记录跳过、概率/阈值、拒绝、失败及实际用量。Dashboard 与 Runtime 需一起升级。

相关验证入口：

```sh
bun run test apps/runtime/test/model-pipeline.test.ts apps/runtime/test/llm-settings.test.ts apps/runtime/test/message-logs.test.ts apps/runtime/test/qq-protocol.test.ts
bun run check
bun run build
bun run smoke
```

2026-11-03 已通过 35 项相关回归及 65 项全量回归，包括严格阈值、缺省直通、失败关闭、取消、低分上下文、旧配置迁移、日志中断与真实官方 SDK 的普通群消息协议；格式/Lint/各 workspace 类型、构建和 Mock 构建产物 Smoke Test 通过。

真实验证：沿用已加密凭据，Decision 测试返回 99%（1122 ms、274 Token），Responses 测试返回 OK（1327 ms、28 Token）。用户随后发私聊，决策返回 100%（1012 ms、305 Token），超过 70% 后调用响应（1366 ms、57 Token），QQ 确认发送；日志保留两次调用的独立指标。上述耗时为各 API 调用，不是端到端延迟。

全量群消息联调：初次未 @ 消息没有入站，官方群状态返回接收模式空值，控制台服务范围、群权限、高级和开发设置未找到可核实的全量入口。用户随后调整 QQ 侧设置后，普通群消息进入第 8、9 条记录，分别为 40% 和 37%，均未超过 70%，没有调用响应；第 10 条未 @ 消息获得 84%，通过后生成并由 QQ 确认发送。记录从 7 条增加到 10 条，证明该群实际全量入站及两种门控结果；具体开关路径未由本次操作核实，不能把公开文档中的功能条件写成通用入口。

真实图片模型输入、长期运行、跨系统凭据库及桌面分发未验收。模型协议与失败取舍见 [ADR 0002](./adr/0002-optional-decision-and-responses.md)。
