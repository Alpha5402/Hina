import type { MessageLogStore } from "./store";

export class LogStreams {
  private readonly clients = new Set<() => void>();

  constructor(private readonly store: MessageLogStore) {}

  open(requestSignal: AbortSignal): ReadableStream<Uint8Array> | undefined {
    if (this.clients.size >= 8) return;
    let cleanup = () => {};
    return new ReadableStream({
      start: (controller) => {
        let stopped = false;
        let unsubscribe: (() => void) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        cleanup = () => {
          if (stopped) return;
          stopped = true;
          clearInterval(heartbeat);
          unsubscribe?.();
          requestSignal.removeEventListener("abort", cleanup);
          this.clients.delete(cleanup);
          try {
            controller.close();
          } catch {
            /* 消费方可能已先取消流。 */
          }
        };
        const send = (name: string) => {
          if (stopped) return;
          // 通知不承载正文；未消费的通知合并为一次完整查询，突发输入也不积压。
          if ((controller.desiredSize ?? 0) <= 0) return;
          try {
            controller.enqueue(new TextEncoder().encode(`event: ${name}\ndata: {}\n\n`));
          } catch {
            cleanup();
          }
        };
        this.clients.add(cleanup);
        requestSignal.addEventListener("abort", cleanup, { once: true });
        try {
          unsubscribe = this.store.subscribe(() => send("changed"));
          heartbeat = setInterval(() => send("status"), 5000);
          if (requestSignal.aborted) cleanup();
          else send("ready");
        } catch {
          cleanup();
          throw new Error("实时日志订阅失败");
        }
      },
      cancel: () => cleanup(),
    });
  }

  close(): void {
    for (const close of [...this.clients]) close();
  }
}
