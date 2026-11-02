import {
  type Channel,
  type ChannelContext,
  parseEvent,
  type RuntimeEvent,
  type SendAction,
} from "@hina/core";
import { createQQClient, type QQClient, type QQCredentials, type QQReplyTarget } from "./client";

type QQIssue = "connection" | "disconnected" | "invalid-message" | "processing";

interface QQChannelOptions {
  readonly createClient?: (credentials: QQCredentials) => QQClient;
  readonly onIssue?: (issue: QQIssue) => void;
  readonly onReady?: () => void;
  readonly now?: () => number;
  readonly replyTtlMs?: number;
  readonly replyLimit?: number;
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error("Promise 尚未初始化");
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error("Promise 尚未初始化");
  };
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("QQ 消息结构无效");
  return value as Record<string, unknown>;
}

function normalize(
  input: unknown,
  appId: string,
): { event: RuntimeEvent; target: QQReplyTarget } | undefined {
  const message = object(input);
  if (message.senderIsBot === true || (message.kind !== "c2c" && message.kind !== "group")) return;
  const target = object(message.replyTarget);
  if (
    target.scope !== message.kind ||
    target.msgId !== message.messageId ||
    typeof target.targetId !== "string" ||
    !target.targetId
  ) {
    throw new TypeError("QQ 被动回复目标无效");
  }
  if (
    (message.kind === "c2c" && target.targetId !== message.senderId) ||
    (message.kind === "group" && target.targetId !== message.groupOpenid)
  ) {
    throw new TypeError("QQ 会话与回复目标不匹配");
  }
  if (message.attachments !== undefined && !Array.isArray(message.attachments))
    throw new TypeError("QQ 附件结构无效");
  const images = (message.attachments ?? []).flatMap((value: unknown) => {
    const attachment = object(value);
    if (
      typeof attachment.content_type !== "string" ||
      !attachment.content_type.toLowerCase().startsWith("image/")
    )
      return [];
    const rawUrl = attachment.url;
    const url = typeof rawUrl === "string" && rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    return [
      {
        type: "image",
        url,
        mediaType: attachment.content_type,
        ...(attachment.filename === undefined ? {} : { name: attachment.filename }),
      },
    ];
  });
  const event = parseEvent({
    id: message.messageId,
    origin: { channelId: "qq", accountId: appId },
    timestamp: message.timestamp,
    actorId: message.senderId,
    conversationId: `${message.kind}:${target.targetId}`,
    conversationType: message.kind === "c2c" ? "direct" : "group",
    directedToCharacter:
      message.kind === "c2c" || message.rawEventType === "GROUP_AT_MESSAGE_CREATE",
    content: images.length
      ? { type: "message", text: message.content ?? "", images }
      : { type: "text", text: message.content },
  });
  if (event.content.type === "text" && !event.content.text.trim()) return;
  return {
    event,
    target: Object.freeze({ scope: message.kind, targetId: target.targetId, msgId: event.id }),
  };
}

function replyKey(conversationId: string, eventId: string): string {
  return JSON.stringify([conversationId, eventId]);
}

export class QQChannel implements Channel {
  readonly identity;
  private readonly ready = deferred<void>();
  private readonly finished = deferred<void>();
  readonly closed = this.finished.promise;
  private readonly controller = new AbortController();
  private readonly replies = new Map<
    string,
    { target: QQReplyTarget; receivedAt: number; sequence: number }
  >();
  private context: ChannelContext | undefined;
  private client: QQClient | undefined;
  private connection: Promise<void> | undefined;
  private unlisten: (() => void) | undefined;
  private abortParent: (() => void) | undefined;
  private accepting = false;
  private readonly now: () => number;
  private readonly replyTtlMs: number;
  private readonly replyLimit: number;

  constructor(
    private readonly credentials: QQCredentials,
    private readonly options: QQChannelOptions = {},
  ) {
    if (!/^\d{1,32}$/.test(credentials.appId) || !credentials.appSecret.trim())
      throw new Error("QQ 凭据未配置或格式无效");
    this.identity = Object.freeze({ channelId: "qq", accountId: credentials.appId });
    this.now = options.now ?? Date.now;
    this.replyTtlMs = options.replyTtlMs ?? 300_000;
    this.replyLimit = options.replyLimit ?? 1000;
    if (
      !Number.isSafeInteger(this.replyTtlMs) ||
      this.replyTtlMs < 1 ||
      !Number.isSafeInteger(this.replyLimit) ||
      this.replyLimit < 1
    )
      throw new RangeError("QQ 缓存配置无效");
    // 连接可能在宿主开始等待 closed 之前失败；原 Promise 仍向调用方传播错误。
    void this.closed.catch(() => undefined);
    void this.ready.promise.catch(() => undefined);
  }

  setup(context: ChannelContext) {
    if (this.context || this.controller.signal.aborted) throw new Error("QQ Channel 无法重复绑定");
    const client = (this.options.createClient ?? createQQClient)(this.credentials);
    this.client = client;
    this.context = context;
    try {
      this.unlisten = client.listen({
        ready: () => {
          this.ready.resolve();
          this.options.onReady?.();
        },
        message: (input) => this.receive(input),
        warning: () => this.options.onIssue?.("connection"),
        disconnected: () => this.options.onIssue?.("disconnected"),
      });
      this.abortParent = () => {
        this.controller.abort(context.signal.reason);
        client.stop();
      };
      context.signal.addEventListener("abort", this.abortParent, { once: true });
      if (context.signal.aborted) this.abortParent();
    } catch (error) {
      client.stop();
      this.context = undefined;
      this.client = undefined;
      throw error;
    }
    return () => {
      this.unlisten?.();
      if (this.abortParent) context.signal.removeEventListener("abort", this.abortParent);
      this.unlisten = undefined;
      this.abortParent = undefined;
      this.context = undefined;
      this.client = undefined;
      this.replies.clear();
    };
  }

  async start(): Promise<void> {
    if (!this.context || !this.client || this.connection)
      throw new Error("QQ Channel 尚未初始化或已经启动");
    this.controller.signal.throwIfAborted();
    this.accepting = true;
    this.connection = this.client.run(this.controller.signal).then(
      () => this.connectionEnded(),
      () => this.connectionEnded(),
    );
    await this.ready.promise;
  }

  private connectionEnded(): void {
    this.accepting = false;
    if (this.controller.signal.aborted) {
      this.ready.reject(new Error("QQ 连接已取消"));
      this.finished.resolve();
    } else {
      const error = new Error("QQ 连接失败或重连预算耗尽，请检查凭据、服务状态和网络");
      this.ready.reject(error);
      this.finished.reject(error);
    }
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.controller.abort(new Error("QQ Channel 已停止"));
    this.client?.stop();
    await this.connection;
    this.ready.reject(new Error("QQ Channel 已停止"));
    this.finished.resolve();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.replies)
      if (now - entry.receivedAt >= this.replyTtlMs) this.replies.delete(key);
  }

  private async receive(input: unknown): Promise<void> {
    if (!this.accepting || !this.context || this.controller.signal.aborted) return;
    let normalized: ReturnType<typeof normalize>;
    try {
      normalized = normalize(input, this.credentials.appId);
    } catch {
      this.options.onIssue?.("invalid-message");
      return;
    }
    if (!normalized) return;
    this.prune();
    const key = replyKey(normalized.event.conversationId, normalized.event.id);
    if (!this.replies.has(key)) {
      this.replies.set(key, { target: normalized.target, receivedAt: this.now(), sequence: 0 });
      if (this.replies.size > this.replyLimit) {
        const oldest = this.replies.keys().next().value;
        if (oldest !== undefined) this.replies.delete(oldest);
      }
    }
    try {
      await this.context.emit(normalized.event);
    } catch {
      this.options.onIssue?.("processing");
    }
  }

  async send(action: SendAction, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.controller.signal.throwIfAborted();
    if (
      !this.accepting ||
      !this.client ||
      action.target.channelId !== "qq" ||
      action.target.accountId !== this.credentials.appId
    )
      throw new Error("QQ 发送状态或目标无效");
    this.prune();
    const entry = this.replies.get(replyKey(action.target.conversationId, action.eventId));
    if (!entry) throw new Error("QQ 被动回复关联不存在或已过期，不允许退化为主动推送");
    entry.sequence += 1;
    await this.client.sendReply(
      entry.target,
      action.content.text,
      entry.sequence,
      AbortSignal.any([signal, this.controller.signal]),
    );
  }
}
