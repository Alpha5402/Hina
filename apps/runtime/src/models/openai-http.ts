import { type ModelMessage, parseModelUsage } from "@hina/core";
import { object } from "@hina/settings";
import { readLimitedJson } from "../http";
import { abortable, operationScope } from "../operations";
import { ServiceError } from "../settings/errors";
import type { LlmConfiguration } from "../settings/store";
import { providerError } from "./provider-error";

export type ModelTransport = (url: string, init: RequestInit) => Promise<Response>;

export function redactToken(text: string, token: string): string {
  return text.split(token).join("[凭据已隐藏]");
}

export function openAIInput(messages: readonly ModelMessage[]) {
  return messages.map((message) => ({
    role: message.role === "system" ? "developer" : message.role,
    content: message.images?.length
      ? [
          { type: "input_text", text: message.text || "[图片消息]" },
          ...message.images.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mediaType};base64,${image.base64}`,
          })),
        ]
      : message.text,
  }));
}

export function openAIUsage(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const raw = object(value);
  return parseModelUsage({
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    totalTokens: raw.total_tokens,
  });
}

export async function postOpenAI(
  config: LlmConfiguration,
  endpoint: string,
  body: unknown,
  parent: AbortSignal,
  request: ModelTransport,
) {
  const scope = operationScope(config.timeoutMs, parent);
  const startedAt = performance.now();
  let phase: "request" | "response" = "request";
  try {
    const response = await abortable(
      () =>
        request(endpoint, {
          method: "POST",
          redirect: "error",
          signal: scope.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
          body: JSON.stringify(body),
        }),
      scope.signal,
    );
    phase = "response";
    if (!response.ok) throw await providerError(response, scope.signal);
    const data = object(await readLimitedJson(response.body, 256 * 1024, scope.signal));
    scope.signal.throwIfAborted();
    return { data, durationMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    if (parent.aborted) throw new ServiceError("cancelled");
    if (scope.signal.aborted) throw new ServiceError("provider_timeout");
    if (error instanceof ServiceError) throw error;
    if (phase === "response") throw new ServiceError("invalid_response");
    throw new ServiceError("provider_network");
  } finally {
    scope.dispose();
  }
}
