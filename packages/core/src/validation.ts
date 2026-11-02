import type {
  ActionProposal,
  ImageAttachment,
  MediaContent,
  RuntimeEvent,
  TextContent,
} from "./index.ts";

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

function eventContent(value: unknown): TextContent | MediaContent {
  const input = record(value, "content");
  if (input.type === "text") return content(input);
  if (
    input.type !== "message" ||
    typeof input.text !== "string" ||
    input.text.length > 16_384 ||
    !Array.isArray(input.images) ||
    input.images.length < 1 ||
    input.images.length > 10
  )
    throw new TypeError("媒体消息必须包含文本字段和 1–10 个图片附件");
  const images = input.images.map((value: unknown): ImageAttachment => {
    const image = record(value, "image");
    if (
      image.type !== "image" ||
      typeof image.url !== "string" ||
      image.url.length > 4096 ||
      typeof image.mediaType !== "string" ||
      !/^image\/[a-z0-9.+-]{1,64}$/i.test(image.mediaType) ||
      (image.name !== undefined && (typeof image.name !== "string" || image.name.length > 256))
    )
      throw new TypeError("图片附件字段无效");
    const url = new URL(image.url);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
      throw new TypeError("图片附件必须使用 HTTPS 地址");
    return Object.freeze({
      type: "image",
      url: url.href,
      mediaType: image.mediaType.toLowerCase(),
      ...(image.name === undefined ? {} : { name: image.name }),
    });
  });
  return Object.freeze({ type: "message", text: input.text, images: Object.freeze(images) });
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
  const conversationType = input.conversationType;
  if (input.directedToCharacter !== undefined && typeof input.directedToCharacter !== "boolean")
    throw new TypeError("directedToCharacter 必须是布尔值");
  if (
    conversationType !== undefined &&
    conversationType !== "direct" &&
    conversationType !== "group" &&
    conversationType !== "channel"
  )
    throw new TypeError("conversationType 必须是 direct、group 或 channel");
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
    ...(conversationType === undefined ? {} : { conversationType }),
    ...(typeof input.directedToCharacter === "boolean"
      ? { directedToCharacter: input.directedToCharacter }
      : {}),
    content: eventContent(input.content),
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
