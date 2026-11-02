import {
  type ActionContext,
  type Channel,
  type Dispose,
  type EventContext,
  type EventResult,
  parseActionProposal,
  parseEvent,
  type PipelineStage,
  type RuntimeEvent,
  type RuntimeHooks,
  type SendAction,
} from "@hina/core";
import { conversationKey, eventKey, ShortTermContext } from "./context";
import { abortable, bounded, operationScope } from "./operations";

interface RuntimeOptions {
  readonly historyLimit?: number;
  readonly historyTtlMs?: number;
  readonly conversationLimit?: number;
  readonly dedupeLimit?: number;
  readonly pendingLimit?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

type RuntimeState = "idle" | "starting" | "running" | "stopping" | "stopped";

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`);
  return value;
}

export class PipelineError extends Error {
  constructor(
    readonly eventId: string,
    readonly stage: PipelineStage,
    readonly sentCount: number,
    cause: unknown,
  ) {
    super(`事件处理在 ${stage} 阶段失败`, { cause });
    this.name = "PipelineError";
  }
}

export class Runtime {
  private currentState: RuntimeState = "idle";
  private readonly shutdown = new AbortController();
  private readonly hooks = new Set<RuntimeHooks>();
  private readonly seen = new Map<string, true>();
  private readonly pending = new Map<string, Promise<EventResult>>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly context: ShortTermContext;
  private readonly dedupeLimit: number;
  private readonly pendingLimit: number;
  private readonly timeoutMs: number;
  private release: Dispose | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private cleaning: Promise<void> | undefined;

  constructor(
    private readonly channel: Channel,
    options: RuntimeOptions = {},
  ) {
    this.context = new ShortTermContext(
      positive(options.historyLimit ?? 20, "historyLimit"),
      positive(options.conversationLimit ?? 100, "conversationLimit"),
      positive(options.historyTtlMs ?? 300_000, "historyTtlMs"),
      options.now ?? Date.now,
    );
    this.dedupeLimit = positive(options.dedupeLimit ?? 1000, "dedupeLimit");
    this.pendingLimit = positive(options.pendingLimit ?? 256, "pendingLimit");
    this.timeoutMs = positive(options.timeoutMs ?? 5000, "timeoutMs");
  }

  get state(): RuntimeState {
    return this.currentState;
  }

  use(hooks: RuntimeHooks): () => void {
    if (this.currentState === "stopping" || this.currentState === "stopped") {
      throw new Error("无法向已停止的 Runtime 注册 Hook");
    }
    const registration = Object.freeze({ ...hooks });
    this.hooks.add(registration);
    return () => {
      this.hooks.delete(registration);
    };
  }

  start(): Promise<void> {
    if (this.currentState === "running") return Promise.resolve();
    if (this.currentState === "starting" && this.starting) return this.starting;
    if (this.currentState !== "idle") return Promise.reject(new Error("Runtime 实例不能重新启动"));
    this.currentState = "starting";
    this.starting = this.startChannel();
    return this.starting;
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopChannel();
    return this.stopping;
  }

  private async startChannel(): Promise<void> {
    try {
      this.release = await bounded(
        () =>
          this.channel.setup({
            signal: this.shutdown.signal,
            emit: (event) => this.receive(event),
          }),
        this.timeoutMs,
        this.shutdown.signal,
      );
      if (typeof this.release !== "function") throw new TypeError("Channel.setup 必须返回清理函数");
      await bounded(() => this.channel.start(), this.timeoutMs, this.shutdown.signal);
      this.shutdown.signal.throwIfAborted();
      this.currentState = "running";
    } catch (error) {
      this.shutdown.abort(error);
      try {
        await this.cleanup();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Runtime 启动与清理失败");
      } finally {
        this.currentState = "stopped";
      }
      throw error;
    }
  }

  private async stopChannel(): Promise<void> {
    this.currentState = "stopping";
    this.shutdown.abort(new Error("Runtime 已停止"));
    // 启动失败仍由 start() 的调用者接收；停止路径继续完成资源清理。
    await this.starting?.catch(() => undefined);
    await Promise.allSettled(this.pending.values());
    try {
      await this.cleanup();
    } finally {
      this.currentState = "stopped";
    }
  }

  private cleanup(): Promise<void> {
    this.cleaning ??= (async () => {
      const errors: unknown[] = [];
      const release = this.release;
      this.release = undefined;
      if (release) {
        try {
          await bounded(() => this.channel.stop(), this.timeoutMs);
        } catch (error) {
          errors.push(error);
        }
        try {
          await bounded(release, this.timeoutMs);
        } catch (error) {
          errors.push(error);
        }
      }
      this.hooks.clear();
      this.context.clear();
      this.seen.clear();
      this.tails.clear();
      if (errors.length > 0) throw new AggregateError(errors, "Runtime 清理失败");
    })();
    return this.cleaning;
  }

  private async receive(value: unknown): Promise<EventResult> {
    if (this.currentState !== "running" && this.currentState !== "starting") {
      throw new Error("Runtime 尚未运行或已经停止");
    }
    const event = parseEvent(value);
    const identity = this.channel.identity;
    if (
      event.origin.channelId !== identity.channelId ||
      event.origin.accountId !== identity.accountId
    ) {
      throw new TypeError("事件来源与注册的 Channel 不匹配");
    }
    const key = eventKey(event);
    if (this.seen.has(key) || this.pending.has(key)) {
      return { status: "duplicate", eventId: event.id };
    }
    if (this.pending.size >= this.pendingLimit) throw new Error("待处理事件已达到容量限制");
    this.seen.set(key, true);
    if (this.seen.size > this.dedupeLimit) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    const conversation = conversationKey(event);
    // 网络 Channel 在 READY 附近即可收到事件；接受输入，但必须等启动成功后才处理。
    const previous = this.tails.get(conversation) ?? this.starting ?? Promise.resolve();
    const task = previous
      .then(() => this.process(event))
      .finally(() => {
        this.pending.delete(key);
        if (this.tails.get(conversation) === tail) this.tails.delete(conversation);
      });
    // 只让队列尾部吸收失败，原始 task 仍向输入方传播错误，避免一个事件阻塞整个会话。
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(key, task);
    this.tails.set(conversation, tail);
    return task;
  }

  private async process(event: RuntimeEvent): Promise<EventResult> {
    this.shutdown.signal.throwIfAborted();
    const history = this.context.append(event);
    const scope = operationScope(this.timeoutMs, this.shutdown.signal);
    const context: EventContext = Object.freeze({
      event,
      history,
      signal: scope.signal,
    });
    const hooks = [...this.hooks];
    let stage: PipelineStage = "onEvent";
    let sentCount = 0;
    let blockedCount = 0;
    try {
      for (const hook of hooks) {
        if (hook.onEvent) await abortable(() => hook.onEvent?.(context), scope.signal);
      }
      stage = "beforeHandle";
      for (const hook of hooks) {
        if (!hook.beforeHandle) continue;
        const result = await abortable(() => hook.beforeHandle?.(context), scope.signal);
        if (result === "observe") return { status: "observed", eventId: event.id };
        if (result !== undefined && result !== "continue")
          throw new TypeError("无效的 beforeHandle 结果");
      }
      stage = "handle";
      const actions: SendAction[] = [];
      for (const hook of hooks) {
        if (!hook.handle) continue;
        const proposals = await abortable(() => hook.handle?.(context), scope.signal);
        if (proposals === undefined) continue;
        if (!Array.isArray(proposals)) throw new TypeError("handle 必须返回 Action 提案数组");
        for (const value of proposals) {
          const proposal = parseActionProposal(value);
          if (
            proposal.target.channelId !== this.channel.identity.channelId ||
            proposal.target.accountId !== this.channel.identity.accountId
          ) {
            throw new TypeError("Action 目标 Channel 尚未注册");
          }
          actions.push(
            Object.freeze({
              ...proposal,
              id: JSON.stringify([eventKey(event), actions.length]),
              eventId: event.id,
            }),
          );
        }
      }
      if (actions.length === 0) return { status: "observed", eventId: event.id };
      for (const action of actions) {
        const actionContext: ActionContext = Object.freeze({ ...context, action });
        stage = "beforeSend";
        let allowed = false;
        for (const hook of hooks) {
          if (!hook.beforeSend) continue;
          const result = await abortable(() => hook.beforeSend?.(actionContext), scope.signal);
          if (result === "deny") {
            allowed = false;
            break;
          }
          if (result === "allow") allowed = true;
          else if (result !== undefined) throw new TypeError("无效的 beforeSend 结果");
        }
        if (!allowed) {
          blockedCount += 1;
          continue;
        }
        stage = "send";
        await abortable(() => this.channel.send(action, scope.signal), scope.signal);
        sentCount += 1;
        stage = "afterSend";
        for (const hook of hooks) {
          if (hook.afterSend) await abortable(() => hook.afterSend?.(actionContext), scope.signal);
        }
      }
      return { status: "processed", eventId: event.id, sentCount, blockedCount };
    } catch (error) {
      const errors: unknown[] = [error];
      for (const hook of hooks) {
        if (!hook.onError) continue;
        const errorScope = operationScope(this.timeoutMs);
        try {
          await abortable(
            () =>
              hook.onError?.({ ...context, signal: errorScope.signal, error, stage, sentCount }),
            errorScope.signal,
          );
        } catch (hookError) {
          errors.push(hookError);
        } finally {
          errorScope.dispose();
        }
      }
      throw new PipelineError(
        event.id,
        stage,
        sentCount,
        errors.length === 1 ? error : new AggregateError(errors, "事件与错误 Hook 均失败"),
      );
    } finally {
      scope.dispose();
    }
  }
}
