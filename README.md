# Hina

轻量、可扩展、跨平台的持久数字角色运行时。开发前阅读 [AGENTS.md](./AGENTS.md)。

当前实现 M0 的 Mock Channel 输入输出子集：事件归一化、去重、短期上下文、按会话排序、可注销 Hook 和生命周期清理。默认 Mock 回声演示独立运行，不调用 Decision、模型或真实平台，也不代表原版 M0 的全部验收项已完成。协议与阶段语义见 [架构文档](./docs/ARCHITECTURE.md)。

QQ 官方机器人适配器支持文本、图片和图文输入，提供本机消息日志与双模型设置。开启回复后，“输入 → 可选 Decision API → 概率阈值 → Responses API → Action 检查 → QQ 被动回复”；决策模型留空则跳过决策。私聊和群聊可配置，群聊不以 @ 为本地门控条件；未 @ 事件仍需 QQ 平台开启全量接收。配置方法见 [模型设置](./docs/LLM.md)，平台与日志边界见 [QQ Bot 接入](./docs/QQ_BOT.md) 和 [消息日志](./docs/MESSAGE_LOG.md)。

## 开发环境

- Bun：`1.4.4`，版本记录在 `.bun-version` 和 `package.json`。
- TypeScript：`7.0.2`；Biome：`2.6.4`。开发依赖使用明确版本，由 `bun.lock` 锁定。
- 前端使用 Vue `3.5.44`、Vite `8.3.5`、Vue 插件 `6.0.10`、`vue-tsc 3.3.14`；前端包单独固定 TypeScript `6.0.3`，供 Vue 工具使用 JavaScript 编译器 API，核心与宿主继续使用 TypeScript 7。格式化统一使用 Biome，启用 Vue/HTML 支持。
- Mock 运行无需凭据、数据库、Docker 或外部服务。QQ 模式额外使用已固定版本的腾讯官方 SDK、扫码连接库与二维码生成库，并需要 QQ 账号持有人授权。

已有对应版本 Bun 时，在项目根目录执行：

```sh
bun install --frozen-lockfile
bun run dev
```

如果本机未安装 Bun，但有 Node.js/npm，可以仅在项目内准备工具链：

```sh
npm install --prefix .tools/bun --no-save --no-package-lock bun@1.4.4
export PATH="$PWD/.tools/bun/node_modules/.bin:$PATH"
bun install --frozen-lockfile
bun run dev
```

`.tools/` 不纳入版本控制，以上 PATH 设置仅作用于当前终端。npm 只用于这个可选的开发工具引导；项目依赖仍由 Bun 管理。这不是未来面向普通用户的桌面安装流程。

## 目录与边界

```text
apps/
  dashboard/            # Vue 3 本机消息日志与模型设置页
  runtime/
    src/index.ts        # 演示与 JSONL CLI 入口
    src/runtime.ts      # 事件通路与生命周期
    src/channels/       # Mock Channel
    src/demo-hooks.ts   # 回声演示，独立于 Channel 和 Runtime
    test/               # 通路、边界与清理测试
    smoke.ts            # 构建产物烟测
    package.json
    tsconfig.json
packages/
  core/                 # 平台无关的公共协议与校验
  logs/                 # 前后端共享的日志查询与响应契约
  settings/             # 可序列化模型设置与运行时校验，不包含密钥存储
docs/
  ARCHITECTURE.md
AGENTS.md
biome.json
bun.lock
package.json
tsconfig.base.json
```

当前有 `@hina/core`、`@hina/logs`、`@hina/settings`、`@hina/runtime` 与 `@hina/dashboard` 五个 workspace。`plugin-sdk`、外部插件及桌面宿主尚未创建。

共享 TypeScript 配置不自动注入宿主类型；Bun 类型仅在 Runtime 的配置和开发依赖中启用，供后续核心包保持宿主无关。当前 Runtime 构建产物不代表已确定外部插件的分发格式。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `bun run dev` | 执行 Mock 演示并监听文件变更，按 Ctrl+C 停止 |
| `bun run start` | 从源码执行一次 Mock 演示并退出 |
| `bun run qq:login` | 手机 QQ 扫码配置，凭据只保存在被忽略的私有目录 |
| `bun run qq` | 启动 QQ 与本机日志/设置服务，模型回复依照已保存开关，首次默认关闭 |
| `bun run dashboard:build` | 构建日志页面，供 QQ 宿主在 3410 端口提供访问 |
| `bun run dashboard:dev` | 启动前端热更新，5173 端口代理本机 QQ 日志 API |
| `bun run qq --reply` | 启动 QQ 并仅对 `/ping` 返回固定测试文本 |
| `bun run build` | 构建现有 workspace，Runtime 产物为 `apps/runtime/dist/index.js` |
| `bun run typecheck` | 对现有 workspace 执行严格类型检查 |
| `bun run lint` | 检查 TypeScript、JSON、Vue、HTML 与 CSS 的静态规则 |
| `bun run format:check` | 检查上述源码格式，不改写文件 |
| `bun run format` | 格式化上述源码 |
| `bun run check` | 依次执行格式、Lint 和类型检查 |
| `bun run test` | 运行当前事件通路、Hook 与清理测试，支持路径过滤 |
| `bun run smoke` | 构建后用真实子进程验证 JSONL 输入输出、去重和错误退出 |

格式与 Lint 不处理生成产物、依赖或项目内工具链；Markdown 等文本遵循 `.editorconfig` 和项目文档约定。包级类型检查可使用：

```sh
bun run --filter @hina/runtime typecheck
```

## Mock 输入输出与 Hook

默认演示输入四个事件，产生两条回声输出：一条事件被 `/observe` 规则保留为观察，另一条重复输入被去重。输出 Action 使用 JSON 写入 stdout，演示统计和错误说明写入 stderr。

交互或管道模式接收一行一个 JSON 对象：

```sh
bun run start --stdin
```

```json
{"id":"message-1","actorId":"tester","conversationId":"room-1","text":"你好，Hina"}
```

输入 `/observe` 文本只观察，不回复；重复 ID 在相同渠道、账号和会话的去重窗口内不重复输出。`timestamp` 可选，提供时必须包含时区。不提供时间时由 Mock Channel 生成。stdin EOF 或 Ctrl+C 会停止并清理 Runtime；输入失败会报告通用错误并最终以非零状态退出，错误日志不回显原始输入。

扩展通过类型明确的 Hook 注册，无需把处理逻辑写入 Channel：

```ts
const unregister = runtime.use({
  beforeHandle: ({ event }) => event.content.text === "/observe" ? "observe" : "continue",
  handle: ({ event }) => [{
    type: "message.send",
    target: { ...event.origin, conversationId: event.conversationId },
    content: { type: "text", text: `收到：${event.content.text}` },
  }],
  beforeSend: ({ action, event }) =>
    action.target.channelId === event.origin.channelId &&
    action.target.accountId === event.origin.accountId &&
    action.target.conversationId === event.conversationId ? "allow" : "deny",
});
// 不再需要时调用；注销对后续开始处理的事件生效。
unregister();
```

`onEvent`、`beforeHandle`、`handle`、`beforeSend`、`afterSend` 和 `onError` 都按注册顺序执行。没有明确的 `beforeSend: allow` 或有任意 `deny` 时不发送。Hook 的时间预算、失败和生命周期约束见架构文档。

## 当前阶段验收

当前增量的验证入口：

```sh
bun run check
bun run test apps/runtime/test
bun run smoke
```

执行上下文、Runtime 去重和输出缓存均有界且只在内存中。默认上下文为每会话 20 条、最多 100 个会话、5 分钟保留期，去重保留最近 1000 个键。消息日志单独持久化最近 10000 条记录、决策概率、阈值与响应结果；它不会恢复运行上下文、Execution、审批或回复关联，也不会重放消息。LLM 设置通过 AES-256-GCM 加密保存在本机，主密钥存入系统凭据库，前端不回填 Token。当前没有持久审批或桌面打包；本地测试与真实平台验收分别记录。

完整 M0 的验收范围和后续里程碑见 `AGENTS.md`。构建产物、依赖、工具链、环境文件及本地数据库文件由 `.gitignore` 排除。
