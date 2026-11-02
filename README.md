# Hina

轻量、可扩展、跨平台的持久数字角色运行时。开发前阅读 [AGENTS.md](./AGENTS.md)。

当前实现 M0 的 Mock Channel 输入输出子集：事件归一化、去重、短期上下文、按会话排序、可注销 Hook 和生命周期清理。回声演示行为单独装配，不接入 Decision、模型或真实平台，也不代表原版 M0 的全部验收项已完成。协议与阶段语义见 [架构文档](./docs/ARCHITECTURE.md)。

## 开发环境

- Bun：`1.4.4`，版本记录在 `.bun-version` 和 `package.json`。
- TypeScript：`7.0.2`；Biome：`2.6.4`。开发依赖使用明确版本，由 `bun.lock` 锁定。
- 当前运行时只依赖本地 `@hina/core` workspace，无需凭据、数据库、Docker 或外部服务。

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
docs/
  ARCHITECTURE.md
AGENTS.md
biome.json
bun.lock
package.json
tsconfig.base.json
```

当前有 `@hina/core` 与 `@hina/runtime` 两个 workspace。`plugin-sdk`、外部插件和 UI 包在具有实际职责后再创建。

共享 TypeScript 配置不自动注入宿主类型；Bun 类型仅在 Runtime 的配置和开发依赖中启用，供后续核心包保持宿主无关。当前 Runtime 构建产物不代表已确定外部插件的分发格式。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `bun run dev` | 执行 Mock 演示并监听文件变更，按 Ctrl+C 停止 |
| `bun run start` | 从源码执行一次 Mock 演示并退出 |
| `bun run build` | 构建现有 workspace，Runtime 产物为 `apps/runtime/dist/index.js` |
| `bun run typecheck` | 对现有 workspace 执行严格类型检查 |
| `bun run lint` | 检查 TypeScript 与 JSON 的静态规则 |
| `bun run format:check` | 检查 TypeScript 与 JSON 格式，不改写文件 |
| `bun run format` | 格式化 TypeScript 与 JSON |
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

上下文、去重和输出缓存均有界且只在内存中。默认上下文为每会话 20 条、最多 100 个会话、5 分钟保留期，去重保留最近 1000 个键。进程重启不恢复历史，失败不自动重试。本轮不覆盖 Decision、模型、真实 QQ、持久审批或桌面打包。

完整 M0 的验收范围和后续里程碑见 `AGENTS.md`。构建产物、依赖、工具链、环境文件及本地数据库文件由 `.gitignore` 排除。
