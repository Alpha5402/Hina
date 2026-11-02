import type { ModelMessage, ModelUsage } from "./model";
import { parseModelUsage } from "./model";

interface DecisionMetrics {
  readonly model: string;
  readonly durationMs: number;
  readonly usage?: ModelUsage;
}

export type DecisionResult = DecisionMetrics &
  ({ readonly type: "probability"; readonly probability: number } | { readonly type: "refusal" });

export interface Decision {
  evaluate(messages: readonly ModelMessage[], signal: AbortSignal): Promise<DecisionResult>;
}

export function parseDecisionResult(input: unknown): DecisionResult {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("决策结果无效");
  const value = input as Record<string, unknown>;
  if (
    typeof value.model !== "string" ||
    !value.model ||
    value.model.length > 128 ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    (value.type !== "probability" && value.type !== "refusal") ||
    (value.type === "probability" &&
      (typeof value.probability !== "number" ||
        !Number.isFinite(value.probability) ||
        value.probability < 0 ||
        value.probability > 1))
  )
    throw new TypeError("决策结果字段无效");
  const metrics: DecisionMetrics = {
    model: value.model,
    durationMs: value.durationMs,
    ...(value.usage === undefined ? {} : { usage: parseModelUsage(value.usage) }),
  };
  return value.type === "refusal"
    ? { ...metrics, type: "refusal" }
    : { ...metrics, type: "probability", probability: value.probability as number };
}
