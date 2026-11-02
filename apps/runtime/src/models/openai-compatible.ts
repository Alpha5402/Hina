import { type Model, type ModelRequest, type ModelResponse, parseModelResponse } from "@hina/core";
import { object } from "@hina/settings";
import { ServiceError } from "../settings/errors";
import type { LlmConfiguration } from "../settings/store";
import {
  type ModelTransport,
  openAIInput,
  openAIUsage,
  postOpenAI,
  redactToken,
} from "./openai-http";

export class OpenAICompatibleModel implements Model {
  constructor(
    private readonly config: LlmConfiguration,
    private readonly request: ModelTransport = fetch,
  ) {}

  async generate(input: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const { data, durationMs } = await postOpenAI(
      this.config,
      this.config.endpoint,
      {
        model: this.config.model,
        input: openAIInput(input.messages),
        max_output_tokens: input.maxOutputTokens,
        stream: false,
        store: false,
      },
      signal,
      this.request,
    );
    try {
      if (!Array.isArray(data.output) || !["completed", "incomplete"].includes(String(data.status)))
        throw new ServiceError("invalid_response");
      const incomplete = data.status === "incomplete";
      if (incomplete && object(data.incomplete_details).reason !== "max_output_tokens")
        throw new ServiceError("invalid_response");
      const texts: string[] = [];
      for (const value of data.output) {
        const item = object(value);
        if (item.type === "reasoning") continue;
        if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content))
          throw new ServiceError("invalid_response");
        for (const value of item.content) {
          const part = object(value);
          if (part.type === "refusal") throw new ServiceError("provider_refusal");
          if (part.type !== "output_text" || typeof part.text !== "string")
            throw new ServiceError("invalid_response");
          texts.push(part.text);
        }
      }
      const usage = openAIUsage(data.usage);
      signal.throwIfAborted();
      return parseModelResponse({
        model: redactToken(
          typeof data.model === "string" ? data.model : this.config.model,
          this.config.token,
        ),
        text: redactToken(texts.join("\n"), this.config.token),
        finishReason: incomplete ? "length" : "stop",
        durationMs,
        ...(usage ? { usage } : {}),
      });
    } catch (error) {
      if (signal.aborted) throw new ServiceError("cancelled");
      throw error instanceof ServiceError ? error : new ServiceError("invalid_response");
    }
  }
}
