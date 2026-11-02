import type { RuntimeHooks } from "@hina/core";

/** 仅在操作者显式启用时回复 /ping；接入阶段不自动复述私人消息。 */
export function qqHooks(appId: string, replyEnabled: boolean): RuntimeHooks {
  return {
    beforeHandle: ({ event }) =>
      replyEnabled && /^(?:<@!?\d+>\s*)?\/ping$/.test(event.content.text.trim())
        ? "continue"
        : "observe",
    handle: ({ event }) => [
      {
        type: "message.send",
        target: { ...event.origin, conversationId: event.conversationId },
        content: { type: "text", text: "Hina QQ Bot 已连接。" },
      },
    ],
    beforeSend: ({ event, action }) =>
      replyEnabled &&
      event.origin.channelId === "qq" &&
      event.origin.accountId === appId &&
      action.target.channelId === "qq" &&
      action.target.accountId === appId &&
      action.target.conversationId === event.conversationId
        ? "allow"
        : "deny",
  };
}
