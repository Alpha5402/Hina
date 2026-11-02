# Hina

轻量、可扩展、跨平台的持久数字角色运行时。开发前阅读 [AGENTS.md](./AGENTS.md)。

当前仅完成工程骨架，包含 Bun workspace、严格 TypeScript、Biome 和运行入口。入口只输出启动信息并退出；开发模式保留文件监听。尚未实现领域契约、角色行为、事件管线、插件加载、存储、平台或模型接入，尚未完成 M0。

## 开发环境

- Bun：`1.4.4`，版本记录在 `.bun-version` 和 `package.json`。
- TypeScript：`7.0.2`；Biome：`2.6.4`。开发依赖使用明确版本，由 `bun.lock` 锁定。
- 当前无运行时第三方依赖，无需凭据、数据库、Docker 或外部服务。

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
    src/index.ts        # 仅输出启动信息的 Bun 宿主入口
    package.json
    tsconfig.json
AGENTS.md
biome.json
bun.lock
package.json
tsconfig.base.json
```

当前只有 `@hina/runtime` 一个 workspace。根目录为后续包保留 `packages/*` 匹配规则，但不创建空的 `core`、`plugin-sdk`、插件或 UI 包；实际引入契约和功能时再建立相应模块。

共享 TypeScript 配置不自动注入宿主类型；Bun 类型仅在 Runtime 的配置和开发依赖中启用，供后续核心包保持宿主无关。当前 Runtime 构建产物不代表已确定外部插件的分发格式。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `bun run dev` | 启动 Runtime 入口并监听文件变更，按 Ctrl+C 停止 |
| `bun run start` | 从源码启动一次，输出启动信息后退出 |
| `bun run build` | 构建现有 workspace，Runtime 产物为 `apps/runtime/dist/index.js` |
| `bun run typecheck` | 对现有 workspace 执行严格类型检查 |
| `bun run lint` | 检查 TypeScript 与 JSON 的静态规则 |
| `bun run format:check` | 检查 TypeScript 与 JSON 格式，不改写文件 |
| `bun run format` | 格式化 TypeScript 与 JSON |
| `bun run check` | 依次执行格式、Lint 和类型检查 |
| `bun run test` | 运行 Bun 测试入口；当前允许零测试，不表示已验证业务功能 |
| `bun run smoke` | 构建并运行实际产物，检查构建和启动能否成功退出 |

格式与 Lint 不处理生成产物、依赖或项目内工具链；Markdown 等文本遵循 `.editorconfig` 和项目文档约定。包级类型检查可使用：

```sh
bun run --filter @hina/runtime typecheck
```

## 当前阶段验收

框架初始化的验证入口：

```sh
bun run check
bun run smoke
```

当前不添加业务测试或占位测试。`test` 命令保留真实 Bun 测试入口，新增测试后可通过文件路径过滤；零测试退出不计为功能回归通过。框架烟测仅验证构建产物可执行，不覆盖插件生命周期、事件决策、真实 QQ、模型调用或桌面打包。

完整 M0 的验收范围和后续里程碑见 `AGENTS.md`。构建产物、依赖、工具链、环境文件及本地数据库文件由 `.gitignore` 排除。
