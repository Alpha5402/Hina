# QQ Bot 接入

本实现连接 QQ 官方机器人平台，使用 `@tencent-connect/qqbot-nodejs@1.0.5` 管理 Token、WebSocket、心跳、会话恢复和有限重连，不使用个人 QQ 登录协议或 OneBot 网关。协议参考 [官方 SDK](https://github.com/tencent-connect/qqbot-nodejs) 与 [使用指南](https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md)。

## 当前能力

- C2C 私聊、群聊及群聊 @机器人消息的文本、图片和图文归一化到现有 Runtime；纯图片不会因空文本而被丢弃。
- 保留消息 ID、来源账号、参与者、时间和会话，沿用现有去重、短期上下文与 Hook。
- 只对仍在本地关联窗口内的入站消息进行被动回复，不退化为主动推送；不同会话与账号不能混用回复关联。
- 首次默认只接收；设置页保存模型连接并显式启用回复后，允许的消息通过模型与 Runtime Action/Policy 到达 QQ。开关状态持久保存，重启继续依照该配置，不重放历史消息。
- 显式开启 `--reply` 后，仅对 `/ping` 返回固定文本 `Hina QQ Bot 已连接。`；此模式与模型回复互斥，设置页不能同时开启模型回复。
- 支持扫码配置或环境变量、本机逐条消息日志、图片预览与可选图片模型输入。尚无 Decision、图片发送、语音/视频/文件接入、频道消息或主动推送。

控制台中机器人的服务范围、好友/群聊权限与成员资格仍由 QQ 平台决定。程序不会自动扩大服务范围，也不会查看或重置控制台 AppSecret。

## 扫码连接

在项目根目录运行，开发环境使用 `.bun-version` 指定的 Bun：

```sh
bun run qq:login
```

如果需要防止选错机器人，可指定控制台提供的 AppID：

```sh
bun run qq:login --app-id YOUR_APP_ID
```

使用手机 QQ 扫描 `.hina/qq-login.png`，在 QQ 的确认页面核对机器人并授权。二维码由 [腾讯官方扫码连接库](https://www.npmjs.com/package/@tencent-connect/qqbot-connector) 产生，绑定结果只保存 `appId` 与 `appSecret`，不保存扫码用户的 OpenID，不打印凭据。

- `.hina/` 已加入 Git 忽略规则；目录权限为 `0700`，凭据 `.hina/qqbot.json` 为 `0600`。
- 登录过程最多等待 10 分钟，支持 SIGINT/SIGTERM 取消，结束后删除二维码图片。
- 已有凭据时拒绝重复绑定和覆盖。需要变更时，先由操作者核对并处理现有配置。
- 控制台提示 AppSecret 再次查看会强制重置时，不要为了复制参数反复查看；扫码授权和可能出现的安全确认应由账号持有人完成。

## 使用已有凭据

把根目录 `.env.example` 复制为本地 `.env.local`，仅在本机填写：

```dotenv
QQBOT_APP_ID=YOUR_APP_ID
QQBOT_APP_SECRET=YOUR_APP_SECRET
```

真实凭据不能写进 `.env.example`、README、代码、聊天记录或 Git。环境变量优先，但必须同时提供 AppID 和 AppSecret，不会把半套环境变量与凭据文件混用。

## 启动与联调

```sh
# 启动；首次只接收，之后遵照设置页的回复开关
bun run dashboard:build
bun run qq

# 明确启用 /ping 固定回复测试
bun run qq --reply
```

看到网关 READY 只证明认证与连接就绪。还需由有权限的测试账号给机器人发送文本，确认日志中的接收计数增加；启用 `--reply` 时，发送 `/ping` 验证被动回复。群聊须按平台权限添加机器人，必要时 @机器人后发送 `/ping`。

模型接入见 [模型设置](./LLM.md)。默认范围仅私聊；只有选择“私聊及群内 @”才处理平台确认的群内 @ 消息，不依据正文猜测。图片输入另有开关，需模型支持视觉。

终端默认只输出连接阶段、问题类别和计数，不包含消息正文、用户/群 OpenID、AppSecret 或 Token。按用户要求，本机日志页会展示正文、来源标识和模型响应，并保存在私有 SQLite 文件；详见 [消息日志](./MESSAGE_LOG.md)。Ctrl+C 会停止 Runtime、网关、日志服务、在途模型/图片请求、心跳、Token 刷新及注册的监听。

## 实现边界

- QQ SDK 与原生 `ReplyTarget` 均封装在 `apps/runtime/src/qq/`，`packages/core` 不导入 QQ 类型。
- `QQBot.start()` 是连接存活期间的任务；Channel 仅等待 READY 完成启动，连接的后续失败通过 `closed` 通知宿主。
- Runtime 允许 Channel 在启动期间提交事件，先排队，等启动成功再处理；启动失败则不处理这些事件。这是通用生命周期修正，不包含 QQ 业务判断。
- QQ 入口使用 60 秒生命周期/事件预算，模型请求可设置 1–30 秒，QQ 发送最多 10 秒；SDK 最多尝试 3 次重连。不会无限重连或无限重试发送。
- SDK 1.0.5 的高层 `sendText` 没有 AbortSignal 参数；本适配器复用 SDK Token 管理，按相同 REST 协议执行文本 POST，并将事件取消、连接取消和 10 秒超时传给实际 fetch。
- 每条回复必须带入站 `msg_id`，`msg_seq` 在该消息关联内递增。失败不自动重试；已到达 QQ 服务端的请求不能通过本地取消撤回。
- 回复关联默认最多 1000 条、保留 5 分钟，停止时清空。进程重启不恢复上下文或消息关联。
- 当前使用官方 SDK 的 WebSocket 路径；如果 QQ 对此机器人拒绝连接，应按真实错误和平台配置处理，不自动开放公网端口或降级成未配置的 Webhook。

## 验证

```sh
bun run check
bun run test apps/runtime/test/qq-channel.test.ts apps/runtime/test/qq-config.test.ts
bun run test apps/runtime/test/qq-protocol.test.ts
bun run smoke
```

本地协议测试运行真正的官方 SDK，连接临时 HTTP/WebSocket 服务，验证 Token、IDENTIFY、READY、C2C/群聊事件、去重、被动回复请求及取消。它不使用真实 QQ 凭据，也不能替代真实平台的消息收发验收。

## 真实联调记录（2026-11-03）

- 账号持有人通过手机 QQ 扫码确认了目标机器人，连接凭据成功保存到本机私有文件，权限为 `0600`，不纳入 Git。
- 实际运行 `bun run qq`，收到 QQ 网关 READY，程序进入仅接收模式。
- 原控制台的目标机器人显示“在线”。
- 账号持有人从 QQ 发送测试消息后，Runtime 的真实文本事件接收计数增加到 1；日志未记录消息正文或个人标识。
- 本次未启用 `--reply`，没有发送自动回复。真实 QQ 发送链路、群聊场景和长期运行尚未验收。

以上结果证明本次绑定、连接和事件接收成功。当前进程用于临时联调，未配置守护进程、开机启动或长期可用性保障。

随后接入本机日志页并重新连接，在用户确认发送文字与图片后，真实日志新增两条私聊记录，图片在浏览器通过本机代理实际加载成功；仍未启用自动回复。该结果验证图片入站与预览，不代表图片发送或真实群聊验收。详细边界见 [消息日志](./MESSAGE_LOG.md)。

模型接入补充（同日）：用户在本机设置页配置 OpenAI 官方地址、`gpt-6-luna` 与自己的 API Key，使用 `max_completion_tokens` 后连接测试返回 `OK`（约 1424 ms、15 Token）。保存并启用后，一条私聊和一条平台确认的群内 @ 完成模型响应与 QQ 确认发送，分别约 1441 ms / 100 Token、1428 ms / 95 Token；本机日志保留对应输入与输出状态。另一条群内 @ 因回复范围限制被记录但未调用模型；用户随后将范围改为私聊及群内 @。上述耗时仅为模型调用，不是端到端延迟；没有记录正文或凭据到本文。其他群组场景、视觉模型输入、长期运行和桌面交付仍未验收。
