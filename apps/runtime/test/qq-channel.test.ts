import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeEvent, SendAction } from "@hina/core";
import { QQChannel } from "../src/qq/channel";
import { qqHooks } from "../src/qq/hooks";
import { Runtime } from "../src/runtime";
import { credentials, FakeQQClient, qqMessage } from "./qq-fixture";

const runtimes: Runtime[] = [];
function setup(
  options: { reply?: boolean; ttl?: number; now?: () => number; limit?: number } = {},
) {
  const client = new FakeQQClient();
  const issues: string[] = [];
  const events: RuntimeEvent[] = [];
  const channel = new QQChannel(credentials, {
    createClient: () => client,
    onIssue: (issue) => {
      issues.push(issue);
    },
    ...(options.ttl ? { replyTtlMs: options.ttl } : {}),
    ...(options.limit ? { replyLimit: options.limit } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const runtime = new Runtime(channel);
  runtime.use(qqHooks(credentials.appId, options.reply ?? false));
  runtime.use({
    onEvent: ({ event }) => {
      events.push(event);
    },
  });
  runtimes.push(runtime);
  return { runtime, channel, client, issues, events };
}

function action(conversationId = "c2c:user-1", eventId = "message-1"): SendAction {
  return {
    id: "test-action",
    eventId,
    type: "message.send",
    target: { channelId: "qq", accountId: credentials.appId, conversationId },
    content: { type: "text", text: "测试" },
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});

describe("QQ Channel", () => {
  test("默认仅接收，私聊与群聊归一化到独立会话", async () => {
    const { runtime, client, events } = setup();
    await runtime.start();
    await client.message(qqMessage());
    await client.message(qqMessage("group"));
    expect(events.map((event) => event.conversationId)).toEqual(["c2c:user-1", "group:group-1"]);
    expect(events[0]?.origin).toEqual({ channelId: "qq", accountId: credentials.appId });
    expect(events[0]?.timestamp).toBe("2026-11-03T00:00:00.000Z");
    expect(client.sends).toHaveLength(0);
  });

  test("READY 附近到达的消息等待 Runtime 启动完成，不丢失首条事件", async () => {
    const { runtime, client, events } = setup({ reply: true });
    client.earlyMessage = qqMessage();
    await runtime.start();
    // 同会话后续输入等待前一条事件处理完，再检查结果。
    await client.message({ ...qqMessage("c2c", "message-2"), content: "只观察" });
    expect(events).toHaveLength(2);
    expect(client.sends).toHaveLength(1);
  });

  test("显式启用后仅响应 /ping，重复推送不会重复发送", async () => {
    const { runtime, client } = setup({ reply: true });
    await runtime.start();
    await client.message({ ...qqMessage(), content: "普通私人消息" });
    await client.message(qqMessage("c2c", "message-2"));
    await client.message(qqMessage("c2c", "message-2"));
    await client.message({ ...qqMessage("group", "message-3"), content: "<@!123> /ping" });
    expect(client.sends).toEqual([
      {
        target: { scope: "c2c", targetId: "user-1", msgId: "message-2" },
        text: "Hina QQ Bot 已连接。",
        sequence: 1,
      },
      {
        target: { scope: "group", targetId: "group-1", msgId: "message-3" },
        text: "Hina QQ Bot 已连接。",
        sequence: 1,
      },
    ]);
  });

  test("过期、淘汰、跨会话和跨账号的动作不能变为主动推送", async () => {
    let now = 0;
    const { runtime, channel, client } = setup({ ttl: 100, now: () => now, limit: 1 });
    await runtime.start();
    await client.message(qqMessage());
    await expect(channel.send(action("group:other"), new AbortController().signal)).rejects.toThrow(
      "关联",
    );
    await client.message(qqMessage("c2c", "message-2"));
    await expect(channel.send(action(), new AbortController().signal)).rejects.toThrow("关联");
    now = 101;
    await expect(
      channel.send(action("c2c:user-1", "message-2"), new AbortController().signal),
    ).rejects.toThrow("过期");
    await expect(
      channel.send(
        { ...action(), target: { ...action().target, accountId: "other" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("目标");
    expect(client.sends).toHaveLength(0);
  });

  test("同一入站消息的多个回复递增 msg_seq，重复入站不重置序号", async () => {
    const { runtime, channel, client } = setup();
    await runtime.start();
    await client.message(qqMessage());
    await channel.send(action(), new AbortController().signal);
    await client.message(qqMessage());
    await channel.send({ ...action(), id: "test-action-2" }, new AbortController().signal);
    expect(client.sends.map((item) => item.sequence)).toEqual([1, 2]);
  });

  test("拒绝伪造回复关联，忽略机器人自身、频道和无文本事件", async () => {
    const { runtime, client, issues, events } = setup({ reply: true });
    await runtime.start();
    await client.message({
      ...qqMessage(),
      replyTarget: { scope: "c2c", targetId: "other", msgId: "message-1" },
    });
    await client.message({ ...qqMessage(), replyTarget: { scope: "c2c", targetId: "user-1" } });
    await client.message({ ...qqMessage(), senderIsBot: true });
    await client.message({ ...qqMessage(), kind: "guild" });
    await client.message({ ...qqMessage(), content: "" });
    expect(issues).toEqual(["invalid-message", "invalid-message"]);
    expect(events).toHaveLength(0);
    expect(client.sends).toHaveLength(0);
  });

  test("网关在 READY 前失败时回滚并移除监听", async () => {
    const { runtime, channel, client, events } = setup();
    client.autoReady = false;
    client.earlyMessage = qqMessage();
    const starting = runtime.start();
    await client.started.promise;
    client.runGate.reject(new Error("fixture-sensitive-marker"));
    await expect(starting).rejects.toThrow("QQ 连接失败");
    await expect(channel.closed).rejects.not.toThrow("fixture-sensitive-marker");
    expect(client.releases).toBe(1);
    expect(client.listeners).toBeUndefined();
    expect(events).toHaveLength(0);
    expect(runtime.state).toBe("stopped");
  });

  test("运行后网关失败可由宿主观察，停止后不再发送或接收", async () => {
    const { runtime, channel, client, events } = setup();
    await runtime.start();
    client.runGate.reject(new Error("fixture-sensitive-marker"));
    await expect(channel.closed).rejects.toThrow("QQ 连接失败");
    await runtime.stop();
    await runtime.stop();
    await client.message(qqMessage());
    await expect(channel.send(action(), new AbortController().signal)).rejects.toThrow();
    expect(events).toHaveLength(0);
    expect(client.releases).toBe(1);
  });
});
