import type { QQClient, QQClientListeners, QQReplyTarget } from "../src/qq/client";

export const credentials = { appId: "123456", appSecret: "fixture-secret-not-a-real-key" };

export function gate<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error("未初始化");
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error("未初始化");
  };
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function qqMessage(kind: "c2c" | "group" = "c2c", id = "message-1") {
  return {
    kind,
    senderId: "user-1",
    groupOpenid: kind === "group" ? "group-1" : undefined,
    messageId: id,
    timestamp: "2026-11-03T00:00:00Z",
    content: "/ping",
    replyTarget: { scope: kind, targetId: kind === "c2c" ? "user-1" : "group-1", msgId: id },
  };
}

export class FakeQQClient implements QQClient {
  listeners: QQClientListeners | undefined;
  readonly runGate = gate<void>();
  readonly started = gate<void>();
  readonly sends: { target: QQReplyTarget; text: string; sequence: number }[] = [];
  autoReady = true;
  earlyMessage: unknown;
  releases = 0;

  listen(listeners: QQClientListeners) {
    this.listeners = listeners;
    return () => {
      this.releases += 1;
      this.listeners = undefined;
    };
  }

  run(signal: AbortSignal): Promise<void> {
    const stop = () => this.runGate.resolve();
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    this.started.resolve();
    if (this.autoReady) this.listeners?.ready();
    if (this.earlyMessage) void this.listeners?.message(this.earlyMessage);
    return this.runGate.promise.finally(() => signal.removeEventListener("abort", stop));
  }

  stop(): void {
    this.runGate.resolve();
  }

  async message(value: unknown): Promise<void> {
    await this.listeners?.message(value);
  }

  async sendReply(
    target: QQReplyTarget,
    text: string,
    sequence: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.sends.push({ target, text, sequence });
  }
}
