# 模型设置与 QQ 回复

当前支持已有的 OpenAI 兼容 **Chat Completions** 接口。只生成文本回复，通过现有 Runtime Action 和发送前检查到达 QQ；不接入 Decision、工具调用、流式输出或 Responses API。

## 配置

1. 构建页面并运行 `bun run qq`，打开 [设置页](http://127.0.0.1:3410/settings)。不要同时运行 `--reply` 固定测试模式。
2. 填入 API 地址、模型 ID 和自己的 Secret Token。地址可为 Base URL 或完整 `/chat/completions` 地址，保存时会归一化；仅允许 HTTPS，回环开发服务可使用 HTTP，不接受 URL 内嵌凭据、查询或 fragment。
3. 点击“测试连接”。它只发送固定短提示，不保存、不调用 QQ、不分享历史消息。成功后可查看实际模型、响应、耗时与服务端提供的用量。
4. 开启“模型回复”并保存，再发送一条新 QQ 私聊。连接测试不替代保存，保存连接也不自动开启回复。修改配置后在途模型调用会取消，后续 Action 重新检查版本。
5. 返回日志，无需刷新即可看到新消息和处理状态；打开详情查看输入、API 响应及 QQ 发送确认。

本次用户选择的官方连接示例：API 地址 `https://api.openai.com/v1`，模型 `gpt-6-luna`；“请求设置”中选择 `max_completion_tokens`。第三方兼容服务按自身文档选择 `max_tokens` 或 `max_completion_tokens`，宿主只发送所选参数，不盲目重试另一种参数。模型 ID 及能力参考 [官方模型文档](https://developers.openai.com/api/docs/models/gpt-6-luna)，接口参考 [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

Token 只能在本机设置页输入，不发送到聊天、文档、Git 或诊断日志。保存后输入框清空；留空表示保留同一地址的 Token，更换地址必须重新输入。

## 加密存储

- `.hina/llm-settings.enc` 使用 AES-256-GCM，加密 Token 及配置；每次写入随机 IV，格式版本与密钥引用参与认证。原子替换文件，版本检查防止旧表单覆盖新配置。
- 随机主密钥单独放入系统凭据库，服务名为 `dev.hina.llm`，通过 `Bun.secrets` 适配。macOS 使用系统钥匙串，Linux 依赖可用的 libsecret/Secret Service，Windows 使用 Credential Manager；系统可能要求用户授权访问。
- 目录 `0700`、文件 `0600`；Git 和 Biome 忽略私有目录。不把主密钥放在旁边的文件或浏览器存储中。系统凭据库不可用、密钥丢失、权限异常或认证失败时明确报错，继续接收消息，不降级为明文或假成功。
- API 只返回公开字段、`hasToken` 与配置版本，绝不返回 Token、后缀或密文。浏览器只在提交用户刚输入的 Token 时持有它，页面卸载/保存时清空；不写入 localStorage。
- 只复制密文文件不能完成迁移，必须同时保有对应系统凭据。该方案保护落盘副本，不抵御已控制当前用户、Runtime 进程或解锁凭据库的攻击者。旧 QQ 平台凭据仍按原有私有文件机制保存，本次没有修改其存储格式。

## 调用与发送约束

- 首次模型回复关闭；范围默认仅私聊，可显式允许平台确认的群内 @。普通群消息保留日志，不调用模型。
- 只共享配置生效后允许参与的短期消息，排除此前仅接收的历史；同会话最多沿用 Runtime 的 20 条/5 分钟窗口，模型输入文本合计 12000 字符。配置变更或进程停止清空模型共享窗口，不持久化角色记忆。
- 当前消息文本超过 12000 字符不调用模型。最多 2 个并发、每分钟 30 次尝试，失败也占用尝试额度；输出上限 64–4096 Token，超时 1–30 秒。费用由所选 API 产生，不根据 Token 数估算价格。连接测试单独最多 1 个并发，输出上限至多 512 Token。
- 图片输入默认关闭。关闭时图文仅提供文字并明确告知模型图片未提供，纯图片只记录；开启后每条最多 2 张，经现有 QQ 域名白名单、字节签名、大小和超时校验后作为图片数据发送到所选模型接口，不传 QQ 签名地址。历史图片不重新下载。本次真实视觉理解尚未验收。
- Model 只返回提案；发送前复核开关、配置版本、QQ 账号、当前会话和响应内容。模型不得改变目标或直接调用 QQ。关闭开关不能撤回已到达 QQ 的发送。
- 不自动重试模型或消息发送。发送失败/中断且无法确认时保留响应并标记“发送未确认”，重启不恢复或重放。当前不提供恰好一次保证。
- 接口错误仅保留白名单类别：认证、权限、模型、参数、限流、额度、网络、超时及响应格式。未知错误显示通用提示，不保留远端错误正文。`max_tokens` 被拒时提示改用 `max_completion_tokens`；429 的额度耗尽与频率限制分别处理。

## 本机 API 与验证

`GET /api/llm/settings` 提供公开配置与宿主 CSRF nonce，`PUT /api/llm/settings` 保存，`POST /api/llm/test` 测试；写入要求同源 Origin、JSON Content-Type、有效 nonce 和 `expectedRevision`，请求体最多 32 KiB、读取限时 5 秒。服务仅监听 IPv4 回环，拒绝跨站请求、任意静态路径和重定向模型请求；不提供公网或多用户认证。

本地回归：

```sh
bun run test apps/runtime/test/llm-settings.test.ts apps/runtime/test/model-pipeline.test.ts apps/runtime/test/message-logs.test.ts
bun run check
bun run build
bun run smoke
```

2026-11-03 已验证：加密重开、篡改/密钥缺失/权限失败、原子写入、并发版本检查、CSRF、错误脱敏、请求超时与取消、门控/去重/配置变更拦截、模型响应到 Fake QQ 输出、SQLite v1→v2 保留数据；系统凭据库随机临时主密钥读写并删除通过。浏览器隔离服务验证保存后 Token 空值、刷新仍显示“已设置”、无原生 select/checkbox、连接测试、自动入列和三阶段详情，样例与真实数据分离。

真实联调：用户通过本机页面提供自己的凭据，OpenAI `gpt-6-luna` 连接测试返回 `OK`；一条私聊和一条群内 @ 完成模型响应与 QQ 确认发送，范围未放开时的群内 @ 被过滤。详细实际指标见 [QQ 联调记录](./QQ_BOT.md)。其他群组场景、真实图片模型输入、长期运行、跨系统凭据库与桌面分发尚未验收，不能由上述结果推断通过。

收尾检查：25 项设置/模型/日志相关回归、所有 workspace 格式/Lint/类型检查、受影响 Runtime 与 Dashboard 构建、Mock 构建产物 Smoke Test 和 `git diff --check` 通过。提交前另对完整增量执行全量回归，56 项通过、0 失败。实际检查 1280×800 与 900×700、深浅主题、窄窗口滚动及已保存状态；页面无整体横向溢出，保存操作可滚动到达，最终控制台无错误或警告。

使用最新 `apps/runtime/dist/qq.js` 停止并重新启动真实宿主后，系统凭据库成功解锁原配置（版本 3），模型回复开关保留，QQ 在线；日志仍为 6 条、已确认输出仍为 2 条，没有历史重放。密文文件仅含版本、密钥引用、IV、认证标签与密文，权限 `0600`。隔离服务、假凭据临时目录与脚本已清理，真实进程继续运行；未配置后台守护或开机启动。
