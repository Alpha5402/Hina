import { type ModelResponse, parseEvent, parseModelResponse, type RuntimeEvent } from "@hina/core";
import { type DecisionTrace, parseDecisionTrace } from "./decision-trace";

export type { DecisionResult, ModelResponse } from "@hina/core";
export { parseDecisionResult, parseModelResponse } from "@hina/core";
export type { DecisionTrace } from "./decision-trace";
export { parseDecisionTrace } from "./decision-trace";

export const messageCategories = ["direct", "group", "channel", "unknown"] as const;
export type MessageCategory = (typeof messageCategories)[number];
export type ConnectionStatus = "connecting" | "online" | "offline";

export interface MessageLogEntry extends RuntimeEvent {
  readonly sequence: number;
  readonly receivedAt: string;
  readonly processing?: MessageProcessing;
  readonly processingVersion?: number;
}

export type MessageProcessing = { readonly decision?: DecisionTrace } & (
  | {
      readonly status: "skipped";
      readonly reason:
        | "disabled"
        | "not-configured"
        | "scope"
        | "images-disabled"
        | "image-limit"
        | "input-limit"
        | "budget"
        | "configuration-unavailable"
        | "decision-threshold"
        | "decision-refused";
    }
  | { readonly status: "deciding" | "generating"; readonly startedAt: string }
  | { readonly status: "generated" | "sending" | "blocked"; readonly response: ModelResponse }
  | { readonly status: "sent"; readonly response: ModelResponse; readonly sentAt: string }
  | {
      readonly status: "failed";
      readonly stage: "decision" | "model" | "policy" | "send";
      readonly code: string;
      readonly response?: ModelResponse;
    }
);

export function parseProcessing(input: unknown): MessageProcessing {
  const value = record(input);
  const state = parseProcessingState(input);
  return {
    ...state,
    ...(value.decision === undefined ? {} : { decision: parseDecisionTrace(value.decision) }),
  };
}

function parseProcessingState(input: unknown): MessageProcessing {
  const value = record(input);
  if (
    value.status === "skipped" &&
    typeof value.reason === "string" &&
    [
      "disabled",
      "not-configured",
      "scope",
      "images-disabled",
      "image-limit",
      "input-limit",
      "budget",
      "configuration-unavailable",
      "decision-threshold",
      "decision-refused",
    ].includes(value.reason)
  )
    return {
      status: "skipped",
      reason: value.reason as Extract<MessageProcessing, { status: "skipped" }>["reason"],
    };
  const time = (input: unknown) => {
    if (
      typeof input !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input) ||
      !Number.isFinite(Date.parse(input)) ||
      new Date(input).toISOString() !== input
    )
      throw new TypeError("处理时间无效");
    return new Date(input).toISOString();
  };
  if (value.status === "generating" || value.status === "deciding")
    return { status: value.status, startedAt: time(value.startedAt) };
  if (value.status === "generated" || value.status === "sending" || value.status === "blocked")
    return { status: value.status, response: parseModelResponse(value.response) };
  if (value.status === "sent")
    return {
      status: "sent",
      response: parseModelResponse(value.response),
      sentAt: time(value.sentAt),
    };
  if (
    value.status === "failed" &&
    typeof value.stage === "string" &&
    ["decision", "model", "policy", "send"].includes(value.stage) &&
    typeof value.code === "string" &&
    /^[a-z_-]{1,64}$/.test(value.code)
  )
    return {
      status: "failed",
      stage: value.stage as "decision" | "model" | "policy" | "send",
      code: value.code,
      ...(value.response === undefined ? {} : { response: parseModelResponse(value.response) }),
    };
  throw new TypeError("消息处理状态无效");
}

export interface MessageLogQuery {
  readonly search: string;
  readonly channel: string;
  readonly category: MessageCategory | "all";
  readonly contentType: "all" | "text" | "image" | "mixed" | "media";
  readonly page: number;
  readonly pageSize: number;
  readonly snapshot?: number;
}

export interface MessageLogPage {
  readonly messages: readonly MessageLogEntry[];
  readonly matchedCount: number;
  readonly retainedCount: number;
  readonly newCount: number;
  readonly snapshot: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly channels: readonly string[];
  readonly capacity: number;
}

export interface MessageLogResponse extends MessageLogPage {
  readonly connection: ConnectionStatus;
  readonly replyEnabled: boolean;
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("消息日志数据无效");
  return input as Record<string, unknown>;
}

function integer(input: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max)
    throw new TypeError("消息日志数值无效");
  return input;
}

export function parseLogQuery(params: URLSearchParams): MessageLogQuery {
  const search = params.get("search")?.trim() ?? "";
  const channel = params.get("channel") ?? "";
  const category = params.get("category") ?? "all";
  const contentType = params.get("contentType") ?? "all";
  if (
    search.length > 200 ||
    channel.length > 256 ||
    (category !== "all" && !messageCategories.some((value) => value === category)) ||
    !["all", "text", "image", "mixed", "media"].includes(contentType)
  )
    throw new TypeError("消息日志筛选条件无效");
  const number = (name: string, fallback: number, min: number, max?: number) => {
    const raw = params.get(name);
    if (raw !== null && !/^\d{1,16}$/.test(raw)) throw new TypeError("分页参数无效");
    return integer(raw === null ? fallback : Number(raw), min, max);
  };
  return {
    search,
    channel,
    category: category as MessageLogQuery["category"],
    contentType: contentType as MessageLogQuery["contentType"],
    page: number("page", 1, 1, 1_000_000),
    pageSize: number("pageSize", 25, 1, 100),
    ...(params.has("snapshot") ? { snapshot: number("snapshot", 0, 0) } : {}),
  };
}

export function parseLogResponse(input: unknown): MessageLogResponse {
  const value = record(input);
  if (
    !Array.isArray(value.messages) ||
    value.messages.length > 100 ||
    !Array.isArray(value.channels) ||
    value.channels.length > 100 ||
    !value.channels.every((channel) => typeof channel === "string" && channel.length <= 256) ||
    typeof value.connection !== "string" ||
    !["connecting", "online", "offline"].includes(value.connection) ||
    typeof value.replyEnabled !== "boolean"
  )
    throw new TypeError("消息日志响应无效");
  return {
    messages: value.messages.map(parseMessageLogEntry),
    matchedCount: integer(value.matchedCount, 0),
    retainedCount: integer(value.retainedCount, 0),
    newCount: integer(value.newCount, 0),
    snapshot: integer(value.snapshot, 0),
    page: integer(value.page, 1),
    pageSize: integer(value.pageSize, 1, 100),
    pageCount: integer(value.pageCount, 1),
    channels: value.channels as string[],
    capacity: integer(value.capacity, 1),
    connection: value.connection as ConnectionStatus,
    replyEnabled: value.replyEnabled,
  };
}

export function parseMessageLogEntry(input: unknown): MessageLogEntry {
  const row = record(input);
  const event = parseEvent(row);
  const received = parseEvent({ ...event, timestamp: row.receivedAt });
  return {
    ...event,
    sequence: integer(row.sequence, 1),
    receivedAt: received.timestamp,
    ...(row.processing === undefined ? {} : { processing: parseProcessing(row.processing) }),
    ...(row.processingVersion === undefined
      ? {}
      : { processingVersion: integer(row.processingVersion, 0) }),
  };
}
