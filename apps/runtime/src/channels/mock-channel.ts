import { type Channel, type ChannelContext, type EventResult, parseEvent } from "@hina/core";
import type { Awaitable, SendAction } from "@hina/core";

interface MockChannelOptions {
  readonly channelId?: string;
  readonly accountId?: string;
  readonly outputLimit?: number;
  readonly output?: (action: SendAction, signal: AbortSignal) => Awaitable<void>;
}

export class MockChannel implements Channel {
  readonly identity;
  private context: ChannelContext | undefined;
  private running = false;
  private readonly sent: SendAction[] = [];
  private readonly outputLimit: number;

  constructor(private readonly options: MockChannelOptions = {}) {
    this.identity = Object.freeze({
      channelId: options.channelId ?? "mock",
      accountId: options.accountId ?? "local",
    });
    this.outputLimit = options.outputLimit ?? 100;
    if (!Number.isSafeInteger(this.outputLimit) || this.outputLimit < 1) {
      throw new RangeError("outputLimit 必须是正整数");
    }
  }

  get outputs(): readonly SendAction[] {
    return Object.freeze([...this.sent]);
  }

  get connected(): boolean {
    return this.context !== undefined;
  }

  setup(context: ChannelContext) {
    if (this.context) throw new Error("Mock Channel 已绑定 Runtime");
    this.context = context;
    return () => {
      this.running = false;
      this.context = undefined;
    };
  }

  start(): void {
    if (!this.context) throw new Error("必须先 setup Mock Channel");
    this.context.signal.throwIfAborted();
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  async receive(value: unknown): Promise<EventResult> {
    if (!this.running || !this.context) throw new Error("Mock Channel 尚未运行或已经停止");
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Mock 输入必须是对象");
    }
    const input = value as Record<string, unknown>;
    const event = parseEvent({
      id: input.id,
      origin: this.identity,
      timestamp: input.timestamp ?? new Date().toISOString(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      content: { type: "text", text: input.text },
    });
    return this.context.emit(event);
  }

  async send(action: SendAction, signal: AbortSignal): Promise<void> {
    if (!this.running) throw new Error("Mock Channel 尚未运行或已经停止");
    signal.throwIfAborted();
    await this.options.output?.(action, signal);
    signal.throwIfAborted();
    this.sent.push(action);
    if (this.sent.length > this.outputLimit) this.sent.shift();
  }
}
