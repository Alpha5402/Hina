import { QQBot, type QQBotEventMap } from "@tencent-connect/qqbot-nodejs";
import { abortable, operationScope } from "../operations";

export interface QQCredentials {
  readonly appId: string;
  readonly appSecret: string;
}

export interface QQReplyTarget {
  readonly scope: "c2c" | "group";
  readonly targetId: string;
  readonly msgId: string;
}

export interface QQClientListeners {
  readonly ready: () => void;
  readonly message: (input: unknown) => Promise<void>;
  readonly warning: () => void;
  readonly disconnected: () => void;
}

export interface QQClient {
  listen(listeners: QQClientListeners): () => void;
  run(signal: AbortSignal): Promise<void>;
  stop(): void;
  sendReply(
    target: QQReplyTarget,
    text: string,
    sequence: number,
    signal: AbortSignal,
  ): Promise<void>;
}

/** 端点覆盖仅供本地协议测试，不从环境变量或用户输入读取。 */
export interface QQTestEndpoints {
  readonly apiBaseUrl?: string;
  readonly tokenBaseUrl?: string;
}

export function createQQClient(
  credentials: QQCredentials,
  endpoints: QQTestEndpoints = {},
): QQClient {
  const bot = new QQBot({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    userAgent: "Hina/0.0.0",
    markdownSupport: false,
    intents: 1 << 25,
    reconnect: { maxAttempts: 3 },
    ...(endpoints.apiBaseUrl ? { baseUrl: endpoints.apiBaseUrl } : {}),
    ...(endpoints.tokenBaseUrl ? { tokenBaseUrl: endpoints.tokenBaseUrl } : {}),
  });
  let lifetime: AbortSignal | undefined;
  return {
    listen(listeners) {
      const message: QQBotEventMap["message"] = (_context, input) => listeners.message(input);
      bot.on("ready", listeners.ready);
      bot.on("resumed", listeners.ready);
      bot.on("message", message);
      bot.on("error", listeners.warning);
      bot.on("disconnected", listeners.disconnected);
      return () => {
        bot.off("ready", listeners.ready);
        bot.off("resumed", listeners.ready);
        bot.off("message", message);
        bot.off("error", listeners.warning);
        bot.off("disconnected", listeners.disconnected);
      };
    },
    async run(signal) {
      lifetime = signal;
      try {
        await bot.start(signal);
      } finally {
        bot.tokenManager.clearCache(credentials.appId);
      }
    },
    stop() {
      bot.stop();
    },
    async sendReply(target, text, sequence, signal) {
      if (!lifetime) throw new Error("QQ 客户端尚未启动");
      const scope = operationScope(10_000, AbortSignal.any([signal, lifetime]));
      try {
        const token = await abortable(
          () => bot.tokenManager.getAccessToken(credentials.appId, credentials.appSecret),
          scope.signal,
        );
        scope.signal.throwIfAborted();
        const resource = target.scope === "c2c" ? "users" : "groups";
        // SDK 1.0.5 的 sendText 没有取消参数；此处使用相同 REST 协议并传递真实 AbortSignal。
        const response = await fetch(
          `${endpoints.apiBaseUrl ?? "https://api.sgroup.qq.com"}/v2/${resource}/${encodeURIComponent(target.targetId)}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `QQBot ${token}`,
              "Content-Type": "application/json",
              "User-Agent": "Hina/0.0.0",
            },
            body: JSON.stringify({
              content: text,
              msg_type: 0,
              msg_id: target.msgId,
              msg_seq: sequence,
            }),
            signal: scope.signal,
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("QQ 回复请求被拒绝");
        }
        const data: unknown = await response.json();
        if (
          typeof data !== "object" ||
          data === null ||
          !("id" in data) ||
          typeof data.id !== "string"
        ) {
          throw new Error("QQ 回复响应无效");
        }
        scope.signal.throwIfAborted();
      } catch {
        throw new Error(scope.signal.aborted ? "QQ 回复已取消或超时" : "QQ 回复发送失败");
      } finally {
        scope.dispose();
      }
    },
  };
}
