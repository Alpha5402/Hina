import type { ConnectionStatus } from "@hina/logs";
import { startLogServer } from "./logs/server";
import { SQLiteMessageLogStore } from "./logs/store";
import { dashboardDirectory, llmSettingsFile, messageLogFile, qqCredentialsFile } from "./paths";
import { ModelPipeline } from "./models/pipeline";
import { SystemSecretKeyStore } from "./settings/key-store";
import { EncryptedSettingsStore } from "./settings/store";
import { QQChannel } from "./qq/channel";
import { loadQQCredentials } from "./qq/config";
import { qqHooks } from "./qq/hooks";
import { Runtime } from "./runtime";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--reply") || args.length > 1) throw new Error("QQ 启动参数无效");
  const credentials = await loadQQCredentials(process.env, qqCredentialsFile);
  const replyEnabled = args.includes("--reply");
  let connection: ConnectionStatus = "connecting";
  const channel = new QQChannel(credentials, {
    onReady: () => {
      connection = "online";
      console.info("QQ 网关连接就绪。");
    },
    onIssue: (issue) => {
      if (issue === "disconnected" || issue === "connection") connection = "connecting";
      console.error(`QQ 通路状态：${issue}；终端不包含消息正文或凭据。`);
    },
  });
  const store = new SQLiteMessageLogStore(messageLogFile);
  const settings = new EncryptedSettingsStore(llmSettingsFile, new SystemSecretKeyStore());
  await settings
    .load()
    .catch(() => console.error("模型配置未能解锁，保持接收；请在设置页检查系统凭据库。"));
  let logServer: ReturnType<typeof startLogServer> | undefined;
  const runtime = new Runtime(channel, { timeoutMs: 60_000 });
  const pipeline = new ModelPipeline(settings, store, credentials.appId);
  const unregister = runtime.use(replyEnabled ? qqHooks(credentials.appId, true) : pipeline.hooks);
  let received = 0;
  let sent = 0;
  runtime.use({
    onEvent: ({ event }) => {
      store.append(event);
      received += 1;
      console.info(`QQ 已接收消息：${received}`);
    },
    afterSend: () => {
      sent += 1;
      console.info(`QQ 已完成被动回复：${sent}`);
    },
  });
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    void runtime.stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    logServer = startLogServer({
      store,
      assetsDirectory: dashboardDirectory,
      connection: () => connection,
      replyEnabled: () => replyEnabled || Boolean(settings.current()?.enabled),
      settings,
      fixedReply: replyEnabled,
    });
    console.info(`本机消息日志：${logServer.url}`);
    store.interruptPending();
    await runtime.start();
    console.info(
      replyEnabled
        ? "QQ 已启用 /ping 固定回复测试。"
        : "QQ 已连接；模型回复由本机设置页的独立开关控制。",
    );
    await channel.closed;
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    unregister();
    connection = "offline";
    try {
      await runtime.stop();
    } finally {
      try {
        await logServer?.stop();
      } finally {
        pipeline.dispose();
        try {
          await settings.close();
        } finally {
          store.close();
        }
      }
    }
  }
}

await main().catch(() => {
  console.error(
    "QQ 或消息日志启动失败；请检查本地凭据、网络、私有目录权限与 3410 端口。未输出消息正文或凭据。",
  );
  process.exitCode = 1;
});
