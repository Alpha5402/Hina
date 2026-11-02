import { afterEach, describe, expect, test } from "bun:test";
import {
  type Decision,
  type Model,
  type ModelRequest,
  type ModelResponse,
  parseModelResponse,
} from "@hina/core";
import { SQLiteMessageLogStore } from "../src/logs/store";
import { OpenAICompatibleModel } from "../src/models/openai-compatible";
import { OpenAIDecision } from "../src/models/openai-decision";
import { ModelPipeline } from "../src/models/pipeline";
import { QQChannel } from "../src/qq/channel";
import { Runtime } from "../src/runtime";
import { ServiceError } from "../src/settings/errors";
import type { LlmConfiguration } from "../src/settings/store";
import { fixtureToken, responsePayload, settingsFixture, settingsUpdate } from "./llm-fixture";
import { credentials, FakeQQClient, gate, qqMessage } from "./qq-fixture";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const response = (): ModelResponse => ({
  model: "fixture-model",
  text: "这是模型回复",
  finishReason: "stop",
  durationMs: 5,
  usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
});

async function setup(
  options: {
    enabled?: boolean;
    model?: (config: LlmConfiguration) => Model;
    client?: FakeQQClient;
    images?: boolean;
    decisionModel?: string;
    decision?: (config: LlmConfiguration) => Decision;
  } = {},
) {
  const settings = await settingsFixture();
  cleanups.push(settings.cleanup);
  await settings.store.save(
    settingsUpdate({
      enabled: options.enabled ?? true,
      includeImages: options.images ?? false,
      decisionModel: options.decisionModel ?? "",
    }),
  );
  const logs = new SQLiteMessageLogStore(":memory:");
  cleanups.push(() => logs.close());
  const calls: ModelRequest[] = [];
  const pipeline = new ModelPipeline(settings.store, logs, credentials.appId, {
    model:
      options.model ??
      (() => ({
        generate: async (input) => {
          calls.push(input);
          return response();
        },
      })),
    image: async () => ({ bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" }),
    ...(options.decision ? { decision: options.decision } : {}),
  });
  cleanups.push(() => pipeline.dispose());
  const client = options.client ?? new FakeQQClient();
  const issues: string[] = [];
  const channel = new QQChannel(credentials, {
    createClient: () => client,
    onIssue: (issue) => issues.push(issue),
  });
  const runtime = new Runtime(channel, { timeoutMs: 2000 });
  cleanups.push(() => runtime.stop());
  runtime.use({ onEvent: ({ event }) => logs.append(event) });
  runtime.use(pipeline.hooks);
  await runtime.start();
  return { settings: settings.store, logs, calls, client, runtime, issues };
}

describe("模型输入到 QQ 输出", () => {
  test("输入、API 响应与已确认发送关联到同一条记录，重复输入不再调用模型", async () => {
    const { client, calls, logs } = await setup();
    await client.message({ ...qqMessage(), content: "你好" });
    await client.message({ ...qqMessage(), content: "你好" });
    expect(calls).toHaveLength(1);
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0]?.text).toBe("这是模型回复");
    expect(logs.find(1)?.processing).toMatchObject({
      status: "sent",
      response: { text: "这是模型回复", usage: { totalTokens: 16 } },
    });
    expect(logs.find(1)?.processingVersion).toBe(4);
  });

  test("关闭时仅记录；启用后不把此前接收的消息送给模型，并保留本轮已发送回复的上下文", async () => {
    const { client, calls, settings } = await setup({ enabled: false });
    await client.message({ ...qqMessage(), content: "启用前的私人记录" });
    expect(calls).toHaveLength(0);
    const { token: _token, ...update } = settingsUpdate({ expectedRevision: 1, enabled: true });
    await settings.save(update);
    await client.message({ ...qqMessage("c2c", "new-1"), content: "新的输入" });
    expect(JSON.stringify(calls[0])).not.toContain("启用前的私人记录");
    await client.message({ ...qqMessage("c2c", "new-2"), content: "继续" });
    expect(calls[1]?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(calls[1]?.messages[2]?.text).toBe("这是模型回复");
    const other = {
      ...qqMessage("c2c", "other"),
      senderId: "user-2",
      replyTarget: { scope: "c2c", targetId: "user-2", msgId: "other" },
      content: "独立会话",
    };
    await client.message(other);
    expect(JSON.stringify(calls[2])).not.toContain("新的输入");
  });

  test("群聊范围允许后，不依赖是否 @，普通群消息也调用响应模型", async () => {
    const { client, calls, settings, logs } = await setup();
    await client.message({
      ...qqMessage("group", "group-1"),
      rawEventType: "GROUP_AT_MESSAGE_CREATE",
      content: "hi",
    });
    expect(calls).toHaveLength(0);
    const { token: _token, ...update } = settingsUpdate({
      expectedRevision: 1,
      enabled: true,
      replyScope: "direct-and-groups",
    });
    await settings.save(update);
    await client.message({
      ...qqMessage("group", "group-2"),
      rawEventType: "GROUP_MESSAGE_CREATE",
      content: "<@!123> hi",
    });
    await client.message({
      ...qqMessage("group", "group-3"),
      rawEventType: "GROUP_AT_MESSAGE_CREATE",
      content: "hi",
    });
    expect(calls).toHaveLength(2);
    expect(client.sends[0]?.target.scope).toBe("group");
    expect(logs.find(2)?.processing?.status).toBe("sent");
    expect(logs.find(1)?.processing).toEqual({ status: "skipped", reason: "scope" });
  });

  test("配置变更取消在途调用，不产生迟到回复", async () => {
    const started = gate<void>();
    const { client, settings, logs } = await setup({
      model: (config) =>
        new OpenAICompatibleModel(config, async () => {
          started.resolve();
          return new Promise<Response>(() => {});
        }),
    });
    const pending = client.message({ ...qqMessage(), content: "等待请求" });
    await started.promise;
    const { token: _token, ...update } = settingsUpdate({ expectedRevision: 1, enabled: false });
    await settings.save(update);
    await pending;
    expect(client.sends).toHaveLength(0);
    expect(logs.find(1)?.processing).toMatchObject({
      status: "failed",
      stage: "model",
      code: "cancelled",
    });
  });

  test("生成后重新检查配置版本，关闭回复会拦截尚未调度的 Action", async () => {
    const { client, settings, logs, runtime } = await setup();
    runtime.use({
      handle: async () => {
        const { token: _token, ...update } = settingsUpdate({
          expectedRevision: 1,
          enabled: false,
        });
        await settings.save(update);
      },
    });
    await client.message({ ...qqMessage(), content: "生成后关闭" });
    expect(client.sends).toHaveLength(0);
    expect(logs.find(1)?.processing).toMatchObject({
      status: "blocked",
      response: { text: "这是模型回复" },
    });
  });

  test("发送失败保留 API 响应并标记未确认，不盲目重试", async () => {
    class FailingClient extends FakeQQClient {
      attempts = 0;
      override async sendReply() {
        this.attempts += 1;
        throw new Error("fixture send failure");
      }
    }
    const failed = new FailingClient();
    const { client, logs, calls } = await setup({ client: failed });
    await client.message(qqMessage());
    await client.message(qqMessage());
    expect(failed.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(logs.find(1)?.processing).toMatchObject({
      status: "failed",
      stage: "send",
      code: "delivery_unconfirmed",
      response: { text: "这是模型回复" },
    });
  });

  test("图片输入需要显式启用；附件转换为模型图片输入，数量有界", async () => {
    const { client, settings, calls, logs } = await setup();
    const attachment = {
      content_type: "image/png",
      url: "https://multimedia.nt.qq.com.cn/fixture",
    };
    await client.message({
      ...qqMessage("c2c", "image-1"),
      content: "",
      attachments: [attachment],
    });
    expect(calls).toHaveLength(0);
    expect(logs.find(1)?.processing).toEqual({ status: "skipped", reason: "images-disabled" });
    const { token: _token, ...update } = settingsUpdate({
      expectedRevision: 1,
      enabled: true,
      includeImages: true,
    });
    await settings.save(update);
    await client.message({
      ...qqMessage("c2c", "image-2"),
      content: "",
      attachments: [attachment],
    });
    expect(calls[0]?.messages.at(-1)?.images?.[0]?.base64).toBe("iVBORw==");
    expect(JSON.stringify(calls[0])).not.toContain("multimedia.nt.qq.com.cn");
    await client.message({
      ...qqMessage("c2c", "image-3"),
      content: "",
      attachments: [attachment, attachment, attachment],
    });
    expect(calls).toHaveLength(1);
    expect(logs.find(3)?.processing).toEqual({ status: "skipped", reason: "image-limit" });
  });

  test("并发与停止受限，独立会话不会无限堆积模型请求", async () => {
    let started = 0;
    const ready = gate<void>();
    const { client, runtime, logs } = await setup({
      model: (config) =>
        new OpenAICompatibleModel(config, async () => {
          started += 1;
          if (started === 2) ready.resolve();
          return new Promise<Response>(() => {});
        }),
    });
    const message = (id: string) => ({
      ...qqMessage("c2c", id),
      senderId: id,
      replyTarget: { scope: "c2c", targetId: id, msgId: id },
    });
    const first = client.message(message("one"));
    const second = client.message(message("two"));
    await ready.promise;
    await client.message(message("three"));
    expect(logs.find(3)?.processing).toEqual({ status: "skipped", reason: "budget" });
    await runtime.stop();
    await Promise.all([first, second]);
    expect(started).toBe(2);
    expect(client.sends).toHaveLength(0);
    expect(logs.find(1)?.processing?.status).toBe("failed");
  });
});

describe("可选决策门控", () => {
  test("未配置决策时明确跳过，直接调用响应模型", async () => {
    const { client, calls, logs } = await setup({
      decision: () => {
        throw new Error("不得创建决策适配器");
      },
    });
    await client.message(qqMessage());
    expect(calls).toHaveLength(1);
    expect(logs.find(1)?.processing?.decision).toEqual({
      status: "skipped",
      reason: "not-configured",
    });
  });

  test("严格超过阈值才调用响应；低分、等于阈值和拒绝均记录但不回复", async () => {
    for (const probability of [0.3, 0.7, 0.9, null]) {
      let decisions = 0;
      const { client, calls, logs } = await setup({
        decisionModel: "gpt-6-luna",
        decision: () => ({
          evaluate: async () => {
            decisions += 1;
            return {
              model: "gpt-6-luna",
              durationMs: 5,
              ...(probability === null
                ? { type: "refusal" as const }
                : { type: "probability" as const, probability }),
            };
          },
        }),
      });
      await client.message(qqMessage());
      const passed = probability !== null && probability > 0.7;
      expect(decisions).toBe(1);
      expect(calls).toHaveLength(passed ? 1 : 0);
      expect(client.sends).toHaveLength(passed ? 1 : 0);
      expect(logs.find(1)?.processing).toMatchObject({
        status: passed ? "sent" : "skipped",
        decision: { status: "evaluated", threshold: 0.7, passed },
      });
      await client.message(qqMessage());
      expect(decisions).toBe(1);
    }
  });

  test("决策失败不会跳过门控，配置变更会取消在途决策", async () => {
    const { client, calls, logs } = await setup({
      decisionModel: "gpt-6-luna",
      decision: () => ({
        evaluate: async () => {
          throw new ServiceError("provider_timeout");
        },
      }),
    });
    await client.message(qqMessage());
    expect(calls).toHaveLength(0);
    expect(client.sends).toHaveLength(0);
    expect(logs.find(1)?.processing).toMatchObject({
      status: "failed",
      stage: "decision",
      code: "provider_timeout",
    });
    const started = gate<void>();
    const pendingSetup = await setup({
      decisionModel: "gpt-6-luna",
      decision: (config) =>
        new OpenAIDecision(config, async () => {
          started.resolve();
          return new Promise<Response>(() => {});
        }),
    });
    const pending = pendingSetup.client.message(qqMessage());
    await started.promise;
    await pendingSetup.settings.save(settingsUpdate({ expectedRevision: 1, enabled: false }));
    await pending;
    expect(pendingSetup.calls).toHaveLength(0);
    expect(pendingSetup.logs.find(1)?.processing).toMatchObject({
      status: "failed",
      stage: "decision",
      code: "cancelled",
    });
  });

  test("低分消息保留在本配置短期上下文中，供后续决策和响应参考", async () => {
    let evaluated = 0;
    const { client, calls } = await setup({
      decisionModel: "gpt-6-luna",
      decision: () => ({
        evaluate: async () => ({
          type: "probability",
          model: "gpt-6-luna",
          durationMs: 1,
          probability: ++evaluated === 1 ? 0.1 : 0.95,
        }),
      }),
    });
    await client.message({ ...qqMessage(), content: "先观察这段上下文" });
    await client.message({ ...qqMessage("c2c", "follow-up"), content: "请根据刚才的内容解释" });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.messages)).toContain("先观察这段上下文");
  });
});

describe("Decision API 适配器", () => {
  const config: LlmConfiguration = {
    ...settingsUpdate({ decisionModel: "gpt-6-luna" }),
    revision: 1,
    token: fixtureToken,
  };
  test("使用真实 decisions 契约，校验单个谓词答案并记录实际用量", async () => {
    let payload: unknown;
    const decision = new OpenAIDecision(config, async (url, init) => {
      expect(url).toBe("https://models.example.test/v1/decisions");
      expect(init.redirect).toBe("error");
      payload = JSON.parse(String(init.body));
      return Response.json({
        model: "gpt-6-luna",
        answers: [{ type: "predicate", name: "should_reply", probability: 0.82 }],
        usage: { input_tokens: 42, output_tokens: 0, total_tokens: 42 },
      });
    });
    expect(
      await decision.evaluate([{ role: "user", text: "hi" }], new AbortController().signal),
    ).toMatchObject({ type: "probability", probability: 0.82, usage: { totalTokens: 42 } });
    expect(payload).toMatchObject({
      model: "gpt-6-luna",
      questions: [{ type: "predicate", name: "should_reply" }],
    });
    expect(JSON.stringify(payload)).not.toContain('"max_output_tokens"');
  });
  test("拒绝乱序或越界答案，不用缺失值或坏 JSON 伪造概率", async () => {
    for (const answers of [
      [],
      [{ type: "predicate", name: "wrong", probability: 0.9 }],
      [{ type: "predicate", name: "should_reply", probability: 1.1 }],
      [{ type: "predicate", name: "should_reply", probability: -0.1 }],
      [{ type: "predicate", name: "should_reply", probability: null }],
      [{ type: "choice", name: "should_reply", choice: true }],
    ])
      await expect(
        new OpenAIDecision(config, async () =>
          Response.json({ model: "gpt-6-luna", answers }),
        ).evaluate([], new AbortController().signal),
      ).rejects.toMatchObject({ code: "invalid_response" });
    expect(
      await new OpenAIDecision(config, async () =>
        Response.json({
          model: "gpt-6-luna",
          answers: [{ type: "refusal", name: "should_reply" }],
        }),
      ).evaluate([], new AbortController().signal),
    ).toMatchObject({ type: "refusal" });
  });
});

describe("OpenAI 兼容适配器", () => {
  const config: LlmConfiguration = { ...settingsUpdate(), revision: 1, token: fixtureToken };
  const request: ModelRequest = {
    messages: [{ role: "user", text: "hello" }],
    maxOutputTokens: 128,
  };
  test("使用 Responses API、关闭服务端存储，校验响应并遮盖意外回显的凭据", async () => {
    let payload: unknown;
    const model = new OpenAICompatibleModel(config, async (url, init) => {
      expect(url.endsWith("/responses")).toBe(true);
      payload = JSON.parse(String(init.body));
      expect(init.redirect).toBe("error");
      return Response.json(responsePayload(`text ${fixtureToken}`));
    });
    const result = await model.generate(request, new AbortController().signal);
    expect(result.text).toBe("text [凭据已隐藏]");
    expect(payload).toMatchObject({
      max_output_tokens: 128,
      store: false,
      stream: false,
      input: [{ role: "user", content: "hello" }],
    });
    expect(JSON.stringify(payload)).not.toContain('"max_tokens"');
    expect(() =>
      parseModelResponse({
        ...result,
        usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 },
      }),
    ).toThrow();
  });
  test("HTTP 错误、畸形响应、网络故障与超时均明确失败且不泄漏远端内容", async () => {
    const signal = new AbortController().signal;
    await expect(
      new OpenAICompatibleModel(
        config,
        async () => new Response(fixtureToken, { status: 401 }),
      ).generate(request, signal),
    ).rejects.toMatchObject({ code: "provider_auth" });
    await expect(
      new OpenAICompatibleModel(config, async () =>
        Response.json({ choices: [{ message: { content: null }, finish_reason: "stop" }] }),
      ).generate(request, signal),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      new OpenAICompatibleModel(config, async () => {
        throw new TypeError("fixture network");
      }).generate(request, signal),
    ).rejects.toMatchObject({ code: "provider_network" });
    await expect(
      new OpenAICompatibleModel(
        { ...config, timeoutMs: 10 },
        () => new Promise<Response>(() => {}),
      ).generate(request, signal),
    ).rejects.toMatchObject({ code: "provider_timeout" });
    await expect(
      new OpenAICompatibleModel(config, async () =>
        Response.json({
          choices: [{ message: { content: "a".repeat(260_000) }, finish_reason: "stop" }],
        }),
      ).generate(request, signal),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("从多个输出项提取文本，保留截断结果，拒绝工具调用和模型拒绝", async () => {
    const raw = responsePayload("第一段");
    const first = raw.output[0];
    const payload = {
      ...raw,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { type: "reasoning", summary: [] },
        first,
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "第二段" }] },
      ],
    };
    const result = await new OpenAICompatibleModel(config, async () =>
      Response.json(payload),
    ).generate(request, new AbortController().signal);
    expect(result.text).toBe("第一段\n第二段");
    expect(result.finishReason).toBe("length");
    for (const [item, code] of [
      [{ type: "function_call", name: "unsafe" }, "invalid_response"],
      [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: fixtureToken }],
        },
        "provider_refusal",
      ],
    ] as const)
      await expect(
        new OpenAICompatibleModel(config, async () =>
          Response.json({ ...raw, output: [item] }),
        ).generate(request, new AbortController().signal),
      ).rejects.toMatchObject({ code });
  });

  test("接口参数、模型权限和额度错误明确分类，忽略远端敏感正文", async () => {
    const cases = [
      [400, { code: "unsupported_parameter", param: "max_tokens" }, "provider_token_parameter"],
      [400, { code: "invalid_request_error" }, "provider_parameter"],
      [404, { code: "model_not_found" }, "provider_model"],
      [403, {}, "provider_access"],
      [429, { code: "insufficient_quota" }, "provider_quota"],
      [429, { code: "rate_limit_exceeded" }, "provider_rate_limit"],
      [500, {}, "provider_rejected"],
    ] as const;
    for (const [status, detail, code] of cases) {
      const model = new OpenAICompatibleModel(config, async () =>
        Response.json({ error: { ...detail, message: fixtureToken } }, { status }),
      );
      let failure: unknown;
      try {
        await model.generate(request, new AbortController().signal);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code });
      expect(String(failure)).not.toContain(fixtureToken);
      expect(JSON.stringify(failure)).not.toContain(fixtureToken);
    }
  });
});
