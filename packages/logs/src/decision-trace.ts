import { type DecisionResult, parseDecisionResult } from "@hina/core";

export type DecisionTrace =
  | { readonly status: "skipped"; readonly reason: "not-configured" }
  | { readonly status: "evaluating"; readonly model: string; readonly threshold: number }
  | {
      readonly status: "evaluated";
      readonly result: DecisionResult;
      readonly threshold: number;
      readonly passed: boolean;
    };

export function parseDecisionTrace(input: unknown): DecisionTrace {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("决策日志无效");
  const value = input as Record<string, unknown>;
  if (value.status === "skipped" && value.reason === "not-configured")
    return { status: "skipped", reason: "not-configured" };
  if (
    typeof value.threshold !== "number" ||
    !Number.isFinite(value.threshold) ||
    value.threshold < 0 ||
    value.threshold > 1
  )
    throw new TypeError("决策阈值无效");
  if (
    value.status === "evaluating" &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    value.model.length <= 128
  )
    return { status: "evaluating", model: value.model, threshold: value.threshold };
  if (value.status === "evaluated" && typeof value.passed === "boolean") {
    const result = parseDecisionResult(value.result);
    if (value.passed !== (result.type === "probability" && result.probability > value.threshold))
      throw new TypeError("决策结果与阈值不符");
    return { status: "evaluated", result, threshold: value.threshold, passed: value.passed };
  }
  throw new TypeError("决策日志状态无效");
}
