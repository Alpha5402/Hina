import { afterEach, describe, expect, test } from "bun:test";
import {
  type Channel,
  type ChannelContext,
  type EventContext,
  parseActionProposal,
  parseEvent,
  type PipelineErrorContext,
} from "@hina/core";
import { MockChannel } from "../src/channels/mock-channel";
import { demoHooks } from "../src/demo-hooks";
import { PipelineError, Runtime } from "../src/runtime";

const message = {
  id: "event-1",
  actorId: "tester",
  conversationId: "room-1",
  timestamp: "2026-11-03T08:00:00+08:00",
  text: "你好",
};
const runtimes: Runtime[] = [];

function track(runtime: Runtime): Runtime {
  runtimes.push(runtime);
  return runtime;
}

function deferred() {
  let resolve: () => void = () => {
    throw new Error("Promise 尚未初始化");
  };
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

afterEach(async () => {
  const active = runtimes.splice(0).filter((runtime) => runtime.state !== "stopped");
  await Promise.all(active.map((runtime) => runtime.stop()));
});

describe("Mock Channel 事件通路", () => {
  test("按阶段和注册顺序处理输入；输出带有关联 ID，事件与上下文不可变", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel));
    const stages: string[] = [];
    let received: EventContext | undefined;
    runtime.use({
      onEvent: (context) => {
        received = context;
        stages.push("event:1");
      },
      beforeHandle: () => {
        stages.push("beforeHandle");
      },
      handle: () => {
        stages.push("handle");
      },
      beforeSend: () => {
        stages.push("beforeSend");
      },
      afterSend: () => {
        stages.push("afterSend");
      },
    });
    runtime.use({
      onEvent: () => {
        stages.push("event:2");
      },
    });
    runtime.use(demoHooks());
    await runtime.start();
    expect(await channel.receive(message)).toEqual({
      status: "processed",
      eventId: message.id,
      sentCount: 1,
      blockedCount: 0,
    });
    expect(stages).toEqual([
      "event:1",
      "event:2",
      "beforeHandle",
      "handle",
      "beforeSend",
      "afterSend",
    ]);
    expect(channel.outputs).toHaveLength(1);
    expect(channel.outputs[0]).toMatchObject({
      eventId: message.id,
      type: "message.send",
      content: { type: "text", text: "回声：你好" },
      target: { channelId: "mock", accountId: "local", conversationId: "room-1" },
    });
    expect(typeof channel.outputs[0]?.id).toBe("string");
    expect(received?.event.timestamp).toBe("2026-11-03T00:00:00.000Z");
    expect(Object.isFrozen(received?.event)).toBe(true);
    expect(Object.isFrozen(received?.event.origin)).toBe(true);
    expect(Object.isFrozen(received?.event.content)).toBe(true);
    expect(Object.isFrozen(received?.history)).toBe(true);
    expect(Object.isFrozen(channel.outputs[0]?.target)).toBe(true);
  });

  test("被抑制事件进入有限上下文；上下文按最近会话淘汰", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel, { historyLimit: 2, conversationLimit: 1 }));
    const histories: string[][] = [];
    runtime.use({
      onEvent: ({ history }) => {
        histories.push(history.map((event) => event.id));
      },
    });
    runtime.use(demoHooks());
    await runtime.start();
    expect(await channel.receive({ ...message, text: "/observe" })).toMatchObject({
      status: "observed",
    });
    await channel.receive({ ...message, id: "event-2" });
    await channel.receive({ ...message, id: "event-3" });
    await channel.receive({ ...message, id: "event-4", conversationId: "room-2" });
    await channel.receive({ ...message, id: "event-5" });
    expect(histories).toEqual([
      ["event-1"],
      ["event-1", "event-2"],
      ["event-2", "event-3"],
      ["event-4"],
      ["event-5"],
    ]);
    expect(channel.outputs).toHaveLength(4);
  });

  test("注销 Hook 幂等；后续事件不再调用已注销 Hook", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel));
    let calls = 0;
    const unregister = runtime.use({
      onEvent: () => {
        calls += 1;
      },
    });
    await runtime.start();
    await channel.receive(message);
    unregister();
    unregister();
    await channel.receive({ ...message, id: "event-2" });
    expect(calls).toBe(1);
    expect(channel.outputs).toHaveLength(0);
  });

  test("上下文按观察时间过期，不用平台时间延长保留期限", async () => {
    let now = 0;
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel, { historyTtlMs: 100, now: () => now }));
    const histories: string[][] = [];
    runtime.use({
      onEvent: ({ history }) => {
        histories.push(history.map((event) => event.id));
      },
    });
    await runtime.start();
    await channel.receive(message);
    now = 50;
    await channel.receive({ ...message, id: "event-2" });
    now = 101;
    await channel.receive({ ...message, id: "event-3" });
    expect(histories).toEqual([["event-1"], ["event-1", "event-2"], ["event-2", "event-3"]]);
  });

  test("Hook 注册快照对当前事件保持稳定，注销在后续事件生效", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel));
    let calls = 0;
    let unregister: () => void = () => undefined;
    runtime.use({
      onEvent: () => {
        unregister();
      },
    });
    unregister = runtime.use({
      handle: () => {
        calls += 1;
      },
    });
    await runtime.start();
    await channel.receive(message);
    await channel.receive({ ...message, id: "event-2" });
    expect(calls).toBe(1);
  });

  test("去重涵盖处理中事件；相同原始 ID 在不同会话互不冲突", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel, { dedupeLimit: 1 }));
    const entered = deferred();
    const release = deferred();
    runtime.use({
      beforeHandle: async ({ event }) => {
        if (event.conversationId === "room-1") {
          entered.resolve();
          await release.promise;
        }
      },
    });
    runtime.use(demoHooks());
    await runtime.start();
    const first = channel.receive(message);
    await entered.promise;
    await channel.receive({ ...message, conversationId: "room-2" });
    expect(await channel.receive(message)).toMatchObject({ status: "duplicate" });
    release.resolve();
    await first;
    expect(channel.outputs).toHaveLength(2);
    expect(channel.outputs[0]?.id).not.toBe(channel.outputs[1]?.id);
  });

  test("同一会话有序，独立会话不被等待中的 Hook 阻塞", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel));
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    runtime.use({
      onEvent: async ({ event }) => {
        order.push(event.id);
        if (event.id === "event-1") {
          entered.resolve();
          await release.promise;
        }
      },
    });
    await runtime.start();
    const first = channel.receive(message);
    await entered.promise;
    const second = channel.receive({ ...message, id: "event-2" });
    await channel.receive({ ...message, id: "event-3", conversationId: "room-2" });
    expect(order).toEqual(["event-1", "event-3"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["event-1", "event-3", "event-2"]);
  });

  test("没有明确 allow 时不发送，任一 deny 否决其他 allow", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel));
    runtime.use({ ...demoHooks(), beforeSend: () => undefined });
    await runtime.start();
    expect(await channel.receive(message)).toMatchObject({ sentCount: 0, blockedCount: 1 });
    runtime.use({ beforeSend: () => "allow" });
    const unregister = runtime.use({ beforeSend: () => "deny" });
    expect(await channel.receive({ ...message, id: "event-2" })).toMatchObject({
      sentCount: 0,
      blockedCount: 1,
    });
    unregister();
    await channel.receive({ ...message, id: "event-3" });
    expect(channel.outputs).toHaveLength(1);
  });

  test("非法输入和未注册输出目标在发送前被拒绝", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel));
    runtime.use({
      handle: () => [
        {
          type: "message.send",
          target: { channelId: "other", accountId: "local", conversationId: "room" },
          content: { type: "text", text: "不应发送" },
        },
      ],
      beforeSend: () => "allow",
    });
    await runtime.start();
    await expect(channel.receive({ ...message, id: "" })).rejects.toBeInstanceOf(TypeError);
    await expect(channel.receive({ ...message, text: 123 })).rejects.toBeInstanceOf(TypeError);
    await expect(channel.receive({ ...message, text: "x".repeat(16_385) })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(channel.receive(message)).rejects.toMatchObject({ stage: "handle", sentCount: 0 });
    expect(channel.outputs).toHaveLength(0);
  });

  test("Hook 失败传播阶段信息，不阻塞会话，也不自动重放失败事件", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel));
    const errors: PipelineErrorContext[] = [];
    runtime.use({
      handle: ({ event }) => {
        if (event.id === "event-1") throw new Error("测试故障");
      },
      onError: (context) => {
        errors.push(context);
      },
    });
    runtime.use(demoHooks());
    await runtime.start();
    await expect(channel.receive(message)).rejects.toMatchObject({ stage: "handle", sentCount: 0 });
    expect(await channel.receive(message)).toMatchObject({ status: "duplicate" });
    await channel.receive({ ...message, id: "event-2" });
    expect(channel.outputs).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stage).toBe("handle");
  });

  test("afterSend 失败保留已发送计数，重复输入不会再发一次", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel));
    runtime.use(demoHooks());
    runtime.use({
      afterSend: () => {
        throw new Error("发送后观察失败");
      },
    });
    await runtime.start();
    await expect(channel.receive(message)).rejects.toMatchObject({
      stage: "afterSend",
      sentCount: 1,
    });
    expect(await channel.receive(message)).toMatchObject({ status: "duplicate" });
    expect(channel.outputs).toHaveLength(1);
  });

  test("超时中断 Hook，不会在其迟到完成后发送", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel, { timeoutMs: 20 }));
    const release = deferred();
    runtime.use({
      handle: async () => {
        await release.promise;
        return [];
      },
    });
    runtime.use(demoHooks());
    await runtime.start();
    await expect(channel.receive(message)).rejects.toBeInstanceOf(PipelineError);
    release.resolve();
    await runtime.stop();
    expect(channel.outputs).toHaveLength(0);
    expect(channel.connected).toBe(false);
  });

  test("队列满时拒绝新事件；停止取消活动与排队事件，并允许重复 stop", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel, { pendingLimit: 2 }));
    const entered = deferred();
    const release = deferred();
    runtime.use({
      handle: async () => {
        entered.resolve();
        await release.promise;
        return [];
      },
    });
    await runtime.start();
    const first = channel.receive(message).catch((error: unknown) => error);
    await entered.promise;
    const second = channel.receive({ ...message, id: "event-2" }).catch((error: unknown) => error);
    await expect(channel.receive({ ...message, id: "event-3" })).rejects.toThrow("容量限制");
    await Promise.all([runtime.stop(), runtime.stop()]);
    release.resolve();
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    expect(channel.connected).toBe(false);
    expect(runtime.state).toBe("stopped");
    await expect(channel.receive(message)).rejects.toThrow();
    await expect(runtime.start()).rejects.toThrow("不能重新启动");
    expect(() => runtime.use({})).toThrow();
  });

  test("启动失败与 stop 失败仍执行 setup 清理，清理只执行一次", async () => {
    class FailingChannel extends MockChannel {
      cleanups = 0;
      stops = 0;

      override setup(context: ChannelContext) {
        const release = super.setup(context);
        return () => {
          this.cleanups += 1;
          release();
        };
      }

      override start(): void {
        super.start();
        throw new Error("启动失败");
      }

      override stop(): void {
        this.stops += 1;
        super.stop();
        throw new Error("停止失败");
      }
    }
    const channel = new FailingChannel();
    const runtime = track(new Runtime(channel));
    await expect(runtime.start()).rejects.toBeInstanceOf(AggregateError);
    expect(channel.connected).toBe(false);
    expect(channel.cleanups).toBe(1);
    expect(channel.stops).toBe(1);
    await expect(runtime.stop()).rejects.toBeInstanceOf(AggregateError);
    expect(channel.cleanups).toBe(1);
    expect(channel.stops).toBe(1);
  });

  test("错误 Hook 的异常不会掩盖原始失败", async () => {
    const channel = new MockChannel();
    const runtime = track(new Runtime(channel));
    runtime.use({
      handle: () => {
        throw new Error("主失败");
      },
      onError: () => {
        throw new Error("观察失败");
      },
    });
    await runtime.start();
    try {
      await channel.receive(message);
      throw new Error("应当失败");
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      if (!(error instanceof PipelineError)) throw error;
      expect(error.cause).toBeInstanceOf(AggregateError);
    }
  });

  test("setup 失败不停止其他 Runtime 已拥有的 Channel", async () => {
    const channel = new MockChannel();
    const owner = track(new Runtime(channel));
    const other = track(new Runtime(channel));
    owner.use(demoHooks());
    await owner.start();
    await expect(other.start()).rejects.toThrow("已绑定");
    await channel.receive(message);
    expect(owner.state).toBe("running");
    expect(channel.outputs).toHaveLength(1);
  });

  test("启动尚未完成时停止，取消等待并清理已经移交的资源", async () => {
    const mock = new MockChannel();
    const entered = deferred();
    const releaseStart = deferred();
    let cleanups = 0;
    const channel: Channel = {
      identity: mock.identity,
      setup: (context) => {
        const release = mock.setup(context);
        return () => {
          cleanups += 1;
          release();
        };
      },
      start: async () => {
        mock.start();
        entered.resolve();
        await releaseStart.promise;
      },
      stop: () => mock.stop(),
      send: (action, signal) => mock.send(action, signal),
    };
    const runtime = track(new Runtime(channel));
    const starting = runtime.start().catch((error: unknown) => error);
    await entered.promise;
    await runtime.stop();
    releaseStart.resolve();
    expect(await starting).toBeInstanceOf(Error);
    expect(runtime.state).toBe("stopped");
    expect(mock.connected).toBe(false);
    expect(cleanups).toBe(1);
  });

  test("输出缓存有界，零容量等非法配置被拒绝", async () => {
    const channel = new MockChannel({ outputLimit: 1 });
    const runtime = track(new Runtime(channel));
    runtime.use(demoHooks());
    await runtime.start();
    await channel.receive(message);
    await channel.receive({ ...message, id: "event-2" });
    expect(channel.outputs).toHaveLength(1);
    expect(channel.outputs[0]?.eventId).toBe("event-2");
    expect(() => new Runtime(channel, { historyLimit: 0 })).toThrow(RangeError);
    expect(() => new MockChannel({ outputLimit: 0 })).toThrow(RangeError);
  });
});

describe("共享协议边界", () => {
  test("拒绝非法事件、时间和 Action 类型", () => {
    expect(() => parseEvent(null)).toThrow(TypeError);
    expect(() => parseEvent({})).toThrow(TypeError);
    expect(() => parseActionProposal({ type: "unknown", target: {} })).toThrow(TypeError);
    expect(() =>
      parseEvent({
        ...message,
        origin: { channelId: "mock", accountId: "local" },
        timestamp: "invalid",
        content: { type: "text", text: message.text },
      }),
    ).toThrow(TypeError);
    for (const timestamp of [
      "2026-02-30T00:00:00Z",
      "2026-11-03T00:00:00",
      "2026-11-03T24:00:00Z",
    ]) {
      expect(() =>
        parseEvent({
          ...message,
          origin: { channelId: "mock", accountId: "local" },
          timestamp,
          content: { type: "text", text: message.text },
        }),
      ).toThrow(TypeError);
    }
  });
});
