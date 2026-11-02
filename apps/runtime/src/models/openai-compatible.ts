import { type Model, type ModelRequest, type ModelResponse, parseModelResponse } from "@hina/core";
import { object } from "@hina/settings";
import { readLimitedJson } from "../http";
import { abortable, operationScope } from "../operations";
import { ServiceError } from "../settings/errors";
import type { LlmConfiguration } from "../settings/store";
import { providerError } from "./provider-error";

export function redactToken(text: string, token: string): string {
  return text.split(token).join("[凭据已隐藏]");
}

export class OpenAICompatibleModel implements Model {
  constructor(
    private readonly config: LlmConfiguration,
    private readonly request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {}

  async generate(input: ModelRequest, parent: AbortSignal): Promise<ModelResponse> {
    const scope = operationScope(this.config.timeoutMs, parent);
    const startedAt = performance.now();
    let phase: "request" | "response" = "request";
    try {
      const messages = input.messages.map((message) => ({
        role: message.role,
        content: message.images?.length
          ? [
              { type: "text", text: message.text || "请回应用户发送的图片。" },
              ...message.images.map((image) => ({
                type: "image_url",
                image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
              })),
            ]
          : message.text,
      }));
      const response = await abortable(
        () =>
          this.request(this.config.endpoint, {
            method: "POST",
            redirect: "error",
            signal: scope.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.config.token}`,
            },
            body: JSON.stringify({
              model: this.config.model,
              messages,
              stream: false,
              [this.config.tokenParameter]: input.maxOutputTokens,
            }),
          }),
        scope.signal,
      );
      phase = "response";
      if (!response.ok) {
        throw await providerError(response, scope.signal);
      }
      const raw = object(await readLimitedJson(response.body, 256 * 1024, scope.signal));
      if (!Array.isArray(raw.choices) || raw.choices.length < 1)
        throw new ServiceError("invalid_response");
      const first = object(raw.choices[0]);
      const message = object(first.message);
      if (
        typeof message.content !== "string" ||
        !message.content.trim() ||
        message.tool_calls !== undefined ||
        typeof first.finish_reason !== "string" ||
        !["stop", "length", "content_filter"].includes(first.finish_reason)
      )
        throw new ServiceError("invalid_response");
      const metrics = raw.usage === undefined || raw.usage === null ? undefined : object(raw.usage);
      const usage = metrics
        ? {
            inputTokens: metrics.prompt_tokens,
            outputTokens: metrics.completion_tokens,
            totalTokens: metrics.total_tokens,
          }
        : undefined;
      scope.signal.throwIfAborted();
      return parseModelResponse({
        model: redactToken(
          typeof raw.model === "string" ? raw.model : this.config.model,
          this.config.token,
        ),
        text: redactToken(message.content, this.config.token),
        finishReason: first.finish_reason,
        durationMs: Math.round(performance.now() - startedAt),
        ...(usage ? { usage } : {}),
      });
    } catch (error) {
      if (parent.aborted) throw new ServiceError("cancelled");
      if (scope.signal.aborted) throw new ServiceError("provider_timeout");
      if (error instanceof ServiceError) throw error;
      if (phase === "response" && (error instanceof TypeError || error instanceof SyntaxError))
        throw new ServiceError("invalid_response");
      throw new ServiceError("provider_network");
    } finally {
      scope.dispose();
    }
  }
}
