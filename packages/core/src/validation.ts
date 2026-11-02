import type { ActionProposal, RuntimeEvent, TextContent } from "./index.ts";

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`${field} 必须是长度为 1–256 的非空字符串`);
  }
  return value;
}

function content(value: unknown): TextContent {
  const input = record(value, "content");
  if (input.type !== "text" || typeof input.text !== "string" || input.text.length > 16_384) {
    throw new TypeError("content 必须是至多 16384 个字符的 text 内容");
  }
  return Object.freeze({ type: "text", text: input.text });
}

export function parseEvent(value: unknown): RuntimeEvent {
  const input = record(value, "event");
  const origin = record(input.origin, "origin");
  if (
    typeof input.timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      input.timestamp,
    ) ||
    !Number.isFinite(Date.parse(input.timestamp))
  ) {
    throw new TypeError("timestamp 必须是包含时区的 ISO 时间字符串");
  }
  const calendarDate = input.timestamp.slice(0, 10);
  const midnight = new Date(`${calendarDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== calendarDate ||
    Number(input.timestamp.slice(11, 13)) > 23
  ) {
    throw new TypeError("timestamp 包含无效的日期或时间");
  }
  return Object.freeze({
    id: identifier(input.id, "id"),
    origin: Object.freeze({
      channelId: identifier(origin.channelId, "origin.channelId"),
      accountId: identifier(origin.accountId, "origin.accountId"),
    }),
    timestamp: new Date(input.timestamp).toISOString(),
    actorId: identifier(input.actorId, "actorId"),
    conversationId: identifier(input.conversationId, "conversationId"),
    content: content(input.content),
  });
}

export function parseActionProposal(value: unknown): ActionProposal {
  const input = record(value, "action");
  const target = record(input.target, "target");
  if (input.type !== "message.send") {
    throw new TypeError("action.type 必须是 message.send");
  }
  return Object.freeze({
    type: "message.send",
    target: Object.freeze({
      channelId: identifier(target.channelId, "target.channelId"),
      accountId: identifier(target.accountId, "target.accountId"),
      conversationId: identifier(target.conversationId, "target.conversationId"),
    }),
    content: content(input.content),
  });
}
