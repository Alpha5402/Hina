export interface ModelImage {
  readonly mediaType: string;
  readonly base64: string;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly text: string;
  readonly images?: readonly ModelImage[];
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ModelResponse {
  readonly model: string;
  readonly text: string;
  readonly finishReason: string;
  readonly durationMs: number;
  readonly usage?: ModelUsage;
}

export interface Model {
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export function parseModelResponse(input: unknown): ModelResponse {
  if (typeof input !== "object" || input === null) throw new TypeError("模型响应无效");
  const value = input as Record<string, unknown>;
  if (
    typeof value.model !== "string" ||
    !value.model ||
    value.model.length > 128 ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 16_384 ||
    typeof value.finishReason !== "string" ||
    value.finishReason.length > 64 ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0
  )
    throw new TypeError("模型响应字段无效");
  let usage: ModelUsage | undefined;
  if (value.usage !== undefined) {
    if (typeof value.usage !== "object" || value.usage === null)
      throw new TypeError("模型用量无效");
    const raw = value.usage as Record<string, unknown>;
    const number = (input: unknown) => {
      if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0)
        throw new TypeError("模型用量无效");
      return input;
    };
    usage = Object.freeze({
      inputTokens: number(raw.inputTokens),
      outputTokens: number(raw.outputTokens),
      totalTokens: number(raw.totalTokens),
    });
  }
  return Object.freeze({
    model: value.model,
    text: value.text,
    finishReason: value.finishReason,
    durationMs: value.durationMs,
    ...(usage ? { usage } : {}),
  });
}
