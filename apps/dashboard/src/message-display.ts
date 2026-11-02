import type { MessageLogEntry } from "@hina/logs";

export function messageText(message: MessageLogEntry): string {
  if (message.origin.channelId !== "qq" || message.content.type !== "message")
    return message.content.text;
  // QQ 表情图片附带的协议标记留在原始记录中，不占据列表正文。
  return message.content.text.replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/g, "").trim();
}

export function contentLabel(message: MessageLogEntry): string {
  return message.content.type === "text" ? "文本" : messageText(message) ? "图文" : "图片";
}
