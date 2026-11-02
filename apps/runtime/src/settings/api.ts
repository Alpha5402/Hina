import { randomBytes, timingSafeEqual } from "node:crypto";
import { type LlmSettingsUpdate, parseSettingsUpdate } from "@hina/settings";
import { readLimitedJson } from "../http";
import { OpenAICompatibleModel } from "../models/openai-compatible";
import { OpenAIDecision } from "../models/openai-decision";
import { operationScope } from "../operations";
import { ServiceError } from "./errors";
import type { EncryptedSettingsStore } from "./store";

export function settingsApi(
  store: EncryptedSettingsStore,
  shutdown: AbortSignal,
  fixedReply: boolean,
) {
  const csrf = randomBytes(32).toString("base64url");
  let testing = false;
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/api/llm/settings" && request.method === "GET")
        return json({ settings: await store.publicView(), csrfToken: csrf });
      if (
        !(
          (path === "/api/llm/settings" && request.method === "PUT") ||
          (["/api/llm/test", "/api/llm/test-decision"].includes(path) && request.method === "POST")
        )
      )
        return json({ error: { code: "method", message: "请求方法无效" } }, 405);
      const supplied = request.headers.get("X-Hina-CSRF") ?? "";
      if (
        !request.headers.get("origin") ||
        !/^[A-Za-z0-9_-]{43}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf)) ||
        request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
      )
        return json(
          { error: { code: "forbidden", message: "请求校验失败，请重新打开设置页" } },
          403,
        );
      const bodyScope = operationScope(5000, AbortSignal.any([request.signal, shutdown]));
      let update: LlmSettingsUpdate;
      try {
        update = parseSettingsUpdate(
          await readLimitedJson(request.body, 32 * 1024, bodyScope.signal),
        );
      } finally {
        bodyScope.dispose();
      }
      if (path === "/api/llm/settings") {
        if (fixedReply && update.enabled)
          return json(
            {
              error: { code: "fixed_reply", message: "当前为 /ping 测试模式，请先以普通模式启动" },
            },
            409,
          );
        return json({ settings: await store.save(update), csrfToken: csrf });
      }
      if (testing) throw new ServiceError("busy");
      testing = true;
      try {
        const config = await store.candidate(update);
        const signal = AbortSignal.any([request.signal, shutdown]);
        if (path === "/api/llm/test-decision") {
          if (!config.decisionModel) throw new ServiceError("decision_required");
          const decision = await new OpenAIDecision(config).evaluate(
            [{ role: "user", text: "Hina，请帮我解释一下什么是事件驱动程序。" }],
            signal,
          );
          return json({
            decision,
            threshold: config.decisionThreshold,
            passed:
              decision.type === "probability" && decision.probability > config.decisionThreshold,
          });
        }
        const model = new OpenAICompatibleModel(config);
        const response = await model.generate(
          {
            messages: [{ role: "user", text: "请只回复 OK。" }],
            maxOutputTokens: Math.min(config.maxOutputTokens, 512),
          },
          signal,
        );
        return json({ response });
      } finally {
        testing = false;
      }
    } catch (error) {
      const safe = error instanceof ServiceError ? error : new ServiceError("invalid_config");
      const status =
        safe.code === "stale_config"
          ? 409
          : safe.code === "secure_storage" ||
              safe.code === "vault_locked" ||
              safe.code === "save_failed"
            ? 503
            : safe.code === "provider_timeout"
              ? 504
              : safe.code.startsWith("provider_") || safe.code === "invalid_response"
                ? 502
                : safe.code === "busy"
                  ? 429
                  : 400;
      return json({ error: { code: safe.code, message: safe.message } }, status);
    }
  };
}
